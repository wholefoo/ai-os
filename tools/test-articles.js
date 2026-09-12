// tools/test-articles.js
// The article content model: validation/normalisation on write, and deterministic expansion into
// pages at render. The cases that matter are the ones that would corrupt a live site — a title
// edit silently moving a published URL, a draft leaking, a fabricated date, or a body that loses
// content on a round trip.
'use strict';
const assert = require('assert');
const A = require('../lib/web-studio/articles');
const { expandArticlePages, renderSection } = require('../lib/web-studio/pipeline');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const NOW = '2026-03-01T12:00:00.000Z';

console.log('articles');

// ---------- normalisation ------------------------------------------------------------------------
t('requires a title', () => {
  assert.throws(() => A.normalizeArticle({ html: '<p>x</p>' }), /title is required/);
  assert.throws(() => A.normalizeArticle({ title: '   ' }), /title is required/);
});

t('derives a slug from the title when none is given', () => {
  const a = A.normalizeArticle({ title: 'The Rare Commodity of Truth!' }, { now: NOW });
  assert.strictEqual(a.slug, 'the-rare-commodity-of-truth');
});

t('an existing slug is NOT changed by editing the title (no silent link rot)', () => {
  const existing = { slug: 'original-slug', createdAt: NOW };
  const a = A.normalizeArticle({ title: 'A Completely New Title' }, { existing, now: NOW });
  assert.strictEqual(a.slug, 'original-slug', 'renaming the title moved the published URL');
});

t('an explicitly supplied slug wins and is slugified', () => {
  const a = A.normalizeArticle({ title: 'T', slug: 'My New Slug!!' }, { existing: { slug: 'old' }, now: NOW });
  assert.strictEqual(a.slug, 'my-new-slug');
});

t('rejects a title that cannot produce a slug', () => {
  assert.throws(() => A.normalizeArticle({ title: '!!!' }), /slug/);
});

t('sanitises the body on write', () => {
  const a = A.normalizeArticle({ title: 'T', html: '<p>ok</p><script>alert(1)</script>' }, { now: NOW });
  assert.ok(!/script/i.test(a.html), 'script survived normalisation: ' + a.html);
  assert.ok(a.html.includes('ok'), 'prose lost');
});

t('derives an excerpt from the body when absent, on a word boundary', () => {
  const body = '<p>' + 'alpha beta gamma '.repeat(40) + '</p>';
  const a = A.normalizeArticle({ title: 'T', html: body }, { now: NOW });
  assert.ok(a.excerpt.length <= 220, 'excerpt too long: ' + a.excerpt.length);
  assert.ok(a.excerpt.endsWith('…'), 'derived excerpt not ellipsised: ' + a.excerpt.slice(-20));
  assert.ok(!/\s\S+…$/.test(a.excerpt.replace(/\s\S*…$/, '')), 'did not cut on a word boundary');
});

t('keeps a supplied excerpt', () => {
  const a = A.normalizeArticle({ title: 'T', html: '<p>body</p>', excerpt: 'mine' }, { now: NOW });
  assert.strictEqual(a.excerpt, 'mine');
});

t('never invents a publish date it was not given, but defaults on create', () => {
  const created = A.normalizeArticle({ title: 'T' }, { now: NOW });
  assert.strictEqual(created.publishedAt, NOW, 'new article did not get the supplied now');
  const kept = A.normalizeArticle({ title: 'T' }, { existing: { publishedAt: '2020-01-01T00:00:00.000Z' }, now: NOW });
  assert.strictEqual(kept.publishedAt, '2020-01-01T00:00:00.000Z', 'edit overwrote the original publish date');
});

t('rejects an oversized body rather than silently truncating', () => {
  const huge = '<p>' + 'x'.repeat(A.MAX_BODY_CHARS + 10) + '</p>';
  assert.throws(() => A.normalizeArticle({ title: 'T', html: huge }), /exceeds/);
});

t('accepts a body the size of the real recovered constitution', () => {
  const big = '<p>' + 'word '.repeat(76000) + '</p>';   // ~380k chars, like state-constitution
  const a = A.normalizeArticle({ title: 'T', html: big }, { now: NOW });
  assert.ok(a.html.length > 300000, 'large real-world body was lost: ' + a.html.length);
});

