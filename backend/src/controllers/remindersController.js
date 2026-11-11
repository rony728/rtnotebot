'use strict';

const db = require('../config/db');
const { HttpError, asyncHandler } = require('../utils/http');
const { readBoolean } = require('../utils/validation');
const { TZ, parseDateInput, formatDisplay, toLocalISO } = require('../utils/time');

const STATUSES = ['pending', 'sent', 'cancelled', 'failed'];
const TITLE_MAX = 150;
const DESCRIPTION_MAX = 2000;
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 años
const MAX_PENDING_PER_USER = 1000;

const COLUMNS = `id, title, description, scheduled_at, status, attempts, last_error,
                 sent_at, notify_30m_before, notify_15m_before, sent_30m_at, sent_15m_at,
                 created_at, updated_at`;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const serialize = (r) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  scheduled_at: r.scheduled_at.toISOString(), // UTC
  scheduled_at_local: toLocalISO(r.scheduled_at), // ISO con -06:00
  scheduled_at_display: formatDisplay(r.scheduled_at), // DD/MM/YYYY hh:mm A
  timezone: TZ,
  attempts: r.attempts,
  last_error: r.last_error,
  sent_at: r.sent_at ? r.sent_at.toISOString() : null,
  sent_at_display: r.sent_at ? formatDisplay(r.sent_at) : null,
  notify_30m_before: Boolean(r.notify_30m_before),
  notify_15m_before: Boolean(r.notify_15m_before),
  sent_30m_at: r.sent_30m_at ? r.sent_30m_at.toISOString() : null,
  sent_15m_at: r.sent_15m_at ? r.sent_15m_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

const parseId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new HttpError(400, 'id de recordatorio inválido');
  }
  return id;
};

const validateTitle = (value, errors) => {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push('title es obligatorio');
    return undefined;
  }
  const title = value.trim();
  if (title.length > TITLE_MAX) errors.push(`title admite máximo ${TITLE_MAX} caracteres`);
  return title;
};

const validateDescription = (value, errors) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push('description debe ser texto');
    return null;
  }
  const desc = value.trim();
  if (desc.length > DESCRIPTION_MAX) {
    errors.push(`description admite máximo ${DESCRIPTION_MAX} caracteres`);
  }
  return desc || null;
};

const validateScheduledAt = (value, errors) => {
  if (value === undefined || value === null || value === '') {
    errors.push('scheduled_at es obligatorio');
    return undefined;
  }
  const date = parseDateInput(value);
  if (!date) {
    errors.push(
      'scheduled_at inválido. Usa ISO-8601, p. ej. "2026-10-13T08:30" (hora de Honduras) ' +
        'o "2026-10-13T14:30:00Z"'
    );
    return undefined;
  }
  const now = Date.now();
  if (date.getTime() <= now) errors.push('scheduled_at debe ser una fecha/hora futura');
  if (date.getTime() - now > MAX_FUTURE_MS) errors.push('scheduled_at no puede superar 5 años');
  return date;
};

