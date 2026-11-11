'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../controllers/authController');
const { requireAuth, optionalAuth, requireAdmin } = require('../middlewares/auth');

const router = Router();

// Limita intentos de login/registro público para frenar fuerza bruta
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.' },
});

router.post('/register', credentialsLimiter, optionalAuth, auth.register);
router.post('/login', credentialsLimiter, auth.login);
router.post('/logout', auth.logout);

router.get('/profile', requireAuth, auth.profile);
router.get('/admin/users', requireAuth, requireAdmin, auth.listUsers);
router.patch('/admin/users/:id', requireAuth, requireAdmin, auth.updateUser);
router.patch('/admin/users/:id/approval', requireAuth, requireAdmin, auth.setUserApproval);
router.put('/admin/users/:id/password', requireAuth, requireAdmin, auth.resetUserPassword);
router.get('/telegram/status', requireAuth, auth.telegramStatus);
router.put('/telegram', requireAuth, auth.linkTelegram);
router.delete('/telegram', requireAuth, auth.unlinkTelegram);

// Evita usar el endpoint de prueba para hacer spam a través del bot
const testTelegramLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: 'Demasiadas pruebas de Telegram. Espera unos minutos.' },
});
router.post('/test-telegram', requireAuth, testTelegramLimiter, auth.testTelegram);

module.exports = router;
