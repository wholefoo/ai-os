// tools/test-oversight.js
// ============================================================
//  The oversight ledger (lib/oversight.js) — P1 of the agent-overhead audit. The metric that
//  answers "what do the agents cost the OPERATOR": decisions demanded, time-to-decision, queue
//  depth, gated-vs-auto share.
//
//  Assertions are on VALUES, not counts (assert-on-values-not-counts): a median that computes the
//  wrong number is exactly as green as a right one under a length check. Time is INJECTED — the
//  module takes {now}, so every expected value here is exact arithmetic, not clock-dependent.
// ============================================================

const assert = require('assert');
const { computeOversight, pctl } = require('../lib/oversight.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const NOW = Date.parse('2026-08-30T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600000;

// --- empty: the "no data" shape must be nulls, never NaN or 0-pretending-to-be-measured ----------
ok('empty queue → nulls where nothing was measured, zeros where zero was counted', () => {
  const o = computeOversight([], {}, { now: NOW });
  assert.strictEqual(o.pending.depth, 0);
  assert.strictEqual(o.pending.oldestAgeMs, null, 'no pending → null age, not 0');
  assert.strictEqual(o.decided.medianDecisionMs, null, 'no decisions → null median, not NaN');
  assert.strictEqual(o.decided.p90DecisionMs, null);
  assert.strictEqual(o.autoVsGated.gatedShare, null, 'nothing ran → null share; 0 would read as "fully autonomous"');
});

ok('pctl on empty is null; on singletons the value itself', () => {
  assert.strictEqual(pctl([], 50), null);
  assert.strictEqual(pctl([42], 50), 42);
  assert.strictEqual(pctl([42], 90), 42);
});

// --- exact decision arithmetic -------------------------------------------------------------------
ok('median and p90 are exact on a known distribution', () => {
  // Five decisions taking 1h,2h,3h,4h,10h — median (nearest-rank, p50 of 5) = 3h, p90 = 10h.
  const approvals = [1, 2, 3, 4, 10].map((hours, i) => ({
    id: `a${i}`, status: 'approved', risk: 'high',
    createdAt: iso(24 * H), approvedAt: iso(24 * H - hours * H),
  }));
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.medianDecisionMs, 3 * H, `median must be exactly 3h, got ${o.decided.medianDecisionMs}`);
  assert.strictEqual(o.decided.p90DecisionMs, 10 * H);
  assert.strictEqual(o.decided.total, 5);
  assert.strictEqual(o.decided.perDay, Math.round((5 / 30) * 100) / 100);
});

ok('oldest pending age is the actual oldest, and byRisk buckets by value', () => {
  const approvals = [
    { id: 'p1', status: 'pending', risk: 'high', createdAt: iso(2 * H) },
    { id: 'p2', status: 'pending', risk: 'critical', createdAt: iso(50 * H) },
    { id: 'p3', status: 'pending', risk: 'high', createdAt: iso(1 * H) },
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.pending.depth, 3);
  assert.strictEqual(o.pending.oldestAgeMs, 50 * H, 'oldest must be the 50h item');
  assert.deepStrictEqual(o.pending.byRisk, { high: 2, critical: 1 });
});

// --- failed-after-approval is decided AND separately visible -------------------------------------
ok('an approved-then-failed item counts as a decision but is named as recovery debt', () => {
  const approvals = [
    { id: 'f1', status: 'failed', risk: 'high', createdAt: iso(3 * H), approvedAt: iso(2 * H), error: 'executor threw' },
    { id: 'a1', status: 'approved', risk: 'high', createdAt: iso(3 * H), approvedAt: iso(1 * H) },
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.total, 2, 'both decisions were made');
  assert.strictEqual(o.decided.approved, 1, 'failed must NOT hide inside approved');
  assert.strictEqual(o.decided.failedAfterApproval, 1);
  assert.strictEqual(o.decided.medianDecisionMs, H, 'median of [1h, 2h] nearest-rank p50 = 1h');
});

// --- window edges --------------------------------------------------------------------------------
ok('a decision outside the window is excluded; its pending twin still counts in the queue', () => {
  const approvals = [
    { id: 'old', status: 'approved', risk: 'low', createdAt: iso(40 * 24 * H), approvedAt: iso(35 * 24 * H) },
    { id: 'sit', status: 'pending', risk: 'low', createdAt: iso(40 * 24 * H) },
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.total, 0, '35-day-old decision is outside the 30d window');
  assert.strictEqual(o.pending.depth, 1, 'a pending item is CURRENT state however old it is');
  assert.strictEqual(o.pending.oldestAgeMs, 40 * 24 * H);
});

