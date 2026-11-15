// lib/settings-audit.js — find settings.json values that are template placeholders, malformed, or that
// silently shadow a real .env value.
//
// Why this exists (prod, 2026-11-07): loadState() only backfills a settings.json key that is MISSING, so a
// persisted value always beats .env. settings.json had been seeded with template placeholders for
// telegram_bot_token and tavily_api_key, and those placeholders won over the REAL keys in .env — AI OS
// Telegram alerts had never been delivered, and tavily calls failed. Every presence check said "set".
// The fix was found by checking SHAPE, not presence. This module makes that check run at every boot.
//
// It NEVER returns or logs a value — only the settings path, the env var name, and what is wrong.

// settings path -> the env var its default is seeded from (`key: process.env.VAR || ''` in server.js's
// loadState('settings', …) block). tools/test-settings-audit.js parses server.js and fails if this map
// drifts from that block, so a new credential field cannot be added without being audited.
const SETTINGS_ENV = {
  'ai.anthropic_api_key': 'ANTHROPIC_API_KEY',
  'ai.deepseek_api_key': 'DEEPSEEK_API_KEY',
  'ai.zai_api_key': 'ZAI_API_KEY',
  'ai.xai_api_key': 'XAI_API_KEY',
  'ai.firecrawl_api_key': 'FIRECRAWL_API_KEY',
  'ai.gemini_api_key': 'GEMINI_API_KEY',
  'ai.tavily_api_key': 'TAVILY_API_KEY',
  'ai.apify_api_token': 'APIFY_API_TOKEN',
  'ai.openai_api_key': 'OPENAI_API_KEY',
  'ai.perplexity_api_key': 'PERPLEXITY_API_KEY',
  'ai.manus_api_key': 'MANUS_API_KEY',
  'ai.livekit_api_key': 'LIVEKIT_API_KEY',
  'ai.livekit_api_secret': 'LIVEKIT_API_SECRET',
  'ai.livekit_url': 'LIVEKIT_URL',
  'ai.deepgram_api_key': 'DEEPGRAM_API_KEY',
  'ai.cartesia_api_key': 'CARTESIA_API_KEY',
  'ai.heygen_api_key': 'HEYGEN_API_KEY',
  'ai.liveavatar_api_key': 'LIVEAVATAR_API_KEY',
  'ai.liveavatar_avatar_id': 'LIVEAVATAR_AVATAR_ID',
  'ai.liveavatar_voice_id': 'LIVEAVATAR_VOICE_ID',
  'ai.did_api_key': 'DID_API_KEY',
  'ai.youtube_api_key': 'YOUTUBE_API_KEY',
  'email.from_email': 'EMAIL_FROM',
  'email.from_name': 'EMAIL_FROM_NAME',
  'email.resend_api_key': 'RESEND_API_KEY',
  'email.smtp_host': 'SMTP_HOST',
  'email.smtp_port': 'SMTP_PORT',
  'email.smtp_user': 'SMTP_USER',
  'email.smtp_pass': 'SMTP_PASS',
  'email.footer_address': 'EMAIL_FOOTER_ADDRESS',
  'email.provider': 'EMAIL_PROVIDER',
  'self_improve.github_pat': 'AIOS_SELF_IMPROVE_GITHUB_PAT',
  'notifications.telegram_bot_token': 'TELEGRAM_BOT_TOKEN',
  'notifications.telegram_chat_id': 'TELEGRAM_CHAT_ID',
  'notifications.slack_webhook_url': 'SLACK_WEBHOOK_URL',
  'automation.n8n_webhook_base': 'N8N_WEBHOOK_BASE',
  'automation.n8n_api_key': 'N8N_API_KEY',
  'automation.team_webhook_url': 'TEAM_WEBHOOK_URL',
  'stripe.secret_key': 'STRIPE_SECRET_KEY',
  'stripe.webhook_secret': 'STRIPE_WEBHOOK_SECRET',
  'stripe.business_price_id': 'STRIPE_BUSINESS_PRICE_ID',
  'stripe.enterprise_price_id': 'STRIPE_ENTERPRISE_PRICE_ID',
  'seo.dataforseo_login': 'DATAFORSEO_LOGIN',
  'seo.dataforseo_password': 'DATAFORSEO_PASSWORD',
  'seo.google_places_api_key': 'GOOGLE_PLACES_API_KEY',
};

// Env-seeded fields deliberately NOT audited, each with the reason. The drift test requires every
// env-seeded field to be in SETTINGS_ENV or here.
const NOT_AUDITED = {
  // Display-only: authentication reads process.env.API_TOKEN directly, so the persisted copy never
  // takes effect — "settings.json wins" would be a false statement about it.
  'general.api_token': 'API_TOKEN',
};

