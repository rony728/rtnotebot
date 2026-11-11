'use strict';

const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken, setAuthCookie, clearAuthCookie } = require('../middlewares/auth');
const { HttpError, asyncHandler } = require('../utils/http');
const telegram = require('../services/telegramService');

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
// chat_id de Telegram: entero (negativo para grupos/canales), máx. ~15 dígitos
const CHAT_ID_RE = /^-?\d{1,15}$/;

// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe
// (mitiga enumeración de usuarios por timing).
const DUMMY_HASH = bcrypt.hashSync('rtnote-dummy-password', BCRYPT_ROUNDS);

const USER_PUBLIC_COLUMNS = 'id, username, telegram_chat_id, role, approval_status, is_active, created_at';

/* ------------------------------------------------------------------ */
/*  Validaciones                                                       */
/* ------------------------------------------------------------------ */

const validateCredentials = (body) => {
  const errors = [];
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    errors.push('username debe tener 3-32 caracteres: letras, números, "_", "." o "-"');
  }
  if (password.length < 8 || password.length > 72) {
    // bcrypt solo usa los primeros 72 bytes
    errors.push('password debe tener entre 8 y 72 caracteres');
  }
  return { username, password, errors };
};

/**
 * Normaliza un chat_id. Devuelve:
 *  - undefined si no se envió
 *  - null si se envió vacío/null (desvincular)
 *  - string numérico si es válido
 * Lanza HttpError(400) si el formato es inválido.
 */
const parseChatId = (raw) => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (!CHAT_ID_RE.test(value)) {
    throw new HttpError(400, 'telegram_chat_id debe ser un número entero válido');
  }
  return value;
};

const toPublicUser = (row) => ({
  id: row.id,
  username: row.username,
  // pg devuelve BIGINT como string: se mantiene así para no perder precisión
  telegram_chat_id: row.telegram_chat_id,
  telegram_linked: row.telegram_chat_id !== null,
  role: row.role || 'user',
  approval_status: row.approval_status || 'approved',
  is_active: row.is_active !== false,
  created_at: row.created_at,
});

/* ------------------------------------------------------------------ */
/*  Controladores                                                      */
/* ------------------------------------------------------------------ */

/**
 * POST /api/auth/register
 * Body: { username, password, telegram_chat_id? }
 */
const register = asyncHandler(async (req, res) => {
  const { username, password, errors } = validateCredentials(req.body || {});
  if (errors.length) throw new HttpError(400, 'Datos inválidos', errors);

  const chatId = parseChatId(req.body.telegram_chat_id) ?? null;
  if (req.user && req.user.role !== 'admin') {
    throw new HttpError(403, 'Solo un administrador puede crear cuentas directamente');
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    // Serializa el bootstrap entre procesos/instancias. La comprobación decisiva
    // ocurre dentro de la misma transacción protegida por el advisory lock.
    await client.query('SELECT pg_advisory_xact_lock(7319, 1)');

    const { rows: countRows } = await client.query('SELECT 1 FROM users LIMIT 1');
    if (countRows.length > 0 && !req.user) {
      throw new HttpError(401, 'Token de autenticación requerido');
    }

    // La primera cuenta del sistema se convierte en administradora y queda
    // aprobada para permitir el bootstrap en instalaciones nuevas.
    const isBootstrap = countRows.length === 0;
    const isAdminCreation = req.user?.role === 'admin';
    const role = isBootstrap ? 'admin' : 'user';
    const approvalStatus = (isBootstrap || isAdminCreation) ? 'approved' : 'pending';
    const { rows } = await client.query(
      `INSERT INTO users (username, password_hash, telegram_chat_id, role, approval_status, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING ${USER_PUBLIC_COLUMNS}`,
      [username, passwordHash, chatId, role, approvalStatus]
    );
    await client.query('COMMIT');

    const user = toPublicUser(rows[0]);
    // Solo el bootstrap inicial inicia sesión automáticamente.
    if (isBootstrap) setAuthCookie(res, signToken(user));
    if (approvalStatus === 'pending') {
      return res.status(202).json({
        message: 'Solicitud recibida. Tu cuenta está pendiente de aprobación por un administrador.',
        status: 'pending',
      });
    }
    return res.status(201).json({ user, message: isAdminCreation ? 'Usuario creado y aprobado' : 'Cuenta inicial creada' });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[auth] No se pudo revertir el registro:', rollbackError.message);
    }
    if (err.code === '23505') throw new HttpError(409, 'El nombre de usuario ya está en uso');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
const login = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    throw new HttpError(400, 'username y password son obligatorios');
  }

  const { rows } = await db.query(
    `SELECT ${USER_PUBLIC_COLUMNS}, password_hash
       FROM users
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1`,
    [username]
  );

  const row = rows[0];
  const valid = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);

  if (!row || !valid) {
    // Mensaje genérico: no revela si el usuario existe
    throw new HttpError(401, 'Credenciales inválidas');
  }
  if (!row.is_active || row.approval_status !== 'approved') {
    throw new HttpError(403, 'Tu cuenta todavía no está habilitada. Contacta al administrador.');
  }

  const user = toPublicUser(row);
  setAuthCookie(res, signToken(user));
  return res.json({ user });
});

