// lib/notify/telegram.js — deciding whether Telegram alerts can go out, what to send, and sending it.
//
// Written after finding (2026-11-07) that sendNotification() had NEVER delivered to Telegram on prod:
//
//   1. Its gate was `notificationConfig.telegram.enabled && botToken`, and `enabled` started FALSE at
//      every boot. Only PUT /api/notifications/config turned it on — in memory, until the next restart —
//      and nothing in the dashboard calls that route. So "Paid but not provisioned", "Renewal payment
//      failed", security self-scan findings, "Automation mode set to AUTO"… reached the dashboard only.
//   2. Its token came from a process.env snapshot at boot, not from Settings → Notifications (where the
//      other Telegram path, telegramCreds(), already reads it).
//   3. It sent with parse_mode 'Markdown'. Alert text carries emails and Stripe ids, and an underscore
//      opens an italic entity Telegram cannot close → "Bad Request: can't parse entities" → the alert is
//      dropped — while the activity log had already recorded "Telegram notification sent" at DISPATCH.
//
// So: ready = credentials present (Settings first, then env — telegramCreds()); text is PLAIN (no
// parse_mode, so no character in an email or id can break it); and delivery is reported from Telegram's
// own answer, never assumed.

const API = 'https://api.telegram.org';
const MAX_TEXT = 4096;                       // Telegram's sendMessage limit

/** Credentials usable for sending: a token and a chat id, both non-empty. */
function telegramReady(creds) {
  return Boolean(creds && String(creds.token || '').trim() && String(creds.chatId || '').trim());
}

/** The PLAIN-TEXT body of an alert (no parse_mode: nothing in it is markup). */
function notificationText({ title, message, priority = 'normal' } = {}) {
  const emoji = priority === 'critical' ? '\u{1F6A8}' : priority === 'normal' ? '\u{1F4CB}' : '\u{2139}\u{FE0F}';
  const text = `${emoji} ${title}\n${message}${priority === 'critical' ? '\n\nRequires attention' : ''}`;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/**
 * POST sendMessage and resolve Telegram's verdict: { ok: true } or { ok: false, error }. Never throws —
 * a network failure is a { ok: false } with the reason. `parseMode` is only for callers that build their
 * own markup (sendTelegramMessage's HTML); alerts leave it unset.
 */
async function sendMessage({ token, chatId, text, parseMode, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return data && data.ok === true ? { ok: true } : { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * The Settings → Notifications "Test" button: check the token (getMe), then actually SEND a message to
 * the configured chat — a token can be valid while the chat id is wrong, and only a real send shows it.
 * Resolves { ok, message } for the UI.
 */
async function testDelivery({ token, chatId, fetchImpl = globalThis.fetch } = {}) {
  if (!String(token || '').trim()) return { ok: false, message: 'No bot token configured' };
  if (!String(chatId || '').trim()) return { ok: false, message: 'No chat id configured' };
  let bot;
  try {
    const r = await fetchImpl(`${API}/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!d || d.ok !== true) return { ok: false, message: (d && d.description) || 'Invalid token' };
    bot = d.result && d.result.username;
  } catch (e) {
    return { ok: false, message: `Connection failed: ${e.message}` };
  }
  const sent = await sendMessage({ token, chatId, fetchImpl, text: '✅ AI OS test message: Telegram alerts are working.' });
  return sent.ok
    ? { ok: true, message: `Test message sent via @${bot} — check Telegram.` }
    : { ok: false, message: `Bot @${bot} is valid, but sending failed: ${sent.error}` };
}

module.exports = { telegramReady, notificationText, sendMessage, testDelivery };
