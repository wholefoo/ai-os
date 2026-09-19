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

// ---------------------------------------------------------------------------------------------
//  HUB FIELDS: kind (article|video), tags, source attribution, featured, and video media.
//  Ported from the standalone hub's ingest validator so content written for it behaves the same
//  here. Videos are a KIND on the same entry rather than a second collection: the hub's whole idea
//  is one feed, and a parallel collection would duplicate CRUD, drafts, upsert, ordering and every
//  future feature.
// ---------------------------------------------------------------------------------------------
const KINDS = new Set(['article', 'video']);
const MAX_TAGS = 10;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _+#.&-]{0,39}$/u;
const YT_ID = /^[\w-]{11}$/;
const DURATION_RE = /^\d{1,2}(:\d{2}){1,2}$/;

const isHttp = (v) => {
  try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
};
// A site path or an http(s) URL. Rejects javascript:, data:, vbscript: and protocol-relative //host,
// which would load from an arbitrary origin while looking like a path.
const isSafeUrl = (v) => typeof v === 'string' && v.length <= 2000
  && (isHttp(v) || /^\/(?!\/)[^\s]*$/.test(v));
// Images are more lenient than links: stored plans already hold relative paths like
// "images/x.webp", and rejecting those would make an existing article unsaveable. What matters for
// safety is the SCHEME, so refuse only the dangerous ones.
const isSafeImage = (v) => typeof v === 'string' && v.length <= 2000
  && !/^\s*(javascript|data|vbscript|file):/i.test(v) && !/^\s*\/\//.test(v);

/** Extract an 11-char YouTube id from an id or any common YouTube URL shape. Null if none. */
function youtubeId(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (YT_ID.test(t)) return t;
  try {
    const u = new URL(t);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/) || [])[1];
    }
    return id && YT_ID.test(id) ? id : null;
  } catch { return null; }
}

/**
 * URL slug for a tag. The hub's version mapped "C#" and "C++" both to "c", so two different tags
 * silently shared one tag page; the symbols are spelled out here to keep them apart.
 */
function tagSlug(tag) {
  return String(tag || '').toLowerCase()
    .replace(/#/g, '-sharp').replace(/\+/g, '-plus')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

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

  // ---- hub fields --------------------------------------------------------------------------
  // Every problem is collected, not just the first: a batch caller (n8n) needs the full list for
  // an item in one round trip. Thrown as ONE error whose message joins them, with the array on
  // .errors, so existing callers that only read e.message keep working unchanged.
  //
  // CARRY-OVER: each hub field falls back to the existing entry when the input omits it. The
  // current dashboard editor does not know these fields exist, so without this every UI save would
  // silently erase tags, attribution and video media that an ingest workflow had set.
  const errors = [];
  const has = (k) => a[k] !== undefined;
  const prev = existing || {};

  const kind = has('kind') ? a.kind : (prev.kind || 'article');
  if (!KINDS.has(kind)) errors.push('kind must be "article" or "video"');

  let tags = Array.isArray(prev.tags) ? prev.tags : [];
  if (has('tags')) {
    if (!Array.isArray(a.tags) || a.tags.length > MAX_TAGS
      || !a.tags.every((t) => typeof t === 'string' && TAG_RE.test(t.trim()))) {
      errors.push('tags must be an array of up to ' + MAX_TAGS
        + ' short labels (letters, numbers, spaces, - _ + # . &)');
    } else {
      // Deduplicate by URL slug, not by exact text: "AI" and "ai" would otherwise produce two
      // entries that render to the same tag page.
      const seen = new Set();
      tags = [];
      for (const t of a.tags.map((x) => x.trim())) {
        const k = tagSlug(t);
        if (k && !seen.has(k)) { seen.add(k); tags.push(t); }
      }
    }
  }

  let source = prev.source || null;
  if (has('source')) {
    const s = a.source;
    if (s === null) source = null;
    else if (!s || typeof s !== 'object' || !isHttp(s.url) || s.url.length > 2000
      || (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 120))) {
      errors.push('source must be {url: http(s) URL, name?: string up to 120 chars}');
    } else {
      source = { url: s.url };
      if (s.name && s.name.trim()) source.name = s.name.trim();
    }
  }

  let featured = prev.featured === true;
  if (has('featured')) {
    if (typeof a.featured !== 'boolean' && a.featured !== 'true' && a.featured !== 'false') {
      errors.push('featured must be a boolean');
    } else featured = a.featured === true || a.featured === 'true';
  }

  // `cover` is the hub's name for what Web Studio calls `image`; accept either.
  const imageIn = has('image') ? a.image : (has('cover') ? a.cover : undefined);
  let image = imageIn === undefined ? (prev.image || null)
    : (typeof imageIn === 'string' && imageIn.trim() ? imageIn.trim() : null);
  if (image && !isSafeImage(image)) { errors.push('image/cover must be an http(s) URL or a site path'); image = null; }

  let videoYoutubeId = prev.youtubeId || null;
  let videoUrl = prev.videoUrl || null;
  let duration = prev.duration || null;
  if (kind === 'video') {
    if (has('youtubeId') || has('youtubeUrl')) {
      const id = youtubeId(has('youtubeId') ? a.youtubeId : a.youtubeUrl);
      if (!id) errors.push('youtubeId must be an 11-character id or a YouTube URL');
      else videoYoutubeId = id;
    }
    if (has('videoUrl')) {
      if (a.videoUrl === null || a.videoUrl === '') videoUrl = null;
      else if (typeof a.videoUrl !== 'string' || !/^https:\/\//i.test(a.videoUrl) || !isHttp(a.videoUrl)) {
        errors.push('videoUrl must be an https URL');
      } else videoUrl = a.videoUrl;
    }
    if (has('duration')) {
      if (a.duration === null || a.duration === '') duration = null;
      else if (typeof a.duration !== 'string' || !DURATION_RE.test(a.duration)) {
        errors.push('duration must look like 12:34 or 1:02:03');
      } else duration = a.duration;
    }
    if (!videoYoutubeId && !videoUrl && !errors.length) {
      errors.push('a video needs a youtubeId (or youtubeUrl) or a videoUrl');
    }
  } else {
    // Switching an entry back to an article drops its media rather than leaving orphaned fields
    // that a later switch back to video would silently resurrect.
    videoYoutubeId = null; videoUrl = null; duration = null;
  }

  if (errors.length) {
    const e = new Error(errors.join('; '));
    e.errors = errors;
    throw e;
  }

  return {
    slug,
    title,
    excerpt,
    html,
    kind,
    image,
    imageAlt: clamp(a.imageAlt, 300).trim() || '',
    tags,
    source,
    featured,
    youtubeId: videoYoutubeId,
    videoUrl,
    duration,
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
  youtubeId, tagSlug,
  MAX_ARTICLES, MAX_BODY_CHARS,
};