// --- gated vs auto -------------------------------------------------------------------------------
ok('gatedShare is gated/(gated+auto), auto summed from in-window day buckets only', () => {
  const approvals = [
    { id: 'g1', status: 'pending', risk: 'high', createdAt: iso(1 * H) },
    { id: 'g2', status: 'approved', risk: 'high', createdAt: iso(2 * H), approvedAt: iso(1 * H) },
  ];
  const counters = {
    autoApproved: 100,
    autoByDay: {
      [new Date(NOW - 1 * 24 * H).toISOString().slice(0, 10)]: 5,
      [new Date(NOW - 2 * 24 * H).toISOString().slice(0, 10)]: 3,
      '2026-06-01': 92,  // outside the 30d window — must not count toward the window share
    },
  };
  const o = computeOversight(approvals, counters, { now: NOW });
  assert.strictEqual(o.autoVsGated.autoApproved, 8, 'only in-window buckets: 5+3');
  assert.strictEqual(o.autoVsGated.gated, 2);
  assert.strictEqual(o.autoVsGated.gatedShare, 20, '2 gated of 10 total = 20%');
  assert.strictEqual(o.autoVsGated.autoApprovedAllTime, 100);
});

// --- remediation cost (P3) -----------------------------------------------------------------------
ok('remediation minutes sum in-window by WHEN LOGGED, and count separates zero from never', () => {
  const approvals = [
    { id: 'r1', status: 'failed', createdAt: iso(10 * H), approvedAt: iso(9 * H),
      remediationMinutes: 45, remediationAt: iso(2 * H) },
    { id: 'r2', status: 'approved', createdAt: iso(8 * H), approvedAt: iso(7 * H),
      remediationMinutes: 0, remediationAt: iso(1 * H) },              // logged as ZERO — still counts
    { id: 'r3', status: 'approved', createdAt: iso(45 * 24 * H), approvedAt: iso(44 * 24 * H),
      remediationMinutes: 500, remediationAt: iso(40 * 24 * H) },      // logged OUTSIDE the window
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.remediation.minutes, 45, 'only in-window logs sum: 45 + 0');
  assert.strictEqual(o.decided.remediation.count, 2, 'the zero-minute log still counts as a log');
});

ok('no remediation logged → {minutes: 0, count: 0}, distinguishable from measured zero by count', () => {
  const o = computeOversight([{ id: 'a', status: 'approved', createdAt: iso(2 * H), approvedAt: iso(H) }], {}, { now: NOW });
  assert.deepStrictEqual(o.decided.remediation, { minutes: 0, count: 0 });
});

// --- malformed input must degrade, not throw or poison -------------------------------------------
ok('malformed rows are skipped, not fatal, and cannot produce NaN', () => {
  const approvals = [
    null,
    { id: 'x', status: 'pending' },                                   // no createdAt → dropped
    { id: 'y', status: 'approved', createdAt: 'garbage', approvedAt: iso(H) },
    { id: 'z', status: 'approved', createdAt: iso(2 * H), approvedAt: iso(H) },
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.medianDecisionMs, H, 'the one well-formed decision computes exactly');
  assert.ok(!Number.isNaN(o.decided.perDay));
});

// --- the wiring exists (source level — server.js cannot be require()d) ---------------------------
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
ok('getCostSummary carries the oversight block and gateAction feeds the counters', () => {
  assert.ok(/oversight: oversightLedger\.computeOversight\(pendingApprovals, oversightCounters\)/.test(src),
    'the /api/costs payload must carry the oversight ledger');
  // Scope to the auto-approve branch: between the Auto-approved log line and the executor call.
  const at = src.indexOf('Auto-approved (${d.mode} mode)');
  assert.notStrictEqual(at, -1, 'auto-approve branch not found');
  const branch = src.slice(at, src.indexOf('ACTION_EXECUTORS[type](params)', at));
  assert.ok(/oversightCounters\.autoByDay\[day\]/.test(branch),
    'the auto-approve branch must bump the day-bucketed counter BEFORE executing');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
