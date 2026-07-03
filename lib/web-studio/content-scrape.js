// lib/web-studio/content-scrape.js
// ============================================================
//  "Reuse my content" — point at a client's OWN existing site and pull structured TEXT CONTENT
//  (titles, descriptions, headings, paragraphs, list items, contact info) off the homepage and a
//  handful of same-origin subpages, so a redesign pipeline can reuse the client's real copy
//  instead of inventing placeholder text. This is content reuse for a redesign, not competitor
//  cloning or a general-purpose crawler.
//
//  SAFETY POSTURE (mirrors lib/web-studio/design-extract.js):
//  (a) Everything this function returns is UNTRUSTED text extracted from an external site. This
//      module does NOT sanitize it for prompt-injection purposes — callers MUST wrap it via
//      lib/safety/untrusted.js's fenceUntrusted() before any of it reaches an executeAgent/LLM
//      call. Treat every string field (title, description, headings[].text, paragraphs[],
//      listItems[], navLabels[]) as hostile, attacker-controlled text.
//  (b) Network safety (SSRF IP-pinning, redirect re-validation, byte + time caps) lives in
//      lib/net/safe-fetch — every fetch here goes through it. On top of that, this module adds a
//      SCOPE boundary: only same-ORIGIN links discovered on the homepage are ever crawled (exact
//      hostname match, not a suffix/subdomain match), the crawl is capped to 6 pages total
//      (homepage + up to 5 subpages), each page fetch is capped at 1.5MB, and ALL fetches for one
//      scrapeSite() call share a single wall-clock deadline budget (default 25000ms). A failed or
//      timed-out subpage is silently dropped (with a note) rather than failing the whole scrape;
//      only a hard failure fetching the initial URL throws.
// ============================================================

const { safeFetch } = require('../net/safe-fetch');

const UA = 'Mozilla/5.0 (compatible; AI-OS-WebStudio/1.0; content-reuse)';

const MAX_TOTAL_PAGES = 6;          // homepage + up to 5 subpages
const MAX_PAGE_BYTES = 1_500_000;
const DEFAULT_DEADLINE_MS = 25000;
const MAX_PAGE_JSON_CHARS = 8000;   // per-page content-size guard (bounds what reaches an LLM prompt)

const NAV_PRIORITY_TERMS = [
  'about', 'service', 'product', 'pricing', 'plan', 'contact', 'team',
  'staff', 'faq', 'portfolio', 'work', 'gallery', 'blog', 'menu',
];

// ---------- entity/tag helpers ----------
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}
function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ');
}
function cleanText(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}
// Remove <script>/<style> blocks BEFORE any content extraction so JS/CSS text is never pulled in.
function stripScriptsAndStyles(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

// ---------- extraction ----------
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(m[1]).slice(0, 200) : '';
}
function extractDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  return m ? cleanText(m[1]).slice(0, 500) : '';
}
function extractHeadings(html, cap = 20) {
  const out = [];
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    if (out.length >= cap) break;
    const text = cleanText(m[2]);
    if (!text) continue;
    out.push({ level: Number(m[1]), text });
  }
  return out;
}
function extractParagraphs(html, cap = 40, maxLen = 500) {
  const out = [];
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (out.length >= cap) break;
    const text = cleanText(m[1]);
    if (!text || text.length < 15) continue;
    out.push(text.slice(0, maxLen));
  }
  return out;
}
function extractListItems(html, cap = 30, maxLen = 200) {
  const out = [];
  for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (out.length >= cap) break;
    const text = cleanText(m[1]);
    if (!text) continue;
    out.push(text.slice(0, maxLen));
  }
  return out;
}
function extractEmails(pageText, cap = 5) {
  const seen = new Set();
  for (const m of pageText.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    if (seen.size >= cap) break;
    seen.add(m[0]);
  }
  return [...seen];
}
function extractPhones(pageText, cap = 5) {
  const re = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
  const seen = new Set();
  for (const m of pageText.matchAll(re)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 7) continue; // filter out short numeric noise (years, counts, etc.)
    if (seen.size >= cap) break;
    seen.add(m[0].trim());
  }
  return [...seen];
}

// Shrink a page's content so JSON.stringify(...) stays under MAX_PAGE_JSON_CHARS — drop from the
// end of paragraphs first, then listItems, so this bounds how much text later reaches an LLM prompt.
function enforcePageSizeCap(page, cap = MAX_PAGE_JSON_CHARS) {
  let guard = 0;
  while (JSON.stringify({ headings: page.headings, paragraphs: page.paragraphs, listItems: page.listItems }).length > cap && guard < 10000) {
    guard++;
    if (page.paragraphs.length) { page.paragraphs.pop(); continue; }
    if (page.listItems.length) { page.listItems.pop(); continue; }
    if (page.headings.length) { page.headings.pop(); continue; }
    break; // nothing left to trim
  }
  return page;
}

