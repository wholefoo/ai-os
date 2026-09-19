// tools/test-hub-render.js
// Rendering the hub content: video pages, the videos index, tag pages and the tag index, Start
// here, source attribution, the RSS feed and VideoObject structured data.
//
// The compatibility rule this suite also pins: a plan with no hub content must expand to exactly
// the pages it did before. That was proved byte-for-byte against the operator's real Oregon and
// Truth Counters plans when this landed (every page identical; the layout gained only the feed
// link); the cases below guard the mechanism so it stays true.
'use strict';
const assert = require('assert');
const A = require('../lib/web-studio/articles');
const P = require('../lib/web-studio/pipeline');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const NOW = '2026-09-18T00:00:00.000Z';
const entry = (a) => A.normalizeArticle(a, { now: NOW });
const plan = (entries, extra = {}) => ({ siteName: 'Demo', domain: 'demo.example', pages: [{ path: '/', title: 'Home', sections: [] }], articles: entries, ...extra });
const paths = (p) => A.expandArticlePages(p).pages.map((x) => x.path);
const pageAt = (p, path) => A.expandArticlePages(p).pages.find((x) => x.path === path);
const YT = 'dQw4w9WgXcQ';

console.log('hub-render');

// ---------- the compatibility rule --------------------------------------------------------------
t('a hub-free plan produces no video, tag or start-here pages', () => {
  const ps = paths(plan([entry({ title: 'One', html: '<p>body text</p>' })]));
  assert.ok(ps.includes('/article/one') && ps.includes('/articles'), 'lost the article pages: ' + ps);
  for (const x of ['/videos', '/tags', '/start-here']) assert.ok(!ps.includes(x), 'emitted ' + x + ' with no hub content');
  assert.ok(!ps.some((x) => x.startsWith('/tags/') || x.startsWith('/video/')), 'emitted hub pages: ' + ps);
});

t('an untagged article renders no chips and no source line', () => {
  const out = P.renderSection(pageAt(plan([entry({ title: 'One', html: '<p>x</p>' })]), '/article/one').sections[0]);
  assert.ok(!out.includes('ws-tags') && !out.includes('ws-source'), 'hub markup on a plain article');
});

t('the hub stylesheet is omitted when no hub component is used', () => {
  const base = P.renderBase(A.expandArticlePages(plan([entry({ title: 'One', html: '<p>x</p>' })])));
  assert.ok(!base.includes('.ws-player'), 'player CSS shipped to a site with no videos');
});

// ---------- videos -------------------------------------------------------------------------------
t('a video lives at /video/<slug>, never /article/<slug>', () => {
  const ps = paths(plan([entry({ title: 'Talk', kind: 'video', youtubeId: YT })]));
  assert.ok(ps.includes('/video/talk'), 'no video page: ' + ps);
  assert.ok(!ps.includes('/article/talk'), 'the video was also rendered as an article');
});

t('the videos index appears only when there are videos, and /articles lists articles only', () => {
  const p = plan([entry({ title: 'Post', html: '<p>x</p>' }), entry({ title: 'Talk', kind: 'video', youtubeId: YT })]);
  const vids = pageAt(p, '/videos').sections[0].items.map((i) => i.title);
  const arts = pageAt(p, '/articles').sections[0].items.map((i) => i.title);
  assert.deepStrictEqual(vids, ['Talk']);
  assert.deepStrictEqual(arts, ['Post'], 'a video leaked into the article index');
});

t('a video-only site gets no empty "Articles" page', () => {
  assert.ok(!paths(plan([entry({ title: 'Talk', kind: 'video', youtubeId: YT })])).includes('/articles'));
});

t('the YouTube player is click-to-load: no iframe until the visitor plays', () => {
  const out = P.renderSection(pageAt(plan([entry({ title: 'Talk', kind: 'video', youtubeId: YT })]), '/video/talk').sections[0]);
  const markup = out.slice(0, out.indexOf('<script'));
  assert.ok(markup.includes('data-yt="' + YT + '"'), 'no player placeholder');
  assert.ok(!/<iframe/i.test(markup), 'an iframe is in the page before the click');
  assert.ok(out.includes('youtube-nocookie.com/embed/'), 'not the privacy-enhanced domain');
});

t('the player script was not interpolated by the build (no dollar-brace, no "undefined")', () => {
  // The script sits inside a JS template literal in pipeline.js. A template literal in the script
  // itself would have been evaluated at BUILD time, baking "undefined" into the page.
  const out = P.renderSection(pageAt(plan([entry({ title: 'Talk', kind: 'video', youtubeId: YT })]), '/video/talk').sections[0]);
  const script = out.slice(out.indexOf('<script'));
  assert.ok(!script.includes('${'), 'a template literal survived into the emitted script');
  assert.ok(!script.includes('undefined'), 'the build interpolated an undefined into the script');
  assert.ok(script.includes("getAttribute('data-yt')"), 'script does not read the id at runtime');
});