t('draft is a real boolean and defaults false', () => {
  assert.strictEqual(A.normalizeArticle({ title: 'T' }, { now: NOW }).draft, false);
  assert.strictEqual(A.normalizeArticle({ title: 'T', draft: true }, { now: NOW }).draft, true);
  assert.strictEqual(A.normalizeArticle({ title: 'T', draft: 'true' }, { now: NOW }).draft, true);
  assert.strictEqual(A.normalizeArticle({ title: 'T', draft: 'no' }, { now: NOW }).draft, false);
});

t('round-trips without drifting (normalise twice = once)', () => {
  const once = A.normalizeArticle({ title: 'T', html: '<p>R&amp;D — "x"</p>' }, { now: NOW });
  const twice = A.normalizeArticle(once, { existing: once, now: NOW });
  assert.strictEqual(twice.html, once.html, 'body drifted on re-save:\n  1: ' + once.html + '\n  2: ' + twice.html);
  assert.strictEqual(twice.slug, once.slug);
  assert.strictEqual(twice.excerpt, once.excerpt);
});

// ---------- expansion ------------------------------------------------------------------------------
const mk = (over) => A.normalizeArticle(Object.assign({ title: 'T', html: '<p>body</p>' }, over), { now: NOW });

t('expands one page per published article plus an index', () => {
  const plan = { siteName: 'S', domain: 'x.com', pages: [{ path: '/', sections: [] }], articles: [mk({ title: 'One' }), mk({ title: 'Two' })] };
  const out = expandArticlePages(plan);
  const paths = out.pages.map((p) => p.path);
  assert.ok(paths.includes('/article/one'), 'missing article page: ' + paths.join(','));
  assert.ok(paths.includes('/article/two'), 'missing article page');
  assert.ok(paths.includes('/articles'), 'missing index page: ' + paths.join(','));
  assert.ok(paths.includes('/'), 'lost the hand-written home page');
});

t('does not mutate the input plan', () => {
  const plan = { pages: [{ path: '/' }], articles: [mk({ title: 'One' })] };
  const before = plan.pages.length;
  expandArticlePages(plan);
  assert.strictEqual(plan.pages.length, before, 'input plan was mutated');
});

t('drafts never produce a page', () => {
  const plan = { articles: [mk({ title: 'Live' }), mk({ title: 'Hidden', draft: true })] };
  const paths = expandArticlePages(plan).pages.map((p) => p.path);
  assert.ok(paths.includes('/article/live'), 'published article missing');
  assert.ok(!paths.includes('/article/hidden'), 'DRAFT LEAKED into a rendered page');
});

t('a hand-written page at the same path wins', () => {
  const plan = { pages: [{ path: '/article/one', title: 'Hand written', sections: [] }], articles: [mk({ title: 'One' })] };
  const out = expandArticlePages(plan);
  const hits = out.pages.filter((p) => p.path === '/article/one');
  assert.strictEqual(hits.length, 1, 'duplicate page path emitted');
  assert.strictEqual(hits[0].title, 'Hand written', 'generated page clobbered the hand-written one');
});

t('orders newest first', () => {
  const plan = { articles: [
    mk({ title: 'Older', publishedAt: '2020-01-01' }),
    mk({ title: 'Newer', publishedAt: '2026-01-01' }),
  ] };
  const idx = expandArticlePages(plan).pages.find((p) => p._articleIndex);
  assert.strictEqual(idx.sections[0].items[0].title, 'Newer', 'index is not newest-first');
});

t('no articles means no pages and no index', () => {
  const plan = { pages: [{ path: '/' }], articles: [] };
  assert.strictEqual(expandArticlePages(plan).pages.length, 1);
  assert.strictEqual(expandArticlePages({ pages: [{ path: '/' }] }).pages.length, 1);
});

t('the index can be disabled', () => {
  const plan = { articleIndex: false, articles: [mk({ title: 'One' })] };
  assert.ok(!expandArticlePages(plan).pages.some((p) => p._articleIndex), 'index emitted despite articleIndex:false');
});

