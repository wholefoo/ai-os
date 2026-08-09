// Spend that happened but could not be measured must be VISIBLE, never invented.
//
// THE DEFECT. Token counts were accumulated only from a SUCCESSFUL response, so every attempt that
// timed out or was retried contributed zero to the ledger — while having been billed by the
// provider, because the request reached Anthropic and produced tokens. `5c6e051` added retry, which
// made discarded attempts more common rather than less, so /api/costs drifted further from real
// spend the more the reliability work paid off.
//
// The fix records what is TRUE (how many attempts were thrown away) and marks affected totals as
// lower bounds. It deliberately does NOT estimate: a failed response carries no usage block and a
// client-side timeout carries no response at all, so any dollar figure would be fabricated — and a
// fabricated number in a cost ledger is worse than a visible gap, because nothing distinguishes it
// from a measurement. Same principle as every announced-truncation guard in this repo.
const T = require('../lib/transient-errors');
const { assert, done, serverSource, readRepoFile } = require('./test-util');

const err = (props) => Object.assign(new Error(props.message || 'boom'), props);
const noSleep = { sleep: async () => {}, rand: () => 0.5 };

async function behaviour() {
  // --- onAttemptFailed fires for EVERY failed attempt ------------------------------------------------
  // Counting via onRetry alone misses the final failure; via onGiveUp alone misses every earlier one.
  // One hook with one meaning is what makes the count trustworthy.
  const seen = [];
  let calls = 0;
  await T.withRetry(async () => {
    calls++;
    if (calls < 3) throw err({ status: 529, message: 'Overloaded' });
    return 'ok';
  }, { ...noSleep, onAttemptFailed: (e, n) => seen.push(n) });
  assert(seen.length === 2 && seen[0] === 1 && seen[1] === 2,
    `a call that succeeded on attempt 3 reports exactly 2 discarded attempts (got ${JSON.stringify(seen)})`);

  // The give-up case: the LAST failure counts too. This is the row that used to read $0.0000 while
  // having made three billed requests.
  const seenFail = [];
  try {
    await T.withRetry(async () => { throw err({ status: 529 }); }, { ...noSleep, onAttemptFailed: (e, n) => seenFail.push(n) });
  } catch { /* expected */ }
  assert(seenFail.length === T.POLICY.overloaded.attempts,
    `an exhausted call reports every attempt as discarded (${seenFail.length} of ${T.POLICY.overloaded.attempts})`);

  // A non-retryable failure is still one discarded attempt — it was sent and billed.
  const seen400 = [];
  try {
    await T.withRetry(async () => { throw err({ status: 400, message: 'bad' }); }, { ...noSleep, onAttemptFailed: (e, n) => seen400.push(n) });
  } catch { /* expected */ }
  assert(seen400.length === 1, 'a single non-retryable failure still counts as one discarded attempt');

  // A first-try success must report nothing — otherwise every row would be marked a lower bound and
  // the signal would mean nothing.
  const clean = [];
  await T.withRetry(async () => 'fine', { ...noSleep, onAttemptFailed: (e, n) => clean.push(n) });
  assert(clean.length === 0, 'a clean call reports no discarded attempts — the marker must stay rare enough to mean something');

  // Metering must never break the request it is measuring.
  const survived = await T.withRetry(async (n) => { if (n < 2) throw err({ status: 529 }); return 'ok'; },
    { ...noSleep, onAttemptFailed: () => { throw new Error('meter exploded'); } });
  assert(survived === 'ok', 'a throwing onAttemptFailed does NOT break the call');
}

// --- REFUSED vs INTERRUPTED: only one of them means we lost money we cannot count ---------------------
// The first version of this feature flagged EVERY discarded attempt as making a row's cost a lower
// bound. Its first real production sample — 46 rows from the 2026-08-08 account-usage-limit outage —
// was 100% false positives: a usage-limit 400 is refused at the gate, so those attempts cost exactly
// $0. The flag meant to raise an alarm was firing constantly about nothing, which is the failure its
// own comment warned about. The distinction is not 4xx-vs-5xx; it is refused-vs-interrupted.
const REFUSED = [
  ['usage limit (the real one, 46 rows of it)', err({ status: 400, message: 'You have reached your specified API usage limits.' })],
  ['bad request', err({ status: 400, message: 'messages.0.content is required' })],
  ['auth', err({ status: 401 })],
  ['rate limit', err({ status: 429 })],
  ['overloaded (5xx by number, refusal by meaning)', err({ status: 529 })],
  ['service unavailable', err({ status: 503 })],
];
for (const [label, e] of REFUSED) {
  assert(T.isBillableUncertain(e) === false, `REFUSED, so its cost IS known: ${label}`);
}
// 529 and 503 are the load-bearing ones: grouping by numeric range would file the single most common
// transient failure this platform sees as unmeasured spend.
assert(T.REFUSED_STATUSES.has(529) && T.REFUSED_STATUSES.has(503),
  '529/503 are classified by MEANING (turned away at the gate), not by being 5xx');

