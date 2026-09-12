// tools/test-adopt.js
// Adoption turns a static imported site into a plan-backed one. It KEEPS CONTENT and REPLACES
// PRESENTATION, so the failure that matters is adopting something that looks fine and is empty —
// exactly what happened when a contentless SPA was imported and published. These tests pin the
// refusals: app shells, thin pages, and missing home pages must be reported, never quietly shipped.
'use strict';
const assert = require('assert');
const { derivePlan, extractPage, sitePathFor, articleSlugFor, stripSiteSuffix } = require('../lib/web-studio/adopt');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};

console.log('adopt');

const page = (title, bodyInner, opts = {}) => `<!doctype html><html><head><title>${title}</title>
${opts.desc ? `<meta name="description" content="${opts.desc}">` : ''}</head>
<body><header><nav><a href="/">Home</a></nav></header>${bodyInner}<footer><p>© 2026 site footer text</p></footer></body></html>`;

const LONG = 'This is a real sentence of article prose that carries meaning. '.repeat(8);

// ---------- extraction -----------------------------------------------------------------------------
t('prefers <main> and reports high confidence', () => {
  const ex = extractPage(page('T', `<main><p>${LONG}</p></main>`));
  assert.strictEqual(ex.container, 'main');
  assert.strictEqual(ex.confidence, 'high');
  assert.ok(ex.text.includes('real sentence'), 'prose lost');
});

t('falls back to <article>, then a content div, then the body — with falling confidence', () => {
  assert.strictEqual(extractPage(page('T', `<article><p>${LONG}</p></article>`)).confidence, 'high');
  assert.strictEqual(extractPage(page('T', `<div class="post-content"><p>${LONG}</p></div>`)).confidence, 'medium');
  const loose = extractPage(page('T', `<p>${LONG}</p>`));
  assert.strictEqual(loose.confidence, 'low');
  assert.ok(loose.warnings.some((w) => /no <main>/.test(w)), 'no warning about the missing container');
});

t('strips nav, header and footer chrome', () => {
  const ex = extractPage(page('T', `<p>${LONG}</p>`));
  assert.ok(!/site footer text/.test(ex.text), 'footer chrome was adopted as content: ' + ex.text.slice(-80));
  assert.ok(!/Home<\/a>/.test(ex.html), 'nav survived');
});

t('sanitises while extracting', () => {
  const ex = extractPage(page('T', `<main><p>${LONG}</p><script>alert(1)</script></main>`));
  assert.ok(!/script/i.test(ex.html), 'script survived adoption: ' + ex.html.slice(0, 120));
});

t('recognises a single-page-app shell and says so', () => {
  const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>';
  const ex = extractPage(shell);
  assert.ok(ex.warnings.some((w) => /single-page-app shell/.test(w)),
    'an SPA shell was not identified: ' + JSON.stringify(ex.warnings));
  assert.strictEqual(ex.confidence, 'low');
});

t('reports a missing title and description rather than inventing them', () => {
  const ex = extractPage('<html><body><main><p>' + LONG + '</p></main></body></html>');
  assert.strictEqual(ex.title, '');
  assert.strictEqual(ex.description, '');
  assert.ok(ex.warnings.some((w) => /no <title>/.test(w)));
  assert.ok(ex.warnings.some((w) => /meta description/.test(w)));
});

// ---------- title suffixes -------------------------------------------------------------------------
// A <title> is written for the browser tab, so it carries the site name. Adopting it verbatim put
// "The Rare Commodity of Truth | Truth Counters Deception" into the h1 of a real adopted article.
t('strips a site-name suffix from adopted titles', () => {
  assert.strictEqual(stripSiteSuffix('My Post | My Site', 'My Site'), 'My Post');
  assert.strictEqual(stripSiteSuffix('About - My Site', 'My Site'), 'About');
  assert.strictEqual(stripSiteSuffix('About – My Site', 'My Site'), 'About');
});