t('a custom prefix changes both the article and index paths', () => {
  const plan = { articlePrefix: 'post', articles: [mk({ title: 'One' })] };
  const paths = expandArticlePages(plan).pages.map((p) => p.path);
  assert.ok(paths.includes('/post/one'), 'custom prefix ignored: ' + paths.join(','));
  assert.ok(paths.includes('/posts'), 'index did not follow the prefix: ' + paths.join(','));
});

// ---------- structured data --------------------------------------------------------------------------
t('emits Article JSON-LD with only the facts that exist', () => {
  const plan = { siteName: 'S', domain: 'x.com', articles: [mk({ title: 'One', author: 'Madison', category: 'Docs' })] };
  const page = expandArticlePages(plan).pages.find((p) => p.path === '/article/one');
  const ld = page.extraLd[0];
  assert.strictEqual(ld['@type'], 'Article');
  assert.strictEqual(ld.headline, 'One');
  assert.deepStrictEqual(ld.author, { '@type': 'Person', name: 'Madison' });
  assert.strictEqual(ld.articleSection, 'Docs');
  assert.strictEqual(ld.url, 'https://x.com/article/one');
  assert.ok(ld.wordCount > 0, 'no wordCount');
  assert.ok(!('articleBody' in ld), 'the whole body was inlined into JSON-LD');
});

t('omits author/section when absent rather than emitting empty values', () => {
  const plan = { siteName: 'S', articles: [mk({ title: 'One' })] };
  const ld = expandArticlePages(plan).pages.find((p) => p.path === '/article/one').extraLd[0];
  assert.ok(!('author' in ld), 'emitted an empty author');
  assert.ok(!('articleSection' in ld), 'emitted an empty articleSection');
});

// ---------- rendering ----------------------------------------------------------------------------------
t('the generated article page renders its body as markup', () => {
  const plan = { articles: [mk({ title: 'One', html: '<h2>Sub</h2><p>real <strong>markup</strong></p>' })] };
  const page = expandArticlePages(plan).pages.find((p) => p.path === '/article/one');
  const html = renderSection(page.sections[0]);
  assert.ok(html.includes('<h2'), 'heading was escaped instead of rendered');
  assert.ok(html.includes('<strong>markup</strong>'), 'inline markup lost');
});

t('the index renders linked entries', () => {
  const plan = { articles: [mk({ title: 'One', category: 'Docs' })] };
  const idx = expandArticlePages(plan).pages.find((p) => p._articleIndex);
  const html = renderSection(idx.sections[0]);
  assert.ok(html.includes('href="/article/one"'), 'index entry is not a link: ' + html);
  assert.ok(html.includes('Docs'), 'category missing from the index');
});

t('an empty index renders a message rather than an empty list', () => {
  const html = renderSection({ type: 'articleList', heading: 'Articles', items: [] });
  assert.ok(/No articles yet/.test(html), 'no empty state: ' + html);
});

// ---------- helpers ---------------------------------------------------------------------------------------
t('metaLine omits what is missing', () => {
  assert.strictEqual(A.metaLine({ author: null, publishedAt: null, html: '' }), '');
  const m = A.metaLine({ author: 'X', publishedAt: '2026-03-01T00:00:00Z', html: '<p>' + 'w '.repeat(440) + '</p>' });
  assert.ok(m.startsWith('By X · '), 'byline wrong: ' + m);
  assert.ok(/min read$/.test(m), 'read time missing: ' + m);
});

t('isoOrNull rejects junk instead of inventing a date', () => {
  assert.strictEqual(A.isoOrNull('not a date'), null);
  assert.strictEqual(A.isoOrNull(''), null);
  assert.strictEqual(A.isoOrNull(null), null);
  assert.ok(A.isoOrNull('2026-01-01').startsWith('2026-01-01'));
});

t('slugify handles punctuation, unicode quotes and length', () => {
  assert.strictEqual(A.slugify("Madison's Notes — Part 2"), 'madisons-notes-part-2');
  assert.strictEqual(A.slugify('  '), '');
  assert.ok(A.slugify('x'.repeat(200)).length <= 80);
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
