// Tests lib/a2a/budget: a scoped A2A key's daily cap cannot be exceeded by the request that is
// currently running.
//
// The bug: the route refused a key only once `spentUsd >= dailyBudgetUsd`, then charged the ACTUAL
// cost after the agent had run. A key with a cent left passed the check and ran a full request, so
// the cap could be exceeded by nearly the price of one call — on every call, silently. The
// assertions below are written against that scenario directly, because "budget enforced" and
// "budget enforced BEFORE the money is spent" are different claims and only the second one is
// worth anything.
const budget = require('../lib/a2a/budget');
const { assert, done, serverSource } = require('./test-util');

const RATE = { input: 5.00, output: 25.00 };   // Opus 4.8, per 1M
const DAY = '2026-08-01';

// --- the estimate is a worst case, not a guess ---------------------------------------------------
const est = budget.estimateCostUsd({ maxTokens: 4096, inputTokens: 1000, rate: RATE });
assert(Math.abs(est - (4096 / 1e6 * 25 + 1000 / 1e6 * 5)) < 1e-9, 'the estimate is maxTokens at the output rate plus input at the input rate');
assert(est > 0.1 && est < 0.11, `a 4096-token Opus call reserves about ten cents (got ${est})`);
assert(budget.estimateCostUsd({ rate: RATE }) === 0, 'no tokens, no reservation');
assert(budget.estimateCostUsd({ maxTokens: 4096 }) === 0, 'an unknown rate estimates zero rather than NaN — NaN would compare false against every budget and silently let everything through');

// --- THE BUG: a nearly-exhausted key must not be able to run a full call --------------------------
const nearlyGone = { date: DAY, spentUsd: 0.99, reservedUsd: 0 };
const attempt = budget.hold(nearlyGone, 1.00, est, DAY);
assert(attempt.ok === false,
  'a key with $0.01 left is REFUSED a call that could cost $0.10 — under the old check it passed, because 0.99 < 1.00, and then spent the money anyway');
assert(/cannot cover/.test(attempt.reason), 'and the refusal says it cannot cover THIS request, not that the budget is exhausted — different situations, different remedies');
assert(attempt.usage.spentUsd === 0.99 && attempt.usage.reservedUsd === 0, 'a refusal leaves the bucket untouched');
assert(attempt.remainingUsd === 0.01, 'and reports what is actually left');

// --- the ordinary path ---------------------------------------------------------------------------
const fresh = { date: DAY, spentUsd: 0, reservedUsd: 0 };
const held = budget.hold(fresh, 1.00, est, DAY);
assert(held.ok === true, 'a fresh key can afford a call');
assert(held.usage.reservedUsd === est, 'the estimate is HELD before the call runs');
assert(held.usage.spentUsd === 0, 'and nothing is charged yet — the call has not happened');

// A second concurrent call sees the hold. This is the property that makes the cap real under
// parallel requests, which is exactly how an agent-to-agent caller behaves.
const second = budget.hold(held.usage, 1.00, est, DAY);
assert(second.ok === true && second.usage.reservedUsd === budget.round4(est * 2), 'a second in-flight call stacks its own hold');
let inFlight = second.usage;
let stacked = 2;
while (stacked < 50) {
  const more = budget.hold(inFlight, 1.00, est, DAY);
  if (!more.ok) break;
  inFlight = more.usage; stacked++;
}
assert(stacked < 50, 'holds eventually exhaust the budget rather than stacking forever');
assert(inFlight.reservedUsd <= 1.00, `total holds never exceed the budget (got ${inFlight.reservedUsd})`);

// --- settling replaces the estimate with the truth ------------------------------------------------
const settled = budget.settle(held.usage, est, 0.0123, DAY);
assert(settled.reservedUsd === 0, 'the hold is released');
assert(settled.spentUsd === 0.0123, 'and the ACTUAL cost is charged, not the estimate — over-reserving must not become over-charging');

// A failed call costs nothing but must still release, or the budget is stranded until midnight.
const failed = budget.settle(held.usage, est, 0, DAY);
assert(failed.reservedUsd === 0 && failed.spentUsd === 0, 'a failed call releases its hold and charges nothing');
assert(budget.settle(held.usage, est, null, DAY).spentUsd === 0, 'a null cost is treated as zero rather than NaN');