const INTERRUPTED = [
  ['our own client timeout — the request was in flight when we abandoned it', err({ timedOut: true, name: 'AbortError' })],
  ['gateway timeout — upstream was almost certainly working', err({ status: 504 })],
  ['internal server error', err({ status: 500 })],
  ['bad gateway', err({ status: 502 })],
  ['connection reset mid-flight', err({ code: 'ECONNRESET' })],
];
for (const [label, e] of INTERRUPTED) {
  assert(T.isBillableUncertain(e) === true, `INTERRUPTED, so its cost is UNKNOWN: ${label}`);
}
// A request that never reached the provider cannot have been billed.
for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
  assert(T.isBillableUncertain(err({ code })) === false, `${code} never reached the provider, so nothing was billed`);
}
assert(T.isBillableUncertain(null) === false, 'a missing error is not evidence of unmeasured spend');
// The timeout is the case the whole feature exists for — assert it directly, not just as part of a list.
assert(T.isBillableUncertain(err({ timedOut: true, status: 400 })) === true,
  'a client timeout counts even if a stale status is attached — timedOut is checked FIRST');

// --- usage recovered from a failed response is REAL, and absence is not zero -------------------------
const res = (status, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] || null } });
const withUsage = T.httpError(res(429), { error: { message: 'slow down' }, usage: { input_tokens: 7, output_tokens: 3 } }, 'Anthropic');
assert(withUsage.usage && withUsage.usage.input_tokens === 7,
  'usage reported on a FAILED response is captured — those tokens were generated and billed');
const noUsage = T.httpError(res(400), { error: { message: 'bad request' } }, 'Anthropic');
assert(noUsage.usage === undefined,
  'and when the response reports none, none is attached — the absence must stay absent, not become a zero that looks measured');

// --- wiring: threaded from the fetch layer to the ledger ------------------------------------------------
const src = serverSource();

assert(/onAttemptFailed: bank/.test(src), 'anthropicMessagesFetch banks every failed attempt');
assert(/e\.aiosDiscarded = discarded;/.test(src),
  'and carries the count on the thrown error — the FAILED row is the one that under-reported worst');
assert(/data\.aiosDiscarded = discarded;/.test(src), 'and on the successful response for a call that retried');
assert(/if \(discarded\) \{/.test(src),
  'the fields are attached ONLY when something was discarded, so a clean response is unchanged');

assert(/discardedAttempts: data\.aiosDiscarded \|\| 0,/.test(src), 'callAnthropic returns the count');
assert(/discardedAttempts \+= data\.aiosDiscarded \|\| 0;/.test(src), 'and the tool loop accumulates it across turns');
assert((src.match(/discardedAttempts \+= data\.aiosDiscarded \|\| 0;/g) || []).length === 2,
  'at BOTH turn sites — the loop turns and the budget-exhaustion recovery call');
// Every exit from callAnthropicWithTools must carry BOTH counts. Matched by counting the exits
// rather than by their exact trailing text — a previous version pinned `discardedAttempts };` and
// broke the moment a second field was added after it, which is a change to its neighbour, not to
// the property. There are three exits: the normal answer, the budget-exhausted recovery, and the
// placeholder when even that produces nothing.
const toolLoop = (src.match(/async function callAnthropicWithTools[\s\S]*?\n\}/) || [''])[0];
assert(toolLoop.length > 0, 'callAnthropicWithTools located');
// `[^}]*` cannot be used here: the budget-exhausted exit interpolates `${text}` and `${maxIters}`
// into its content string, so a brace-excluding match stops inside the template literal and misses
// that exit entirely — silently reporting 2 of 3 and passing the per-exit checks on the two it saw.
const exits = (toolLoop.match(/return \{[\s\S]{0,500}?\};/g) || []).filter((r) => /toolInvocations/.test(r));
assert(exits.length === 3, `all three exits from the tool loop found (${exits.length})`);
for (const e of exits) {
  assert(/discardedAttempts/.test(e) && /unmeasuredAttempts/.test(e),
    `an exit returns both counts: ${e.slice(0, 58)}…`);
}

// --- the ledger rows ---------------------------------------------------------------------------------
assert(/\.\.\.\(result\.discardedAttempts \? \{ discardedAttempts: result\.discardedAttempts \} : \{\}\)/.test(src),
  'a successful row records discardedAttempts');
assert(/\.\.\.\(result\.unmeasuredAttempts \? \{ unmeasuredAttempts: result\.unmeasuredAttempts, costIsLowerBound: true \} : \{\}\)/.test(src),
  'and flags costIsLowerBound ONLY from the unmeasured subset');
