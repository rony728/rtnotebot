'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');
const { HttpError } = require('../utils/http');

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
 * Middleware: exige "Authorization: Bearer <token>" válido.
 * Si es correcto, expone req.user = { id, username }.
 */
const requireAuth = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Token de autenticación requerido'));
  }

  try {
    const payload = jwt.verify(token, env.jwt.secret, {
      algorithms: ['HS256'], // evita ataques de "alg: none" / confusión de algoritmo
      issuer: env.jwt.issuer,
    });

    const id = Number.parseInt(payload.sub, 10);
    if (!Number.isInteger(id)) throw new Error('sub inválido');

    req.user = { id, username: payload.username };
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido';
    return next(new HttpError(401, message));
  }
};

/**
 * Middleware para registro:
 * Si la tabla users tiene 0 usuarios, permite bootstrap inicial sin token.
 * Si ya existe al menos 1 usuario, exige obligatoriamente un JWT válido de sesión activa (401 si no está autenticado).
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

module.exports = { signToken, requireAuth, allowBootstrapOrAuth };
