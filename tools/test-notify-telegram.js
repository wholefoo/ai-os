// lib/notify/telegram.js — Telegram alerts actually go out, as plain text, and delivery is reported from
// Telegram's own answer. Until 2026-11-07 sendNotification() never reached Telegram on prod (its switch
// started off at every boot), and when it did send, parse_mode Markdown let an underscore in an email or
// a Stripe id get the alert rejected while the log said "sent". The end-to-end proof (a booted server
// delivering an alert and the Settings Test button sending) is in tools/test-audit-smoke.js.
const { assert, done } = require('./test-util');
const T = require('../lib/notify/telegram');
require('./test-util').requireFinish();

(async () => {
  // ---- ready
  assert(T.telegramReady({ token: '1:abc', chatId: '42' }), 'a token and a chat id -> ready');
  assert(!T.telegramReady({ token: '1:abc', chatId: '' }) && !T.telegramReady({ token: ' ', chatId: '42' }) && !T.telegramReady(null) && !T.telegramReady({}),
    'a missing or blank token or chat id -> not ready (nothing is sent)');

  // ---- the text: PLAIN, so nothing in it can be read as markup
  const t = T.notificationText({ title: 'Paid but not provisioned', message: 'Stripe session cs_live_a1_b2 for jane_doe@x.io', priority: 'critical' });
  assert(t.includes('cs_live_a1_b2') && t.includes('jane_doe@x.io'), 'underscores in ids and emails are kept exactly (they used to break parse_mode Markdown)');
  assert(!/[*_]Requires attention[*_]/.test(t) && !/\*Paid/.test(t) && /\nRequires attention$/.test(t), 'no Markdown markers are added; a critical alert ends "Requires attention"');
  assert(t.startsWith('\u{1F6A8} Paid but not provisioned\n'), 'critical alerts start with the siren and the title');
  assert(T.notificationText({ title: 'x', message: 'y' }).startsWith('\u{1F4CB} x\ny') && !/Requires attention/.test(T.notificationText({ title: 'x', message: 'y' })), 'a normal alert: clipboard, title, message');
  assert(T.notificationText({ title: 'x', message: 'z'.repeat(5000) }).length === 4096, 'text is capped at Telegram\'s 4096-character limit');

  // ---- sending (fake fetch)
  const calls = [];
  let reply = { status: 200, json: async () => ({ ok: true, result: {} }) };
  const fake = async (url, opts) => { calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(url) : reply; };
  let r = await T.sendMessage({ token: '1:abc', chatId: '42', text: 'hi', fetchImpl: fake });
  assert(r.ok === true && calls[0].url === 'https://api.telegram.org/bot1:abc/sendMessage' && calls[0].body.chat_id === '42' && calls[0].body.text === 'hi', 'sendMessage posts the text to the chat');
  assert(!('parse_mode' in calls[0].body), 'with no parseMode, NO parse_mode is sent (alerts are plain text)');
  await T.sendMessage({ token: '1:abc', chatId: '42', text: '<b>x</b>', parseMode: 'HTML', fetchImpl: fake });
  assert(calls[1].body.parse_mode === 'HTML', 'a caller that builds its own markup can still ask for HTML');
  reply = { status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
  r = await T.sendMessage({ token: '1:abc', chatId: '42', text: 'x', fetchImpl: fake });
  assert(r.ok === false && /can't parse entities/.test(r.error), "Telegram's refusal is returned with its reason, never reported as sent");
  reply = { status: 502, json: async () => { throw new Error('not json'); } };
  r = await T.sendMessage({ token: '1:abc', chatId: '42', text: 'x', fetchImpl: fake });
  assert(r.ok === false && r.error === 'HTTP 502', 'a non-JSON error page -> its HTTP status');
  reply = new Error('ECONNRESET');
  r = await T.sendMessage({ token: '1:abc', chatId: '42', text: 'x', fetchImpl: fake });
  assert(r.ok === false && r.error === 'ECONNRESET', 'a network failure -> { ok: false } with the reason, never a throw');

  // ---- the Settings "Test" button: check the token, then really send
  assert((await T.testDelivery({ token: '', chatId: '42', fetchImpl: fake })).message === 'No bot token configured', 'no token -> says so');
  assert((await T.testDelivery({ token: '1:abc', chatId: '', fetchImpl: fake })).message === 'No chat id configured', 'no chat id -> says so (a token alone used to pass this button)');
  calls.length = 0;
  reply = (url) => ({ status: 200, json: async () => (url.endsWith('/getMe') ? { ok: true, result: { username: 'aios_bot' } } : { ok: true, result: {} }) });
  r = await T.testDelivery({ token: '1:abc', chatId: '42', fetchImpl: fake });
  assert(r.ok && r.message === 'Test message sent via @aios_bot — check Telegram.' && calls.map((c) => c.url.split('/').pop()).join() === 'getMe,sendMessage' && calls[1].body.chat_id === '42',
    'a working setup: getMe, then a REAL test message to the configured chat');
  reply = (url) => ({ status: 200, json: async () => (url.endsWith('/getMe') ? { ok: true, result: { username: 'aios_bot' } } : { ok: false, description: 'Bad Request: chat not found' }) });
  r = await T.testDelivery({ token: '1:abc', chatId: '999', fetchImpl: fake });
  assert(!r.ok && r.message === 'Bot @aios_bot is valid, but sending failed: Bad Request: chat not found', 'a valid token with a WRONG chat id is caught and explained');
  reply = { status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
  r = await T.testDelivery({ token: '1:bad', chatId: '42', fetchImpl: fake });
  assert(!r.ok && r.message === 'Unauthorized', 'an invalid token -> Telegram\'s reason');

  done();
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exitCode = 1; done(); });
