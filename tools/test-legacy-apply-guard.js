// tools/test-legacy-apply-guard.js
// ============================================================
//  The LEGACY enterprise applyProposal path (server.js) — P0 of the 2026-08-28 agent-overhead
//  audit. Before this guard, content-refresh wrote to any path that survived a 4-entry substring
//  denylist, with no traversal or symlink check: `path.join(BASE, '../x')` escaped the repo, and
//  lib/safety/approval.js, .claude/agents/*, and .magent/state/settings.json (plaintext API keys)
//  were all writable by an approved low-risk "content refresh". security-patch ran
//  `npm audit fix --force`, which on this repo is a DOCUMENTED breaking downgrade
//  (silero 1.6.3→1.3.2, exceljs 4.4.0→3.4.0 — both investigated 2026-08-27, both unreachable vulns).
//
//  server.js cannot be require()d in a test (it boots the app), so the wiring is asserted at
//  SOURCE level — same approach as test-pipeline-events.js, and like there, each assertion is
//  scoped so that deleting the guard fails the test rather than a comment satisfying it.
//  The containment functions themselves are require()d and exercised for real.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const plans = require('../lib/self-improve/plan-store.js');
const approval = require('../lib/safety/approval.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- the shared containment is real, exported, and bites -----------------------------------------
ok('plan-store exports assertContained (one implementation, not a legacy copy)', () => {
  assert.strictEqual(typeof plans.assertContained, 'function');
});

ok('assertContained throws on ../ traversal out of the repo', () => {
  assert.throws(() => plans.assertContained(ROOT, '../escaped.txt'), /outside|refus/i);
});

ok('isPathAllowed refuses the paths the old denylist missed', () => {
  // These were all WRITABLE under BLOCKED_PATHS.some(includes).
  assert.strictEqual(plans.isPathAllowed('.magent/state/settings.json'), false,
    'settings.json holds plaintext API keys and must never be a content-refresh target');
  assert.strictEqual(plans.isPathAllowed('commercial/modules/x.js'), false,
    'commercial/ is a separate repo and always denied');
});

// --- the registry names the action ---------------------------------------------------------------
ok('self-improve.apply-proposal is registered critical', () => {
  assert.strictEqual(approval.ACTION_RISK['self-improve.apply-proposal'], 'critical');
});

// --- source-level wiring in server.js ------------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
// Scope every assertion to the content-refresh CASE BODY, not the whole file — a comment elsewhere
// mentioning these names must not be able to satisfy the test.
const start = src.indexOf("case 'content-refresh': {");
assert.notStrictEqual(start, -1, 'content-refresh case not found — applyProposal shape changed');
const end = src.indexOf('break;', src.indexOf('fs.writeFileSync', start));
const body = src.slice(start, end);

ok('content-refresh is gated by a content-root ALLOWLIST, not only the denylist', () => {
  assert.ok(/CONTENT_REFRESH_ROOTS/.test(body), 'no allowlist in the case body');
  assert.ok(/inContentRoot/.test(body) && /isPathAllowed/.test(body),
    'allowlist + plan-store denylist must both gate the write');
});

ok('content-refresh calls the SHARED assertContained before writing', () => {
  const writeAt = body.indexOf('fs.writeFileSync');
  const containAt = body.indexOf('assertContained');
  assert.notStrictEqual(containAt, -1, 'assertContained not called in content-refresh');
  assert.ok(containAt < writeAt, 'containment must run BEFORE the write');
});

ok('security-patch no longer uses --force', () => {
  const spStart = src.indexOf("case 'security-patch': {");
  const spBody = src.slice(spStart, src.indexOf('break;', spStart));
  // Assert on the EXECUTED line, not the case body: the comment explaining WHY --force is banned
  // necessarily contains the banned string (the vhost soft-404 test hit the identical trap).
  const execLine = spBody.split('\n').find((l) => /execSync\(/.test(l));
  assert.ok(execLine && /npm audit fix/.test(execLine), 'npm audit fix execSync call missing');
  assert.ok(!/--force/.test(execLine),
    'npm audit fix --force is a documented breaking downgrade on this repo');
});

ok('applyProposal results carry the canonical actionId', () => {
  const apStart = src.indexOf('async function applyProposal(');
  const apHead = src.slice(apStart, apStart + 800);
  assert.ok(/actionId: 'self-improve\.apply-proposal'/.test(apHead));
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
