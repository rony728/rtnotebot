'use strict';

/**
 * Cliente mínimo de la Telegram Bot API para @rtnotebot (sin dependencias: usa fetch nativo).
 */

const env = require('../config/env');
const { TZ_LABEL, formatDisplay } = require('../utils/time');

const MAX_DESCRIPTION_CHARS = 3000; // límite de mensaje de Telegram: 4096
const LATE_THRESHOLD_MS = 5 * 60 * 1000;

class TelegramError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, retryable?: boolean, retryAfter?: number, description?: string, code?: string}} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = info.status ?? null;
    this.retryable = Boolean(info.retryable);
    this.retryAfter = info.retryAfter ?? null;
    this.description = info.description ?? message;
    this.code = info.code ?? null;
  }
}

const isConfigured = () => Boolean(env.telegram.botToken);

// Evita que el token aparezca jamás en logs o respuestas
const redact = (text) =>
  isConfigured() ? String(text).split(env.telegram.botToken).join('<redacted>') : String(text);

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Llamada genérica a la Bot API.
 * Clasifica errores como reintentables (red, 429, 5xx) o permanentes (400, 401, 403...).
 */
const callApi = async (method, payload) => {
  if (!isConfigured()) {
    throw new TelegramError('TELEGRAM_BOT_TOKEN no está configurado', {
      code: 'NOT_CONFIGURED',
      retryable: false,
    });
  }

  const url = `${env.telegram.apiBase}/bot${env.telegram.botToken}/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.telegram.timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
    throw new TelegramError(redact(`Error de red con Telegram: ${reason}`), {
      retryable: true,
      code: 'NETWORK',
    });
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta no-JSON */
  }

  if (res.ok && data && data.ok) return data.result;

  const status = data?.error_code ?? res.status;
  const description = redact(data?.description || `HTTP ${res.status}`);
  throw new TelegramError(`Telegram API ${status}: ${description}`, {
    status,
    description,
    retryAfter: data?.parameters?.retry_after,
    retryable: status === 429 || status >= 500,
  });
};

const sendMessage = (chatId, html) =>
  callApi('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

const getChat = (chatId) => callApi('getChat', { chat_id: chatId });
const getMe = () => callApi('getMe', {});

/* ------------------------------------------------------------------ */
/*  Plantillas de mensajes                                             */
/* ------------------------------------------------------------------ */

const buildReminderMessage = (reminder, now = new Date()) => {
  const scheduledAt = new Date(reminder.scheduled_at);
  const lines = [
    `🔔 <b>${escapeHtml(reminder.title)}</b>`,
    '',
    `📅 ${formatDisplay(scheduledAt)} <i>(${escapeHtml(TZ_LABEL)})</i>`,
  ];

  if (reminder.description && reminder.description.trim()) {
    let desc = reminder.description.trim();
    if (desc.length > MAX_DESCRIPTION_CHARS) desc = `${desc.slice(0, MAX_DESCRIPTION_CHARS)}…`;
    lines.push(`📝 ${escapeHtml(desc)}`);
  }

  const lateMs = now.getTime() - scheduledAt.getTime();
  if (lateMs > LATE_THRESHOLD_MS) {
    lines.push('', `⏱️ <i>Enviado con ${Math.round(lateMs / 60000)} min de retraso.</i>`);
  }

  lines.push('', '— <i>RTNote</i>');
  return lines.join('\n');
};

const buildTestMessage = (username, now = new Date()) =>
  [
    '✅ <b>¡Conexión exitosa con RTNote!</b>',
    '',
    `👤 Usuario: <code>${escapeHtml(username)}</code>`,
    `🕒 ${formatDisplay(now)} <i>(${escapeHtml(TZ_LABEL)})</i>`,
    '',
    'A partir de ahora recibirás aquí tus recordatorios 🔔',
  ].join('\n');

module.exports = {
  TelegramError,
  isConfigured,
  sendMessage,
  getChat,
  getMe,
  escapeHtml,
  buildReminderMessage,
  buildTestMessage,
};