t('does NOT truncate a title that merely contains a separator', () => {
  const t1 = 'Fact-Checkers: Unbiased Analysis or Biased Verification';
  assert.strictEqual(stripSiteSuffix(t1, 'Truth Counters'), t1, 'a hyphenated title was truncated');
  assert.strictEqual(stripSiteSuffix('A | B', 'Other Site'), 'A | B', 'stripped a suffix that is not the site name');
  assert.strictEqual(stripSiteSuffix('Plain Title', 'My Site'), 'Plain Title');
  assert.strictEqual(stripSiteSuffix('My Site', 'My Site'), 'My Site', 'a title equal to the site name was emptied');
});

t('applies the suffix strip through derivePlan', () => {
  const { plan } = derivePlan([
    { path: 'index.html', html: page('Home | Acme', `<main><p>${LONG}</p></main>`) },
    { path: 'article/x/index.html', html: page('Post | Acme', `<main><p>${LONG}</p></main>`) },
  ], { siteName: 'Acme' });
  assert.strictEqual(plan.articles[0].title, 'Post', 'article title kept the suffix');
  assert.ok(plan.pages.some((p) => p.title === 'Home'), 'page title kept the suffix');
});

// ---------- path mapping ------------------------------------------------------------------------------
t('maps file paths to site paths', () => {
  assert.strictEqual(sitePathFor('index.html'), '/');
  assert.strictEqual(sitePathFor('about/index.html'), '/about');
  assert.strictEqual(sitePathFor('contact.html'), '/contact');
  assert.strictEqual(sitePathFor('/a/b/index.html'), '/a/b');
});

t('identifies article files under the prefix', () => {
  assert.strictEqual(articleSlugFor('article/my-post/index.html', 'article'), 'my-post');
  assert.strictEqual(articleSlugFor('article/my-post.html', 'article'), 'my-post');
  assert.strictEqual(articleSlugFor('about/index.html', 'article'), null);
  assert.strictEqual(articleSlugFor('post/x/index.html', 'article'), null);
});

// ---------- derivePlan --------------------------------------------------------------------------------
t('splits articles from pages', () => {
  const { plan, stats } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'about/index.html', html: page('About', `<main><p>${LONG}</p></main>`) },
    { path: 'article/one/index.html', html: page('One', `<main><p>${LONG}</p></main>`) },
    { path: 'article/two/index.html', html: page('Two', `<main><p>${LONG}</p></main>`) },
  ]);
  assert.strictEqual(stats.articlesAdopted, 2, 'articles not detected');
  assert.deepStrictEqual(plan.pages.map((p) => p.path).sort(), ['/', '/about']);
  assert.deepStrictEqual(plan.articles.map((a) => a.slug).sort(), ['one', 'two']);
});

t('REFUSES a page with nothing to adopt, and says why', () => {
  const { plan, report, stats } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'empty/index.html', html: page('Empty', '<main><p>hi</p></main>') },
  ]);
  assert.ok(!plan.pages.some((p) => p.path === '/empty'), 'an empty page was adopted anyway');
  const entry = report.find((r) => r.file === 'empty/index.html');
  assert.strictEqual(entry.adopted, false);
  assert.ok(/nothing to adopt/.test(entry.reason), 'no reason given: ' + entry.reason);
  assert.strictEqual(stats.skipped, 1);
});

// This is the case that changed the design. A single "too short" floor set high enough to catch app
// shells also dropped Oregon's real contact page (social links, no prose) and a sparse category
// index. Losing a real page to a length heuristic is worse than adopting a short one, so a short
// page is now KEPT and flagged.
t('KEEPS a legitimately short page and flags it as thin', () => {
  const contact = page('Contact', '<main><h1>Contact</h1><p>Reach us on social media.</p>'
    + '<ul><li><a href="https://example.com/a">one</a></li><li><a href="https://example.com/b">two</a></li></ul></main>');
  const { plan, report, stats } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'contact/index.html', html: contact },
  ]);
  assert.ok(plan.pages.some((p) => p.path === '/contact'), 'a real short page was dropped');
  const entry = report.find((r) => r.file === 'contact/index.html');
  assert.strictEqual(entry.adopted, true);
  assert.strictEqual(entry.thin, true, 'short page was not flagged thin');
  assert.strictEqual(stats.thin, 1, 'stats.thin did not count it');
  assert.strictEqual(stats.skipped, 0, 'a short page counted as skipped');
});

