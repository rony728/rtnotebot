'use strict';

// Variables mínimas para cargar la configuración sin un .env real
process.env.DB_HOST ??= 'localhost';
process.env.DB_USER ??= 'test';
process.env.DB_PASSWORD ??= 'test';
process.env.DB_NAME ??= 'test';
process.env.JWT_SECRET ??= 'x'.repeat(48);
process.env.APP_TIMEZONE = 'America/Tegucigalpa';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { parseDateInput, formatDisplay, toLocalISO, getOffsetMinutes } = require('../src/utils/time');
const {
  buildReminderMessage,
  buildPreReminderMessage,
  buildPreReminder30Message,
  buildPreReminder15Message,
  escapeHtml,
} = require('../src/services/telegramService');
const { backoffSeconds } = require('../src/services/scheduler');
const { signToken, getCookieToken, requireAuth, allowBootstrapOrAuth } = require('../src/middlewares/auth');
const { csrfProtection } = require('../src/middlewares/csrf');
const db = require('../src/config/db');
const { readBoolean } = require('../src/utils/validation');
const { register } = require('../src/controllers/authController');

test('Honduras es UTC-6 todo el año (sin horario de verano)', () => {
  assert.equal(getOffsetMinutes(new Date('2026-01-15T12:00:00Z')), -360);
  assert.equal(getOffsetMinutes(new Date('2026-07-15T12:00:00Z')), -360);
});

test('fecha sin offset se interpreta como hora local de Honduras', () => {
  assert.equal(parseDateInput('2026-10-13T08:30').toISOString(), '2026-10-13T14:30:00.000Z');
  assert.equal(parseDateInput('2026-10-13 23:15:00').toISOString(), '2026-10-14T05:15:00.000Z');
});

test('fecha con offset/Z respeta el offset indicado', () => {
  assert.equal(parseDateInput('2026-10-13T14:30:00Z').toISOString(), '2026-10-13T14:30:00.000Z');
  assert.equal(
    parseDateInput('2026-10-13T08:30:00-06:00').toISOString(),
    '2026-10-13T14:30:00.000Z'
  );
  assert.equal(
    parseDateInput('2026-10-13T10:30:00-04:00').toISOString(),
    '2026-10-13T14:30:00.000Z'
  );
});

test('fechas inválidas devuelven null', () => {
  for (const bad of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-10-13T24:00', 'mañana', '', 123, null]) {
    assert.equal(parseDateInput(bad), null, `debería rechazar ${bad}`);
  }
});

test('formato de visualización DD/MM/YYYY hh:mm A en hora de Honduras', () => {
  assert.equal(formatDisplay(new Date('2026-10-13T14:30:00Z')), '13/10/2026 08:30 AM');
  assert.equal(formatDisplay(new Date('2026-10-14T05:15:00Z')), '13/10/2026 11:15 PM');
  assert.equal(formatDisplay(new Date('2026-10-13T06:05:00Z')), '13/10/2026 12:05 AM');
  assert.equal(formatDisplay(new Date('2026-10-13T18:00:00Z')), '13/10/2026 12:00 PM');
});

test('toLocalISO incluye offset -06:00', () => {
  assert.equal(toLocalISO(new Date('2026-10-13T14:30:00Z')), '2026-10-13T08:30:00-06:00');
});

test('mensaje de Telegram: iconos, hora de Honduras y HTML escapado', () => {
  const msg = buildReminderMessage(
    {
      title: 'Pagar <luz> & agua',
      description: 'Banco <b>central</b>',
      scheduled_at: new Date('2026-10-13T14:30:00Z'),
    },
    new Date('2026-10-13T14:30:30Z')
  );
  assert.match(msg, /🔔 <b>Pagar &lt;luz&gt; &amp; agua<\/b>/);
  assert.match(msg, /📅 13\/10\/2026 08:30 AM <i>\(hora de Honduras\)<\/i>/);
  assert.match(msg, /📝 Banco &lt;b&gt;central&lt;\/b&gt;/);
  assert.doesNotMatch(msg, /retraso/);
});