t('an mp4 video uses a native player with no script', () => {
  const out = P.renderSection(pageAt(plan([entry({ title: 'Clip', kind: 'video', videoUrl: 'https://cdn.example/a.mp4' })]), '/video/clip').sections[0]);
  assert.ok(/<video src="https:\/\/cdn\.example\/a\.mp4" controls/.test(out), 'no native video element');
  assert.ok(!out.includes('<script'), 'script emitted for a video that does not need one');
});

t('the renderer re-validates media rather than trusting the plan', () => {
  // A plan can reach the renderer without passing the model (a restored backup, a hand-edited
  // state file). A bad id must not land in an attribute; a javascript: url must not become a src.
  const out = P.renderSection({ type: 'video', heading: 'x', youtubeId: '"><script>alert(1)</script>', videoUrl: 'javascript:alert(1)' });
  assert.ok(!/data-yt/.test(out) && !/javascript:/i.test(out) && !/<script>alert/.test(out), 'unvalidated media reached the page');
});

t('a video meta line shows the running time, not a reading time', () => {
  const v = entry({ title: 'Talk', kind: 'video', youtubeId: YT, duration: '12:34', html: '<p>' + 'word '.repeat(600) + '</p>' });
  assert.ok(A.metaLine(v).includes('12:34'), 'no duration: ' + A.metaLine(v));
  assert.ok(!/min read/.test(A.metaLine(v)), 'a video claimed a reading time: ' + A.metaLine(v));
});

// ---------- VideoObject --------------------------------------------------------------------------
t('VideoObject carries an ISO duration, the nocookie embed and a real date only', () => {
  const pg = pageAt(plan([entry({ title: 'Talk', kind: 'video', youtubeId: YT, duration: '1:02:03', publishedAt: '2024-05-01T12:00:00Z' })]), '/video/talk');
  const ld = pg.extraLd[0];
  assert.strictEqual(ld['@type'], 'VideoObject');
  assert.strictEqual(ld.duration, 'PT1H2M3S');
  assert.strictEqual(ld.embedUrl, 'https://www.youtube-nocookie.com/embed/' + YT);
  assert.strictEqual(ld.uploadDate, '2024-05-01T12:00:00.000Z');
  assert.ok(ld.thumbnailUrl && ld.description, 'missing a field Google requires');
});

t('an undated video emits no uploadDate rather than an invented one', () => {
  const v = A.normalizeArticle({ title: 'Talk', kind: 'video', youtubeId: YT }, { now: NOW, undatedOk: true });
  const ld = pageAt(plan([v]), '/video/talk').extraLd[0];
  assert.ok(!('uploadDate' in ld), 'fabricated uploadDate: ' + ld.uploadDate);
});

// ---------- tags ---------------------------------------------------------------------------------
t('tags produce one page per tag, grouped by slug, plus an index', () => {
  const p = plan([entry({ title: 'A', html: '<p>x</p>', tags: ['AI'] }), entry({ title: 'B', html: '<p>x</p>', tags: ['ai', 'Security'] })]);
  const ps = paths(p);
  assert.ok(ps.includes('/tags/ai') && ps.includes('/tags/security') && ps.includes('/tags'), 'missing tag pages: ' + ps);
  assert.strictEqual(ps.filter((x) => x === '/tags/ai').length, 1, '"AI" and "ai" produced two pages');
  assert.deepStrictEqual(pageAt(p, '/tags/ai').sections[0].items.map((i) => i.title).sort(), ['A', 'B']);
});

t('a tag page lists articles and videos together', () => {
  const p = plan([entry({ title: 'Post', html: '<p>x</p>', tags: ['ai'] }), entry({ title: 'Talk', kind: 'video', youtubeId: YT, tags: ['ai'] })]);
  const items = pageAt(p, '/tags/ai').sections[0].items;
  assert.deepStrictEqual(items.map((i) => i.kind).sort(), ['article', 'video']);
});

t('chips link to the tag page and escape their labels', () => {
  const out = P.renderSection({ type: 'article', heading: 'x', html: '<p>x</p>',
    tags: [{ label: 'a"><img src=x onerror=alert(1)>', href: '/tags/a' }] });
  assert.ok(!/<img src=x/.test(out), 'a tag label went live as markup');
  assert.ok(out.includes('href="/tags/a"'), 'chip does not link');
});

