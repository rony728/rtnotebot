'use strict';

/**
 * Utilidades de fecha/hora para la zona horaria de negocio
 * (por defecto America/Tegucigalpa, UTC-6, sin horario de verano).
 *
 * Regla de oro: en BD y en memoria todo es un instante absoluto (Date / TIMESTAMPTZ).
 * La zona horaria solo interviene al INTERPRETAR entradas sin offset y al MOSTRAR.
 */

const env = require('../config/env');

const TZ = env.timezone;

try {
  new Intl.DateTimeFormat('en-US', { timeZone: TZ });
} catch {
  console.error(`[config] APP_TIMEZONE inválida: "${TZ}"`);
  process.exit(1);
}

const TZ_LABEL = TZ === 'America/Tegucigalpa' ? 'hora de Honduras' : TZ;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const pad = (n, len = 2) => String(n).padStart(len, '0');

/** Componentes de fecha/hora de un instante, vistos en la zona de negocio. */
const getZonedParts = (date) => {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
};

/** Offset (en minutos) de la zona de negocio respecto a UTC en un instante dado. Honduras: -360. */
const getOffsetMinutes = (date) => {
  const p = getZonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
};

/** Convierte una "hora de pared" de la zona de negocio a un instante UTC. */
const zonedTimeToDate = (year, month, day, hour, minute, second = 0) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getOffsetMinutes(new Date(guess));
  let ts = guess - offset1 * 60_000;
  // Segunda pasada por si el offset cambia justo en esa fecha (zonas con DST)
  const offset2 = getOffsetMinutes(new Date(ts));
  if (offset2 !== offset1) ts = guess - offset2 * 60_000;
  return new Date(ts);
};

const WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

/**
 * Interpreta una fecha de entrada del cliente.
 *  - "2026-10-13T08:30:00Z" / "...-06:00" -> se respeta el offset indicado.
 *  - "2026-10-13T08:30" / "2026-10-13 08:30:00" (sin offset) -> hora local de Honduras.
 * Devuelve un Date válido o null si el formato es inválido.
 */
const parseDateInput = (value) => {
  if (typeof value !== 'string') return null;
  const input = value.trim();

  if (WITH_OFFSET_RE.test(input)) {
    const d = new Date(input.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = LOCAL_RE.exec(input);
  if (!m) return null;

  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] ? Number(m[6]) : 0;

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // Valida días inexistentes (p. ej. 31/02)
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  return zonedTimeToDate(year, month, day, hour, minute, second);
};

/** "DD/MM/YYYY hh:mm AM|PM" en la zona de negocio. */
const formatDisplay = (date) => {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const p = getZonedParts(d);
  const h12 = p.hour % 12 || 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(h12)}:${pad(p.minute)} ${ampm}`;
};

/** ISO-8601 con el offset de la zona de negocio, p. ej. "2026-10-13T08:30:00-06:00". */
const toLocalISO = (date) => {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const p = getZonedParts(d);
  const off = getOffsetMinutes(d);
  const sign = off <= 0 ? '-' : '+';
  const abs = Math.abs(off);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${off === 0 ? '+' : sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

module.exports = {
  TZ,
  TZ_LABEL,
  parseDateInput,
  formatDisplay,
  toLocalISO,
  getOffsetMinutes,
  zonedTimeToDate,
};