t('an app shell is refused even when it carries more text than the empty floor', () => {
  // Enough chrome text to clear EMPTY_TEXT, but the prose is rendered by JS and absent from the HTML.
  const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root">'
    + 'Loading the application, please enable JavaScript to continue.</div></body></html>';
  const { plan, report } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'app/index.html', html: shell },
  ]);
  assert.ok(!plan.pages.some((p) => p.path === '/app'), 'an app shell was adopted');
  const entry = report.find((r) => r.file === 'app/index.html');
  assert.ok(/single-page-app shell/.test(entry.reason), 'shell not identified: ' + entry.reason);
});

t('an all-SPA import adopts nothing and generates a flagged home page', () => {
  const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';
  const { plan, stats, report } = derivePlan([
    { path: 'index.html', html: shell },
    { path: 'article/a/index.html', html: shell },
  ]);
  assert.strictEqual(stats.articlesAdopted, 0, 'an SPA shell was adopted as an article');
  assert.strictEqual(stats.skipped, 2, 'shells were not skipped');
  // It must still yield a publishable site (a home page), but flagged.
  assert.ok(plan.pages.some((p) => p.path === '/'), 'no home page in the derived plan');
  assert.ok(report.some((r) => r.warnings && r.warnings.some((w) => /placeholder home page/.test(w))),
    'the generated home page was not flagged');
});

t('generates a home page when no index.html exists', () => {
  const { plan } = derivePlan([{ path: 'about/index.html', html: page('About', `<main><p>${LONG}</p></main>`) }]);
  assert.ok(plan.pages.some((p) => p.path === '/'), 'a site with no / cannot be published');
});

t('is pure — the input files are not mutated', () => {
  const files = [{ path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) }];
  const snapshot = JSON.stringify(files);
  derivePlan(files);
  assert.strictEqual(JSON.stringify(files), snapshot, 'input was mutated');
});

t('carries a base plan through (tokens, nav, features are preserved)', () => {
  const base = { tokens: { brand: '#123456' }, nav: [{ label: 'Home', href: '/' }], features: { enableDarkMode: true } };
  const { plan } = derivePlan([{ path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) }], { base, siteName: 'S', domain: 'd.com' });
  assert.deepStrictEqual(plan.tokens, base.tokens, 'design tokens lost');
  assert.deepStrictEqual(plan.nav, base.nav, 'nav lost');
  assert.strictEqual(plan.siteName, 'S');
  assert.strictEqual(plan.domain, 'd.com');
});

t('respects a custom article prefix', () => {
  const { plan, stats } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'post/x/index.html', html: page('X', `<main><p>${LONG}</p></main>`) },
  ], { articlePrefix: 'post' });
  assert.strictEqual(stats.articlesAdopted, 1, 'custom prefix ignored');
  assert.strictEqual(plan.articlePrefix, 'post');
});

t('non-HTML files are ignored', () => {
  const { stats } = derivePlan([
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'styles.css', html: 'body{color:red}' },
    { path: 'sitemap.xml', html: '<urlset></urlset>' },
  ]);
  assert.strictEqual(stats.pagesAdopted, 1, 'a non-HTML file was adopted: ' + stats.pagesAdopted);
});

t('duplicate paths collapse rather than producing two pages at one URL', () => {
  const { plan } = derivePlan([
    { path: 'about/index.html', html: page('About', `<main><p>${LONG}</p></main>`) },
    { path: 'about.html', html: page('About dup', `<main><p>${LONG}</p></main>`) },
  ]);
  assert.strictEqual(plan.pages.filter((p) => p.path === '/about').length, 1, 'duplicate page path emitted');
});

t('the report accounts for every file it looked at', () => {
  const files = [
    { path: 'index.html', html: page('Home', `<main><p>${LONG}</p></main>`) },
    { path: 'thin/index.html', html: page('Thin', '<main><p>x</p></main>') },
    { path: 'article/a/index.html', html: page('A', `<main><p>${LONG}</p></main>`) },
  ];
  const { report } = derivePlan(files);
  for (const f of files) {
    assert.ok(report.some((r) => r.file === f.path), 'no report entry for ' + f.path);
  }
  assert.ok(report.every((r) => typeof r.adopted === 'boolean'), 'a report entry has no adopted flag');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
