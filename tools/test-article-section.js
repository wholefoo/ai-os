// tools/test-article-section.js
// The `article` section is the only one that emits author-supplied MARKUP instead of escaped text,
// so it carries two risks nothing else in the renderer does:
//   1. stored XSS on a published customer domain
//   2. a literal `{` in prose being parsed by Astro as a JS expression, breaking the build
// Both are tested here as failure paths, plus the ordinary "real article still renders" case.
'use strict';
const assert = require('assert');
const { renderSection, renderBase, renderPage, astroSafe, planHasArticle } = require('../lib/web-studio/pipeline');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const absent = (out, needle, label) =>
  assert.ok(!out.toLowerCase().includes(needle.toLowerCase()), label + ' — found "' + needle + '" in: ' + out.slice(0, 400));

console.log('article-section');

// ---------- XSS ---------------------------------------------------------------------------------
t('strips a script tag from the body', () => {
  const out = renderSection({ type: 'article', html: '<p>hi</p><script>alert(1)</script>' });
  absent(out, '<script', 'script survived into the rendered section');
  absent(out, 'alert(1)', 'script body survived');
  assert.ok(out.includes('hi'), 'prose lost');
});

t('strips event handlers and javascript: urls from the body', () => {
  const out = renderSection({ type: 'article', html: '<p onclick="alert(1)">x</p><a href="javascript:alert(1)">y</a>' });
  absent(out, 'onclick', 'handler survived');
  absent(out, 'javascript:', 'javascript: url survived');
});

t('escapes the non-body fields (heading, meta, eyebrow, alt)', () => {
  const out = renderSection({
    type: 'article', heading: '<img src=x onerror=alert(1)>', eyebrow: '<b>e</b>',
    meta: '<i>m</i>', standfirst: '<u>s</u>', imageAlt: '"><script>alert(1)</script>',
    image: '/a.png', html: '<p>body</p>',
  });
  // These fields are escaped, NOT stripped: the payload survives as inert TEXT, which is correct.
  // Asserting the substring "onerror" is absent would be wrong — it is present and harmless as
  // "&lt;img src=x onerror=alert(1)&gt;". What must be absent is LIVE markup.
  const h1 = (out.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1];
  assert.ok(h1.includes('&lt;img'), 'heading was not entity-escaped: ' + h1);
  assert.ok(!/<img/.test(h1), 'heading produced a live <img> tag: ' + h1);
  assert.ok(!/<h1[^>]*>[^<]*<(img|script|b|i|u)\b/.test(out), 'a tag went live inside the heading');
  const alt = (out.match(/alt="([^"]*)"/) || [, ''])[1];
  assert.ok(alt.includes('&lt;script&gt;') && !alt.includes('"'), 'alt attribute broke out: ' + alt);
  absent(out, '<b>e</b>', 'eyebrow was not escaped');
  absent(out, '<script>alert(1)</script>', 'a live script tag was emitted');
});

t('rejects a javascript: hero image src', () => {
  const out = renderSection({ type: 'article', image: 'javascript:alert(1)', html: '<p>x</p>' });
  absent(out, 'javascript:', 'unsafe image src survived');
});

// ---------- the Astro brace trap -----------------------------------------------------------------
t('neutralises braces in body markup (Astro parses {expr} as code)', () => {
  const out = renderSection({ type: 'article', html: '<p>Use {curly} and }weird{ braces</p>' });
  absent(out, '{', 'a literal { reached the .astro template and would be parsed as an expression');
  absent(out, '}', 'a literal } reached the .astro template');
  assert.ok(out.includes('&#123;') && out.includes('&#125;'), 'braces were not entity-encoded: ' + out);
});

t('astroSafe leaves ordinary markup alone', () => {
  assert.strictEqual(astroSafe('<p>plain</p>'), '<p>plain</p>');
  assert.strictEqual(astroSafe(null), '');
});

t('braces inside an attribute are neutralised too', () => {
  const out = renderSection({ type: 'article', html: '<a href="/a?x={y}">l</a>' });
  absent(out, '{', 'brace in an attribute survived');
});

// ---------- real content renders ------------------------------------------------------------------
t('renders a realistic article body intact', () => {
  const html = '<h2 id="s1">Heading</h2><p>Some <strong>bold</strong> text and a '
    + '<a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>'
    + '<blockquote>quoted</blockquote>';
  const out = renderSection({ type: 'article', html });
  for (const frag of ['<h2 id="s1">', '<strong>bold</strong>', '<ul>', '<li>one</li>', '<blockquote>',
    'href="https://example.com"']) {
    assert.ok(out.includes(frag), 'lost legitimate markup: ' + frag);
  }
});

t('renders the article furniture when supplied', () => {
  const out = renderSection({
    type: 'article', eyebrow: 'Founding Documents', heading: 'Federalist Papers 51-60',
    standfirst: 'A series of essays.', meta: 'By Madison * 93 min read',
    image: '/images/fed.webp', imageAlt: 'quill', html: '<p>body</p>',
  });
  assert.ok(out.includes('Founding Documents'), 'eyebrow missing');
  assert.ok(out.includes('<h1'), 'no h1 for the article title');
  assert.ok(out.includes('Federalist Papers 51-60'), 'title missing');
  assert.ok(out.includes('A series of essays.'), 'standfirst missing');
  assert.ok(out.includes('src="/images/fed.webp"'), 'hero image missing');
  assert.ok(out.includes('alt="quill"'), 'alt missing');
  assert.ok(out.includes('class="ws-article'), 'prose wrapper missing');
});

