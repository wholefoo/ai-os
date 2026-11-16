// lib/settings-audit.js — settings.json values that are placeholders, malformed, or shadow a real .env value.
// The headline case is the real prod failure of 2026-11-07: template placeholders persisted in
// settings.json for telegram_bot_token and tavily_api_key beat the REAL keys in .env, so AI OS Telegram
// alerts were never delivered. That exact shape must come out as severity 'error'.
const { assert, done, serverSource, readRepoFile } = require('./test-util');
const { auditSettings, summaryLine, classify, SETTINGS_ENV, NOT_AUDITED } = require('../lib/settings-audit');

// Fake-but-correctly-shaped values (none of these are real credentials).
const REAL_TG = '7123456789:AAH4mZq9vR2kLp8sT0wXyB6nC3dE5fG7hJk';
const REAL_TAVILY = 'tvly-dev-9fK2mQ7pL4xR8sT1vW3yZ6bC';

// --- 1. The 2026-11-07 failure ----------------------------------------------------------------------
{
  const settings = { notifications: { telegram_bot_token: 'your-telegram-bot-token', telegram_chat_id: '123456789' },
    ai: { tavily_api_key: 'your_tavily_api_key_here' } };
  const env = { TELEGRAM_BOT_TOKEN: REAL_TG, TELEGRAM_CHAT_ID: '123456789', TAVILY_API_KEY: REAL_TAVILY };
  const f = auditSettings(settings, env);
  const tg = f.find((x) => x.path === 'notifications.telegram_bot_token');
  const tv = f.find((x) => x.path === 'ai.tavily_api_key');
  assert(tg && tg.severity === 'error' && tg.problem === 'placeholder' && tg.env === 'TELEGRAM_BOT_TOKEN',
    'a placeholder telegram token overriding a real .env token is an ERROR naming TELEGRAM_BOT_TOKEN');
  assert(tv && tv.severity === 'error', 'a placeholder tavily key overriding a real .env key is an ERROR');
  assert(!f.some((x) => x.path === 'notifications.telegram_chat_id'), 'a chat id equal to .env produces no finding');
  assert(f.length === 2, `exactly the two shadowing values are reported (got ${f.length})`);
}

// A 28-char placeholder-shaped token (what prod actually held) is caught by SHAPE even if it has no marker.
{
  const f = auditSettings({ notifications: { telegram_bot_token: 'abcdefghijklmnopqrstuvwxyz12' } }, { TELEGRAM_BOT_TOKEN: REAL_TG });
  assert(f.length === 1 && f[0].severity === 'error' && f[0].problem === 'malformed',
    'a token without a placeholder marker but the wrong shape is MALFORMED, and still an ERROR over a real .env token');
}

// --- 2. Nothing to fall back to: warn, not error ------------------------------------------------------
{
  const f = auditSettings({ ai: { apify_api_token: 'your_apify_token_here' }, automation: { team_webhook_url: 'https://example.com/webhook' } }, {});
  assert(f.length === 2 && f.every((x) => x.severity === 'warn'), 'a placeholder with no usable .env value is a WARN (feature not configured)');
}
{
  // .env ALSO holds a placeholder (prod had this for apify/perplexity/manus): still only a warn.
  const f = auditSettings({ ai: { manus_api_key: 'your-manus-key' } }, { MANUS_API_KEY: 'your_manus_api_key_here' });
  assert(f.length === 1 && f[0].severity === 'warn', 'placeholder in BOTH places is a WARN, not an error (nothing usable is being shadowed)');
}

// --- 3. Healthy and informational --------------------------------------------------------------------
{
  assert(auditSettings({}, { TELEGRAM_BOT_TOKEN: REAL_TG }).length === 0, 'empty settings produce no findings');
  assert(auditSettings({ notifications: { telegram_bot_token: '' } }, { TELEGRAM_BOT_TOKEN: REAL_TG }).length === 0,
    'an EMPTY persisted value produces no finding (telegramCreds falls back to env)');
  assert(auditSettings({ notifications: { telegram_bot_token: REAL_TG } }, { TELEGRAM_BOT_TOKEN: REAL_TG }).length === 0,
    'a persisted value equal to .env produces no finding');
  const f = auditSettings({ ai: { openai_api_key: 'sk-proj-AAAAbbbbCCCCdddd1234' } }, { OPENAI_API_KEY: 'sk-proj-ZZZZyyyyXXXXwwww9876' });
  assert(f.length === 1 && f[0].severity === 'info' && f[0].problem === 'differs',
    'two usable but different values are INFO (settings.json wins; may be intended — prod openai key was exactly this)');
}

