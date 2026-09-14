// lib/web-studio/adopt.js
// ============================================================
//  Adoption: turn a STATIC IMPORTED site into a plan-backed one, so it gains the no-code content
//  backend (and with it the AEO emitters, which are all plan-driven).
//
//  WHAT THIS COSTS, STATED PLAINLY. An imported site's design lives in its own HTML and CSS. A
//  plan-backed site is rendered from the Astro templates in pipeline.js. Adoption therefore keeps
//  the CONTENT and replaces the PRESENTATION. That is a real loss and the caller must choose it
//  knowingly — hence derivePlan() is pure and the route offers a dry run, so the whole result can
//  be inspected before anything is written.
//
//  WHERE THE HTML COMES FROM. Two sources, because they answer different questions:
//    * 'workspace' — the site's imported source files. The normal case.
//    * 'live'      — the deployed release the domain is actually serving. This exists because a
//                    workspace can be STALE: both recovered sites (truthcountersdeception.com,
//                    oregonpolitiscape.com) were rebuilt and deployed by hand into release
//                    directories, so their workspaces still hold the old contentless SPA while the
//                    live release holds the real articles. Adopting the workspace would import
//                    nothing; adopting the live release imports what readers actually see.
//
//  EXTRACTION IS CONSERVATIVE AND HONEST. There is no way to reliably separate content from chrome
//  in arbitrary HTML. So every page reports a `confidence` and the warnings that produced it, and
//  a page that yields too little text is flagged rather than silently published as a stub.
// ============================================================
'use strict';

const { sanitizeHtml, htmlToText } = require('./sanitize-html');
const { normalizeArticle, slugify } = require('./articles');

// Two thresholds, not one. A single "too short to adopt" floor cannot tell a legitimately brief
// page from an empty app shell, and set high enough to catch shells it DROPS REAL PAGES: on the
// real rebuilt sites a 200-char floor skipped Oregon's contact page (social links, no prose) and a
// single-entry category index. Losing a real page to a heuristic is the worse error, so:
//   < EMPTY_TEXT        -> refuse (nothing to adopt)
//   < THIN_TEXT         -> adopt, but flagged thin so the operator can see it
//   an SPA shell        -> refuse regardless of length (see extractPage)
const EMPTY_TEXT = 40;
const THIN_TEXT = 200;
const MIN_BODY_TEXT = THIN_TEXT;    // kept as the documented "healthy page" mark
const MAX_PAGES = 500;

// Chrome that is never article content. Removed WITH their contents before picking a container.
const CHROME = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form', 'svg', 'iframe'];

function stripChrome(html) {
  let s = String(html || '');
  for (const tag of CHROME) {
    s = s.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?</' + tag + '\\s*>', 'gi'), ' ');
  }
  return s;
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

/** Slice an element and its contents by tag, respecting nesting. */
function sliceElement(html, openRe, tag) {
  const m = html.match(openRe);
  if (!m) return null;
  const start = html.indexOf('>', m.index) + 1;
  const open = new RegExp('<' + tag + '[\\s>]', 'gi');
  const close = new RegExp('</' + tag + '\\s*>', 'gi');
  let depth = 1, i = start;
  while (depth > 0 && i < html.length) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(html); const c = close.exec(html);
    if (!c) return html.slice(start);
    if (o && o.index < c.index) { depth++; i = o.index + 1; }
    else { depth--; if (depth === 0) return html.slice(start, c.index); i = c.index + 1; }
  }
  return null;
}

// `title` and `description` are TEXT fields: every consumer escapes them for its own context (HTML
// attribute, body text, JSON-LD). They are read out of HTML source, though, where entities are
// mandatory — so "A &amp; B" must be decoded to "A & B" here or it gets escaped a SECOND time and
// renders as the literal "&amp;". Found on Oregon's home page title; no Truth Counters title
// contained an ampersand, which is why adoption looked clean the first time.
// Deliberately NOT applied to the body html — the sanitizer preserves entities there, correctly.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/g, (m, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Reject anything that is not a real scalar value rather than emitting U+FFFD.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const lower = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, lower) ? NAMED[lower] : m;
  });
}

