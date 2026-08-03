// Tests lib/handbooks/criterion-stats — which criteria fire, and which duplicate each other.
//
// §9 item 14 of .magent/vault/wiki/agent-handbooks-design.md. P2 derived criterion ids from their
// TEXT precisely so they survive between runs; this is the consumer those ids were built for.
//
// The assertions that matter most are the ones about REFUSING to conclude. With a single observation
// every pair of criteria agrees perfectly and nothing has ever failed, so a naive implementation
// would recommend deleting the entire corpus after one run — and a deleted standard is not restored
// by re-running. Every claim here has to earn a sample size first.
const stats = require('../lib/handbooks/criterion-stats');
const { assert, done, serverSource } = require('./test-util');

const R = (id, status, text, source) => ({ id, status, description: text || `criterion ${id}`, source: source || 'handbook' });

// --- recording ------------------------------------------------------------------------------------
let s = stats.record(null, [R('a', 'pass'), R('b', 'fail')], { agent: 'researcher' });
assert(s.runs === 1, 'a run is counted');
assert(s.criteria.a.pass === 1 && s.criteria.b.fail === 1, 'each criterion keeps its own verdict tally');
assert(s.criteria.a.agents.join() === 'researcher', 'and which agents it has been applied to');
assert(s.criteria.b.text === 'criterion b', 'the text is kept so a report can show WHAT to delete');

s = stats.record(s, [R('a', 'pass'), R('b', 'partial')], { agent: 'writer' });
assert(s.runs === 2 && s.criteria.a.runs === 2, 'a second run accumulates');
assert(s.criteria.b.partial === 1 && s.criteria.b.fail === 1, 'verdicts are tracked separately, not collapsed to pass/not-pass');
assert(s.criteria.a.agents.length === 2, 'agents accumulate');

assert(stats.record(null, []).runs === 0, 'a verification with no gradeable results is not counted as a run');
assert(stats.record(null, [{ id: 'x', status: 'weird' }]).runs === 0, 'and an unknown status is ignored rather than tallied as something');
assert(stats.record(null, [{ status: 'pass' }]).runs === 0, 'a result with no id cannot be tracked — ids are the whole mechanism');

// record must not mutate the store it was given: the caller persists the returned value, and an
// in-place mutation would make a failed save silently take effect anyway.
const before = stats.record(null, [R('a', 'pass')]);
const snapshot = JSON.stringify(before);
stats.record(before, [R('a', 'fail')]);
assert(JSON.stringify(before) === snapshot, 'record() does not mutate its input');

// --- it REFUSES to judge on thin data -------------------------------------------------------------
let thin = null;
for (let i = 0; i < stats.MIN_RUNS_TO_JUDGE - 1; i++) thin = stats.record(thin, [R('a', 'pass'), R('b', 'pass')]);
let sum = stats.summarizeCriteria(thin);
assert(sum.neverFails.length === 0,
  `nothing is called dead below ${stats.MIN_RUNS_TO_JUDGE} runs — after one run EVERY criterion has never failed`);
assert(sum.redundant.length === 0 || thin.pairs['a|b'].together >= stats.MIN_COOCCURRENCE,
  'and no pair is called redundant before it has co-occurred enough times');
assert(sum.undecided === 2, 'criteria below the bar are reported as UNDECIDED, not as absent');
assert(/need \d+ before/.test(sum.readiness) || /still below/.test(sum.readiness),
  'and the summary says in plain words why it is not concluding');

// --- once the sample is there ---------------------------------------------------------------------
let ripe = null;
for (let i = 0; i < stats.MIN_RUNS_TO_JUDGE; i++) {
  ripe = stats.record(ripe, [
    R('always', 'pass', 'Output is in English.'),
    R('dup1', 'partial', 'Every claim cites a source retrieved in this run.', 'skill'),
    R('dup2', 'partial', 'Claims are supported by evidence or labeled as assumptions', 'rubric'),
    R('real', i % 2 ? 'fail' : 'pass', 'At least 5 distinct sources cited.'),
  ]);
}
sum = stats.summarizeCriteria(ripe);
assert(sum.neverFails.some((c) => c.id === 'always'), 'a criterion that never once failed IS surfaced for deletion once the sample is there');
assert(!sum.neverFails.some((c) => c.id === 'real'), 'and one that sometimes fails is not — it is doing work');
assert(!sum.neverFails.some((c) => c.id === 'dup1'), 'a criterion that lands PARTIAL is not "never fails" — partial is a real signal, not a pass');
assert(sum.neverFails[0].text && sum.neverFails[0].source, 'the deletion candidate carries its text and where it came from');

const pair = sum.redundant.find((p) => [p.a.id, p.b.id].sort().join() === 'dup1,dup2');
assert(pair, 'two criteria that always agree ARE reported as redundant — the live case was three ways of asking for citations');
assert(pair.agreementRate === 1 && pair.together >= stats.MIN_COOCCURRENCE, 'with the evidence: how often together, how often they agreed');
assert(!sum.redundant.some((p) => [p.a.id, p.b.id].includes('real') && [p.a.id, p.b.id].includes('always')),
  'criteria that disagree are NOT called redundant');

// --- bounded ----------------------------------------------------------------------------------------
let big = null;
const many = Array.from({ length: 40 }, (_, i) => R('c' + i, 'pass'));
for (let i = 0; i < 3; i++) big = stats.record(big, many);
assert(Object.keys(big.criteria).length <= stats.MAX_TRACKED, 'tracked criteria stay bounded');
assert(Object.keys(big.pairs).every((k) => { const [a, b] = k.split('|'); return big.criteria[a] && big.criteria[b]; }),
  'and no pair references a criterion that was pruned away');

// --- the server records and exposes it --------------------------------------------------------------
const src = serverSource();
assert(/criterionStore = criterionStats\.record\(criterionStore, report\.results/.test(src),
  'every completed verification is folded into the tally');
assert(/saveState\('criterion_stats', criterionStore\)/.test(src),
  'and persisted — an in-memory tally resets on deploy and never reaches the sample size it needs');
assert(/loadState\('criterion_stats'/.test(src), 'and reloaded at boot');
assert(/try \{[\s\S]{0,200}criterionStats\.record/.test(src),
  'recording is best-effort — instrumentation must never fail a verification that already has a verdict');
assert(/app\.get\('\/api\/verify\/criteria', requireAdmin/.test(src), 'the report is exposed, admin-only');

// Express matches in order: a literal path registered AFTER `/api/verify/:id` would be swallowed by it
// and return "verification not found" for a route that exists.
assert(src.indexOf("app.get('/api/verify/criteria'") < src.indexOf("app.get('/api/verify/:id'"),
  'and is registered BEFORE /api/verify/:id, or the id route swallows it');

// The report is advisory. Deleting a standard is not undone by re-running, so nothing here deletes.
assert(!/criterionStats\.(delete|remove|prune)\w*\(/.test(src.replace(/function prune/g, '')),
  'nothing in the server deletes a criterion — the report names candidates and the operator decides');

console.log(`  info: thresholds — judge after ${stats.MIN_RUNS_TO_JUDGE} runs, pairs after ${stats.MIN_COOCCURRENCE} co-occurrences at >=${stats.REDUNDANCY_THRESHOLD} agreement`);
done();
