'use strict';

const { Router } = require('express');
const db = require('../config/db');
const authRoutes = require('./authRoutes');
const reminderRoutes = require('./reminderRoutes');

const router = Router();

// Health check (útil para PM2 / Cloudflare / monitoreo)
router.get('/health', async (_req, res) => {
  try {
    await db.testConnection();
    res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down', time: new Date().toISOString() });
  }
});

router.use('/auth', authRoutes);
router.use('/reminders', reminderRoutes);

module.exports = router;
