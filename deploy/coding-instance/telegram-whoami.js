#!/usr/bin/env node
// deploy/coding-instance/telegram-whoami.js
// ============================================================
//  One-time setup helper for the Hermes-Dev Telegram gateway (P3). Prints the numeric user id and chat
//  id of whoever has messaged the bot, so they can be put in the allowlist — Telegram offers no other
//  way to learn them. Run it BEFORE enabling the gateway (two getUpdates pollers on one bot conflict).
//
//    1. In Telegram, send your NEW Hermes-Dev bot any message (e.g. /start).
//    2. sudo -iu hermes node /home/hermes/work/ai-os/deploy/coding-instance/telegram-whoami.js
//
//  Reads TELEGRAM_BOT_TOKEN from the environment or the app's .env. Never prints the token. Does not
//  confirm (consume) any update, so nothing is lost for the gateway.
// ============================================================

const fs = require('fs');
const path = require('path');

function tokenFromEnvFile() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  try {
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).reverse().find((l) => /^TELEGRAM_BOT_TOKEN=/.test(l));   // last wins, as dotenv
    return line ? line.replace(/^TELEGRAM_BOT_TOKEN=/, '').trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN || tokenFromEnvFile();
  if (!token) { console.error('No TELEGRAM_BOT_TOKEN in the environment or the app .env. Create a bot with @BotFather first.'); process.exit(1); }
  const call = async (method, params = {}) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || `HTTP ${r.status}`}`);
    return j.result;
  };
  try {
    const me = await call('getMe');
    console.log(`Bot: @${me.username} (id ${me.id})`);
    const hook = await call('getWebhookInfo');
    if (hook.url) {
      console.log('WARNING: this bot has a WEBHOOK set, so polling (the gateway) cannot work.');
      console.log('Use a bot dedicated to Hermes-Dev, or remove the webhook if nothing else needs it.');
    }
    const updates = await call('getUpdates', { timeout: 0 });
    const seen = new Map();
    for (const u of updates) {
      const msg = u.message || (u.callback_query && u.callback_query.message);
      const from = (u.message && u.message.from) || (u.callback_query && u.callback_query.from);
      if (!msg || !from) continue;
      seen.set(`${from.id}:${msg.chat.id}`, { userId: from.id, user: from.username ? `@${from.username}` : (from.first_name || ''), chatId: msg.chat.id, chatType: msg.chat.type });
    }
    if (!seen.size) { console.log('\nNo messages yet. Send the bot a message in Telegram (e.g. /start), then run this again.'); return; }
    console.log('\nWho has messaged this bot:');
    for (const s of seen.values()) console.log(`  user ${s.userId} ${s.user}  in ${s.chatType} chat ${s.chatId}`);
    const first = [...seen.values()][0];
    console.log('\nFor YOUR account, add to the app .env (one user and one chat id; comma-separate to allow more):');
    console.log(`  HERMES_TELEGRAM_ALLOWED_USER_IDS=${first.userId}`);
    console.log(`  HERMES_TELEGRAM_ALLOWED_CHAT_IDS=${first.chatId}`);
    console.log('Only allowlist accounts you control — an allowlisted user can approve coding plans.');
  } catch (e) {
    console.error(String(e.message).split(token).join('<token>'));
    process.exit(1);
  }
})();
