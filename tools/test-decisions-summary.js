// tools/test-decisions-summary.js
// ============================================================
//  The federated decision count (audit P2b). Before it, the Inbox badge counted ONLY action
//  approvals: a run awaiting a pipeline gate, a queued automation, a platform proposal, or a clone
//  draft awaiting review was invisible from every other screen — six surfaces, five of them
//  uncounted. /api/decisions/summary is the one number for "how many decisions wait on me".
//
//  server.js boots on require, so wiring is asserted at source, scoped to the route body.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const at = src.indexOf("app.get('/api/decisions/summary'");
assert.notStrictEqual(at, -1, 'the federated endpoint does not exist');
const route = src.slice(at, src.indexOf('});', src.indexOf('res.json', at)));

ok('endpoint is admin-gated', () => {
  assert.ok(/requireAdmin/.test(src.slice(at, at + 120)));
});

ok('every counted surface uses the discovered pending predicate, not a guess', () => {
  // Each of these predicates was DISCOVERED from the writing site, not assumed:
  assert.ok(/kind === 'action' && a\.status === 'pending'/.test(route), 'action approvals');
  assert.ok(/kind === 'proposal' && a\.status === 'pending'/.test(route), 'platform proposals');
  assert.ok(/pipelineRuns\.values\(\)\]\.filter\(r => r\.status === 'awaiting_approval'\)/.test(route),
    'pipeline gates count awaiting_approval runs (the status set at server.js stage/run gating)');
  assert.ok(/automationLog\.filter\(e => e\.status === 'pending_approval'\)/.test(route), 'automations');
  assert.ok(/cloneDrafts\.filter\(d => d\.status === 'pending'\)/.test(route), 'clone drafts');
  assert.ok(/clonePersonaProposals\.filter\(p => p\.status === 'pending'\)/.test(route), 'evolve proposals');
});

ok('Hermes is EXCLUDED, with the reason in the payload — not silently missing', () => {
  assert.ok(/excluded: \{ hermes:/.test(route),
    'the exclusion must be visible in the response, so a consumer knows the total is 5-surface');
  assert.ok(/demo-seeded/.test(route), 'the reason must name the cause: demo-seeded data');
});

const app = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'app.js'), 'utf8');

ok('the badge uses the federated total, with a fallback for old servers', () => {
  const badgeAt = app.indexOf('const badge = document.getElementById(\'inboxBadge\')');
  const before = app.slice(Math.max(0, badgeAt - 700), badgeAt);
  assert.ok(/state\.decisionSummary && typeof state\.decisionSummary\.total === 'number'/.test(before),
    'badge must prefer the federated total');
  assert.ok(/state\.inbox\.filter\(i => i\.status === 'pending'\)\.length/.test(before),
    'and fall back to the inbox-only count when the endpoint is absent');
});

ok('the breakdown strip uses data-* dispatch, not string interpolation into onclick', () => {
  const stripAt = app.indexOf('Also waiting elsewhere:');
  assert.notStrictEqual(stripAt, -1, 'breakdown strip missing');
  const strip = app.slice(stripAt - 400, stripAt + 600);
  assert.ok(/data-goto-view="\$\{view\}"/.test(strip) && /switchView\(this\.dataset\.gotoView\)/.test(strip),
    'the 99249a5 two-context lesson: dispatch via dataset, never a value inside an onclick string');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