// --- 4. No false placeholders on real-shaped values -------------------------------------------------
// A false "placeholder" would tell an operator to delete a working key — so check the real formats.
const realShaped = {
  'ai.anthropic_api_key': 'sk-ant-api03-Q1w2E3r4T5y6U7i8O9p0-AbCdEfGh',
  'ai.openai_api_key': 'sk-proj-Q1w2E3r4T5y6U7i8O9p0AbCdEfGh',
  'ai.tavily_api_key': REAL_TAVILY,
  'ai.gemini_api_key': 'AIzaSyQ1w2E3r4T5y6U7i8O9p0AbCdEfGhIjK',
  'ai.xai_api_key': 'xai-Q1w2E3r4T5y6U7i8O9p0AbCdEfGh',
  'ai.livekit_url': 'wss://aios-abc123.livekit.cloud',
  'ai.liveavatar_avatar_id': '6f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8',
  'notifications.telegram_bot_token': REAL_TG,
  'notifications.telegram_chat_id': '-1001234567890',
  'notifications.slack_webhook_url': 'https://hooks.slack.com/services/T04ABCDEF/B05GHIJKL/q1w2e3r4t5y6u7i8o9p0',
  // sk_TEST_, not sk_live_: CI's secret scan (rightly) fails on any key-shaped sk_live_ string, fake or not.
  'stripe.secret_key': 'sk_test_51Q1w2E3r4T5y6U7i8O9p0',
  'stripe.webhook_secret': 'whsec_Q1w2E3r4T5y6U7i8O9p0',
  'stripe.business_price_id': 'price_1Q1w2E3r4T5y6U7i',
  'automation.n8n_webhook_base': 'http://127.0.0.1:5678/webhook',
  'automation.n8n_api_key': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc',
  'email.smtp_host': 'smtp.resend.com',
  'email.smtp_port': '587',
  'email.from_email': 'hello@aiosorchestrationlab.com',
  'email.from_name': 'AI OS Orchestration Lab',
  'email.provider': 'resend',
  'self_improve.github_pat': 'github_pat_11ABCDEFG0Q1w2E3r4T5y6',
};
for (const [p, v] of Object.entries(realShaped)) {
  assert(classify(p, v) === 'ok', `real-shaped ${p} is not flagged`);
}
for (const v of ['your_api_key_here', 'YOUR-KEY', '<token>', '{{TELEGRAM_BOT_TOKEN}}', '${OPENAI_API_KEY}', 'changeme',
  'replace_me', 'sk-xxxxxxxxxxxx', 'sk-...', 'placeholder', 'xxx', '***', 'api_key_here']) {
  assert(classify('ai.openai_api_key', v) === 'placeholder', `template value "${v}" is flagged as a placeholder`);
}

// --- 5. Never a value in the output -------------------------------------------------------------------
{
  const settings = { notifications: { telegram_bot_token: 'your-telegram-bot-token' }, ai: { openai_api_key: 'sk-proj-SETTINGSVALUE1234' } };
  const env = { TELEGRAM_BOT_TOKEN: REAL_TG, OPENAI_API_KEY: 'sk-proj-ENVVALUE5678' };
  const f = auditSettings(settings, env);
  const out = JSON.stringify(f) + summaryLine(f);
  assert(f.length === 2, 'the leak check runs against real findings (an error and an info)');
  for (const v of ['your-telegram-bot-token', REAL_TG, 'SETTINGSVALUE1234', 'ENVVALUE5678']) {
    assert(!out.includes(v), `no persisted or .env value appears in findings or the startup line (${v.slice(0, 6)}…)`);
  }
  assert(/OVERRIDING a usable \.env value \(notifications\.telegram_bot_token<-TELEGRAM_BOT_TOKEN\)/.test(summaryLine(f)),
    'the startup line names the overriding path and its env var');
  assert(summaryLine([]) === '[CONFIG] settings.json: no placeholder or shadowed values', 'a clean audit says so');
}

// --- 6. The map cannot drift from server.js -----------------------------------------------------------
// Every `key: process.env.VAR || ''` default in loadState('settings', …) must be audited, and nothing else.
{
  const src = serverSource();
  const start = src.indexOf("const settings = loadState('settings', {");
  const end = src.indexOf('\n});', start);
  assert(start > 0 && end > start, 'found the settings defaults block in server.js');
  const block = src.slice(start, end);
  const parsed = {};
  let section = null;
  for (const line of block.split('\n')) {
    const s = line.match(/^ {2}([a-z_]+): \{/);
    if (s) { section = s[1]; continue; }
    const k = line.match(/^ {4}([a-z0-9_]+): process\.env\.([A-Z0-9_]+) \|\| '',/);
    if (k && section) parsed[`${section}.${k[1]}`] = k[2];
  }
  assert(Object.keys(parsed).length >= 30, `parsed the credential defaults (got ${Object.keys(parsed).length}) — a broken parser must not pass vacuously`);
  const known = { ...SETTINGS_ENV, ...NOT_AUDITED };
  const missing = Object.keys(parsed).filter((p) => known[p] !== parsed[p]);
  const extra = Object.keys(known).filter((p) => !(p in parsed));
  assert(!Object.keys(NOT_AUDITED).some((p) => p in SETTINGS_ENV), 'no field is both audited and excluded');
  assert(auditSettings({ general: { api_token: 'your_token_here' } }, { API_TOKEN: 'a'.repeat(40) }).length === 0,
    'general.api_token is not reported (auth reads .env directly; the persisted copy is display-only)');
  assert(missing.length === 0, `every env-seeded settings field is audited with the right env var${missing.length ? ` (missing/wrong: ${missing.join(', ')})` : ''}`);
  assert(extra.length === 0, `SETTINGS_ENV has no stale entries${extra.length ? ` (${extra.join(', ')})` : ''}`);
}

// --- 7. Wired where an operator will see it -----------------------------------------------------------
{
  const src = serverSource();
  assert(src.includes('config_warnings: settingsAudit.auditSettings(settings),'), 'GET /api/settings returns config_warnings, recomputed per request');
  assert(/settingsAudit\.summaryLine\(findings\)/.test(src), 'the startup log prints the audit summary');
  assert(readRepoFile('dashboard/app.html').includes('id="settings-config-warnings"'), 'the Settings view has the warnings banner');
  const js = readRepoFile('dashboard/js/app.js');
  assert(js.includes('renderConfigWarnings(data.config_warnings);'), 'loadSettings renders the banner');
  const fn = js.slice(js.indexOf('function renderConfigWarnings'), js.indexOf('// ---------- Auto-Mode approvals inbox'));
  assert(fn.length > 100 && !/innerHTML/.test(fn), 'the banner builds DOM with textContent only (no innerHTML)');
}

done();
