// lib/trends.js
// ============================================================
//  Trending-content aggregator. Pulls "what's hot right now" from several sources and
//  returns a normalized { source -> { items:[{title,url,score?}] } } map to seed Web Studio
//  briefs. Each source is ISOLATED (one failing source never sinks the others), results are
//  cached ~15 min, and item counts are capped.
//
//  Keyless sources (no API key needed): Google Trends RSS, Reddit JSON, Hacker News (Algolia),
//  Google News RSS. YouTube needs a Data API key (graceful skip without one). X/social is
//  opt-in and routed through an injected agent caller (deps.socialFetch) so this module stays
//  free of token-spending side effects by default.
// ============================================================

const { safeFetch } = require('./net/safe-fetch');

const CACHE_TTL_MS = 15 * 60 * 1000;
const PER_SOURCE = 12;
const UA = 'Mozilla/5.0 (compatible; AI-OS-Trends/1.0)';
const _cache = new Map();

function cacheGet(key) { const e = _cache.get(key); return e && (Date.now() - e.t) < CACHE_TTL_MS ? e.v : null; }
function cacheSet(key, v) { _cache.set(key, { t: Date.now(), v }); }

async function getText(url, { headers = {}, timeoutMs = 10000 } = {}) {
  return await safeFetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeoutMs, maxBytes: 4_000_000 });
}
const getJson = async (url, opts) => JSON.parse(await getText(url, opts));

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/\s+/g, ' ').trim();
}

// Handles BOTH RSS 2.0 (<item>, <link>text</link>) and Atom (<entry>, <link href="…"/>).
function parseFeedItems(xml, cap = PER_SOURCE) {
  const items = [];
  for (const m of String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const title = decodeEntities((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = ((block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1])
      || decodeEntities((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
    if (title) items.push({ title: title.slice(0, 200), url: /^https?:/i.test(link) ? link : '' });
    if (items.length >= cap) break;
  }
  return items;
}

function dedupe(items) {
  const seen = new Set(), out = [];
  for (const it of items) {
    const k = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out.slice(0, PER_SOURCE);
}

// ---------- per-source fetchers: (topic, { geo, deps }) -> array | { skipped } | { error } ----------
// Google autocomplete = real "related searches" for a topic. Keyless, datacenter-friendly
// (the Trends internal widgetdata API 429s from server IPs), so it powers topic mode.
async function googleSuggest(q) {
  try {
    const arr = JSON.parse(await getText(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`, { timeoutMs: 7000 }));
    return Array.isArray(arr) && Array.isArray(arr[1]) ? arr[1] : [];
  } catch { return []; }
}

async function srcGoogleTrends(topic, { geo = 'US' } = {}) {
  // Topic mode → related queries via Google autocomplete, expanded with intent seeds.
  if (topic) {
    const seeds = [topic, `${topic} `, `how to ${topic}`, `best ${topic}`, `${topic} vs`, `why ${topic}`];
    const lists = await Promise.all(seeds.map((s) => googleSuggest(s)));
    const seen = new Set(), out = [];
    for (const list of lists) {
      for (const s of list) {
        const k = String(s).toLowerCase().trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push({ title: String(s).slice(0, 200), url: `https://www.google.com/search?q=${encodeURIComponent(s)}`, source: 'Google Trends' });
        if (out.length >= PER_SOURCE) return out;
      }
    }
    if (out.length) return out;
  }
  // No topic (or suggest unavailable) → geo-wide "trending now".
  let items = [];
  try { items = parseFeedItems(await getText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`)); } catch {}
  if (!items.length) { try { items = parseFeedItems(await getText(`https://trends.google.com/trends/trendingsearches/daily/rss?geo=${encodeURIComponent(geo)}`)); } catch {} }
  return items.map((i) => ({ ...i, source: 'Google Trends' }));
}

// Reddit's JSON API 403s generic UAs / datacenter IPs; its RSS (Atom) feed is more permissive.
async function srcReddit(topic) {
  const url = topic
    ? `https://www.reddit.com/search.rss?q=${encodeURIComponent(topic)}&sort=hot&t=week&limit=${PER_SOURCE}`
    : `https://www.reddit.com/r/popular/hot/.rss?limit=${PER_SOURCE}`;
  const xml = await getText(url, { headers: { 'User-Agent': 'web:ai-os-trends:1.0 (trending aggregator)' } });
  return parseFeedItems(xml).map((i) => ({ ...i, source: 'Reddit' }));
}

async function srcHackerNews(topic) {
  const url = topic
    ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=${PER_SOURCE}`
    : `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${PER_SOURCE}`;
  const j = await getJson(url);
  return (j.hits || []).map((h) => ({
    title: decodeEntities(h.title || h.story_title || '').slice(0, 200),
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    score: h.points, source: 'Hacker News',
  })).filter((i) => i.title);
}

async function srcGoogleNews(topic) {
  const url = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  return parseFeedItems(await getText(url)).map((i) => ({ ...i, source: 'Google News' }));
}

async function srcYouTube(topic, { deps = {} } = {}) {
  const key = deps.youtubeKey;
  if (!key) return { skipped: 'YouTube trends need a YouTube Data API key (set it in Settings).' };
  const q = topic || 'trending';
  const j = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=${PER_SOURCE}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`);
  return (j.items || []).map((it) => ({
    title: decodeEntities(it.snippet && it.snippet.title || ''),
    url: it.id && it.id.videoId ? `https://youtube.com/watch?v=${it.id.videoId}` : '',
    source: 'YouTube',
  })).filter((i) => i.title && i.url);
}

async function srcSocial(topic, { deps = {} } = {}) {
  if (typeof deps.socialFetch !== 'function') return { skipped: 'X/social trends need the realtime agent (request source "social" to enable).' };
  const items = await deps.socialFetch(topic);
  return (Array.isArray(items) ? items : []).map((i) => ({
    title: decodeEntities(typeof i === 'string' ? i : (i.title || '')).slice(0, 200),
    url: (i && i.url) || '', source: 'X / Social',
  })).filter((i) => i.title);
}

const SOURCES = {
  google_trends: srcGoogleTrends,
  reddit: srcReddit,
  hacker_news: srcHackerNews,
  google_news: srcGoogleNews,
  youtube: srcYouTube,
  social: srcSocial,
};
const DEFAULT_SOURCES = ['google_trends', 'reddit', 'hacker_news', 'google_news'];

/**
 * Fetch trending items across sources. Never rejects on a single source's failure.
 * @param {{sources?:string[], topic?:string, geo?:string}} opts
 * @param {{youtubeKey?:string, socialFetch?:Function}} deps
 * @returns {Promise<Object>} { <source>: { items:[...] } | { skipped } | { error } }
 */
async function fetchTrending({ sources, topic, geo } = {}, deps = {}) {
  const want = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES).filter((s) => SOURCES[s]);
  const t = (topic || '').trim().slice(0, 120);
  const out = {};
  await Promise.all(want.map(async (name) => {
    const key = `${name}|${t}|${geo || ''}`;
    const cached = cacheGet(key);
    if (cached) { out[name] = cached; return; }
    try {
      const r = await SOURCES[name](t, { geo, deps });
      const val = Array.isArray(r) ? { items: dedupe(r) } : r; // array → items; {skipped}/{error} pass through
      cacheSet(key, val);
      out[name] = val;
    } catch (e) { out[name] = { error: e.message }; }
  }));
  return out;
}

module.exports = { fetchTrending, SOURCES, DEFAULT_SOURCES, parseFeedItems, decodeEntities, dedupe };
