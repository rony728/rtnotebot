'use strict';

const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
  // Zona horaria de sesión: afecta a la representación/casts en SQL, no al instante almacenado
  options: `-c timezone=${env.timezone}`,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Errores en clientes inactivos: se registran sin tumbar el proceso.
  console.error('[db] Error inesperado en cliente inactivo:', err.message);
});

/**
 * Ejecuta una consulta parametrizada (siempre usar $1, $2... para evitar SQL injection).
 */
const query = (text, params) => pool.query(text, params);

/**
 * Obtiene un cliente dedicado para transacciones. Recuerda llamar client.release().
 */
const getClient = () => pool.connect();

const testConnection = async () => {
  const { rows } = await pool.query('SELECT NOW() AS now');
  return rows[0].now;
};

const close = () => pool.end();

module.exports = { pool, query, getClient, testConnection, close };
