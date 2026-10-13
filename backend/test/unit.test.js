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
const { parseDateInput, formatDisplay, toLocalISO, getOffsetMinutes } = require('../src/utils/time');
const { buildReminderMessage, escapeHtml } = require('../src/services/telegramService');
const { backoffSeconds } = require('../src/services/scheduler');

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
