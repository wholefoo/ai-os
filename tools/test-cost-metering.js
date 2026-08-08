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
assert((src.match(/toolInvocations, discardedAttempts/g) || []).length >= 2
  && /toolInvocations, discardedAttempts \};/.test(src),
  'and every exit from the tool loop returns it, including the budget-exhausted ones');

// --- the ledger rows ---------------------------------------------------------------------------------
assert(/\.\.\.\(result\.discardedAttempts \? \{ discardedAttempts: result\.discardedAttempts, costIsLowerBound: true \} : \{\}\)/.test(src),
  'a successful row records discardedAttempts and flags its cost as a LOWER BOUND');
assert(/\.\.\.\(failedAttempts \? \{ discardedAttempts: failedAttempts, costIsLowerBound: true \} : \{\}\)/.test(src),
  'and so does a failed row');

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
assert(/lower bounds when this is non-zero/.test(src),
  'and says plainly that the period costs are lower bounds — a number without that caveat reads as exact');

// --- and the operator sees it ------------------------------------------------------------------------------
const ui = readRepoFile('dashboard/js/app.js');
assert(/summary\.unmeasured/.test(ui), 'the dashboard reads the unmeasured block');
assert(/lower bound/.test(ui), 'and labels the spend figures as a lower bound');
assert(/limitBanner \+ unmeasuredHtml \+ periods\.map/.test(ui), 'rendering it above the spend cards');
assert(/un && un\.discardedAttempts \?/.test(ui),
  'and only when something was actually discarded — a permanent caveat would train everyone to ignore it');
assert(!/\$\{[^}]*discardedAttempts[^}]*\* /.test(ui), 'the UI does not invent a dollar figure for it either');

behaviour().then(done, (e) => { console.error('FAIL: behaviour suite threw:', e); process.exitCode = 1; done(); });
