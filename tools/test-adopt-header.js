// tools/test-adopt-header.js
// Recovering an article's real header out of its adopted body.
//
// WHY: a content page repeats its own title, standfirst, date and hero image at the top of the
// markup. The article template renders all four itself, so adopting the body verbatim showed each
// twice — and the real date sat in the prose while the article record got TODAY, because
// normalizeArticle falls back to `now`. Two live sites rendered "14 September 2026" directly above
// a body that read "June 24, 2023".
//
// The stripper must be conservative: it removes only leading elements it can positively identify
// and stops at the first it cannot. Losing real prose to an over-eager heuristic would be far worse
// than leaving a duplicated heading.
'use strict';
const assert = require('assert');
const A = require('../lib/web-studio/adopt');
const { normalizeArticle } = require('../lib/web-studio/articles');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const textOf = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('adopt-header');

// The exact shape produced by the real rebuilt sites.
const REAL = `
<article>
  <div>
    <a href="/category/essential-patriot/">Essential Patriot</a>
    <h1>Practical Guide For Disaster Preparedness</h1>
    <p>Disaster preparedness involves planning and preparation to ensure safety.</p>
    <p>June 24, 2023 &middot; 5 min read</p>
    <img src="/images/essential-patriot.webp" alt="kit" width="1200" height="675" />
    <div><p>Real body paragraph one.</p><p>Real body paragraph two.</p></div>
  </div>
</article>`;
const OPTS = { title: 'Practical Guide For Disaster Preparedness',
  excerpt: 'Disaster preparedness involves planning and preparation to ensure safety.' };

t('recovers the real publication date from the header', () => {
  const r = A.splitArticleHeader(REAL, OPTS);
  assert.strictEqual(r.publishedAt, '2023-06-24T12:00:00.000Z', 'got ' + r.publishedAt);
});

t('dates land at midday UTC, so no timezone shifts them to the previous day', () => {
  // Midnight UTC becomes the 23rd in every negative-offset timezone — every article a day early
  // across the Americas.
  const r = A.splitArticleHeader(REAL, OPTS);
  assert.ok(r.publishedAt.includes('T12:00:00'), 'not midday UTC: ' + r.publishedAt);
});

t('hoists the hero image and its alt text', () => {
  const r = A.splitArticleHeader(REAL, OPTS);
  assert.strictEqual(r.image, '/images/essential-patriot.webp');
  assert.strictEqual(r.imageAlt, 'kit');
});

t('hoists the category eyebrow', () => {
  assert.strictEqual(A.splitArticleHeader(REAL, OPTS).eyebrow, 'Essential Patriot');
});

t('removes the duplicated furniture and keeps every word of the prose', () => {
  const r = A.splitArticleHeader(REAL, OPTS);
  const after = textOf(r.html);
  assert.ok(after.includes('Real body paragraph one.'), 'lost body text');
  assert.ok(after.includes('Real body paragraph two.'), 'lost body text');
  assert.ok(!after.includes('Practical Guide For Disaster Preparedness'), 'duplicate title survived');
  assert.ok(!after.includes('June 24, 2023'), 'duplicate date line survived');
  assert.ok(!after.includes('Essential Patriot'), 'duplicate eyebrow survived');
});

// ---------- conservatism: the cases where it must do NOTHING --------------------------------------
t('a body with no recognisable header is returned byte-identical', () => {
  const body = '<div><p>Straight into the prose with no furniture at all.</p></div>';
  const r = A.splitArticleHeader(body, { title: 'T', excerpt: 'E' });
  assert.strictEqual(r.html, body, 'an ordinary body was modified');
  assert.strictEqual(r.removed.length, 0);
});

t('an h1 that is NOT the article title is left alone', () => {
  const body = '<div><h1>A heading that belongs to the prose</h1><p>text</p></div>';
  const r = A.splitArticleHeader(body, { title: 'Something Else Entirely', excerpt: '' });
  assert.ok(r.html.includes('A heading that belongs to the prose'), 'stripped a real heading');
});