t('omits furniture cleanly when not supplied', () => {
  const out = renderSection({ type: 'article', html: '<p>only body</p>' });
  assert.ok(!out.includes('<h1'), 'emitted an empty h1');
  assert.ok(!out.includes('<img'), 'emitted an empty img');
  assert.ok(!out.includes('<hr'), 'emitted a rule with no furniture above it');
  assert.ok(out.includes('only body'), 'body lost');
});

t('an empty article does not throw and emits no body text', () => {
  const out = renderSection({ type: 'article' });
  assert.ok(out.includes('ws-article'), 'wrapper missing: ' + out);
});

t('a malformed section falls back rather than throwing', () => {
  // renderSection catches and falls back to prose; it must never propagate.
  const out = renderSection({ type: 'article', html: { not: 'a string' } });
  assert.ok(typeof out === 'string' && out.length > 0, 'did not return a string');
});

// ---------- page level ----------------------------------------------------------------------------
// LIMIT OF THIS SUITE: it does not run a real Astro build. Astro is installed per generated
// workspace (scaffold.js pins it in the site's own package.json), so building here would need a
// network npm install, which .claude/rules/testing.md forbids for verification. The brace
// neutralisation is therefore verified by STRING inspection of the emitted .astro source — no bare
// brace reaches the template — not by an actual Astro parse.
t('a rendered PAGE has no stray brace in the article body region', () => {
  const plan = { siteName: 'S', domain: 'example.com' };
  const page = {
    path: '/article/x', title: 'T', description: 'd',
    sections: [{ type: 'article', heading: 'H', html: '<p>math: {a} + {b} = {c}</p>' }],
  };
  const out = renderPage(page, { title: 'T', description: 'd' }, plan);
  const body = out.slice(out.indexOf('<article'));           // everything after the frontmatter
  assert.ok(!body.includes('{'), 'a bare { survived into the page body: ' + body.slice(0, 300));
  assert.ok(body.includes('&#123;a&#125;'), 'braces not encoded in the page: ' + body.slice(0, 300));
});

t('frontmatter expressions are untouched by the brace encoding', () => {
  const out = renderPage({ path: '/a', title: 'T', sections: [{ type: 'article', html: '<p>x</p>' }] },
    { title: 'T', description: 'd' }, { siteName: 'S' });
  // The Base invocation and the JSON-LD const legitimately use braces; encoding must not reach them.
  assert.ok(out.includes('const pageLd = '), 'frontmatter lost');
  assert.ok(/<Base title=/.test(out), 'Base invocation lost');
  assert.ok(out.includes('og={'), 'og expression was encoded and would no longer be an expression');
});

// ---------- the layout import must resolve from any depth -----------------------------------------
// THE FIRST REAL BUILD DIED ON THIS. The layout import was hardcoded to '../layouts/Base.astro',
// which only resolves for a page sitting directly in src/pages. Every nested page — every article,
// every category, and every plan.dynamic page — emitted an unresolvable import:
//   Could not resolve "../layouts/Base.astro" from "src/pages/article/<slug>.astro"
// A pre-existing defect (plan.dynamic has always produced `${prefix}/${slug}`), invisible to every
// string-level test because nothing ever tried to RESOLVE the path.
t('the layout import climbs out of however deep the page sits', () => {
  const cases = [
    ['/', '../layouts/Base.astro'],
    ['/about', '../layouts/Base.astro'],
    ['/articles', '../layouts/Base.astro'],
    ['/article/one', '../../layouts/Base.astro'],
    ['/category/media-analysis', '../../layouts/Base.astro'],
    ['/a/b/c', '../../../layouts/Base.astro'],
  ];
  for (const [path, expected] of cases) {
    const out = renderPage({ path, title: 't', sections: [] }, {}, { siteName: 's' });
    const got = (out.match(/import Base from '([^']+)'/) || [, ''])[1];
    assert.strictEqual(got, expected, `wrong layout import for ${path}`);
  }
});

t('an article page generated from the plan gets a resolvable import', () => {
  const { expandArticlePages } = require('../lib/web-studio/pipeline');
  const A = require('../lib/web-studio/articles');
  const plan = { siteName: 'S', articles: [A.normalizeArticle({ title: 'One', html: '<p>body text here</p>' }, { now: '2026-01-01T00:00:00.000Z' })] };
  const page = expandArticlePages(plan).pages.find((p) => p.path === '/article/one');
  const out = renderPage(page, {}, plan);
  assert.ok(out.includes("import Base from '../../layouts/Base.astro'"),
    'the generated article page would not resolve its layout: ' + (out.match(/import Base from '[^']+'/) || [''])[0]);
});

// ---------- the prose stylesheet ------------------------------------------------------------------
t('planHasArticle detects an article section anywhere in the plan', () => {
  assert.strictEqual(planHasArticle({ pages: [{ sections: [{ type: 'prose' }] }] }), false);
  assert.strictEqual(planHasArticle({ pages: [{ sections: [{ type: 'prose' }, { type: 'article' }] }] }), true);
  assert.strictEqual(planHasArticle({}), false);
  assert.strictEqual(planHasArticle(null), false);
});

t('Base emits the prose stylesheet only when an article section exists', () => {
  const withArticle = renderBase({ siteName: 'S', pages: [{ sections: [{ type: 'article' }] }] });
  const without = renderBase({ siteName: 'S', pages: [{ sections: [{ type: 'prose' }] }] });
  assert.ok(withArticle.includes('.ws-article'), 'prose CSS missing when an article is present');
  assert.ok(!without.includes('.ws-article'), 'prose CSS emitted for a site with no article');
});

t('the prose stylesheet keeps anchor targets clear of a sticky header', () => {
  const out = renderBase({ siteName: 'S', pages: [{ sections: [{ type: 'article' }] }] });
  assert.ok(/\.ws-article \[id\]\{scroll-margin-top/.test(out), 'no scroll-margin rule for anchors');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
