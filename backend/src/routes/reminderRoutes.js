'use strict';

const { Router } = require('express');
const reminders = require('../controllers/remindersController');
const { requireAuth } = require('../middlewares/auth');

const router = Router();

// Todas las rutas de recordatorios requieren JWT
router.use(requireAuth);

router.get('/', reminders.list);
router.get('/:id', reminders.getOne);
router.post('/', reminders.create);
router.put('/:id', reminders.update);
router.delete('/:id', reminders.remove);

module.exports = router;
