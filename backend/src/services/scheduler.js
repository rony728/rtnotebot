'use strict';

/**
 * Motor de notificaciones en segundo plano.
 *
 * Garantías:
 *  - Reclamo atómico: SELECT ... FOR UPDATE SKIP LOCKED + UPDATE (lease con locked_until)
 *    en una sola sentencia. Varias instancias (PM2 cluster) o ticks solapados nunca
 *    toman el mismo recordatorio a la vez.
 *  - Recuperación: si el proceso muere durante un envío, el lease expira y se reintenta.
 *  - Reintentos con backoff exponencial para errores transitorios (red, 429, 5xx).
 *  - Errores permanentes (chat inexistente, bot bloqueado) o agotar reintentos -> 'failed'.
 */

const cron = require('node-cron');
const env = require('../config/env');
const db = require('../config/db');
const telegram = require('./telegramService');
const { TZ } = require('../utils/time');

const { batchSize, maxAttempts, leaseSeconds } = env.scheduler;
const CONCURRENCY = 5; // envíos simultáneos (Telegram admite ~30 msg/s)
const MAX_BATCHES_PER_TICK = 20;
const MAX_ERROR_LENGTH = 500;

let task = null;
let running = false;

const log = (...args) => console.log('[scheduler]', ...args);
const logError = (...args) => console.error('[scheduler]', ...args);

const CLAIM_SQL = `
  WITH due AS (
    SELECT r.id
      FROM reminders r
     WHERE r.status = 'pending'
       AND r.scheduled_at <= NOW()
       AND (r.locked_until IS NULL OR r.locked_until <= NOW())
     ORDER BY r.scheduled_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE reminders r
     SET locked_until = NOW() + make_interval(secs => $2),
         attempts     = r.attempts + 1
    FROM due, users u
   WHERE r.id = due.id
     AND u.id = r.user_id
  RETURNING r.id, r.title, r.description, r.scheduled_at, r.attempts, u.telegram_chat_id`;

const CLAIM_30M_SQL = `
  WITH due_30m AS (
    SELECT r.id
      FROM reminders r
     WHERE r.status = 'pending'
       AND r.notify_30m_before = TRUE
       AND r.sent_30m_at IS NULL
       AND r.scheduled_at <= NOW() + INTERVAL '30 minutes'
       AND r.scheduled_at > NOW()
       AND (r.locked_until IS NULL OR r.locked_until <= NOW())
     ORDER BY r.scheduled_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE reminders r
     SET locked_until = NOW() + make_interval(secs => $2)
    FROM due_30m, users u
   WHERE r.id = due_30m.id
     AND u.id = r.user_id
  RETURNING r.id, r.title, r.description, r.scheduled_at, r.attempts, u.telegram_chat_id`;

const CLAIM_15M_SQL = `
  WITH due_15m AS (
    SELECT r.id
      FROM reminders r
     WHERE r.status = 'pending'
       AND r.notify_15m_before = TRUE
       AND r.sent_15m_at IS NULL
       AND r.scheduled_at <= NOW() + INTERVAL '15 minutes'
       AND r.scheduled_at > NOW()
       AND (r.locked_until IS NULL OR r.locked_until <= NOW())
     ORDER BY r.scheduled_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE reminders r
     SET locked_until = NOW() + make_interval(secs => $2)
    FROM due_15m, users u
   WHERE r.id = due_15m.id
     AND u.id = r.user_id
  RETURNING r.id, r.title, r.description, r.scheduled_at, r.attempts, u.telegram_chat_id`;

/** Reclama atómicamente hasta `limit` recordatorios vencidos (lease de leaseSeconds). */
const claimDue = async (limit = batchSize) => {
  const { rows } = await db.query(CLAIM_SQL, [limit, leaseSeconds]);
  return rows;
};

const claim30mDue = async (limit = batchSize) => {
  const { rows } = await db.query(CLAIM_30M_SQL, [limit, leaseSeconds]);
  return rows;
};