// --- settle cannot MINT budget --------------------------------------------------------------------
// The crash-recovery case: a process restart between reserve and settle, or a double-settle, must
// not drive reservedUsd negative — negative holds would read as extra headroom.
const doubleSettled = budget.settle(budget.settle(held.usage, est, 0.01, DAY), est, 0.01, DAY);
assert(doubleSettled.reservedUsd === 0, 'a double-settle clamps at zero rather than going negative');
assert(budget.settle({ date: DAY, spentUsd: 0, reservedUsd: 0 }, 5.00, 0, DAY).reservedUsd === 0,
  'settling a hold this bucket never had cannot create negative reserved — that would be free budget');
assert(budget.settle(held.usage, est, -5, DAY).spentUsd === 0, 'a negative cost cannot refund money into the budget');

// --- boundaries ------------------------------------------------------------------------------------
assert(budget.hold({ date: DAY, spentUsd: 0.9, reservedUsd: 0 }, 1.00, 0.1, DAY).ok === true,
  'a request whose worst case lands EXACTLY on the budget is allowed — otherwise an exactly-sized budget is unusable');
assert(budget.hold({ date: DAY, spentUsd: 0.9, reservedUsd: 0 }, 1.00, 0.1001, DAY).ok === false,
  'a hair over is refused');
const exhausted = budget.hold({ date: DAY, spentUsd: 1.00, reservedUsd: 0 }, 1.00, 0.01, DAY);
assert(exhausted.ok === false && /exhausted/.test(exhausted.reason),
  'a fully spent key says EXHAUSTED — the message distinguishes "come back tomorrow" from "this one request is too big"');
assert(budget.hold({ date: DAY, spentUsd: 0, reservedUsd: 0 }, 0, 0.01, DAY).ok === false, 'a zero budget refuses everything');

// --- the daily bucket rolls over ------------------------------------------------------------------
const yesterday = { date: '2026-07-31', spentUsd: 1.00, reservedUsd: 0.5 };
const rolled = budget.currentUsage(yesterday, DAY);
assert(rolled.spentUsd === 0 && rolled.reservedUsd === 0 && rolled.date === DAY,
  "yesterday's spend AND its leaked holds are both cleared — this is what bounds a reservation leaked by a crash");
assert(budget.hold(yesterday, 1.00, 0.5, DAY).ok === true, 'so a new day starts spendable');
assert(budget.currentUsage(null, DAY).spentUsd === 0, 'a key that has never been used starts at zero rather than throwing');
assert(budget.currentUsage({ date: DAY }, DAY).reservedUsd === 0, 'a bucket predating reservedUsd reads as zero, not NaN — existing keys upgrade cleanly');

// --- remaining, for reporting ---------------------------------------------------------------------
assert(budget.remainingUsd({ date: DAY, spentUsd: 0.25, reservedUsd: 0.25 }, 1.00, DAY) === 0.5,
  'remaining counts holds as well as spend — a number that ignored in-flight calls would invite exactly the overshoot this module prevents');
assert(budget.remainingUsd({ date: DAY, spentUsd: 5, reservedUsd: 0 }, 1.00, DAY) === 0, 'and never goes negative');

// --- the route actually reserves before it spends --------------------------------------------------
// The module can be perfect while the route keeps its old check-then-charge. That gap IS the bug.
// serverSource() normalises CRLF, which MATTERS here: the two assertions below match a multi-line
// literal, and a branch checkout on Windows rewrites server.js with CRLF, breaking the match while
// the reservation logic is entirely untouched. It reads exactly like a code regression and is not one.
const src = serverSource();
const reserveAt = src.indexOf('a2aBudget.hold(');
const executeAt = src.indexOf('const result = await executeAgent(\n    skill.agent,');
const settleAt = src.indexOf('a2aBudget.settle(');
assert(reserveAt > 0 && executeAt > 0 && settleAt > 0, 'the route reserves, executes and settles');
assert(reserveAt < executeAt, 'the RESERVATION happens before the agent runs — the whole point');
assert(settleAt > executeAt, 'and settlement happens after');
assert(!/usage\.spentUsd >= \(req\.a2aKey\.dailyBudgetUsd/.test(src),
  'the old check-then-charge comparison is gone, not merely bypassed');
assert(/saveState\('a2a-keys', a2aKeys\);\s*\/\/ the hold must survive/.test(src),
  'the hold is PERSISTED before the call — an in-memory-only hold vanishes on the crash it exists to survive');

done();
