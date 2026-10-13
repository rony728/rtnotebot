'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Carga backend/.env independientemente del directorio desde el que se lance
// (útil con PM2 en Ubuntu y con terminales en Windows).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];

const missing = REQUIRED.filter((key) => !process.env[key] || !process.env[key].trim());
if (missing.length) {
  console.error(`[config] Faltan variables de entorno obligatorias: ${missing.join(', ')}`);
  console.error('[config] Copia backend/.env.example a backend/.env y complétalo.');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  console.error('[config] JWT_SECRET debe tener al menos 32 caracteres.');
  process.exit(1);
}

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: toInt(process.env.PORT, 3000),

  db: Object.freeze({
    host: process.env.DB_HOST,
    port: toInt(process.env.DB_PORT, 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL).toLowerCase() === 'true',
  }),

  jwt: Object.freeze({
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: 'rtnote-api',
  }),

  telegram: Object.freeze({
    botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    timeoutMs: 10_000,
  }),

  // Zona horaria de negocio (Honduras: UTC-6, sin horario de verano)
  timezone: process.env.APP_TIMEZONE || 'America/Tegucigalpa',

  scheduler: Object.freeze({
    enabled: String(process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
    cron: process.env.SCHEDULER_CRON || '* * * * *', // cada minuto
    batchSize: toInt(process.env.SCHEDULER_BATCH_SIZE, 50),
    maxAttempts: toInt(process.env.REMINDER_MAX_ATTEMPTS, 5),
    leaseSeconds: 120,
  }),

  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
});

module.exports = env;
