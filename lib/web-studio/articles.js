// lib/web-studio/articles.js
// ============================================================
//  The content model behind the no-code content backend: articles as a first-class collection on
//  the plan, expanded deterministically into real pages at render time.
//
//  WHY NOT plan.dynamic. That mechanism (template + items + {{var}} substitution) already exists,
//  but it is a generic dataset-to-pages tool: items are opaque rows, there is no notion of a body,
//  an excerpt, a publish date or a draft, and every page it makes is the same shape. Articles need
//  to be edited one at a time, ordered by date, hidden while drafting, and rendered with real
//  Article structured data. Squeezing that into {{var}} substitution would make both features worse.
//  plan.dynamic keeps working, untouched, alongside this.
//
//  EVERYTHING HERE IS PURE. Expansion returns a NEW plan with pages appended, so every downstream
//  emitter (sitemap, llms.txt, JSON-LD, the OKF bundle, the WCAG gate) sees article pages exactly
//  as it sees hand-written ones — no emitter needs to know articles exist.
//
//  Bodies are sanitised on the way IN (here) and again at render (the article section). Both,
//  deliberately: an article can reach the plan without passing through this module (a restored
//  backup, an adopted import, a hand-edited state file), and sanitizeHtml is idempotent.
// ============================================================
'use strict';

const { sanitizeHtml, htmlToText } = require('./sanitize-html');

const MAX_ARTICLES = 500;          // plan objects are held in memory and saved whole; see saveState
const MAX_BODY_CHARS = 600000;     // the recovered Oregon constitution is ~383k, so this is ~1.5x
const MAX_TITLE = 200;
const MAX_EXCERPT = 500;
const DEFAULT_PREFIX = 'article';

const WORDS_PER_MINUTE = 220;

function slugify(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function readingMinutes(html) {
  const words = htmlToText(html).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function wordCount(html) {
  return htmlToText(html).split(/\s+/).filter(Boolean).length;
}

/** ISO string, or null. Never invents a date — an absent date stays absent. */
function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(/^\d{10}$/.test(String(v)) ? Number(v) * 1000 : v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const clamp = (s, n) => String(s == null ? '' : s).slice(0, n);

/**
 * Validate and normalise an article submitted by the content API.
 * Throws on the errors a caller must fix; silently normalises the rest.
 * @param {object} input
 * @param {{existing?:object, now?:string}} [opts]
 */
function normalizeArticle(input, opts = {}) {
  const a = input && typeof input === 'object' ? input : {};
  const existing = opts.existing || null;
  const now = opts.now || new Date().toISOString();

  const title = clamp(a.title, MAX_TITLE).trim();
  if (!title) throw new Error('title is required');

  // A slug is derived from the title only when one was not supplied AND none exists. Changing a
  // title must never silently move a published URL — that is a link-rot bug, not a convenience.
  let slug = slugify(a.slug || (existing ? existing.slug : '') || title);
  if (!slug) throw new Error('could not derive a usable slug from the title');

  const rawBody = typeof a.html === 'string' ? a.html : (existing ? existing.html : '') || '';
  if (rawBody.length > MAX_BODY_CHARS) throw new Error('body exceeds ' + MAX_BODY_CHARS + ' characters');
  const html = sanitizeHtml(rawBody, { maxLength: MAX_BODY_CHARS });

  // An excerpt is derived from the body when absent, because meta descriptions are an AEO scoring
  // dimension and an empty one costs points. Derived text is truncated on a word boundary.
  let excerpt = clamp(a.excerpt, MAX_EXCERPT).trim();
  if (!excerpt) {
    const text = htmlToText(html);
    excerpt = text.length > 200 ? text.slice(0, 200).replace(/\s+\S*$/, '') + '…' : text;
  }

  const seo = a.seo && typeof a.seo === 'object' ? a.seo : {};

  return {
    slug,
    title,
    excerpt,
    html,
    image: typeof a.image === 'string' && a.image.trim() ? a.image.trim() : null,
    imageAlt: clamp(a.imageAlt, 300).trim() || '',
    category: clamp(a.category, 120).trim() || null,
    author: clamp(a.author, 160).trim() || null,
    // `now` is the right default for an article CREATED here — it is genuinely published now.
    // It is the wrong default for ADOPTED content, where an unknown date became a false claim:
    // two live sites rendered "14 September 2026" above prose that read "June 24, 2023".
    // opts.undatedOk lets a caller say "the source has no date" and keep it null; metaLine and the
    // JSON-LD both already omit the date when it is falsy, so an undated article renders cleanly.
    publishedAt: isoOrNull(a.publishedAt) || (existing ? existing.publishedAt : null)
      || (opts.undatedOk ? null : now),
    updatedAt: now,
    createdAt: (existing && existing.createdAt) || now,
    draft: a.draft === true || a.draft === 'true',
    seo: {
      title: clamp(seo.title, MAX_TITLE).trim() || null,
      description: clamp(seo.description, MAX_EXCERPT).trim() || null,
    },
  };
}

/** The public URL path for an article, e.g. /article/my-post. */
function articlePath(plan, slug) {
  const prefix = slugify((plan && plan.articlePrefix) || DEFAULT_PREFIX) || DEFAULT_PREFIX;
  return '/' + prefix + '/' + slug;
}

function indexPath(plan) {
  const prefix = slugify((plan && plan.articlePrefix) || DEFAULT_PREFIX) || DEFAULT_PREFIX;
  return '/' + prefix + 's';                 // /article -> /articles
}

/** Published, newest first. Drafts never reach a rendered page. */
function publishedArticles(plan) {
  const list = Array.isArray(plan && plan.articles) ? plan.articles : [];
  return list.filter((a) => a && a.slug && a.title && !a.draft)
    .slice(0, MAX_ARTICLES)
    .sort((x, y) => String(y.publishedAt || '').localeCompare(String(x.publishedAt || '')));
}

/** schema.org Article for one article page — the AEO scorer's structured_data dimension. */
function articleLd(plan, article, url) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    articleBody: undefined,                   // never inline the whole body into JSON-LD
    wordCount: wordCount(article.html),
    inLanguage: 'en',
  };
  if (article.excerpt) ld.description = article.excerpt;
  if (url) { ld.url = url; ld.mainEntityOfPage = { '@type': 'WebPage', '@id': url }; }
  // Dates are emitted ONLY when real. A fabricated datePublished is a factual claim to every
  // consumer that reads it (the rebuilt Truth Counters site has no source dates, and says nothing).
  if (article.publishedAt) ld.datePublished = article.publishedAt;
  if (article.updatedAt) ld.dateModified = article.updatedAt;
  if (article.author) ld.author = { '@type': 'Person', name: article.author };
  if (article.category) ld.articleSection = article.category;
  if (article.image) ld.image = article.image;
  if (plan && plan.siteName) ld.publisher = { '@type': 'Organization', name: plan.siteName };
  delete ld.articleBody;
  return ld;
}

/** The human byline under the title: "By X · 12 March 2026 · 6 min read", omitting what is absent. */
function metaLine(article) {
  const bits = [];
  if (article.author) bits.push('By ' + article.author);
  if (article.publishedAt) {
    const d = new Date(article.publishedAt);
    if (!isNaN(d.getTime())) {
      bits.push(d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }));
    }
  }
  if (article.html) bits.push(readingMinutes(article.html) + ' min read');
  return bits.join(' · ');
}

