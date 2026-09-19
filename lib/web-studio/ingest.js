// lib/web-studio/ingest.js
// ============================================================
//  The hub's ingest contract, on Web Studio's content model: n8n, a scraper or a generator POSTs
//  one item, an array, or {items:[...]}, and the entries appear on the site.
//
//  Ported from hub/server/ingest-server.mjs so workflows written for the standalone hub keep
//  working. What is NOT ported is the hub's own server, token and Caddy/systemd setup: Web Studio
//  already authenticates (a `content` service key, confined to one site) and deploys atomically.
//
//  SEMANTICS THAT DIFFER FROM THE EDITOR, ON PURPOSE:
//    * UPSERT REPLACES. Re-posting a slug replaces that entry with exactly what was sent — the
//      hub's contract, where the item IS the item. The editor does the opposite (carry-over), and
//      both are right: the editor must not erase fields it cannot see; a scraper re-run must not
//      keep stale tags it no longer sends. Only createdAt survives a replace.
//    * DRAFTS BY DEFAULT. Machine-posted content stays off the live site until it says
//      draft:false, unless the site sets plan.ingestAutoPublish. Scraped or generated material
//      should be reviewed before it is public.
//    * ALL OR NOTHING. A batch is validated as a whole; if any item is invalid, nothing is written
//      and every problem in every item comes back in one response.
//
//  PURE: no I/O. The route owns persistence, locking and the build.
// ============================================================
'use strict';

const crypto = require('crypto');
const { marked } = require('marked');
const A = require('./articles');

const MAX_BATCH = 50;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MARKDOWN = { article: 500000, video: 100000 };

/** The items in a request body, or { error }. Accepts one item, an array, or {items:[...]}. */
function itemsOf(body) {
  let items;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === 'object' && Array.isArray(body.items)) items = body.items;
  else if (body && typeof body === 'object' && (body.title !== undefined || body.type !== undefined || body.kind !== undefined)) items = [body];
  else return { error: 'send one item, an array of items, or {"items": [...]}' };
  if (!items.length) return { error: 'no items to ingest' };
  if (items.length > MAX_BATCH) return { error: `a batch may hold at most ${MAX_BATCH} items (got ${items.length})` };
  return { items };
}

/**
 * The slug for an item. An explicit slug is validated, never altered. A derived slug comes from the
 * title; when the item carries a source URL, a short hash of that URL is appended — the hub's rule,
 * which is what makes re-running a scraper idempotent: the same source lands on the same entry even
 * if two sources share a headline.
 */
function slugFor(raw, title, source) {
  if (raw.slug !== undefined) {
    if (typeof raw.slug !== 'string' || raw.slug.length > 80 || !SLUG_RE.test(raw.slug)) {
      return { error: 'slug must be lowercase letters, numbers and single hyphens (max 80)' };
    }
    return { slug: raw.slug };
  }
  let slug = A.articleSlug(title) || 'untitled';
  if (source && typeof source.url === 'string') {
    slug = slug.slice(0, 50).replace(/-+$/, '') + '-'
      + crypto.createHash('sha1').update(source.url).digest('hex').slice(0, 6);
  }
  return { slug };
}

/**
 * Convert one hub-shaped item into a normalised entry, or collect every problem with it.
 * @returns {{entry:object}|{errors:string[], slug?:string}}
 */
