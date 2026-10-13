'use strict';

const env = require('../config/env');
const { HttpError } = require('../utils/http');

const notFound = (req, _res, next) => {
  next(new HttpError(404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, _req, res, _next) => {
  // JSON mal formado enviado por el cliente
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido en el cuerpo de la petición' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Cuerpo de la petición demasiado grande' });
  }

  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  // Error no controlado: se registra completo pero no se filtra al cliente.
  console.error('[error]', err);
  return res.status(500).json({
    error: 'Error interno del servidor',
    ...(env.isProduction ? {} : { debug: err.message }),
  });
};

module.exports = { notFound, errorHandler };