const claim15mDue = async (limit = batchSize) => {
  const { rows } = await db.query(CLAIM_15M_SQL, [limit, leaseSeconds]);
  return rows;
};

/** Backoff exponencial: 1, 2, 4, 8... min (máx. 60). Respeta retry_after de Telegram. */
const backoffSeconds = (attempts, retryAfter) => {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter + 1, 3600);
  return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3600);
};

const truncate = (text) => String(text).slice(0, MAX_ERROR_LENGTH);

const markSent = (id) =>
  db.query(
    `UPDATE reminders
        SET status = 'sent', sent_at = NOW(), locked_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id]
  );

const mark30mSent = (id) =>
  db.query(
    `UPDATE reminders
        SET sent_30m_at = NOW(), locked_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id]
  );

const mark15mSent = (id) =>
  db.query(
    `UPDATE reminders
        SET sent_15m_at = NOW(), locked_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id]
  );

const markFailed = (id, message) =>
  db.query(
    `UPDATE reminders
        SET status = 'failed', last_error = $2, locked_until = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id, truncate(message)]
  );

const markPreReminderFailed = (id, minutes, message) => {
  const col = minutes === 30 ? 'sent_30m_at' : 'sent_15m_at';
  return db.query(
    `UPDATE reminders
        SET ${col} = NOW(), locked_until = NULL, last_error = $2
      WHERE id = $1 AND status = 'pending'`,
    [id, truncate(message)]
  );
};

const scheduleRetry = (id, message, delaySeconds) =>
  db.query(
    `UPDATE reminders
        SET last_error = $2, locked_until = NOW() + make_interval(secs => $3)
      WHERE id = $1 AND status = 'pending'`,
    [id, truncate(message), delaySeconds]
  );

/** Procesa un pre-aviso de 30m o 15m. */
const processPreReminder = async (reminder, minutes) => {
  if (!reminder.telegram_chat_id) {
    await markPreReminderFailed(reminder.id, minutes, 'El usuario no tiene un chat de Telegram vinculado');
    return 'failed';
  }

  try {
    const text =
      minutes === 30
        ? telegram.buildPreReminder30Message(reminder)
        : telegram.buildPreReminder15Message(reminder);
    await telegram.sendMessage(reminder.telegram_chat_id, text);
    if (minutes === 30) await mark30mSent(reminder.id);
    else await mark15mSent(reminder.id);
    return 'sent';
  } catch (err) {
    const message = err.message || String(err);
    const retryable = err instanceof telegram.TelegramError ? err.retryable : true;

    if (retryable) {
      const delay = 30; // Reintento corto antes del evento
      await scheduleRetry(reminder.id, message, delay);
      logError(`#${reminder.id} pre-aviso ${minutes}m falló: ${message}. Reintento en ${delay}s`);
      return 'retry';
    }

    await markPreReminderFailed(reminder.id, minutes, message);
    logError(`#${reminder.id} pre-aviso ${minutes}m falló permanentemente: ${message}`);
    return 'failed';
  }
};

/** Procesa un recordatorio ya reclamado. Devuelve 'sent' | 'retry' | 'failed'. */
const processOne = async (reminder) => {
  if (!reminder.telegram_chat_id) {
    await markFailed(reminder.id, 'El usuario no tiene un chat de Telegram vinculado');
    return 'failed';
  }

  try {
    await telegram.sendMessage(reminder.telegram_chat_id, telegram.buildReminderMessage(reminder));
    await markSent(reminder.id);
    return 'sent';
  } catch (err) {
    const message = err.message || String(err);
    const retryable = err instanceof telegram.TelegramError ? err.retryable : true;

    if (retryable && reminder.attempts < maxAttempts) {
      const delay = backoffSeconds(reminder.attempts, err.retryAfter);
      await scheduleRetry(reminder.id, message, delay);
      logError(
        `#${reminder.id} intento ${reminder.attempts}/${maxAttempts} falló: ${message}. ` +
          `Reintento en ${delay}s`
      );
      return 'retry';
    }

    await markFailed(reminder.id, message);
    logError(`#${reminder.id} marcado como failed tras ${reminder.attempts} intento(s): ${message}`);
    return 'failed';
  }
};