/**
 * Pull title, description and the main content out of one HTML document.
 * Returns { title, description, html, text, confidence, warnings, container }.
 */
function extractPage(rawHtml) {
  const warnings = [];
  const html = String(rawHtml || '');

  const title = decodeEntities(firstMatch(html, /<title>([\s\S]*?)<\/title>/i) || '')
    .replace(/\s+/g, ' ').trim();
  const description = decodeEntities(
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || '').trim();

  // Prefer real semantics; fall back to the densest block. Each step is less trustworthy than the
  // last, and `confidence` says so rather than pretending they are equivalent.
  const body = sliceElement(html, /<body[^>]*>/i, 'body') || html;
  const cleaned = stripChrome(body);
  let container = null;
  let picked = sliceElement(cleaned, /<main[^>]*>/i, 'main');
  if (picked) container = 'main';
  if (!picked) { picked = sliceElement(cleaned, /<article[^>]*>/i, 'article'); if (picked) container = 'article'; }
  if (!picked) {
    const byRole = sliceElement(cleaned, /<div[^>]*(?:id|class)=["'][^"']*(?:content|post|entry|prose|article)[^"']*["'][^>]*>/i, 'div');
    if (byRole) { picked = byRole; container = 'content-div'; }
  }
  if (!picked) { picked = cleaned; container = 'body'; warnings.push('no <main>, <article> or content container found — used the whole body, which may include chrome'); }

  const safe = sanitizeHtml(picked);
  const text = htmlToText(safe);

  let confidence = container === 'main' || container === 'article' ? 'high'
    : container === 'content-div' ? 'medium' : 'low';
  if (text.length < THIN_TEXT) { warnings.push(`only ${text.length} characters of text extracted`); confidence = 'low'; }
  if (!title) warnings.push('no <title> element');
  if (!description) warnings.push('no meta description');
  // An app shell: markup present, prose absent because JavaScript renders it. This is the exact
  // shape that was imported and published with no content, so it is refused on its own signal
  // rather than on length — a shell can carry more than EMPTY_TEXT characters of chrome.
  const isShell = /<div[^>]+id=["'](?:root|app|__next)["']/i.test(html) && text.length < THIN_TEXT;
  if (isShell) {
    warnings.push('looks like a single-page-app shell — the content is rendered by JavaScript and is not in the HTML');
    confidence = 'low';
  }

  return { title, description, html: safe, text, confidence, warnings, container, isShell, empty: text.length < EMPTY_TEXT };
}

// A <title> is written for the browser tab, so it usually carries the site name: "My Post | Site"
// or "My Post - Site". Adopting that verbatim puts the suffix in every h1, every listing entry and
// every Article headline. Stripped only when the tail actually matches the site name — never by
// guessing at the separator alone, which would truncate a title that legitimately contains one
// ("Fact-Checkers: Unbiased Analysis or Biased Verification").
function stripSiteSuffix(title, siteName) {
  const t = String(title || '').trim();
  const site = String(siteName || '').trim();
  if (!t || !site) return t;
  const m = t.match(/^([\s\S]+?)\s*[|–—-]\s*([^|–—-]+)$/);
  if (!m) return t;
  const tail = m[2].trim().toLowerCase();
  const name = site.toLowerCase();
  if (tail === name || tail === name.replace(/^the\s+/, '')) return m[1].trim() || t;
  return t;
}

/** Is this file path an article under the given prefix, e.g. article/my-post/index.html? */
function articleSlugFor(relPath, prefix) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const re = new RegExp('^' + prefix + '/([^/]+)/index\\.html$', 'i');
  const m = p.match(re) || p.match(new RegExp('^' + prefix + '/([^/]+)\\.html$', 'i'));
  return m ? slugify(m[1]) : null;
}

/** Turn a file path into a site path: about/index.html -> /about, index.html -> / */
function sitePathFor(relPath) {
  let p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  p = p.replace(/index\.html$/i, '').replace(/\.html$/i, '');
  p = '/' + p.replace(/^\/+|\/+$/g, '');
  return p === '/' ? '/' : p.replace(/\/$/, '');
}

/**
 * Derive a plan from a set of static HTML files. PURE — no filesystem, no mutation.
 * @param {Array<{path:string, html:string}>} files
 * @param {{siteName?:string, domain?:string, articlePrefix?:string, base?:object}} [opts]
 */
function derivePlan(files, opts = {}) {
  const prefix = slugify(opts.articlePrefix || 'article') || 'article';
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && typeof f.html === 'string')
    .slice(0, MAX_PAGES);

  const pages = [];
  const articles = [];
  const report = [];
  const skipped = [];

  for (const f of list) {
    const rel = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/\.html?$/i.test(rel)) continue;
    const ex = extractPage(f.html);
    ex.title = stripSiteSuffix(ex.title, opts.siteName);
    const slug = articleSlugFor(rel, prefix);
    const entry = {
      file: rel, kind: slug ? 'article' : 'page', title: ex.title, chars: ex.text.length,
      confidence: ex.confidence, container: ex.container, warnings: ex.warnings,
    };

    // Refuse only what has nothing to adopt, or what is an app shell — publishing an empty shell
    // over real content is the failure this whole exercise exists to avoid. A merely SHORT page
    // (a contact page, a sparse category index) is adopted and flagged, because dropping a real
    // page to a length heuristic is the worse error.
    if (ex.empty || ex.isShell) {
      entry.adopted = false;
      entry.reason = ex.isShell
        ? 'single-page-app shell — its content is not in the HTML'
        : `nothing to adopt (${ex.text.length} characters of text)`;
      skipped.push(entry); report.push(entry);
      continue;
    }
    entry.adopted = true;
    entry.thin = ex.text.length < THIN_TEXT;
    report.push(entry);

    if (slug) {
      try {
        articles.push(normalizeArticle({
          slug, title: ex.title || slug, excerpt: ex.description || '', html: ex.html,
        }, { now: opts.now }));
      } catch (e) {
        entry.adopted = false; entry.reason = e.message; skipped.push(entry);
      }
      continue;
    }

    pages.push({
      path: sitePathFor(rel),
      title: ex.title || sitePathFor(rel),
      description: ex.description || '',
      sections: [{ type: 'article', html: ex.html }],
    });
  }

  // Deduplicate page paths; the first file wins (index.html sorts before deeper paths).
  const seen = new Set();
  const uniquePages = pages.filter((p) => (seen.has(p.path) ? false : seen.add(p.path)));
  if (!uniquePages.some((p) => p.path === '/')) {
    // Without a home page the built site has no index.html and cannot be published.
    uniquePages.unshift({
      path: '/', title: opts.siteName || 'Home', description: '',
      sections: [{ type: 'articleList', heading: 'Articles', items: [] }],
    });
    report.push({ file: '(generated)', kind: 'page', title: 'Home', adopted: true, confidence: 'low',
      warnings: ['no index.html was found, so a placeholder home page was generated'] });
  }

  const base = opts.base && typeof opts.base === 'object' ? opts.base : {};
  const plan = {
    ...base,
    siteName: opts.siteName || base.siteName || 'Site',
    domain: opts.domain || base.domain || '',
    articlePrefix: prefix,
    pages: uniquePages,
    articles,
  };

  return {
    plan,
    report,
    stats: {
      filesSeen: list.length,
      pagesAdopted: uniquePages.length,
      articlesAdopted: articles.length,
      skipped: skipped.length,
      lowConfidence: report.filter((r) => r.adopted && r.confidence === 'low').length,
      thin: report.filter((r) => r.adopted && r.thin).length,
    },
  };
}

module.exports = { derivePlan, extractPage, sitePathFor, articleSlugFor, stripChrome, stripSiteSuffix, MIN_BODY_TEXT, EMPTY_TEXT, THIN_TEXT };