// ---------- start here ---------------------------------------------------------------------------
t('Start here lists featured entries of any kind, and is absent when nothing is featured', () => {
  const p = plan([entry({ title: 'Post', html: '<p>x</p>', featured: true }), entry({ title: 'Talk', kind: 'video', youtubeId: YT, featured: true }), entry({ title: 'Other', html: '<p>x</p>' })]);
  assert.deepStrictEqual(pageAt(p, '/start-here').sections[0].items.map((i) => i.title).sort(), ['Post', 'Talk']);
  assert.ok(!paths(plan([entry({ title: 'Other', html: '<p>x</p>' })])).includes('/start-here'));
});

t('a hand-written page at a generated path always wins', () => {
  const p = plan([entry({ title: 'Post', html: '<p>x</p>', featured: true })]);
  p.pages.push({ path: '/start-here', title: 'My own page', sections: [] });
  const found = A.expandArticlePages(p).pages.filter((x) => x.path === '/start-here');
  assert.strictEqual(found.length, 1, 'two pages at /start-here');
  assert.strictEqual(found[0].title, 'My own page', 'the generated page replaced the hand-written one');
});

// ---------- source attribution -------------------------------------------------------------------
t('source attribution links out safely, falling back to the hostname', () => {
  const out = P.renderSection(pageAt(plan([entry({ title: 'P', html: '<p>x</p>', source: { url: 'https://www.example.com/post' } })]), '/article/p').sections[0]);
  assert.ok(/Originally published at <a href="https:\/\/www\.example\.com\/post" rel="noopener noreferrer" target="_blank">example\.com<\/a>/.test(out),
    'attribution wrong: ' + (out.match(/Originally[^\n]*/) || [''])[0]);
});

t('a non-http source never renders a link', () => {
  const out = P.renderSection({ type: 'article', heading: 'x', html: '<p>x</p>', source: { url: 'javascript:alert(1)' } });
  assert.ok(!out.includes('ws-source') && !/javascript:/i.test(out), 'unsafe source rendered');
});

// ---------- RSS ----------------------------------------------------------------------------------
const canon = (p) => (page) => require('../lib/web-studio/aeo-emit').canonicalUrl(p, page);

t('RSS links match the canonical URLs, trailing slash included', () => {
  const p = plan([entry({ title: 'Post', html: '<p>x</p>' }), entry({ title: 'Talk', kind: 'video', youtubeId: YT })]);
  const xml = A.rssXml(p, canon(p));
  assert.ok(xml.includes('<link>https://demo.example/article/post/</link>'), 'article link wrong');
  assert.ok(xml.includes('<link>https://demo.example/video/talk/</link>'), 'video link wrong');
  assert.ok(!/<link>https:\/\/demo\.example\/(article|video)\/[a-z-]+<\/link>/.test(xml), 'a feed link would redirect');
});

t('an undated entry has no pubDate in the feed', () => {
  const v = A.normalizeArticle({ title: 'Old', html: '<p>x</p>' }, { now: NOW, undatedOk: true });
  const p = plan([v]);
  assert.ok(!A.rssXml(p, canon(p)).includes('<pubDate>'), 'invented a pubDate');
});

t('RSS escapes titles and tags, and is empty without a domain', () => {
  const p = plan([entry({ title: 'A & B <c>', html: '<p>x</p>', tags: ['R&D'] })]);
  const xml = A.rssXml(p, canon(p));
  assert.ok(xml.includes('A &amp; B &lt;c&gt;') && xml.includes('<category>R&amp;D</category>'), 'unescaped');
  assert.strictEqual(A.rssXml({ ...p, domain: '' }, canon(p)), '', 'produced a feed with no absolute URLs');
});

t('the feed caps at 50 items', () => {
  const many = Array.from({ length: 60 }, (_, i) => entry({ title: 'Post ' + i, html: '<p>x</p>' }));
  const p = plan(many);
  assert.strictEqual((A.rssXml(p, canon(p)).match(/<item>/g) || []).length, 50);
});

t('the layout advertises the feed only when it will exist', () => {
  const withFeed = P.renderBase(A.expandArticlePages(plan([entry({ title: 'P', html: '<p>x</p>' })])));
  const noDomain = P.renderBase(A.expandArticlePages(plan([entry({ title: 'P', html: '<p>x</p>' })], { domain: '' })));
  const noEntries = P.renderBase(A.expandArticlePages(plan([])));
  assert.ok(withFeed.includes('application/rss+xml'), 'feed not advertised');
  assert.ok(!noDomain.includes('application/rss+xml'), 'advertised a feed that cannot be built (no domain)');
  assert.ok(!noEntries.includes('application/rss+xml'), 'advertised an empty feed');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
