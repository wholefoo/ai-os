// lib/analytics/bots.js
// ============================================================
//  AI-crawler + referrer classification for the analytics panel. UA classification is the
//  layer Google Analytics structurally cannot see: AI crawlers don't execute JS, so the only
//  vantage point is the origin server's logs. Purposes:
//    training  — bulk crawl to train models (GPTBot, CCBot, ...)
//    search    — building an answer-engine's retrieval index (OAI-SearchBot, PerplexityBot, ...)
//    live      — a human just asked an AI about this site and it's fetching NOW (ChatGPT-User, ...)
//  `match` is a lowercase substring tested against the UA. Ordering matters where one token
//  contains another (e.g. 'claude-searchbot' before 'claudebot' is unnecessary — different
//  substrings — but 'meta-externalagent' vs 'meta-externalfetcher' are distinct).
//  NOTE: Google-Extended and Applebot-Extended are robots.txt tokens, not UAs — they never
//  appear in logs (Google crawls as Googlebot/GoogleOther, Apple as Applebot), so they are
//  deliberately absent here even though lib/aeo/crawlers.js lists them for robots checks.
//  UA identity is self-reported and spoofable — the panel labels it "reported identity";
//  IP-range verification against published ranges is a P2 hardening step.
// ============================================================

const AI_BOTS = [
  // OpenAI
  { match: 'oai-searchbot', engine: 'OpenAI', bot: 'OAI-SearchBot', purpose: 'search' },
  { match: 'chatgpt-user', engine: 'OpenAI', bot: 'ChatGPT-User', purpose: 'live' },
  { match: 'gptbot', engine: 'OpenAI', bot: 'GPTBot', purpose: 'training' },
  // Anthropic
  { match: 'claude-searchbot', engine: 'Anthropic', bot: 'Claude-SearchBot', purpose: 'search' },
  { match: 'claude-user', engine: 'Anthropic', bot: 'Claude-User', purpose: 'live' },
  { match: 'claude-web', engine: 'Anthropic', bot: 'Claude-Web', purpose: 'live' },
  { match: 'claudebot', engine: 'Anthropic', bot: 'ClaudeBot', purpose: 'training' },
  { match: 'anthropic-ai', engine: 'Anthropic', bot: 'anthropic-ai', purpose: 'training' },
  // Perplexity
  { match: 'perplexity-user', engine: 'Perplexity', bot: 'Perplexity-User', purpose: 'live' },
  { match: 'perplexitybot', engine: 'Perplexity', bot: 'PerplexityBot', purpose: 'search' },
  // Google (AI-relevant fetchers; classic Googlebot stays out — it's search-engine, not answer-engine)
  { match: 'googleother', engine: 'Google', bot: 'GoogleOther', purpose: 'training' },
  { match: 'google-cloudvertexbot', engine: 'Google', bot: 'Google-CloudVertexBot', purpose: 'live' },
  // Microsoft — bingbot feeds the Copilot index, so it earns a seat at the AI table
  { match: 'bingbot', engine: 'Microsoft', bot: 'Bingbot', purpose: 'search' },
  // DuckDuckGo
  { match: 'duckassistbot', engine: 'DuckDuckGo', bot: 'DuckAssistBot', purpose: 'search' },
  // Meta
  { match: 'meta-externalagent', engine: 'Meta', bot: 'Meta-ExternalAgent', purpose: 'training' },
  { match: 'meta-externalfetcher', engine: 'Meta', bot: 'Meta-ExternalFetcher', purpose: 'live' },
  // Mistral
  { match: 'mistralai-user', engine: 'Mistral', bot: 'MistralAI-User', purpose: 'live' },
  // Aggregate trainers
  { match: 'ccbot', engine: 'Common Crawl', bot: 'CCBot', purpose: 'training' },
  { match: 'amazonbot', engine: 'Amazon', bot: 'Amazonbot', purpose: 'training' },
  { match: 'bytespider', engine: 'ByteDance', bot: 'Bytespider', purpose: 'training' },
  { match: 'applebot', engine: 'Apple', bot: 'Applebot', purpose: 'training' },
];

// Referrer hosts that mean "a human arrived FROM an answer engine" — the conversion side of AEO.
const AI_REFERRERS = [
  { match: 'chatgpt.com', engine: 'ChatGPT' },
  { match: 'chat.openai.com', engine: 'ChatGPT' },
  { match: 'perplexity.ai', engine: 'Perplexity' },
  { match: 'claude.ai', engine: 'Claude' },
  { match: 'gemini.google.com', engine: 'Gemini' },
  { match: 'copilot.microsoft.com', engine: 'Copilot' },
  { match: 'you.com', engine: 'You.com' },
  { match: 'phind.com', engine: 'Phind' },
];

const SEARCH_REFERRERS = ['google.', 'bing.com', 'duckduckgo.com', 'search.yahoo.', 'ecosia.org', 'search.brave.com', 'baidu.com', 'yandex.'];
const SOCIAL_REFERRERS = ['facebook.com', 'twitter.com', 't.co/', 'x.com', 'linkedin.com', 'reddit.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'news.ycombinator.com'];

// → { engine, bot, purpose } | null. Null = not a known AI bot (human or other crawler).
function classifyUA(ua) {
  const lc = String(ua || '').toLowerCase();
  if (!lc) return null;
  for (const b of AI_BOTS) if (lc.includes(b.match)) return { engine: b.engine, bot: b.bot, purpose: b.purpose };
  return null;
}

// → { class: 'ai'|'search'|'social'|'direct'|'other', engine? }.
// `utm` lets callers pass a parsed utm_source (ChatGPT appends utm_source=chatgpt.com to outbound links).
function classifyReferrer(ref, utm) {
  const r = String(ref || '').toLowerCase();
  const u = String(utm || '').toLowerCase();
  for (const a of AI_REFERRERS) if ((r && r.includes(a.match)) || (u && u.includes(a.match))) return { class: 'ai', engine: a.engine };
  if (!r || r === '-') return { class: 'direct' };
  for (const s of SEARCH_REFERRERS) if (r.includes(s)) return { class: 'search' };
  for (const s of SOCIAL_REFERRERS) if (r.includes(s)) return { class: 'social' };
  return { class: 'other' };
}

module.exports = { classifyUA, classifyReferrer };
