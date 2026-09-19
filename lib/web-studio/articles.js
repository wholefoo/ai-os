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

/** Published, newest first. Drafts never reach a rendered page. Every kind — see entriesOfKind. */
function publishedArticles(plan) {
  const list = Array.isArray(plan && plan.articles) ? plan.articles : [];
  return list.filter((a) => a && a.slug && a.title && !a.draft)
    .slice(0, MAX_ARTICLES)
    .sort((x, y) => String(y.publishedAt || '').localeCompare(String(x.publishedAt || '')));
}

// An entry with no `kind` predates videos and is an article. This default is what keeps every
// existing plan rendering exactly as it did.
const kindOf = (e) => (e && e.kind === 'video' ? 'video' : 'article');
const entriesOfKind = (plan, kind) => publishedArticles(plan).filter((e) => kindOf(e) === kind);

/** /video/<slug> for videos, /article/<slug> (or the plan's prefix) for everything else. */
function entryPath(plan, entry) {
  return kindOf(entry) === 'video' ? '/video/' + entry.slug : articlePath(plan, entry.slug);
}

const siteOrigin = (plan) => (plan && plan.domain
  ? 'https://' + String(plan.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : null);

// "12:34" -> "PT12M34S", "1:02:03" -> "PT1H2M3S". schema.org wants ISO 8601 durations.
function isoDuration(d) {
  const parts = String(d || '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s || (!h && !m) ? (s || 0) + 'S' : '');
}

/** The poster image: an explicit cover wins, else YouTube's own thumbnail. */
function videoPoster(entry) {
  if (entry.image) return entry.image;
  return entry.youtubeId ? 'https://i.ytimg.com/vi/' + entry.youtubeId + '/hqdefault.jpg' : '';
}

/**
 * schema.org VideoObject. Google requires name, description, thumbnailUrl and uploadDate; the date
 * is emitted ONLY when real, for the same reason articleLd refuses to invent one. A video without a
 * real date is a slightly weaker search result, and a video with a fabricated one is a false claim.
 */
function videoLd(plan, entry, url) {
  const ld = { '@context': 'https://schema.org', '@type': 'VideoObject', name: entry.title };
  ld.description = entry.excerpt || entry.title;
  const poster = videoPoster(entry);
  if (poster) ld.thumbnailUrl = /^https?:/i.test(poster) ? poster : (siteOrigin(plan) || '') + poster;
  if (entry.publishedAt) ld.uploadDate = entry.publishedAt;
  const dur = entry.duration ? isoDuration(entry.duration) : null;
  if (dur) ld.duration = dur;
  if (entry.youtubeId) ld.embedUrl = 'https://www.youtube-nocookie.com/embed/' + entry.youtubeId;
  if (entry.videoUrl) ld.contentUrl = entry.videoUrl;
  if (url) ld.url = url;
  if (Array.isArray(entry.tags) && entry.tags.length) ld.keywords = entry.tags.join(', ');
  if (plan && plan.siteName) ld.publisher = { '@type': 'Organization', name: plan.siteName };
  return ld;
}

/** One listing row, shared by every index so they cannot drift apart. */
function listItem(plan, e) {
  return {
    title: e.title,
    href: entryPath(plan, e),
    excerpt: e.excerpt,
    meta: metaLine(e),
    category: e.category || '',
    image: kindOf(e) === 'video' ? videoPoster(e) : (e.image || ''),
    kind: kindOf(e),
    duration: e.duration || '',
    tags: Array.isArray(e.tags) ? e.tags.map((t) => ({ label: t, href: '/tags/' + tagSlug(t) })) : [],
  };
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
  // A video's useful length is its running time; "3 min read" of its show notes would be misleading.
  if (article.kind === 'video') { if (article.duration) bits.push(article.duration); }
  else if (article.html) bits.push(readingMinutes(article.html) + ' min read');
  return bits.join(' · ');
}

/**
 * Expand plan.articles into real pages: one per published article, plus an index listing.
 * Returns a NEW plan; the input is not mutated. A hand-written page at the same path always wins.
 */
function expandArticlePages(plan) {
  const all = publishedArticles(plan);
  if (!all.length) return plan;

  const out = { ...plan, pages: [...(Array.isArray(plan.pages) ? plan.pages : [])] };
  const taken = new Set(out.pages.map((p) => p && p.path));
  const origin = siteOrigin(plan);
  // A hand-written page at the same path ALWAYS wins over a generated one.
  const add = (page) => { if (taken.has(page.path)) return false; taken.add(page.path); out.pages.push(page); return true; };
  const tagLinks = (e) => (Array.isArray(e.tags) ? e.tags : []).map((t) => ({ label: t, href: '/tags/' + tagSlug(t) }));

  const articles = all.filter((e) => kindOf(e) === 'article');
  const videos = all.filter((e) => kindOf(e) === 'video');

  for (const a of articles) {
    const p = articlePath(plan, a.slug);
    add({
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
        tags: tagLinks(a),
        source: a.source || null,
      }],
      extraLd: [articleLd(plan, a, origin ? origin + p : null)],
    });
  }

  for (const v of videos) {
    const p = entryPath(plan, v);
    add({
      path: p,
      title: (v.seo && v.seo.title) || v.title,
      description: (v.seo && v.seo.description) || v.excerpt,
      _article: v.slug,
      sections: [{
        type: 'video',
        eyebrow: v.category || '',
        heading: v.title,
        standfirst: v.excerpt || '',
        meta: metaLine(v),
        youtubeId: v.youtubeId || '',
        videoUrl: v.videoUrl || '',
        poster: videoPoster(v),
        html: v.html || '',
        tags: tagLinks(v),
        source: v.source || null,
      }],
      extraLd: [videoLd(plan, v, origin ? origin + p : null)],
    });
  }

  // Article index — ARTICLES ONLY, as it always was. Only emitted when there is an article to list,
  // so a video-only site does not get an empty "Articles" page.
  const ip = indexPath(plan);
  if (articles.length && plan.articleIndex !== false) {
    add({
      path: ip,
      title: plan.articleIndexTitle || 'Articles',
      description: 'All articles from ' + (plan.siteName || 'this site') + '.',
      _articleIndex: true,
      sections: [{ type: 'articleList', heading: plan.articleIndexTitle || 'Articles',
        items: articles.map((a) => listItem(plan, a)) }],
    });
  }

  if (videos.length) {
    add({
      path: '/videos',
      title: plan.videoIndexTitle || 'Videos',
      description: 'All videos from ' + (plan.siteName || 'this site') + '.',
      _articleIndex: true,
      sections: [{ type: 'articleList', heading: plan.videoIndexTitle || 'Videos',
        emptyText: 'No videos yet.', items: videos.map((v) => listItem(plan, v)) }],
    });
  }

  // Tags: one page per tag listing every kind, plus an index. Grouped by SLUG so "AI" and "ai" on
  // different entries share a page; the first spelling seen is the display label.
  const byTag = new Map();
  for (const e of all) {
    for (const t of (Array.isArray(e.tags) ? e.tags : [])) {
      const k = tagSlug(t);
      if (!k) continue;
      if (!byTag.has(k)) byTag.set(k, { label: t, entries: [] });
      byTag.get(k).entries.push(e);
    }
  }
  if (byTag.size) {
    const sorted = [...byTag.entries()].sort((x, y) => y[1].entries.length - x[1].entries.length
      || x[1].label.localeCompare(y[1].label));
    for (const [k, g] of sorted) {
      add({
        path: '/tags/' + k,
        title: 'Tagged "' + g.label + '"',
        description: g.entries.length + ' item' + (g.entries.length === 1 ? '' : 's') + ' tagged '
          + g.label + ' on ' + (plan.siteName || 'this site') + '.',
        _articleIndex: true,
        sections: [{ type: 'articleList', heading: g.label, eyebrow: 'Tag',
          items: g.entries.map((e) => listItem(plan, e)) }],
      });
    }
    add({
      path: '/tags',
      title: 'Tags',
      description: 'Every topic on ' + (plan.siteName || 'this site') + '.',
      _articleIndex: true,
      sections: [{ type: 'tagCloud', heading: 'Tags',
        tags: sorted.map(([k, g]) => ({ label: g.label, href: '/tags/' + k, count: g.entries.length })) }],
    });
  }

  // Start here: featured entries of any kind. Absent entirely when nothing is featured, rather
  // than an empty page telling visitors there is nothing to start with.
  const featured = all.filter((e) => e.featured === true);
  if (featured.length) {
    add({
      path: '/start-here',
      title: plan.startHereTitle || 'Start here',
      description: plan.startHereIntro || ('The best place to begin with ' + (plan.siteName || 'this site') + '.'),
      _articleIndex: true,
      sections: [{ type: 'articleList', heading: plan.startHereTitle || 'Start here',
        intro: plan.startHereIntro || '', items: featured.map((e) => listItem(plan, e)) }],
    });
  }
  return out;
}

