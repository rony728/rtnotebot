'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');
const { HttpError } = require('../utils/http');

const AUTH_COOKIE = 'rtnote_session';

const getCookieToken = (header = '') => {
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== AUTH_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

const setAuthCookie = (res, token) => {
  const payload = jwt.decode(token);
  const maxAge = payload?.exp ? Math.max(0, payload.exp * 1000 - Date.now()) : undefined;
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  });
};

const clearAuthCookie = (res) => {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
  });
};

/**
 * Genera un JWT firmado para el usuario.
 */
const signToken = (user) =>
  jwt.sign({ username: user.username }, env.jwt.secret, {
    subject: String(user.id),
    expiresIn: env.jwt.expiresIn,
    issuer: env.jwt.issuer,
    algorithm: 'HS256',
  });

/**
 * Acepta sesión HttpOnly y mantiene Bearer temporalmente por compatibilidad.
 * Si es correcto, expone req.user = { id, username }.
 */
const requireAuth = async (req, _res, next) => {
  const cookieToken = getCookieToken(req.headers.cookie);
  const header = req.headers.authorization || '';
  const [scheme, bearerToken] = header.split(' ');
  const token = cookieToken || (scheme === 'Bearer' ? bearerToken : null);

  if (!token) return next(new HttpError(401, 'Token de autenticación requerido'));

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret, {
      algorithms: ['HS256'],
      issuer: env.jwt.issuer,
    });
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido';
    return next(new HttpError(401, message));
  }

  const id = Number.parseInt(payload.sub, 10);
  if (!Number.isInteger(id)) return next(new HttpError(401, 'Token inválido'));

  try {
    // La sesión se contrasta con PostgreSQL en cada petición para aplicar
    // inmediatamente desactivaciones, rechazos y cambios de rol.
    const { rows } = await db.query(
      `SELECT id, username, role, approval_status, is_active
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [id]
    );
    const account = rows[0];
    if (!account || !account.is_active || account.approval_status !== 'approved') {
      return next(new HttpError(401, 'Cuenta no disponible. Contacta al administrador.'));
    }

    req.user = {
      id: account.id,
      username: account.username,
      role: account.role,
      approval_status: account.approval_status,
    };
    return next();
  } catch (err) {
    return next(err);
  }
};

const optionalAuth = (req, res, next) => {
  const hasCookie = Boolean(getCookieToken(req.headers.cookie));
  const hasBearer = /^Bearer\s+/.test(req.headers.authorization || '');
  if (!hasCookie && !hasBearer) return next();
  return requireAuth(req, res, next);
};

const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Autenticación requerida'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Se requieren permisos de administrador'));
  return next();
};

/**
 * Middleware para registro:
 * Permite continuar sin sesión cuando no hay cookie/token y validar opcionalmente una sesión existente.
 */
const allowBootstrapOrAuth = async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT 1 FROM users LIMIT 1');
    if (!rows.length) {
      return next();
    }
    return requireAuth(req, res, next);
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  AUTH_COOKIE,
  signToken,
  getCookieToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  optionalAuth,
  requireAdmin,
  allowBootstrapOrAuth,
};