const runWithConcurrency = async (items, worker, limit) => {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    // allSettled: un fallo de BD en un ítem no detiene al resto
    const settled = await Promise.allSettled(chunk.map(worker));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else {
        logError('Error inesperado procesando recordatorio:', s.reason?.message || s.reason);
        results.push('error');
      }
    }
  }
  return results;
};

/**
 * Un "tick" del scheduler: reclama y procesa recordatorios con pre-avisos (30m y 15m)
 * y recordatorios vencidos (evento principal).
 * Exportado para poder dispararlo manualmente en pruebas.
 */
const processDueReminders = async () => {
  if (running) return { skipped: true };
  running = true;
  const stats = {
    claimed: 0,
    sent: 0,
    retry: 0,
    failed: 0,
    error: 0,
    pre30m_sent: 0,
    pre15m_sent: 0,
  };

  try {
    // 1. Pre-avisos de 30 minutos
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
      const rows = await claim30mDue();
      if (!rows.length) break;

      const results = await runWithConcurrency(rows, (r) => processPreReminder(r, 30), CONCURRENCY);
      for (const res of results) {
        if (res === 'sent') stats.pre30m_sent += 1;
        else if (res === 'retry') stats.retry += 1;
        else if (res === 'failed') stats.failed += 1;
        else stats.error += 1;
      }

      if (rows.length < batchSize) break;
    }

    // 2. Pre-avisos de 15 minutos
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
      const rows = await claim15mDue();
      if (!rows.length) break;

      const results = await runWithConcurrency(rows, (r) => processPreReminder(r, 15), CONCURRENCY);
      for (const res of results) {
        if (res === 'sent') stats.pre15m_sent += 1;
        else if (res === 'retry') stats.retry += 1;
        else if (res === 'failed') stats.failed += 1;
        else stats.error += 1;
      }

      if (rows.length < batchSize) break;
    }

    // 3. Evento principal vencido (scheduled_at <= NOW())
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
      const rows = await claimDue();
      if (!rows.length) break;

      stats.claimed += rows.length;
      const results = await runWithConcurrency(rows, processOne, CONCURRENCY);
      for (const r of results) stats[r] += 1;

      if (rows.length < batchSize) break;
    }

    if (stats.claimed || stats.pre30m_sent || stats.pre15m_sent) {
      log(
        `Tick: ${stats.claimed} vencidos, ${stats.sent} enviados, ` +
          `${stats.pre30m_sent} pre-30m, ${stats.pre15m_sent} pre-15m, ` +
          `${stats.retry} reintentos, ${stats.failed} fallidos`
      );
    }
    return stats;
  } catch (err) {
    logError('Error en el tick:', err.message);
    return { ...stats, fatal: err.message };
  } finally {
    running = false;
  }
};

const start = () => {
  if (!env.scheduler.enabled) {
    log('Deshabilitado (SCHEDULER_ENABLED=false)');
    return false;
  }
  if (!telegram.isConfigured()) {
    log('ADVERTENCIA: TELEGRAM_BOT_TOKEN no configurado; el scheduler no se iniciará.');
    return false;
  }
  if (!cron.validate(env.scheduler.cron)) {
    logError(`Expresión cron inválida: "${env.scheduler.cron}"`);
    return false;
  }

  task = cron.schedule(env.scheduler.cron, () => void processDueReminders(), { timezone: TZ });
  log(`Iniciado ("${env.scheduler.cron}", zona ${TZ}, máx. ${maxAttempts} intentos)`);
  // Procesa de inmediato lo que haya quedado pendiente mientras el servidor estaba apagado
  setImmediate(() => void processDueReminders());
  return true;
};

const stop = () => {
  if (task) {
    task.stop();
    task = null;
    log('Detenido');
  }
};

module.exports = {
  start,
  stop,
  processDueReminders,
  claimDue,
  claim30mDue,
  claim15mDue,
  processPreReminder,
  backoffSeconds,
};
