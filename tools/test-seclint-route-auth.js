// seclint's route-no-auth rule: a mutating /api route must carry AUTH middleware or be allowlisted.
//
// This suite exists because the rule it tests replaced one that did not work. The old version matched
// only `app.post('/api/x', (req` — the handler directly after the path — so ANY middleware satisfied
// it. A rate limiter is not auth, and `app.post('/api/x', heavyLimiter, async (req, res) =>` sailed
// through while being exactly as anonymous as the shape the rule was written to catch.
// /api/web-studio/sites/:id/chat was live in precisely that shape, unallowlisted, calling a paid model
// for anonymous visitors of any generated site. Case 1 below is that regression, pinned.
//
// Like the other tools/test-seclint-*.js suites, this drives the REAL CLI over throwaway fixtures
// rather than importing the rule: a suite must not be able to pass while the shipped linter fails.
const { assert, done, cleanupAndFinish, seclintFixture } = require('./test-util');

const F = seclintFixture('seclint-route-auth-');
const HANDLER = '{ res.json({ ok: true }); });';
const hits = (src) => (F.run(src).match(/route-no-auth/g) || []).length;

// --- CAUGHT: anonymous mutating routes -----------------------------------------------------------
// The middleware in these chains is real and useful; none of it authenticates anyone.
const caught = [
  ['a shared rate limiter — THE regression this rule exists for',
    `app.post('/api/newthing', heavyLimiter, async (req, res) => ${HANDLER}`],
  ['a bespoke rate limiter',
    `app.post('/api/newthing', myOwnLimiter, async (req, res) => ${HANDLER}`],
  ['no middleware at all (what the old rule did catch — still caught)',
    `app.post('/api/newthing', async (req, res) => ${HANDLER}`],
  ['a body parser is not auth either',
    `app.post('/api/newthing', express.urlencoded({ extended: false }), (req, res) => ${HANDLER}`],
  // authLimiter is a RATE LIMITER whose name contains "auth". A looser "does the chain mention auth?"
  // test passes it, which is why the rule matches `require*` and not the substring.
  ['authLimiter — a limiter named like a guard',
    `app.post('/api/newthing', authLimiter, async (req, res) => ${HANDLER}`],
  ['PUT is mutating too',
    `app.put('/api/newthing', heavyLimiter, async (req, res) => ${HANDLER}`],
  ['DELETE is mutating too',
    `app.delete('/api/newthing', heavyLimiter, async (req, res) => ${HANDLER}`],
  ['a limiter-only chain spread over several lines',
    `app.post('/api/newthing',\n  heavyLimiter,\n  express.urlencoded({ extended: false }),\n  async (req, res) => ${HANDLER}`],
];
for (const [label, src] of caught) assert(hits(src) === 1, `CAUGHT: ${label}`);

// --- CLEAN: genuinely authenticated routes -------------------------------------------------------
// Every auth form the codebase actually uses, so tightening the rule cannot cost 143 false positives.
const clean = [
  ['requireAdmin', `app.post('/api/thing', requireAdmin, async (req, res) => ${HANDLER}`],
  ['requireClientOrAdmin + a limiter', `app.post('/api/thing', requireClientOrAdmin, heavyLimiter, async (req, res) => ${HANDLER}`],
  ['requireCloneAccess', `app.post('/api/thing', requireCloneAccess, async (req, res) => ${HANDLER}`],
  // A call expression must survive as one token — naive comma-splitting would tear
  // `requireCommercial('leadGen')` in half and lose the guard.
  ['requireCommercial(\'leadGen\') — a call, not a bare name',
    `app.post('/api/thing', requireAdmin, requireCommercial('leadGen'), heavyLimiter, async (req, res) => ${HANDLER}`],
  ['a2aAuth — authenticates at the route level under its own name',
    `app.post('/api/a2a', a2aAuth, async (req, res) => ${HANDLER}`],
  ['auth on a continuation line, limiter first',
    `app.post('/api/thing',\n  heavyLimiter,\n  requireAdmin,\n  async (req, res) => ${HANDLER}`],
  ['a (req, res) named _req still reads as the handler boundary',
    `app.post('/api/thing', requireAdmin, (_req, res) => ${HANDLER}`],
];
for (const [label, src] of clean) assert(hits(src) === 0, `clean: ${label}`);

// --- OUT OF SCOPE --------------------------------------------------------------------------------
assert(hits(`app.get('/api/thing', async (req, res) => ${HANDLER}`) === 0,
  'GET is not mutating — the rule stays off read routes');
assert(hits(`app.post('/webhook/thing', heavyLimiter, async (req, res) => ${HANDLER}`) === 0,
  'non-/api paths are out of scope');

// --- THE ALLOWLIST IS THE ESCAPE HATCH, AND IT IS EXACT ------------------------------------------
assert(hits(`app.post('/api/seo/free-audit', heavyLimiter, async (req, res) => ${HANDLER}`) === 0,
  'an allowlisted public route with a limiter is accepted');
// Prefix matching would let /api/seo/free-audit-v2 inherit the exemption without anyone deciding to
// grant it. Allowlisting must be a per-path act.
assert(hits(`app.post('/api/seo/free-audit-v2', heavyLimiter, async (req, res) => ${HANDLER}`) === 1,
  'a NEW route that merely starts with an allowlisted path is still caught');

// --- A FINDING MUST FAIL THE BUILD, NOT JUST PRINT -----------------------------------------------
// A rule at level `error` that still exits 0 is decorative: CI would stay green.
assert(F.exitCode(`app.post('/api/newthing', heavyLimiter, async (req, res) => ${HANDLER}`) !== 0,
  'a caught route exits non-zero, so CI actually fails');

// --- AND THE SHIPPED CODEBASE PASSES -------------------------------------------------------------
// Tightening a linter only counts once the real tree is clean under it.
const ci = F.ci();
assert(ci.code === 0, `the repo itself is clean under the tightened rule (exit ${ci.code})`);
assert(!/route-no-auth/.test(ci.out), 'no route-no-auth findings remain in the repo');

F.cleanup();
cleanupAndFinish(null);
