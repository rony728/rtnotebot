'use strict';

const env = require('./config/env'); // valida variables antes que nada
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const db = require('./config/db');
const apiRoutes = require('./routes');
const scheduler = require('./services/scheduler');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { csrfProtection } = require('./middlewares/csrf');

const app = express();

// Detrás de Cloudflare Tunnel: confiar en el primer proxy para obtener la IP real
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

// CORS: solo orígenes listados en CORS_ORIGINS (se endurecerá en la Etapa 4)
app.use(
  cors({
    origin(origin, callback) {
      // Peticiones sin Origin (curl, Postman, server-to-server) se permiten
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      // En desarrollo, permitir localhost y 127.0.0.1 en cualquier puerto
      if (!env.isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-RTNote-Request'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '10kb' }));

app.get('/', (_req, res) => res.json({ name: 'RTNote API', status: 'running' }));
app.use('/api', csrfProtection, apiRoutes);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(env.port, async () => {
  console.log(`[server] RTNote API escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
  try {
    const now = await db.testConnection();
    console.log(`[db] Conexión a PostgreSQL OK (${now.toISOString()})`);
  } catch (err) {
    console.error(`[db] No se pudo conectar a PostgreSQL: ${err.message}`);
  }
  scheduler.start();
});

// Apagado ordenado (PM2 envía SIGINT; systemd/docker SIGTERM)
const shutdown = (signal) => {
  console.log(`[server] ${signal} recibido, cerrando...`);
  scheduler.stop();
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[process] Promesa rechazada sin manejar:', reason);
});

module.exports = app;
