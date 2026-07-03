// lib/web-studio/content-scrape.js
// ============================================================
//  Two related entry points, both extracting structured TEXT (never raw markup) from a live site
//  via the SSRF-pinned safeFetch — deliberately NOT a general-purpose crawler:
//
//  scrapeSite()      — "reuse MY OWN content": the homepage + up to 5 same-origin subpages of a
//                       CLIENT'S OWN existing site, for a redesign that keeps their real copy.
//  scrapeForResearch — "gather FACTS about a THIRD-PARTY product": the given URL + up to 2
//                       same-origin pricing/feature pages ONLY (no blog, no docs, no portfolio) —
//                       deliberately narrow. This exists to ground ORIGINAL affiliate/review copy
//                       in real facts (price, feature names, specs); it is NOT a license to
//                       reproduce or closely paraphrase the source's own writing. Callers MUST
//                       instruct the model to write in its own words from these facts — see
//                       pipeline.js's researchContentNote().
//
//  SAFETY POSTURE (mirrors lib/web-studio/design-extract.js):
//  (a) Everything either function returns is UNTRUSTED text extracted from an external site. This
//      module does NOT sanitize it for prompt-injection purposes — callers MUST wrap it via
//      lib/safety/untrusted.js's fenceUntrusted() before any of it reaches an executeAgent/LLM
//      call. Treat every string field (title, description, headings[].text, paragraphs[],
//      listItems[], navLabels[]) as hostile, attacker-controlled text.
//  (b) Network safety (SSRF IP-pinning, redirect re-validation, byte + time caps) lives in
//      lib/net/safe-fetch — every fetch here goes through it. On top of that, this module adds a
//      SCOPE boundary: only same-ORIGIN links discovered on the homepage are ever crawled (exact
//      hostname match, not a suffix/subdomain match), each fetch shares one wall-clock deadline
//      budget, and each page fetch is capped at 1.5MB. A failed or timed-out subpage is silently
//      dropped (with a note) rather than failing the whole scrape; only a hard failure fetching the
//      initial URL throws.
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

// Research mode is deliberately narrower: only commercial/factual pages, never a blog or docs
// archive — the point is a few real facts (price, features), not a corpus to draw phrasing from.
const MAX_RESEARCH_PAGES = 3;        // the given URL + up to 2 more
const RESEARCH_PRIORITY_TERMS = ['pricing', 'plan', 'product', 'service', 'feature', 'faq'];

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
function navPriorityScore(anchor, terms) {
  const hay = `${anchor.text} ${anchor.href}`.toLowerCase();
  for (let i = 0; i < terms.length; i++) {
    if (hay.includes(terms[i])) return terms.length - i;
  }
  return 0;
}

// Shared crawl+parse core for both public entry points below. `maxPages`/`priorityTerms` are the
// only things that differ between them (redesign: broad IA terms, 6 pages; research: commercial-
// only terms, 3 pages) — everything else (same-origin scope, caps, safeFetch) is identical.
async function crawlAndParse(rawUrl, { deadlineMs, maxPages, priorityTerms }) {
  const deadline = Date.now() + (deadlineMs || DEFAULT_DEADLINE_MS);
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
    const score = navPriorityScore(a, priorityTerms);
    const existing = candidateMap.get(abs);
    if (!existing || score > existing.score) candidateMap.set(abs, { score, text: a.text });
  }
  const ranked = [...candidateMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([url]) => url);
  const subpageUrls = ranked.slice(0, Math.max(0, maxPages - 1));

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
    if (pages.length >= maxPages) break;
  }

  const title = extractTitle(homeHtml);
  return { sourceUrl: base.href, title, pages, navLabels, notes };
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
  return crawlAndParse(rawUrl, { deadlineMs: opts.deadlineMs, maxPages: MAX_TOTAL_PAGES, priorityTerms: NAV_PRIORITY_TERMS });
}

/**
 * Gather a BOUNDED set of facts about a third-party product (the given URL + up to 2 same-origin
 * pricing/feature pages — never a blog or docs archive) to ground original affiliate/comparison
 * copy. This is fact-gathering, not content acquisition: the returned text is for a writer to cite
 * facts from (price figures, feature names, specs) in THEIR OWN words — it must never be
 * reproduced or closely paraphrased. See pipeline.js's researchContentNote() for the instruction
 * this is paired with. Same safety posture as scrapeSite (SSRF-pinned, same-origin only, capped).
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.deadlineMs=25000]
 * @returns {Promise<{sourceUrl, title, pages, navLabels, notes}>}
 */
async function scrapeForResearch(rawUrl, opts = {}) {
  return crawlAndParse(rawUrl, { deadlineMs: opts.deadlineMs, maxPages: MAX_RESEARCH_PAGES, priorityTerms: RESEARCH_PRIORITY_TERMS });
}

module.exports = { scrapeSite, scrapeForResearch };