/** Distingue 404 (no existe / no es del usuario) de 409 (estado no permite la acción). */
const assertExistsOrConflict = async (id, userId, conflictMessage) => {
  const { rows } = await db.query('SELECT status FROM reminders WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (!rows[0]) throw new HttpError(404, 'Recordatorio no encontrado');
  throw new HttpError(409, conflictMessage(rows[0].status));
};

/* ------------------------------------------------------------------ */
/*  Controladores                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/reminders
 * Query:
 *   view=upcoming  -> solo pendientes (más próximos primero)
 *   view=history   -> enviados, cancelados y fallidos (más recientes primero)
 *   status=pending,sent -> filtro explícito por estado(s)
 *   limit (1-200, def. 100), offset (def. 0)
 */
const list = asyncHandler(async (req, res) => {
  const { view, status } = req.query;
  let statuses = null;

  if (view !== undefined) {
    if (view === 'upcoming') statuses = ['pending'];
    else if (view === 'history') statuses = ['sent', 'cancelled', 'failed'];
    else throw new HttpError(400, 'view debe ser "upcoming" o "history"');
  }

  if (status !== undefined) {
    const requested = String(status)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const invalid = requested.filter((s) => !STATUSES.includes(s));
    if (invalid.length || !requested.length) {
      throw new HttpError(400, `status inválido. Valores permitidos: ${STATUSES.join(', ')}`);
    }
    statuses = statuses ? statuses.filter((s) => requested.includes(s)) : requested;
  }

  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

  const params = [req.user.id];
  let where = 'user_id = $1';
  if (statuses) {
    params.push(statuses);
    where += ` AND status = ANY($${params.length}::text[])`;
  }
  params.push(limit, offset);

  const [listResult, countResult] = await Promise.all([
    db.query(
      `SELECT ${COLUMNS} FROM reminders
        WHERE ${where}
        ORDER BY (status = 'pending') DESC,
                 CASE WHEN status = 'pending' THEN scheduled_at END ASC,
                 scheduled_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    db.query(
      `SELECT status, COUNT(*)::int AS total FROM reminders WHERE user_id = $1 GROUP BY status`,
      [req.user.id]
    ),
  ]);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of countResult.rows) counts[row.status] = row.total;

  res.json({
    timezone: TZ,
    counts,
    pagination: { limit, offset, returned: listResult.rowCount },
    reminders: listResult.rows.map(serialize),
  });
});

/** GET /api/reminders/:id */
const getOne = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM reminders WHERE id = $1 AND user_id = $2`,
    [id, req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Recordatorio no encontrado');
  res.json({ reminder: serialize(rows[0]) });
});

/**
 * POST /api/reminders
 * Body: { title, description?, scheduled_at, notify_30m_before?, notify_15m_before? }
 * scheduled_at sin offset ("2026-10-13T08:30") se interpreta como hora de Honduras.
 */
const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const errors = [];
  const title = validateTitle(body.title, errors);
  const description = validateDescription(body.description, errors);
  const scheduledAt = validateScheduledAt(body.scheduled_at, errors);
  if (errors.length) throw new HttpError(400, 'Datos inválidos', errors);

  const { rows: pending } = await db.query(
    `SELECT COUNT(*)::int AS total FROM reminders WHERE user_id = $1 AND status = 'pending'`,
    [req.user.id]
  );
  if (pending[0].total >= MAX_PENDING_PER_USER) {
    throw new HttpError(429, `Límite de ${MAX_PENDING_PER_USER} recordatorios pendientes alcanzado`);
  }

  const notify30m = readBoolean(body.notify_30m_before, 'notify_30m_before', errors);
  const notify15m = readBoolean(body.notify_15m_before, 'notify_15m_before', errors);
  if (errors.length) throw new HttpError(400, 'Datos inválidos', errors);

  const now = Date.now();
  const diffMs = scheduledAt.getTime() - now;
  // Si al guardar faltan menos de 30 o 15 minutos, marcar automáticamente sent_*_at = NOW() para evitar alertas extemporáneas
  const sent30mAt = notify30m && diffMs < 30 * 60 * 1000 ? new Date() : null;
  const sent15mAt = notify15m && diffMs < 15 * 60 * 1000 ? new Date() : null;

  const { rows } = await db.query(
    `INSERT INTO reminders (user_id, title, description, scheduled_at, notify_30m_before, notify_15m_before, sent_30m_at, sent_15m_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [req.user.id, title, description, scheduledAt, notify30m, notify15m, sent30mAt, sent15mAt]
  );
  res.status(201).json({ reminder: serialize(rows[0]) });
});

/**
 * PUT /api/reminders/:id
 * Body (parcial): { title?, description?, scheduled_at?, notify_30m_before?, notify_15m_before? }
 * Solo permitido si el recordatorio sigue en estado 'pending'.
 */
const update = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const errors = [];
  const sets = [];
  const params = [];

  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  const { rows: existingRows } = await db.query(
    `SELECT scheduled_at, status, notify_30m_before, notify_15m_before, sent_30m_at, sent_15m_at
       FROM reminders
      WHERE id = $1 AND user_id = $2`,
    [id, req.user.id]
  );
  if (!existingRows[0]) {
    throw new HttpError(404, 'Recordatorio no encontrado');
  }
  const current = existingRows[0];
  if (current.status !== 'pending') {
    throw new HttpError(409, `Solo se pueden editar recordatorios pendientes (estado actual: ${current.status})`);
  }

  let newScheduledAt;
  if (body.title !== undefined) add('title', validateTitle(body.title, errors));
  if (body.description !== undefined) {
    add('description', validateDescription(body.description, errors));
  }
  if (body.scheduled_at !== undefined) {
    newScheduledAt = validateScheduledAt(body.scheduled_at, errors);
    add('scheduled_at', newScheduledAt);
    // Reprogramar reinicia el ciclo de reintentos
    sets.push('attempts = 0', 'last_error = NULL', 'locked_until = NULL');
  }

  const effectiveScheduledAt = newScheduledAt || new Date(current.scheduled_at);
  const now = Date.now();
  const diffMs = effectiveScheduledAt.getTime() - now;

  let effectiveNotify30m = current.notify_30m_before;
  let effectiveNotify15m = current.notify_15m_before;

  if (body.notify_30m_before !== undefined) {
    effectiveNotify30m = readBoolean(body.notify_30m_before, 'notify_30m_before', errors);
    add('notify_30m_before', effectiveNotify30m);
  }
  if (body.notify_15m_before !== undefined) {
    effectiveNotify15m = readBoolean(body.notify_15m_before, 'notify_15m_before', errors);
    add('notify_15m_before', effectiveNotify15m);
  }

  // Si se reprograma scheduled_at a una fecha futura lejana, resetear sent_*_at = NULL.
  // Si al guardar faltan menos de 30 o 15 minutos, marcar automáticamente sent_*_at = NOW()
  if (body.scheduled_at !== undefined) {
    const sent30mAt = effectiveNotify30m && diffMs < 30 * 60 * 1000 ? new Date() : null;
    const sent15mAt = effectiveNotify15m && diffMs < 15 * 60 * 1000 ? new Date() : null;
    add('sent_30m_at', sent30mAt);
    add('sent_15m_at', sent15mAt);
  } else {
    if (body.notify_30m_before !== undefined) {
      if (effectiveNotify30m) {
        add('sent_30m_at', diffMs < 30 * 60 * 1000 ? new Date() : null);
      } else {
        add('sent_30m_at', null);
      }
    }
    if (body.notify_15m_before !== undefined) {
      if (effectiveNotify15m) {
        add('sent_15m_at', diffMs < 15 * 60 * 1000 ? new Date() : null);
      } else {
        add('sent_15m_at', null);
      }
    }
  }

  if (!sets.length) {
    throw new HttpError(400, 'Envía al menos uno de: title, description, scheduled_at, notify_30m_before, notify_15m_before');
  }
  if (errors.length) throw new HttpError(400, 'Datos inválidos', errors);

  params.push(id, req.user.id);
  const { rows } = await db.query(
    `UPDATE reminders SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND user_id = $${params.length} AND status = 'pending'
      RETURNING ${COLUMNS}`,
    params
  );

  if (!rows[0]) {
    await assertExistsOrConflict(
      id,
      req.user.id,
      (status) => `Solo se pueden editar recordatorios pendientes (estado actual: ${status})`
    );
  }
  res.json({ reminder: serialize(rows[0]) });
});

/**
 * DELETE /api/reminders/:id
 *   - Por defecto: CANCELA (soft delete) un recordatorio pendiente.
 *   - ?permanent=true: elimina físicamente el registro (cualquier estado).
 */
const remove = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const permanent = String(req.query.permanent).toLowerCase() === 'true';

  if (permanent) {
    const { rowCount } = await db.query('DELETE FROM reminders WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Recordatorio no encontrado');
    return res.json({ message: 'Recordatorio eliminado definitivamente', id });
  }

  const { rows } = await db.query(
    `UPDATE reminders SET status = 'cancelled', locked_until = NULL
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [id, req.user.id]
  );

  if (!rows[0]) {
    await assertExistsOrConflict(
      id,
      req.user.id,
      (status) =>
        `El recordatorio ya no está pendiente (estado: ${status}). ` +
        'Usa ?permanent=true para eliminarlo definitivamente'
    );
  }
  return res.json({ message: 'Recordatorio cancelado', reminder: serialize(rows[0]) });
});

module.exports = { list, getOne, create, update, remove };
