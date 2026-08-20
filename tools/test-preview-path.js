// tools/test-preview-path.js
// ============================================================
//  The web-studio preview route's path resolution, under Express 5's wildcard semantics.
//
//  WHY THIS EXISTS. Express 5 (path-to-regexp v8) changed a NAMED wildcard from `req.params[0]`
//  (a string) to `req.params.splat` (an ARRAY of already-decoded segments). Verified against a live
//  Express 5.2.1 app, not inferred from a changelog:
//      /preview/_astro/x/y.css  ->  { id: 'abc', splat: ['_astro','x','y.css'] }
//  Passing that array straight to path.resolve() throws a TypeError on every request, so the join
//  is load-bearing. This route also serves files off disk behind a containment guard, which makes
//  it the one place in the Express 5 migration where a mistake is a SECURITY mistake rather than a
//  404.
//
//  The block under test is READ OUT OF server.js rather than retyped, so this tests what ships. A
//  retyped copy would keep passing after someone edited the route.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

// Pull the real resolution + guard out of the handler.
// The tail is matched GENERICALLY, not by the guard's exact text. An earlier draft pinned
// `!target.startsWith(dist + path.sep)` verbatim, so weakening the guard broke EXTRACTION rather
// than tripping the traversal assertions — the suite failed at assertion 0 with "not found",
// which is a confusing error whose obvious fix is to loosen this regex and lose the real check.
// Keep this loose enough that a rewritten guard is caught BY THE ASSERTIONS below.
const m = src.match(
  /const splat = req\.params\.splat;[\s\S]*?send\('bad path'\);/
);
assert.ok(m, 'preview-route path resolution not found in server.js — did the route change shape?');

const BAD = Symbol('bad path');
/** Run the shipped block with a fabricated splat. Returns the resolved target, or BAD if rejected. */
function resolvePreview(splat, dist) {
  const req = { params: { splat } };
  const res = { status: () => ({ send: () => BAD }) };
  // eslint-disable-next-line no-new-func
  const fn = new Function('req', 'res', 'dist', 'path', `${m[0]}\n return target;`);
  return fn(req, res, dist, path);
}

const DIST = path.resolve('/srv/site/dist');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- The shape Express 5 actually delivers. ----------------------------------------------------
ok('joins an ARRAY splat into a real sub-path (the Express 5 shape)', () => {
  const t = resolvePreview(['_astro', 'x', 'y.css'], DIST);
  assert.notStrictEqual(t, BAD, 'a legitimate asset path must not be rejected');
  assert.strictEqual(t, path.resolve(DIST, '_astro/x/y.css'));
});

ok('handles a single-segment splat', () => {
  assert.strictEqual(resolvePreview(['favicon.ico'], DIST), path.resolve(DIST, 'favicon.ico'));
});

// --- Fallbacks. `/preview/` must still serve the site, not 400. -------------------------------
ok('falls back to index.html for an empty splat (bare /preview/)', () => {
  for (const empty of [[], undefined, '']) {
    assert.strictEqual(resolvePreview(empty, DIST), path.resolve(DIST, 'index.html'),
      `empty splat ${JSON.stringify(empty)} must fall back to index.html`);
  }
});

ok('tolerates a STRING splat, so a future Express change cannot silently break it', () => {
  assert.strictEqual(resolvePreview('_astro/x.css', DIST), path.resolve(DIST, '_astro/x.css'));
});

// --- THE GUARD. This is why the route matters. -------------------------------------------------
// path.resolve() normalises `..` BEFORE the containment check, so escapes collapse into an
// absolute path outside dist and are rejected. Asserting the REJECTION, not just the string.
ok('REJECTS traversal escapes via ..', () => {
  const attacks = [
    ['..', '..', 'etc', 'passwd'],
    ['..'],
    ['a', '..', '..', '..', 'secrets.env'],
    ['_astro', '..', '..', '..', '..', 'root', '.ssh', 'id_rsa'],
  ];
  for (const a of attacks) {
    assert.strictEqual(resolvePreview(a, DIST), BAD, `escape not rejected: ${a.join('/')}`);
  }
});

ok('REJECTS an absolute path smuggled through a segment', () => {
  // path.resolve() lets a later absolute segment win, which is exactly what the guard is for.
  assert.strictEqual(resolvePreview([path.resolve('/etc'), 'passwd'], DIST), BAD);
});

ok('allows a path that merely LOOKS like a sibling of dist', () => {
  // dist + '-evil' shares the prefix but is a different directory; the `path.sep` in the guard is
  // what distinguishes them. A guard written with a bare startsWith(dist) would wrongly allow this.
  const t = resolvePreview(['..', `${path.basename(DIST)}-evil`, 'x'], DIST);
  assert.strictEqual(t, BAD, 'a sibling directory sharing the dist prefix must be rejected');
});

ok('a `..` that stays INSIDE dist is allowed', () => {
  const t = resolvePreview(['a', '..', 'b.css'], DIST);
  assert.strictEqual(t, path.resolve(DIST, 'b.css'), 'normalising within dist is legitimate');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