t('a long paragraph that merely mentions a date is not treated as metadata', () => {
  const body = '<div><p>On June 24, 2023 the committee met to discuss the proposal at length, and '
    + 'the minutes record a lengthy debate about preparedness funding.</p><p>more</p></div>';
  const r = A.splitArticleHeader(body, { title: 'T', excerpt: '' });
  assert.ok(r.html.includes('the committee met'), 'ate a real paragraph that contained a date');
  assert.strictEqual(r.publishedAt, null, 'took a date out of running prose');
});

t('stops at the first unrecognised element rather than scanning onward', () => {
  // A date line AFTER real prose must not be harvested — only leading furniture counts.
  const body = '<div><p>Real opening paragraph.</p><p>June 24, 2023</p></div>';
  const r = A.splitArticleHeader(body, { title: 'T', excerpt: '' });
  assert.strictEqual(r.publishedAt, null, 'reached past the prose to grab a date');
  assert.ok(r.html.includes('June 24, 2023'), 'removed content after the header ended');
});

t('empty and malformed input do not throw', () => {
  for (const v of ['', null, undefined, '<div>', '<<>>']) {
    const r = A.splitArticleHeader(v, {});
    assert.ok(typeof r.html === 'string', 'did not return a string for ' + JSON.stringify(v));
  }
});

// ---------- the site-name suffix -------------------------------------------------------------------
t('strips the suffix by site name OR by domain', () => {
  const title = 'Practical Guide For Disaster Preparedness | Oregon Politiscape';
  assert.strictEqual(A.stripSiteSuffix(title, 'Oregon Politiscape'), 'Practical Guide For Disaster Preparedness');
  // THE REAL FAILURE: the site record was still called "dist", so the exact-name match missed and
  // every <h1> shipped with the site name welded on. The domain is the reliable second candidate.
  assert.strictEqual(A.stripSiteSuffix(title, 'dist', 'oregonpolitiscape.com'),
    'Practical Guide For Disaster Preparedness');
});

t('does not strip a tail that is not the site name', () => {
  assert.strictEqual(A.stripSiteSuffix('Guns - Germs - Steel', 'Oregon Politiscape', 'oregonpolitiscape.com'),
    'Guns - Germs - Steel');
  assert.strictEqual(A.stripSiteSuffix('A Title | Some Other Brand', 'dist', 'oregonpolitiscape.com'),
    'A Title | Some Other Brand');
});

t('never returns an empty title', () => {
  assert.strictEqual(A.stripSiteSuffix('| Oregon Politiscape', 'Oregon Politiscape'), '| Oregon Politiscape');
});

// ---------- the honest-date contract ---------------------------------------------------------------
t('undatedOk keeps an unknown date null instead of inventing today', () => {
  const a = normalizeArticle({ slug: 's', title: 'T', html: '<p>body text here</p>' },
    { now: '2026-09-14T00:00:00.000Z', undatedOk: true });
  assert.strictEqual(a.publishedAt, null, 'invented a publication date for undated source content');
});

t('without undatedOk a new article still gets today — it really is published now', () => {
  const a = normalizeArticle({ slug: 's', title: 'T', html: '<p>body text here</p>' },
    { now: '2026-09-14T00:00:00.000Z' });
  assert.strictEqual(a.publishedAt, '2026-09-14T00:00:00.000Z', 'broke the default for authored articles');
});

t('a recovered date always wins over both', () => {
  const a = normalizeArticle({ slug: 's', title: 'T', html: '<p>body text here</p>',
    publishedAt: '2023-06-24T12:00:00.000Z' }, { now: '2026-09-14T00:00:00.000Z', undatedOk: true });
  assert.strictEqual(a.publishedAt, '2023-06-24T12:00:00.000Z');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