// Template markers. Deliberately conservative: a false "placeholder" on a real key would tell an operator
// to delete a working credential, so each pattern is something no real key or URL looks like.
const PLACEHOLDER_PATTERNS = [
  /^(your|enter|insert|put|add|paste)[\s_-]/i,               // your_api_key_here, your-telegram-bot-token
  /[\s_-]here$/i,                                            // api_key_here, token-here
  /^<[^>]*>$/, /^\{\{.*\}\}$/, /^\$\{.*\}$/,                 // <token>, {{TOKEN}}, ${TOKEN} (unexpanded)
  /^(change[-_ ]?me|replace[-_ ]?me|placeholder|example|todo|tbd|none|null|undefined|test|dummy|fake|secret|token|key|xxx+|\*+|\.+|-+)$/i,
  /x{6,}/i,                                                  // sk-xxxxxxxxxxxx, 123456:XXXXXXXX
  /\.\.\.$/,                                                 // sk-...
  /\bexample\.(com|org|net)\b/i,                             // https://example.com/webhook
  /hooks\.slack\.com\/services\/T0+\/B0+\//i,                // Slack's docs sample webhook
];

// Shapes we are certain of: a value that fails one of these cannot work, whatever it is.
const URL_RE = /^(https?|wss?):\/\/[^\s/$.?#][^\s]*$/i;
const SHAPES = {
  'notifications.telegram_bot_token': { re: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, want: 'a BotFather token (digits:secret)' },
  'notifications.telegram_chat_id': { re: /^(-?\d+|@[A-Za-z0-9_]{5,})$/, want: 'a numeric chat id or @channel' },
  'notifications.slack_webhook_url': { re: /^https:\/\/hooks\.slack\.com\/services\/\S+$/, want: 'an https://hooks.slack.com/services/… URL' },
  'stripe.secret_key': { re: /^(sk|rk)_(live|test)_\S+$/, want: 'an sk_/rk_ live or test key' },
  'stripe.webhook_secret': { re: /^whsec_\S+$/, want: 'a whsec_ signing secret' },
  'ai.anthropic_api_key': { re: /^sk-ant-\S+$/, want: 'an sk-ant- key' },
  'ai.livekit_url': { re: URL_RE, want: 'a ws(s):// or http(s):// URL' },
  'automation.n8n_webhook_base': { re: URL_RE, want: 'an http(s):// URL' },
  'automation.team_webhook_url': { re: URL_RE, want: 'an http(s):// URL' },
};

/** 'ok' | 'placeholder' | 'malformed' for a non-empty string at `path`. */
function classify(path, value) {
  const v = String(value).trim();
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(v))) return 'placeholder';
  const shape = SHAPES[path];
  if (shape && !shape.re.test(v)) return 'malformed';
  return 'ok';
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Audit persisted settings against the environment. Returns findings, worst first:
 *   { path, env, severity: 'error'|'warn'|'info', problem, message }
 *   error — the persisted value is a placeholder/malformed AND .env holds a usable value: the bad value
 *           wins, so a working credential is being ignored (the 2026-11-07 failure).
 *   warn  — the persisted value is a placeholder/malformed and there is nothing usable to fall back to.
 *   info  — persisted and .env are both usable but DIFFER: settings.json wins, which may be intended.
 * No value ever appears in a finding.
 */
function auditSettings(settings, env = process.env) {
  const findings = [];
  for (const [path, envName] of Object.entries(SETTINGS_ENV)) {
    const persisted = get(settings, path);
    if (typeof persisted !== 'string' || !persisted.trim()) continue;      // empty: env fallback applies
    const envVal = typeof env[envName] === 'string' ? env[envName].trim() : '';
    const envUsable = envVal !== '' && classify(path, envVal) === 'ok';
    const state = classify(path, persisted);
    if (state !== 'ok') {
      const what = state === 'placeholder'
        ? 'looks like a template placeholder'
        : `is not ${SHAPES[path].want}`;
      if (envUsable && envVal !== persisted.trim()) {
        findings.push({ path, env: envName, severity: 'error', problem: state,
          message: `settings.json ${path} ${what}, and it OVERRIDES a usable ${envName} in .env. Clear it in Settings so the .env value takes effect.` });
      } else {
        findings.push({ path, env: envName, severity: 'warn', problem: state,
          message: `settings.json ${path} ${what}; this integration is not really configured.` });
      }
    } else if (envUsable && envVal !== persisted.trim()) {
      findings.push({ path, env: envName, severity: 'info', problem: 'differs',
        message: `settings.json ${path} differs from ${envName} in .env; the settings.json value is the one used.` });
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path));
}

/** One startup line (values never included). */
function summaryLine(findings) {
  if (!findings.length) return '[CONFIG] settings.json: no placeholder or shadowed values';
  const by = (s) => findings.filter((f) => f.severity === s);
  const part = (s, label) => {
    const fs = by(s);
    return fs.length ? `${fs.length} ${label} (${fs.map((f) => `${f.path}<-${f.env}`).join(', ')})` : '';
  };
  return `[CONFIG] settings.json: ${[part('error', 'OVERRIDING a usable .env value'), part('warn', 'placeholder/malformed'), part('info', 'differ from .env')].filter(Boolean).join(' | ')}`;
}

module.exports = { auditSettings, summaryLine, classify, SETTINGS_ENV, NOT_AUDITED };