test('mensaje de Telegram indica retraso si se envía tarde', () => {
  const msg = buildReminderMessage(
    { title: 'X', scheduled_at: new Date('2026-10-13T14:00:00Z') },
    new Date('2026-10-13T14:30:00Z')
  );
  assert.match(msg, /30 min de retraso/);
  assert.doesNotMatch(msg, /📝/);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('backoff exponencial con tope y retry_after', () => {
  assert.equal(backoffSeconds(1), 60);
  assert.equal(backoffSeconds(2), 120);
  assert.equal(backoffSeconds(3), 240);
  assert.equal(backoffSeconds(20), 3600);
  assert.equal(backoffSeconds(1, 15), 16);
});

test('mensaje de Telegram pre-aviso 30 min: encabezado, hora de Honduras y HTML escapado', () => {
  const msg = buildPreReminder30Message({
    title: 'Reunión con <cliente> & equipo',
    description: 'Sala de juntas <b>piso 2</b>',
    scheduled_at: new Date('2026-10-13T14:30:00Z'), // 08:30 AM en Honduras
  });
  assert.match(msg, /⏳ <b>Faltan 30 minutos para el evento: Reunión con &lt;cliente&gt; &amp; equipo<\/b>/);
  assert.match(msg, /📅 13\/10\/2026 08:30 AM <i>\(hora de Honduras\)<\/i>/);
  assert.match(msg, /📝 Sala de juntas &lt;b&gt;piso 2&lt;\/b&gt;/);
  assert.match(msg, /— <i>RTNote<\/i>/);
  assert.doesNotMatch(msg, /retraso/);
});

test('mensaje de Telegram pre-aviso 15 min: encabezado, hora de Honduras y HTML escapado', () => {
  const msg = buildPreReminder15Message({
    title: 'Webinar de "DevOps" & Cloud',
    scheduled_at: new Date('2026-10-13T15:00:00Z'), // 09:00 AM en Honduras
  });
  assert.match(msg, /⏳ <b>Faltan 15 minutos para el evento: Webinar de &quot;DevOps&quot; &amp; Cloud<\/b>/);
  assert.match(msg, /📅 13\/10\/2026 09:00 AM <i>\(hora de Honduras\)<\/i>/);
  assert.doesNotMatch(msg, /📝/);
  assert.match(msg, /— <i>RTNote<\/i>/);
  assert.doesNotMatch(msg, /retraso/);
});

test('requireAuth: rechaza con 401 si falta token o esquema no es Bearer', () => {
  let calledErr = null;
  requireAuth({ headers: {} }, {}, (err) => {
    calledErr = err;
  });
  assert.equal(calledErr?.status, 401);
  assert.match(calledErr?.message, /Token de autenticación requerido/);

  calledErr = null;
  requireAuth({ headers: { authorization: 'Basic 12345' } }, {}, (err) => {
    calledErr = err;
  });
  assert.equal(calledErr?.status, 401);
});

test('requireAuth: valida token firmado por signToken correctamente', () => {
  const token = signToken({ id: 42, username: 'tester' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalled = false;
  requireAuth(req, {}, (err) => {
    assert.ifError(err);
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 42, username: 'tester' });
});



test('getCookieToken: extrae la cookie de sesión sin confundir otras cookies', () => {
  const token = signToken({ id: 42, username: 'tester' });
  assert.equal(getCookieToken(`theme=dark; rtnote_session=${encodeURIComponent(token)}; lang=es`), token);
  assert.equal(getCookieToken('rtnote_session_extra=abc; theme=dark'), null);
  assert.equal(getCookieToken('rtnote_session=%E0%A4%A'), null);
});

test('requireAuth: valida JWT desde cookie HttpOnly', () => {
  const token = signToken({ id: 43, username: 'cookie_user' });
  const req = { headers: { cookie: `rtnote_session=${encodeURIComponent(token)}` } };
  let nextCalled = false;
  requireAuth(req, {}, (err) => {
    assert.ifError(err);
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 43, username: 'cookie_user' });
});

test('csrfProtection: permite métodos seguros y clientes sin Origin', () => {
  for (const req of [
    { method: 'GET', headers: { origin: 'https://evil.example' } },
    { method: 'POST', headers: {} },
  ]) {
    let called = false;
    csrfProtection(req, {}, (err) => { assert.ifError(err); called = true; });
    assert.equal(called, true);
  }
});

test('csrfProtection: exige origen permitido y cabecera personalizada en mutaciones del navegador', () => {
  const cases = [
    [{ method: 'POST', headers: { origin: 'https://evil.example', 'x-rtnote-request': '1' } }, 403],
    [{ method: 'POST', headers: { origin: 'http://localhost:5500' } }, 403],
    [{ method: 'POST', headers: { origin: 'http://localhost:5500', 'x-rtnote-request': '1' } }, null],
  ];
  for (const [req, expectedStatus] of cases) {
    let calledErr = null;
    csrfProtection(req, {}, (err) => { calledErr = err || null; });
    assert.equal(calledErr?.status ?? null, expectedStatus);
  }
});

test('allowBootstrapOrAuth: permite bootstrap si hay 0 usuarios', async () => {
  const origQuery = db.query;
  db.query = async (sql) => {
    if (sql.includes('FROM users')) return { rows: [] };
    return origQuery(sql);
  };

  try {
    const req = { headers: {} };
    let nextCalled = false;
    await allowBootstrapOrAuth(req, {}, (err) => {
      assert.ifError(err);
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  } finally {
    db.query = origQuery;
  }
});

test('allowBootstrapOrAuth: exige JWT y rechaza 401 si ya existe al menos 1 usuario y no está autenticado', async () => {
  const origQuery = db.query;
  db.query = async (sql) => {
    if (sql.includes('FROM users')) return { rows: [{ '1': 1 }] };
    return origQuery(sql);
  };

  try {
    const req = { headers: {} };
    let calledErr = null;
    await allowBootstrapOrAuth(req, {}, (err) => {
      calledErr = err;
    });
    assert.equal(calledErr?.status, 401);
  } finally {
    db.query = origQuery;
  }
});

test('allowBootstrapOrAuth: permite registro autenticado si ya existen usuarios', async () => {
  const origQuery = db.query;
  db.query = async (sql) => {
    if (sql.includes('FROM users')) return { rows: [{ '1': 1 }] };
    return origQuery(sql);
  };

  try {
    const token = signToken({ id: 1, username: 'admin' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    let nextCalled = false;
    await allowBootstrapOrAuth(req, {}, (err) => {
      assert.ifError(err);
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.deepEqual(req.user, { id: 1, username: 'admin' });
  } finally {
    db.query = origQuery;
  }
});


test('readBoolean: acepta booleanos JSON y aplica el valor predeterminado', () => {
  const errors = [];
  assert.equal(readBoolean(true, 'flag', errors), true);
  assert.equal(readBoolean(false, 'flag', errors), false);
  assert.equal(readBoolean(undefined, 'flag', errors), false);
  assert.equal(readBoolean(undefined, 'flag', errors, true), true);
  assert.deepEqual(errors, []);
});

test('readBoolean: rechaza strings, números y null sin convertirlos', () => {
  for (const value of ['false', 'true', 0, 1, null, '', '0']) {
    const errors = [];
    assert.equal(readBoolean(value, 'notify_30m_before', errors), false);
    assert.deepEqual(errors, ['notify_30m_before debe ser booleano (true o false)']);
  }
});



test('register: crear un usuario desde sesión autenticada no reemplaza la cookie actual', async () => {
  const originalGetClient = db.getClient;
  let cookieSet = false;
  db.getClient = async () => ({
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM users')) return { rows: [{ '1': 1 }] };
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: 99, username: params[0], telegram_chat_id: null, created_at: new Date() }] };
      }
      throw new Error(`Consulta inesperada en prueba: ${sql}`);
    },
    release() {},
  });

  const req = {
    user: { id: 7, username: 'admin' },
    body: { username: 'nuevo_usuario', password: 'password-seguro-123' },
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    cookie() { cookieSet = true; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  try {
    await new Promise((resolve, reject) => {
      res.json = (payload) => { res.payload = payload; resolve(); return res; };
      register(req, res, reject);
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.user.username, 'nuevo_usuario');
    assert.equal(cookieSet, false);
    assert.equal(Object.hasOwn(res.payload, 'token'), false);
  } finally {
    db.getClient = originalGetClient;
  }
});

test('register: serializa el bootstrap y solo permite crear el primer usuario anónimo', async () => {
  const originalGetClient = db.getClient;
  const users = [];
  let lockTail = Promise.resolve();
  let nextId = 1;

  db.getClient = async () => {
    let releaseLock = null;
    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql !== 'BEGIN' && releaseLock) {
            releaseLock();
            releaseLock = null;
          }
          return { rows: [] };
        }
        if (sql.includes('pg_advisory_xact_lock')) {
          const previous = lockTail;
          let unlock;
          lockTail = new Promise((resolve) => { unlock = resolve; });
          await previous;
          releaseLock = unlock;
          return { rows: [] };
        }
        if (sql.includes('SELECT 1 FROM users')) {
          return { rows: users.length ? [{ '1': 1 }] : [] };
        }
        if (sql.includes('INSERT INTO users')) {
          const row = {
            id: nextId++,
            username: params[0],
            telegram_chat_id: params[2],
            created_at: new Date(),
          };
          users.push(row);
          return { rows: [row] };
        }
        throw new Error(`Consulta inesperada en prueba: ${sql}`);
      },
      release() {},
    };
  };

  const invoke = (username) => new Promise((resolve) => {
    const req = { body: { username, password: 'password-seguro-123' } };
    const res = {
      status(code) { this.statusCode = code; return this; },
      cookie(name, value, options) { this.cookieData = { name, value, options }; return this; },
      json(payload) { resolve({ status: this.statusCode || 200, payload, cookie: this.cookieData }); },
    };
    register(req, res, (error) => resolve({ error }));
  });

  try {
    const results = await Promise.all([invoke('primer_usuario'), invoke('segundo_usuario')]);
    assert.equal(users.length, 1);
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    const created = results.find((result) => result.status === 201);
    assert.equal(created.cookie?.name, 'rtnote_session');
    assert.equal(created.cookie?.options.httpOnly, true);
    assert.equal(Object.hasOwn(created.payload, 'token'), false);
    const rejected = results.find((result) => result.error);
    assert.equal(rejected?.error.status, 401);
    assert.match(rejected?.error.message || '', /Token de autenticación requerido/);
  } finally {
    db.getClient = originalGetClient;
  }
});
