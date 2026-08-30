// tools/test-repeat-offenders.js
// ============================================================
//  P4 — the mistake-repeated signal. summarizeCriteria surfaced never-fails and redundancy but
//  never the criteria that KEEP FAILING; and rejections carried reasons nothing aggregated.
//
//  Pure-module assertions on exact values (the store is synthetic, thresholds are known).
//  The suggestion is a HUMAN prompt, never an auto-edit — asserted on wording, because the
//  distinction lives in the sentence.
// ============================================================

const assert = require('assert');
const stats = require('../lib/handbooks/criterion-stats.js');
const { computeOversight } = require('../lib/oversight.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// Build a store through the real record() path so shapes stay honest.
function storeWith(runsPerCriterion) {
  // runsPerCriterion: { id: ['pass','fail','partial', ...] }
  let s = stats.emptyStore();
  const maxLen = Math.max(...Object.values(runsPerCriterion).map((a) => a.length));
  for (let i = 0; i < maxLen; i++) {
    const results = Object.entries(runsPerCriterion)
      .filter(([, seq]) => i < seq.length)
      .map(([id, seq]) => ({ id, description: `criterion ${id}`, source: 'handbook', status: seq[i] }));
    s = stats.record(s, results, { agent: 'coder' });
  }
  return s;
}

ok('a criterion failing 5 of 10 runs is an offender with the exact weighted rate', () => {
  const s = storeWith({
    bad: ['fail', 'fail', 'fail', 'fail', 'fail', 'pass', 'pass', 'pass', 'pass', 'pass'],
    good: ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'],
  });
  const sum = stats.summarizeCriteria(s);
  assert.strictEqual(sum.repeatOffenders.length, 1);
  const o = sum.repeatOffenders[0];
  assert.strictEqual(o.id, 'bad');
  assert.strictEqual(o.failRate, 0.5, '5 fails / 10 runs = 0.5 exactly');
  assert.deepStrictEqual(o.agents, ['coder'], 'the owning agent is named');
  assert.ok(/human call/i.test(o.suggestion) && /handbook|rubric/i.test(o.suggestion),
    'the suggestion must present BOTH readings (behaviour vs criterion) as a human decision');
});

ok('partials count at half weight — all-partial crosses the 0.4 bar, and a clean criterion never appears', () => {
  const s = storeWith({
    scraping: Array(10).fill('partial'),   // 10 * 0.5 / 10 = 0.5 ≥ 0.4
  });
  const sum = stats.summarizeCriteria(s);
  assert.strictEqual(sum.repeatOffenders.length, 1);
  assert.strictEqual(sum.repeatOffenders[0].failRate, 0.5);
});

ok('below MIN_RUNS_TO_JUDGE nothing is an offender, however bad the rate', () => {
  const s = storeWith({ young: ['fail', 'fail', 'fail'] });   // 3 runs < 8
  assert.strictEqual(stats.summarizeCriteria(s).repeatOffenders.length, 0,
    'an early conclusion about a criterion is the exact failure this module documents refusing');
});

ok('a 30% failer stays below the 0.4 threshold', () => {
  const s = storeWith({ okish: ['fail', 'fail', 'fail', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'] });
  assert.strictEqual(stats.summarizeCriteria(s).repeatOffenders.length, 0);
});

// --- reject reasons (oversight side) -------------------------------------------------------------
const NOW = Date.parse('2026-08-30T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600000;

ok('reject reasons normalise, count, and rank; blank reasons counted separately', () => {
  const approvals = [
    { id: 'r1', status: 'rejected', risk: 'high', createdAt: iso(5 * H), rejectedAt: iso(4 * H), rejectReason: 'Too risky' },
    { id: 'r2', status: 'rejected', risk: 'high', createdAt: iso(5 * H), rejectedAt: iso(3 * H), rejectReason: '  too risky ' },
    { id: 'r3', status: 'rejected', risk: 'low', createdAt: iso(5 * H), rejectedAt: iso(2 * H), rejectReason: 'wrong recipient' },
    { id: 'r4', status: 'rejected', risk: 'low', createdAt: iso(5 * H), rejectedAt: iso(1 * H), rejectReason: '' },
  ];
  const o = computeOversight(approvals, {}, { now: NOW });
  assert.strictEqual(o.decided.rejectReasons.withReason, 3);
  assert.strictEqual(o.decided.rejectReasons.withoutReason, 1,
    'a low with-reason share is itself a signal — the prompt is being skipped');
  assert.deepStrictEqual(o.decided.rejectReasons.top[0], { reason: 'too risky', count: 2 },
    'case/whitespace variants are ONE pattern');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