function parsePage(url, html) {
  const cleaned = stripScriptsAndStyles(html);
  const bodyText = cleanText(cleaned);
  const page = {
    url,
    title: extractTitle(cleaned),
    description: extractDescription(cleaned),
    headings: extractHeadings(cleaned),
    paragraphs: extractParagraphs(cleaned),
    listItems: extractListItems(cleaned),
    contactInfo: {
      emails: extractEmails(bodyText),
      phones: extractPhones(bodyText),
    },
  };
  return enforcePageSizeCap(page);
}

// ---------- nav discovery (homepage only, same-origin only) ----------
function extractAnchors(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: m[1], text: cleanText(m[2]) });
  }
  return out;
}
function resolveSameOrigin(href, base) {
  try {
    const abs = new URL(href, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    if (abs.hostname !== base.hostname) return null; // exact hostname match — scope boundary
    abs.hash = '';
    return abs.href;
  } catch {
    return null;
  }
}
function navPriorityScore(anchor) {
  const hay = `${anchor.text} ${anchor.href}`.toLowerCase();
  for (let i = 0; i < NAV_PRIORITY_TERMS.length; i++) {
    if (hay.includes(NAV_PRIORITY_TERMS[i])) return NAV_PRIORITY_TERMS.length - i;
  }
  return 0;
}

/**
 * Scrape a client's OWN existing site for reusable content (redesign content reuse, not
 * competitor cloning). Never trusts fetched content, never evaluates/executes it, never follows
 * off-origin links. Throws only on a hard failure fetching the initial URL; per-subpage failures
 * are dropped silently (with a note) so the whole scrape never fails because of one bad page.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.deadlineMs=25000]  total wall-clock budget shared across every fetch made
 * @returns {Promise<{sourceUrl, title, pages, navLabels, notes}>}
 */
async function scrapeSite(rawUrl, opts = {}) {
  const deadline = Date.now() + (opts.deadlineMs || DEFAULT_DEADLINE_MS);
  const notes = [];

  const homeHtml = await safeFetch(rawUrl, { deadline, userAgent: UA, maxBytes: MAX_PAGE_BYTES });
  const base = new URL(rawUrl);

  // Nav discovery: prefer anchors inside a <nav> block if present, else all homepage anchors.
  const navMatch = homeHtml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  const navScopeHtml = navMatch ? navMatch[1] : homeHtml;
  const navAnchors = extractAnchors(navScopeHtml);
  const allAnchors = navMatch ? extractAnchors(homeHtml) : navAnchors;

  // Same-origin candidates ranked by IA-term priority, deduped by resolved URL.
  const candidateMap = new Map(); // url -> { score, text }
  for (const a of allAnchors) {
    const abs = resolveSameOrigin(a.href, base);
    if (!abs) continue;
    if (abs === base.href || abs === base.href.replace(/\/$/, '')) continue; // skip homepage itself
    const score = navPriorityScore(a);
    const existing = candidateMap.get(abs);
    if (!existing || score > existing.score) candidateMap.set(abs, { score, text: a.text });
  }
  const ranked = [...candidateMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([url]) => url);
  const subpageUrls = ranked.slice(0, Math.max(0, MAX_TOTAL_PAGES - 1));

  // navLabels: visible text of same-origin nav-area anchors, deduped, capped.
  const navLabelSet = new Set();
  for (const a of navAnchors) {
    if (!a.text) continue;
    if (!resolveSameOrigin(a.href, base)) continue;
    navLabelSet.add(a.text);
    if (navLabelSet.size >= 12) break;
  }
  const navLabels = [...navLabelSet];

  // Fetch subpages concurrently, sharing the same deadline; failures are dropped, not thrown.
  const results = await Promise.allSettled(
    subpageUrls.map((u) => safeFetch(u, { deadline, userAgent: UA, maxBytes: MAX_PAGE_BYTES }))
  );

  const pages = [parsePage(base.href, homeHtml)];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const url = subpageUrls[i];
    if (r.status === 'fulfilled') {
      pages.push(parsePage(url, r.value));
    } else {
      notes.push(`skipped ${url}: ${(r.reason && r.reason.message) || 'fetch failed'}`);
    }
    if (pages.length >= MAX_TOTAL_PAGES) break;
  }

  const title = extractTitle(homeHtml);

  return { sourceUrl: base.href, title, pages, navLabels, notes };
}

module.exports = { scrapeSite };
