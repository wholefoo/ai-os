// tools/test-canonical-slash.js
// The site is built with Astro `build: { format: 'directory' }`, so /about is emitted as
// dist/about/index.html and nginx 301s /about -> /about/. Every URL the AEO layer advertises must
// therefore END IN A SLASH, or it advertises a redirect.
//
// This shipped to two live customer sites before anyone noticed, because no test asserted the one
// property that matters: THE CANONICAL MUST BE THE URL THE PAGE IS SERVED AT. A canonical pointing
// at a 301 is not self-referencing, and sitemap entries that redirect are reported by search
// engines as "Page with redirect" and discounted — the opposite of the product's purpose.
// It was found on the live site by following redirects; a status check that did not follow them
// reported 301 and looked survivable.
'use strict';
const assert = require('assert');
const aeoEmit = require('../lib/web-studio/aeo-emit');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};

console.log('canonical-slash');

const DOMAIN = 'example.com';
const plan = {
  domain: DOMAIN,
  siteName: 'S',
  pages: [
    { path: '/', title: 'Home' },
    { path: '/about', title: 'About' },
    { path: '/article/one', title: 'One' },
    { path: '/category/media-analysis', title: 'Cat' },
    { path: '/a/b/c', title: 'Deep' },
  ],
};

// ---------- canonical ----------------------------------------------------------------------------
t('canonical ends in a slash for every non-root page', () => {
  for (const page of plan.pages) {
    const c = aeoEmit.canonicalUrl(plan, page);
    assert.ok(c.endsWith('/'), `canonical for ${page.path} does not end in a slash: ${c}`);
  }
});

t('canonical is exactly the served URL', () => {
  const cases = [
    ['/', 'https://example.com/'],
    ['/about', 'https://example.com/about/'],
    ['/article/one', 'https://example.com/article/one/'],
    ['/a/b/c', 'https://example.com/a/b/c/'],
  ];
  for (const [path, want] of cases) {
    assert.strictEqual(aeoEmit.canonicalUrl(plan, { path }), want, 'wrong canonical for ' + path);
  }
});

t('a path already carrying a slash is not doubled', () => {
  assert.strictEqual(aeoEmit.canonicalUrl(plan, { path: '/about/' }), 'https://example.com/about/');
  assert.strictEqual(aeoEmit.canonicalUrl(plan, { path: '//about//' }), 'https://example.com/about/');
});

t('root stays a single slash', () => {
  for (const p of ['/', '', null, undefined]) {
    assert.strictEqual(aeoEmit.canonicalUrl(plan, { path: p }), 'https://example.com/', 'root broke for ' + JSON.stringify(p));
  }
});

t('a file-like final segment is NOT slashed', () => {
  // Served as a file, not a directory. Appending a slash would 404 it.
  assert.strictEqual(aeoEmit.canonicalUrl(plan, { path: '/feed.xml' }), 'https://example.com/feed.xml');
  assert.strictEqual(aeoEmit.canonicalUrl(plan, { path: '/docs/guide.pdf' }), 'https://example.com/docs/guide.pdf');
});

t('no domain still yields no URL rather than a bare slash', () => {
  assert.strictEqual(aeoEmit.canonicalUrl({ domain: '' }, { path: '/about' }), '');
});

// ---------- sitemap ------------------------------------------------------------------------------
t('every sitemap loc ends in a slash', () => {
  const xml = aeoEmit.sitemapXml(plan);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.strictEqual(locs.length, plan.pages.length, 'wrong number of sitemap entries');
  for (const loc of locs) assert.ok(loc.endsWith('/'), 'sitemap loc is a redirect hop: ' + loc);
});

t('sitemap and canonical agree exactly — a mismatch is a split signal', () => {
  const xml = aeoEmit.sitemapXml(plan);
  for (const page of plan.pages) {
    const c = aeoEmit.canonicalUrl(plan, page);
    assert.ok(xml.includes('<loc>' + c + '</loc>'),
      `sitemap does not contain the canonical for ${page.path} (${c})`);
  }
});

// ---------- the other emitters that share the chokepoint -----------------------------------------
t('llms.txt links end in a slash', () => {
  const txt = aeoEmit.llmsTxt(plan);
  const links = [...txt.matchAll(/\]\((https:\/\/example\.com[^)]*)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'no links found in llms.txt');
  for (const l of links) {
    if (/\.[a-z0-9]+$/i.test(l)) continue;             // knowledge bundle .md and friends
    assert.ok(l.endsWith('/'), 'llms.txt advertises a redirect: ' + l);
  }
});

t('page JSON-LD url matches the canonical', () => {
  for (const page of plan.pages) {
    const ld = aeoEmit.pageLdObject(plan, page);
    if (!ld || !ld.url) continue;
    assert.strictEqual(ld.url, aeoEmit.canonicalUrl(plan, page),
      'JSON-LD url disagrees with the canonical for ' + page.path);
  }
});

// ---------- the regression itself ----------------------------------------------------------------
t('NO emitted page URL is the slashless form that 301s', () => {
  // The exact defect: https://example.com/about (no slash) appeared in canonical, sitemap and
  // llms.txt, and every one of them redirected.
  const blob = [
    aeoEmit.sitemapXml(plan),
    aeoEmit.llmsTxt(plan),
    ...plan.pages.map((p) => aeoEmit.canonicalUrl(plan, p)),
  ].join('\n');
  for (const bad of ['https://example.com/about<', 'https://example.com/about)', 'https://example.com/about\n',
    'https://example.com/article/one<', 'https://example.com/article/one)']) {
    assert.ok(!blob.includes(bad), 'a slashless page URL is still being emitted: ' + JSON.stringify(bad));
  }
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