/** POST /api/auth/logout: elimina la cookie de sesión. */
const logout = asyncHandler(async (_req, res) => {
  clearAuthCookie(res);
  return res.json({ message: 'Sesión cerrada correctamente' });
});

/**
 * GET /api/auth/profile  (protegido)
 */
const profile = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${USER_PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  return res.json({ user: toPublicUser(rows[0]) });
});

/**
 * PUT /api/auth/telegram  (protegido)
 * Body: { telegram_chat_id }
 * Vincula o actualiza el chat de Telegram al que @rtnotebot enviará los avisos.
 * Si el bot está configurado, verifica con getChat que el chat existe y que el usuario
 * ya inició conversación con el bot (/start).
 */
const linkTelegram = asyncHandler(async (req, res) => {
  const chatId = parseChatId((req.body || {}).telegram_chat_id);
  if (!chatId) throw new HttpError(400, 'telegram_chat_id es obligatorio');

  let verified = false;
  let warning;
  if (telegram.isConfigured()) {
    try {
      await telegram.getChat(chatId);
      verified = true;
    } catch (err) {
      if (err instanceof telegram.TelegramError && !err.retryable) {
        throw new HttpError(
          400,
          'Telegram no reconoce ese chat_id. Abre @rtnotebot, envía /start y vuelve a intentarlo.',
          [err.description]
        );
      }
      // Fallo transitorio de Telegram: se guarda igualmente, sin verificar
      warning = 'No se pudo verificar con Telegram en este momento; usa la prueba de envío.';
    }
  } else {
    warning = 'El bot no está configurado en el servidor; el chat_id no se verificó.';
  }

  const { rows } = await db.query(
    `UPDATE users SET telegram_chat_id = $1
      WHERE id = $2
      RETURNING ${USER_PUBLIC_COLUMNS}`,
    [chatId, req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  return res.json({
    message: 'Telegram vinculado correctamente',
    verified,
    ...(warning ? { warning } : {}),
    user: toPublicUser(rows[0]),
  });
});

/**
 * DELETE /api/auth/telegram  (protegido)
 * Desvincula el chat de Telegram del usuario.
 */
const unlinkTelegram = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE users SET telegram_chat_id = NULL
      WHERE id = $1
      RETURNING ${USER_PUBLIC_COLUMNS}`,
    [req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  return res.json({ message: 'Telegram desvinculado', user: toPublicUser(rows[0]) });
});

/**
 * POST /api/auth/test-telegram  (protegido)
 * Envía un mensaje de prueba al chat vinculado para comprobar la comunicación.
 */
const testTelegram = asyncHandler(async (req, res) => {
  if (!telegram.isConfigured()) {
    throw new HttpError(503, 'El bot de Telegram no está configurado en el servidor');
  }

  const { rows } = await db.query('SELECT username, telegram_chat_id FROM users WHERE id = $1', [
    req.user.id,
  ]);
  const user = rows[0];
  if (!user) throw new HttpError(404, 'Usuario no encontrado');
  if (!user.telegram_chat_id) {
    throw new HttpError(400, 'Primero vincula tu chat de Telegram (PUT /api/auth/telegram)');
  }

  try {
    const result = await telegram.sendMessage(
      user.telegram_chat_id,
      telegram.buildTestMessage(user.username)
    );
    return res.json({ message: 'Mensaje de prueba enviado', telegram_message_id: result.message_id });
  } catch (err) {
    if (err instanceof telegram.TelegramError && !err.retryable) {
      throw new HttpError(
        422,
        'Telegram rechazó el mensaje. ¿Bloqueaste el bot o el chat_id es incorrecto?',
        [err.description]
      );
    }
    throw new HttpError(502, 'Telegram no está disponible en este momento. Intenta más tarde.');
  }
});

/**
 * GET /api/auth/telegram/status  (protegido)
 * Estado de la integración: bot configurado/accesible, username del bot y vinculación del usuario.
 */
let cachedBot = null;
const telegramStatus = asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT telegram_chat_id FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');

  const status = {
    bot_configured: telegram.isConfigured(),
    bot_reachable: false,
    bot_username: cachedBot?.username ?? null,
    linked: rows[0].telegram_chat_id !== null,
    telegram_chat_id: rows[0].telegram_chat_id,
  };

  if (status.bot_configured) {
    try {
      cachedBot = await telegram.getMe();
      status.bot_reachable = true;
      status.bot_username = cachedBot.username;
    } catch {
      /* bot_reachable = false */
    }
  }
  return res.json(status);
});

const listUsers = asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const allowed = ['pending', 'approved', 'rejected'];
  if (status && !allowed.includes(status)) throw new HttpError(400, 'Filtro de estado inválido');
  const { rows } = await db.query(
    `SELECT id, username, role, approval_status, is_active, telegram_chat_id, created_at
       FROM users
      WHERE ($1::text IS NULL OR approval_status = $1)
      ORDER BY CASE approval_status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
    [status]
  );
  return res.json({ users: rows.map(toPublicUser) });
});

