'use strict';

const env = require('../config/env');
const { HttpError } = require('../utils/http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const isAllowedOrigin = (origin) =>
  env.corsOrigins.includes(origin) || (!env.isProduction && LOCAL_ORIGIN.test(origin));

const csrfProtection = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  // Los clientes no navegador (curl, Postman, integraciones) pueden no enviar Origin.
  if (!req.headers.origin) return next();

  if (!isAllowedOrigin(req.headers.origin)) {
    return next(new HttpError(403, 'Origen no permitido'));
  }

  if (req.headers['x-rtnote-request'] !== '1') {
    return next(new HttpError(403, 'Solicitud de navegador no válida'));
  }

  return next();
};

module.exports = { csrfProtection, isAllowedOrigin };
