'use strict';

/**
 * RTNote API - PM2 Ecosystem Configuration
 * Configuración optimizada para producción en Ubuntu Server.
 *
 * Uso:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production
 */

module.exports = {
  apps: [
    {
      name: 'rtnote-api',
      script: 'src/index.js',
      cwd: __dirname,

      // Modo de ejecución:
      // 'fork' con 1 instancia es el modo recomendado y más ligero para servidores con cron interno.
      // (Nota: el scheduler usa FOR UPDATE SKIP LOCKED, por lo que también tolera modo 'cluster').
      exec_mode: 'fork',
      instances: 1,

      // Manejo de reinicios automáticos y límites de recursos
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 4000,
      max_memory_restart: '300M',

      // Apagado ordenado (graceful shutdown)
      kill_timeout: 5000,
      listen_timeout: 8000,

      // Logs centralizados con estampas de tiempo
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Variables de entorno
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