assert(/\.\.\.\(failedAttempts \? \{ discardedAttempts: failedAttempts \} : \{\}\)/.test(src), 'and so does a failed row');
assert(/\.\.\.\(failedUnmeasured \? \{ unmeasuredAttempts: failedUnmeasured, costIsLowerBound: true \} : \{\}\)/.test(src),
  'with the same split');
// THE REGRESSION GUARD. If costIsLowerBound is ever set from the discard count again, the 46-false-
// positive outage repeats and the flag stops meaning anything.
assert(!/discardedAttempts: (result\.discardedAttempts|failedAttempts), costIsLowerBound: true/.test(src),
  'costIsLowerBound is NEVER set from the raw discard count — a refused attempt cost nothing and must not flag the row');
assert(/transientErrors\.isBillableUncertain\(err\)/.test(src),
  'and the split is decided by isBillableUncertain, not re-derived inline');

// THE ANTI-FABRICATION ASSERTION. A failed row's cost may come only from usage the provider actually
// reported. If this ever fails, someone has started estimating, and the ledger stops being evidence.
const failBlock = (src.match(/const failedAttempts = \(e && e\.aiosDiscarded\)[\s\S]*?timestamp: new Date\(\)\.toISOString\(\),\n    \}\);/) || [''])[0];
assert(failBlock.length > 0, 'the failed-row block was located');
assert(/recovered \? recovered\.input_tokens : 0/.test(failBlock),
  'a failed row reports ONLY tokens the provider actually reported, and 0 otherwise');

// Pin the COST EXPRESSION ITSELF, not the absence of suspicious words. A first version of this
// assertion banned `discardedAttempts *` — but the variable in this block is `failedAttempts`, so a
// mutant that priced the row at `failedAttempts * 0.05` passed every check here. The test was
// guarding a name rather than the value, which is the same mistake as asserting on counts instead of
// values. State what the cost must BE.
assert(/cost: Math\.round\(recoveredCost \* 10000\) \/ 10000,/.test(failBlock),
  'a failed row\'s cost comes from recoveredCost and nothing else');
const recoveredCostDef = (src.match(/const recoveredCost = recovered[\s\S]*?: 0;/) || [''])[0];
assert(recoveredCostDef.length > 0, 'recoveredCost is defined');
assert(/recovered\.input_tokens \/ 1e6/.test(recoveredCostDef) && /recovered\.output_tokens \/ 1e6/.test(recoveredCostDef),
  'and is computed ONLY from tokens the provider reported — priced at the real rate, not guessed');
assert(!/failedAttempts/.test(recoveredCostDef) && !/discardedAttempts/.test(recoveredCostDef),
  'the attempt COUNT never enters the cost calculation — counting discarded attempts is evidence, pricing them is fabrication');

// --- the summary declares the gap ------------------------------------------------------------------------
assert(/unmeasured: \{/.test(src), 'getCostSummary reports an `unmeasured` block');
assert(/discardedAttempts: monthly\.reduce\(\(s, e\) => s \+ num\(e\.discardedAttempts\), 0\)/.test(src),
  'summing real recorded events');
assert(/unmeasuredAttempts: monthly\.reduce\(\(s, e\) => s \+ num\(e\.unmeasuredAttempts\), 0\)/.test(src),
  'and reporting the unmeasured subset SEPARATELY from the total discarded');
assert(/calls: monthly\.filter\(\(e\) => e\.unmeasuredAttempts\)\.length/.test(src),
  'the affected-call count is driven by the unmeasured subset too — during the outage 55 calls were discarded and 0 were unmeasured');
assert(/those never reached inference and cost nothing/.test(src),
  'and the note explains that refused attempts are free, so the two numbers are not interchangeable');

// --- and the operator sees it ------------------------------------------------------------------------------
const ui = readRepoFile('dashboard/js/app.js');
assert(/summary\.unmeasured/.test(ui), 'the dashboard reads the unmeasured block');
assert(/lower bound/.test(ui), 'and labels the spend figures as a lower bound');
assert(/limitBanner \+ unmeasuredHtml \+ periods\.map/.test(ui), 'rendering it above the spend cards');
assert(/un && un\.unmeasuredAttempts \?/.test(ui),
  'and only when spend was actually UNMEASURED — gating on discards showed a permanent warning about $0 during the outage, which is how a caveat becomes wallpaper');
assert(!/un\.discardedAttempts \?/.test(ui), 'the banner is not gated on the raw discard count');
assert(!/\$\{[^}]*discardedAttempts[^}]*\* /.test(ui), 'the UI does not invent a dollar figure for it either');

behaviour().then(done, (e) => { console.error('FAIL: behaviour suite threw:', e); process.exitCode = 1; done(); });
