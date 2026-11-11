'use strict';

/**
 * Lee un booleano opcional de una petición HTTP.
 * Solo acepta booleanos JSON reales; no convierte strings, números ni null.
 */
const readBoolean = (value, field, errors, fallback = false) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(`${field} debe ser booleano (true o false)`);
    return fallback;
  }
  return value;
};

module.exports = { readBoolean };