function toEntry(raw, { now, autoPublish = false, existing = null } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['item must be an object'] };

  // `type` is the hub's name; `kind` is Web Studio's. Either, but they must agree.
  const kind = raw.type !== undefined ? raw.type : raw.kind;
  if (raw.type !== undefined && raw.kind !== undefined && raw.type !== raw.kind) errors.push('type and kind disagree');
  if (kind !== 'article' && kind !== 'video') errors.push('type must be "article" or "video"');

  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 200) errors.push('title required, max 200 characters');

  // Body: Markdown (the hub's `body`) or ready HTML (`html`). Never both — an item carrying two
  // bodies has no single meaning. Whichever it is, normalizeArticle sanitises the result: marked
  // passes raw HTML straight through, so the SANITISER is the security boundary, not the parser.
  if (raw.body !== undefined && raw.html !== undefined) errors.push('send body (Markdown) or html, not both');
  let html = '';
  if (raw.body !== undefined) {
    if (typeof raw.body !== 'string') errors.push('body must be a string');
    else {
      const md = raw.body.replace(/\r\n?/g, '\n').replace(/\0/g, '');
      const cap = MAX_MARKDOWN[kind] || MAX_MARKDOWN.article;
      if (md.length > cap) errors.push(`body max ${cap} characters`);
      else html = md.trim() ? marked.parse(md, { async: false }) : '';
    }
  } else if (raw.html !== undefined) {
    if (typeof raw.html !== 'string') errors.push('html must be a string');
    else html = raw.html;
  }
  if (kind === 'article' && !html.trim()) errors.push('body required for articles');

  if (raw.summary !== undefined && typeof raw.summary !== 'string') errors.push('summary must be a string');
  if (raw.draft !== undefined && typeof raw.draft !== 'boolean') errors.push('draft must be boolean');

  // publishedAt: omitted means NOW (the hub's contract — the item is being published now);
  // an explicit null means UNDATED, for scraped material whose date is unknown. Inventing "now"
  // for old content is the defect that stamped 2023 articles as published in 2026.
  let publishedAt;
  let undated = false;
  if (raw.publishedAt === null) undated = true;
  else if (raw.publishedAt !== undefined) {
    // A bare date is anchored at MIDDAY UTC, not midnight. new Date('2023-06-24') is midnight UTC,
    // which displays as June 23 everywhere in the Americas — the same defect adoption fixed.
    const text = typeof raw.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.publishedAt.trim())
      ? raw.publishedAt.trim() + 'T12:00:00Z' : raw.publishedAt;
    const d = new Date(text);
    if (typeof raw.publishedAt !== 'string' || Number.isNaN(+d)) errors.push('publishedAt must be an ISO date string or null');
    else publishedAt = d.toISOString();
  }

  const source = raw.source && typeof raw.source === 'object' ? raw.source : undefined;
  const s = title ? slugFor(raw, title, source) : { error: null };
  if (s.error) errors.push(s.error);

  if (errors.length) return { errors, slug: s.slug };

  // REPLACE semantics: every hub field is passed explicitly — absent means empty — and
  // normalizeArticle is called WITHOUT `existing`, so nothing carries over from the old entry.
  const input = {
    kind, title, slug: s.slug, html,
    excerpt: raw.summary !== undefined ? raw.summary : '',
    tags: raw.tags !== undefined ? raw.tags : [],
    featured: raw.featured !== undefined ? raw.featured : false,
    image: raw.cover !== undefined ? raw.cover : '',
    source: raw.source !== undefined ? raw.source : null,
    draft: typeof raw.draft === 'boolean' ? raw.draft : !autoPublish,
    publishedAt,
  };
  if (kind === 'video') {
    for (const k of ['youtubeId', 'youtubeUrl', 'videoUrl', 'duration']) if (raw[k] !== undefined) input[k] = raw[k];
  }
  try {
    const entry = A.normalizeArticle(input, { now, undatedOk: undated });
    if (existing && existing.createdAt) entry.createdAt = existing.createdAt;
    return { entry };
  } catch (e) {
    return { errors: Array.isArray(e.errors) ? e.errors : [e.message], slug: s.slug };
  }
}

/**
 * Validate a whole request against the site's current entries and produce the new list.
 * All or nothing: returns { errors } with one record per bad item, or { next, results }.
 * @param {*} body       the parsed request body
 * @param {object[]} list the site's current plan.articles
 */
function prepareBatch(body, list, { now = new Date().toISOString(), autoPublish = false } = {}) {
  const got = itemsOf(body);
  if (got.error) return { errors: [{ index: null, errors: [got.error] }] };

  const current = Array.isArray(list) ? list : [];
  const bySlug = new Map(current.map((e, i) => [e.slug, i]));
  const errors = [];
  const results = [];
  const seen = new Set();
  const next = [...current];
  let created = 0;

  got.items.forEach((raw, index) => {
    const peekSlug = raw && typeof raw === 'object' && typeof raw.title === 'string'
      ? slugFor(raw, raw.title.replace(/\s+/g, ' ').trim(), raw.source).slug : undefined;
    const existingAt = peekSlug !== undefined && bySlug.has(peekSlug) ? bySlug.get(peekSlug) : -1;
    const r = toEntry(raw, { now, autoPublish, existing: existingAt >= 0 ? current[existingAt] : null });
    if (r.errors) { errors.push({ index, slug: r.slug, errors: r.errors }); return; }
    const e = r.entry;
    // The same slug twice in one batch is ambiguous: which one wins would depend on array order.
    if (seen.has(e.slug)) { errors.push({ index, slug: e.slug, errors: ['this slug appears more than once in the batch'] }); return; }
    seen.add(e.slug);
    const at = bySlug.has(e.slug) ? bySlug.get(e.slug) : -1;
    // Slugs are unique across kinds here (the hub kept articles and videos in separate folders, so
    // it never had this problem). A video whose title matches an existing article would derive the
    // same slug and REPLACE the article — silent data loss from an innocent scraper run. Refused.
    const prevKind = at >= 0 ? (current[at].kind === 'video' ? 'video' : 'article') : null;
    if (prevKind && prevKind !== e.kind) {
      errors.push({ index, slug: e.slug, errors: [`the slug "${e.slug}" is already used by ${prevKind === 'video' ? 'a video' : 'an article'} — send an explicit slug for this ${e.kind}`] });
      return;
    }
    if (at >= 0) { next[at] = e; results.push({ index, slug: e.slug, kind: e.kind, action: 'updated', draft: e.draft }); }
    else { next.push(e); created++; results.push({ index, slug: e.slug, kind: e.kind, action: 'created', draft: e.draft }); }
  });

  if (!errors.length && current.length + created > A.MAX_ARTICLES) {
    errors.push({ index: null, errors: [`this would take the site past its ${A.MAX_ARTICLES}-entry limit`] });
  }
  if (errors.length) return { errors };
  return { next, results };
}

// Only prepareBatch has a consumer; toEntry and itemsOf are internal steps of it and are tested
// through it, so they stay private rather than becoming dead public surface.
module.exports = { prepareBatch };