/**
 * Expand plan.articles into real pages: one per published article, plus an index listing.
 * Returns a NEW plan; the input is not mutated. A hand-written page at the same path always wins.
 */
function expandArticlePages(plan) {
  const articles = publishedArticles(plan);
  if (!articles.length) return plan;

  const out = { ...plan, pages: [...(Array.isArray(plan.pages) ? plan.pages : [])] };
  const taken = new Set(out.pages.map((p) => p && p.path));

  for (const a of articles) {
    const p = articlePath(plan, a.slug);
    if (taken.has(p)) continue;               // a hand-written page beats a generated one
    taken.add(p);
    out.pages.push({
      path: p,
      title: (a.seo && a.seo.title) || a.title,
      description: (a.seo && a.seo.description) || a.excerpt,
      _article: a.slug,                       // marks the page as article-generated (used by the UI)
      sections: [{
        type: 'article',
        eyebrow: a.category || '',
        heading: a.title,
        standfirst: a.excerpt || '',
        meta: metaLine(a),
        image: a.image || '',
        imageAlt: a.imageAlt || '',
        html: a.html,
      }],
      extraLd: [articleLd(plan, a, plan.domain ? 'https://' + String(plan.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '') + p : null)],
    });
  }

  // Index page. Skipped when the plan already has a page there, or when explicitly disabled.
  const ip = indexPath(plan);
  if (plan.articleIndex !== false && !taken.has(ip)) {
    out.pages.push({
      path: ip,
      title: plan.articleIndexTitle || 'Articles',
      description: 'All articles from ' + (plan.siteName || 'this site') + '.',
      _articleIndex: true,
      sections: [{
        type: 'articleList',
        heading: plan.articleIndexTitle || 'Articles',
        items: articles.map((a) => ({
          title: a.title,
          href: articlePath(plan, a.slug),
          excerpt: a.excerpt,
          meta: metaLine(a),
          category: a.category || '',
          image: a.image || '',
        })),
      }],
    });
  }
  return out;
}

// Exported as `articleSlug`, not `slugify`: lib/pipeline-reports.js already exports a `slugify`
// with different rules (this one caps at 80 chars and folds unicode quotes). Two different slug
// functions under one name is a genuine ambiguity for anything that re-exports either, so the name
// says which one it is. `publishedArticles` and `articleLd` are used internally only.
module.exports = {
  articleSlug: slugify, normalizeArticle, expandArticlePages, articlePath, indexPath,
  metaLine, readingMinutes, wordCount, isoOrNull,
  MAX_ARTICLES, MAX_BODY_CHARS,
};