const updateUser = asyncHandler(async (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, 'ID de usuario inválido');
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : undefined;
  const role = req.body?.role;
  const isActive = req.body?.is_active;
  if (username !== undefined && !USERNAME_RE.test(username)) throw new HttpError(400, 'Nombre de usuario inválido');
  if (role !== undefined && !['admin', 'user'].includes(role)) throw new HttpError(400, 'Rol inválido');
  if (isActive !== undefined && typeof isActive !== 'boolean') throw new HttpError(400, 'is_active debe ser booleano');
  if (userId === req.user.id && (role === 'user' || isActive === false)) {
    throw new HttpError(400, 'No puedes quitarte tus propios permisos ni desactivar tu cuenta');
  }
  if (role === 'user' || isActive === false) {
    const { rows: targetRows } = await db.query('SELECT role, is_active FROM users WHERE id = $1', [userId]);
    if (targetRows[0]?.role === 'admin' && targetRows[0]?.is_active) {
      const { rows: admins } = await db.query("SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin' AND is_active = TRUE AND approval_status = 'approved'");
      if (admins[0].total <= 1) throw new HttpError(409, 'No puedes desactivar o degradar al último administrador activo');
    }
  }
  if (username === undefined && role === undefined && isActive === undefined) throw new HttpError(400, 'No hay cambios para guardar');
  try {
    const { rows } = await db.query(
      `UPDATE users SET
         username = COALESCE($1, username),
         role = COALESCE($2, role),
         is_active = COALESCE($3, is_active),
         updated_at = NOW()
       WHERE id = $4
       RETURNING ${USER_PUBLIC_COLUMNS}`,
      [username ?? null, role ?? null, isActive ?? null, userId]
    );
    if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
    return res.json({ message: 'Usuario actualizado', user: toPublicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'El nombre de usuario ya está en uso');
    throw err;
  }
});

const resetUserPassword = asyncHandler(async (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, 'ID de usuario inválido');
  if (password.length < 8 || password.length > 72) throw new HttpError(400, 'La contraseña debe tener entre 8 y 72 caracteres');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rowCount } = await db.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [passwordHash, userId]
  );
  if (!rowCount) throw new HttpError(404, 'Usuario no encontrado');
  return res.json({ message: 'Contraseña actualizada' });
});

const setUserApproval = asyncHandler(async (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  const status = req.body?.approval_status;
  if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, 'ID de usuario inválido');
  if (!['approved', 'rejected'].includes(status)) {
    throw new HttpError(400, 'approval_status debe ser approved o rejected');
  }
  if (userId === req.user.id && status !== 'approved') {
    throw new HttpError(400, 'No puedes rechazar tu propia cuenta administradora');
  }
  const { rows } = await db.query(
    `UPDATE users SET approval_status = $1, is_active = CASE WHEN $1 = 'approved' THEN TRUE ELSE is_active END, updated_at = NOW()
      WHERE id = $2
      RETURNING ${USER_PUBLIC_COLUMNS}`,
    [status, userId]
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  return res.json({ message: status === 'approved' ? 'Cuenta aprobada' : 'Solicitud rechazada', user: toPublicUser(rows[0]) });
});

module.exports = {
  register,
  login,
  logout,
  profile,
  linkTelegram,
  unlinkTelegram,
  testTelegram,
  telegramStatus,
  listUsers,
  setUserApproval,
  updateUser,
  resetUserPassword,
};
