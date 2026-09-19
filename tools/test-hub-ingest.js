// tools/test-hub-ingest.js
// The hub ingest contract on Web Studio (lib/web-studio/ingest.js + the route in server.js).
//
// The README examples of the standalone hub are used VERBATIM as fixtures: a workflow written
// against the hub must keep working here, and paraphrased fixtures would only prove that my
// reading of the hub works.
'use strict';
const assert = require('assert');
const I = require('../lib/web-studio/ingest');
const { serverSource } = require('./test-util');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const NOW = '2026-09-18T00:00:00.000Z';
const run = (body, list = [], opts = {}) => I.prepareBatch(body, list, { now: NOW, ...opts });
const ok = (r) => { assert.ok(!r.errors, 'unexpected errors: ' + JSON.stringify(r.errors)); return r; };

// Verbatim from hub/README.md.
const HUB_ARTICLE = {
  type: 'article', title: 'My first post', body: '# Markdown here',
  tags: ['ai', 'security'], draft: false,
  source: { name: 'Original site', url: 'https://example.com/post' },
};
const HUB_VIDEO = { type: 'video', title: '...', youtubeUrl: 'https://youtu.be/XXXXXXXXXXX', duration: '12:34', body: 'show notes', draft: false };

console.log('hub-ingest');

// ---------- the hub's own examples ---------------------------------------------------------------
t("the hub README's article example ingests unchanged", () => {
  const r = ok(run(HUB_ARTICLE));
  const e = r.next[0];
  assert.strictEqual(e.kind, 'article');
  assert.ok(/<h1[^>]*>Markdown here<\/h1>/.test(e.html), 'markdown not rendered: ' + e.html);
  assert.deepStrictEqual(e.tags, ['ai', 'security']);
  assert.deepStrictEqual(e.source, { url: 'https://example.com/post', name: 'Original site' });
  assert.strictEqual(e.draft, false);
});

t("the hub README's video example ingests unchanged", () => {
  const e = ok(run(HUB_VIDEO)).next[0];
  assert.strictEqual(e.kind, 'video');
  assert.strictEqual(e.youtubeId, 'XXXXXXXXXXX');
  assert.strictEqual(e.duration, '12:34');
});

// ---------- request shapes -----------------------------------------------------------------------
t('accepts one item, an array, or {items:[...]}', () => {
  assert.strictEqual(ok(run(HUB_ARTICLE)).next.length, 1);
  assert.strictEqual(ok(run([HUB_ARTICLE, { ...HUB_ARTICLE, title: 'Second' }])).next.length, 2);
  assert.strictEqual(ok(run({ items: [HUB_ARTICLE] })).next.length, 1);
});

t('rejects an empty batch and one over 50', () => {
  assert.ok(run([]).errors, 'accepted an empty batch');
  const many = Array.from({ length: 51 }, (_, i) => ({ ...HUB_ARTICLE, title: 'P' + i, source: undefined }));
  assert.ok(/at most 50/.test(JSON.stringify(run(many).errors)), '51 items accepted');
});

// ---------- the sanitiser is the boundary, not the parser ----------------------------------------
t('Markdown cannot smuggle script or javascript: links through the parser', () => {
  // marked passes raw HTML straight through, so this proves the sanitiser runs on its output.
  const e = ok(run({ type: 'article', title: 'X', body: 'hi <script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>' })).next[0];
  assert.ok(!/<script/i.test(e.html), 'script survived: ' + e.html);
  assert.ok(!/javascript:/i.test(e.html), 'javascript: link survived: ' + e.html);
  assert.ok(!/onerror/i.test(e.html), 'event handler survived: ' + e.html);
});

t('html is accepted as an alternative to body, never both', () => {
  assert.ok(/<p>raw<\/p>/.test(ok(run({ type: 'article', title: 'X', html: '<p>raw</p>' })).next[0].html));
  assert.ok(run({ type: 'article', title: 'X', body: 'a', html: '<p>b</p>' }).errors, 'accepted two bodies');
});

// ---------- validation ---------------------------------------------------------------------------
t('an article needs a body; a video does not', () => {
  assert.ok(/body required/.test(JSON.stringify(run({ type: 'article', title: 'X' }).errors)));
  assert.ok(!run({ type: 'video', title: 'X', youtubeId: 'dQw4w9WgXcQ' }).errors);
});

t('type and kind are both accepted, and must agree', () => {
  assert.strictEqual(ok(run({ kind: 'article', title: 'X', body: 'b' })).next[0].kind, 'article');
  assert.ok(run({ type: 'article', kind: 'video', title: 'X', body: 'b' }).errors, 'accepted a contradiction');
  assert.ok(run({ type: 'podcast', title: 'X', body: 'b' }).errors, 'accepted an unknown type');
});

t('every problem in an item is reported together', () => {
  const r = run({ type: 'video', title: '', youtubeId: 'bad', duration: 'long', tags: 'x', draft: 'no' });
  const errs = r.errors[0].errors;
  assert.ok(errs.length >= 2, 'only ' + errs.length + ' reported: ' + errs.join(' | '));
});

// ---------- all or nothing -----------------------------------------------------------------------
t('one bad item means NOTHING is written', () => {
  const r = run([HUB_ARTICLE, { type: 'article', title: '' }, { ...HUB_ARTICLE, title: 'Third', source: undefined }]);
  assert.ok(r.errors && !r.next, 'a partial batch was accepted');
  assert.deepStrictEqual(r.errors.map((x) => x.index), [1], 'wrong item blamed: ' + JSON.stringify(r.errors));
});

