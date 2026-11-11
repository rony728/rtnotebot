'use strict';

const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../middlewares/auth');
const { HttpError, asyncHandler } = require('../utils/http');
const telegram = require('../services/telegramService');

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
// chat_id de Telegram: entero (negativo para grupos/canales), máx. ~15 dígitos
const CHAT_ID_RE = /^-?\d{1,15}$/;

// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe
// (mitiga enumeración de usuarios por timing).
const DUMMY_HASH = bcrypt.hashSync('rtnote-dummy-password', BCRYPT_ROUNDS);

const USER_PUBLIC_COLUMNS = 'id, username, telegram_chat_id, created_at';

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
  const { rows: countRows } = await db.query('SELECT 1 FROM users LIMIT 1');
  if (countRows.length > 0 && !req.user) {
    throw new HttpError(401, 'Token de autenticación requerido');
  }

  const { username, password, errors } = validateCredentials(req.body || {});
  if (errors.length) throw new HttpError(400, 'Datos inválidos', errors);

  const chatId = parseChatId(req.body.telegram_chat_id) ?? null;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, telegram_chat_id)
       VALUES ($1, $2, $3)
       RETURNING ${USER_PUBLIC_COLUMNS}`,
      [username, passwordHash, chatId]
    );
    const user = toPublicUser(rows[0]);
    return res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'El nombre de usuario ya está en uso');
    throw err;
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

  const user = toPublicUser(row);
  return res.json({ token: signToken(user), user });
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

module.exports = {
  register,
  login,
  profile,
  linkTelegram,
  unlinkTelegram,
  testTelegram,
  telegramStatus,
};
