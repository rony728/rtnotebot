'use strict';

/**
 * Error HTTP controlado: su mensaje sí se expone al cliente.
 */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details) this.details = details;
  }
}

/**
 * Envuelve handlers async para que Express 4 capture los rechazos de promesas.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { HttpError, asyncHandler };