t('the same slug twice in one batch is refused', () => {
  const r = run([{ type: 'article', title: 'Same', body: 'a' }, { type: 'article', title: 'Same', body: 'b' }]);
  assert.ok(/more than once/.test(JSON.stringify(r.errors)), 'duplicate slug accepted');
});

// ---------- slugs --------------------------------------------------------------------------------
t('a source URL makes the derived slug stable, so re-running a scraper is idempotent', () => {
  const a = ok(run(HUB_ARTICLE)).next[0].slug;
  const b = ok(run(HUB_ARTICLE)).next[0].slug;
  assert.strictEqual(a, b, 'the same source produced two slugs');
  assert.ok(/^my-first-post-[0-9a-f]{6}$/.test(a), 'unexpected slug shape: ' + a);
  const other = ok(run({ ...HUB_ARTICLE, source: { url: 'https://other.example/post' } })).next[0].slug;
  assert.notStrictEqual(a, other, 'two sources sharing a headline collided');
});

t('an explicit slug is validated, never rewritten', () => {
  assert.strictEqual(ok(run({ ...HUB_ARTICLE, slug: 'custom-slug' })).next[0].slug, 'custom-slug');
  for (const bad of ['Has Caps', 'a--b', '-lead', 'a/b', 'x'.repeat(81)]) {
    assert.ok(run({ ...HUB_ARTICLE, slug: bad }).errors, 'accepted slug ' + JSON.stringify(bad));
  }
});

// ---------- upsert REPLACES ----------------------------------------------------------------------
t('re-posting a slug replaces the entry — omitted fields are cleared, not kept', () => {
  const first = ok(run(HUB_ARTICLE)).next;
  const created = first[0].createdAt;
  const r = ok(run({ type: 'article', title: 'My first post', body: 'v2', source: HUB_ARTICLE.source }, first, { now: '2026-10-01T00:00:00.000Z' }));
  assert.strictEqual(r.next.length, 1, 'duplicated instead of updated');
  assert.strictEqual(r.results[0].action, 'updated');
  assert.deepStrictEqual(r.next[0].tags, [], 'stale tags survived a replace');
  assert.strictEqual(r.next[0].createdAt, created, 'createdAt was not preserved');
});

t('an ingested video cannot silently replace an article that shares its slug', () => {
  const list = ok(run({ type: 'article', title: 'Launch', body: 'the article' })).next;
  const r = run({ type: 'video', title: 'Launch', youtubeId: 'dQw4w9WgXcQ' }, list);
  assert.ok(r.errors && /already used by an article/.test(JSON.stringify(r.errors)), 'the article was overwritten');
});

// ---------- drafts and dates ---------------------------------------------------------------------
t('ingested items are drafts by default; autoPublish and draft:false override', () => {
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b' })).next[0].draft, true);
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b' }, [], { autoPublish: true })).next[0].draft, false);
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b', draft: false })).next[0].draft, false);
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b', draft: true }, [], { autoPublish: true })).next[0].draft, true);
});

t('publishedAt: omitted is now, null is honestly undated, garbage is refused', () => {
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b' })).next[0].publishedAt, NOW);
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b', publishedAt: null })).next[0].publishedAt, null);
  // A bare date lands at MIDDAY UTC: midnight would display as June 23 across the Americas.
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b', publishedAt: '2023-06-24' })).next[0].publishedAt, '2023-06-24T12:00:00.000Z');
  // A full timestamp is taken exactly as given.
  assert.strictEqual(ok(run({ type: 'article', title: 'X', body: 'b', publishedAt: '2023-06-24T03:15:00Z' })).next[0].publishedAt, '2023-06-24T03:15:00.000Z');
  assert.ok(run({ type: 'article', title: 'X', body: 'b', publishedAt: 'last tuesday' }).errors);
});

// ---------- the route ----------------------------------------------------------------------------
const src = serverSource();
const route = src.slice(src.indexOf("app.post('/api/web-studio/sites/:id/ingest'"));
const body = route.slice(0, route.indexOf('\n// ====='));

t('the route is ownership-scoped and mounts the larger body parser', () => {
  assert.ok(route.startsWith("app.post('/api/web-studio/sites/:id/ingest', requireClientOrAdmin, wsArticleJsonIngest"), 'guards missing');
  assert.ok(body.includes('wsFindSite(req, res)'), 'not resolved through the ownership-scoped lookup');
  assert.ok(/WS_INGEST_WRITE = \/\^\\\/api\\\/web-studio\\\/sites\\\/\[\^\/\]\+\\\/ingest\$\//.test(src), 'global parser exception missing');
});

t('ingest runs under the per-site lock and re-reads the plan inside it', () => {
  const inLock = body.slice(body.indexOf('wsWithSiteLock(site.id'));
  assert.ok(inLock.indexOf('const plan = site.plan') > 0, 'the plan is read OUTSIDE the lock, so a queued request would work from stale data');
});

t('a deferred build persists; a real build keeps a failed batch', () => {
  assert.ok(/if \(!build\) \{[\s\S]*site\.plan = next;[\s\S]*saveState\('web_studio_sites'/.test(body), 'build=false does not persist');
  assert.ok(body.includes('wsApplyPlanChange(site, next, { persistPlanOnFailure: true })'), 'a failed build would discard the batch');
});

t('a rejected batch reports 422 and writes nothing', () => {
  const rejected = body.slice(body.indexOf('if (prepared.errors)'), body.indexOf('const next ='));
  assert.ok(rejected.includes('status: 422'), 'wrong status for a rejected batch');
  assert.ok(!/saveState|wsApplyPlanChange|site\.plan =/.test(rejected), 'the rejection path writes');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
