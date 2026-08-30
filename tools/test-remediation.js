// tools/test-remediation.js
// ============================================================
//  P3 wiring — remediation visibility. Three claims, each previously false:
//    1. a FAILED approval was terminal (no retry route);
//    2. remediation cost was recorded nowhere;
//    3. no pipeline-failure path notified anyone.
//  server.js boots on require → source-level, scoped to each construct.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

ok('a retry route exists, gated, and only accepts status failed', () => {
  const at = src.indexOf("app.post('/api/approvals/:id/retry'");
  assert.notStrictEqual(at, -1, 'retry route missing — failed approvals are terminal again');
  const route = src.slice(at, src.indexOf('});', src.indexOf('res.json', at)));
  assert.ok(/requireAdmin, heavyLimiter/.test(src.slice(at, at + 120)));
  assert.ok(/status !== 'failed'/.test(route), 'retry must refuse anything not failed');
  assert.ok(/executeApprovedAction\(a, secrets, actor\)/.test(route),
    'retry re-runs the SHARED executor — no third implementation');
  assert.ok(/retryCount/.test(route) && /lastError/.test(route),
    'repeated failure must be visible (retryCount) and the prompting error preserved (lastError)');
});

ok('a remediation route exists and refuses pending items', () => {
  const at = src.indexOf("app.post('/api/approvals/:id/remediation'");
  assert.notStrictEqual(at, -1, 'remediation route missing');
  const route = src.slice(at, src.indexOf('});', src.indexOf('res.json', at)));
  assert.ok(/status === 'pending'/.test(route), 'remediation is recorded on RESOLVED actions only');
  assert.ok(/minutes < 0 \|\| minutes > 6000/.test(route), 'minutes bounded — a typo of 1e9 is not a datum');
  assert.ok(/remediationMinutes/.test(route) && /remediationAt/.test(route));
});

ok('every pipeline-failure site notifies, once per run', () => {
  const helper = src.indexOf('function notifyPipelineFailure(run)');
  assert.notStrictEqual(helper, -1, 'helper missing');
  const helperBody = src.slice(helper, src.indexOf('\n}', helper));
  assert.ok(/failureNotified/.test(helperBody), 'the once-per-run guard is the point — a refusal storm must not nag 52x/day');
  assert.ok(/sendNotification\(/.test(helperBody));
  // Every site that sets run.status = 'failed' must call the helper nearby (within its block).
  const sites = [...src.matchAll(/run\.status = 'failed'/g)].map((m) => m.index);
  assert.ok(sites.length >= 5, `expected the 5 known failure sites, found ${sites.length}`);
  for (const i of sites) {
    const after = src.slice(i, i + 400);
    assert.ok(/notifyPipelineFailure\(run\)/.test(after),
      `failure site at index ${i} does not notify — a run can die silently again`);
  }
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