/**
 * RSS 2.0 for every published entry, newest first, capped at 50 — the hub's feed, emitted as a
 * static file. Needs absolute URLs, so like the sitemap it is only produced when the plan knows
 * its domain. `canonicalOf` is injected so links match the canonical tags exactly, trailing slash
 * included — a feed pointing at redirecting URLs is the defect f4a6529 fixed for the sitemap.
 */
function rssXml(plan, canonicalOf) {
  const origin = siteOrigin(plan);
  if (!origin) return '';
  const x = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = publishedArticles(plan).slice(0, 50).map((e) => {
    const link = canonicalOf({ path: entryPath(plan, e) });
    const lines = ['    <item>', '      <title>' + x(e.title) + '</title>',
      '      <link>' + x(link) + '</link>', '      <guid isPermaLink="true">' + x(link) + '</guid>'];
    if (e.excerpt) lines.push('      <description>' + x(e.excerpt) + '</description>');
    // Undated entries carry no pubDate — never an invented one.
    if (e.publishedAt) lines.push('      <pubDate>' + new Date(e.publishedAt).toUTCString() + '</pubDate>');
    for (const t of (Array.isArray(e.tags) ? e.tags : [])) lines.push('      <category>' + x(t) + '</category>');
    lines.push('    </item>');
    return lines.join('\n');
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
    + '  <channel>\n'
    + '    <title>' + x(plan.siteName || 'Site') + '</title>\n'
    + '    <link>' + x(origin + '/') + '</link>\n'
    + '    <description>' + x(plan.description || plan.siteName || '') + '</description>\n'
    + '    <atom:link href="' + x(origin + '/rss.xml') + '" rel="self" type="application/rss+xml" />\n'
    + items.join('\n') + (items.length ? '\n' : '')
    + '  </channel>\n</rss>\n';
}

/** Does the plan have anything a feed could list? Drives the <link rel=alternate> in the head. */
function planHasFeed(plan) {
  return !!siteOrigin(plan) && publishedArticles(plan).length > 0;
}

// Exported as `articleSlug`, not `slugify`: lib/pipeline-reports.js already exports a `slugify`
// with different rules (this one caps at 80 chars and folds unicode quotes). Two different slug
// functions under one name is a genuine ambiguity for anything that re-exports either, so the name
// says which one it is. `publishedArticles` and `articleLd` are used internally only.
module.exports = {
  articleSlug: slugify, normalizeArticle, expandArticlePages, articlePath, indexPath,
  metaLine, readingMinutes, wordCount, isoOrNull,
  youtubeId, tagSlug, rssXml, planHasFeed,
  MAX_ARTICLES, MAX_BODY_CHARS,
};
