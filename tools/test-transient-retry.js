// Transient-failure retry: classification, backoff bounds, and the wiring that makes it reachable.
//
// The defect: run-1786085226550 cost $1.06 and returned nothing. `dependencies` completed with 6716
// real chars; `architecture` then died at 255s with "This operation was aborted" — a client-side
// AbortError from our own 120s fetch timeout — and one stage failing marks the whole run `failed`.
// Separately, run-1785910447282 died in under 5s on an Anthropic 529 and a manual retry worked.
//
// Two things are pinned here, and the SECOND is the one that will actually rot:
//   1. the policy (what is retryable, how long we wait, when we stop)
//   2. that the policy is REACHED — a classifier nothing calls is a very well-tested no-op. Every
//      previous instance of this failure class in this repo was a declaration with no enforcement
//      behind it (`depends_on`, `required: true`, the handbooks' `tools:` line).
const { assert, done, serverSource } = require('./test-util');
const T = require('../lib/transient-errors');

const err = (props) => Object.assign(new Error(props.message || 'boom'), props);

// --- classification: STATUS, never prose ----------------------------------------------------------
for (const s of [429, 529, 503]) {
  const c = T.classifyError(err({ status: s }));
  assert(c.retryable && c.kind === 'overloaded', `HTTP ${s} classifies as retryable/overloaded`);
}
for (const s of [500, 502, 504, 508]) {
  const c = T.classifyError(err({ status: s }));
  assert(c.retryable && c.kind === 'server', `HTTP ${s} classifies as retryable/server`);
}
// 508 above is the load-bearing one: it is NOT a status this repo has ever seen. It passes only
// because the guard is a >=500 RANGE. An enumerated list of the four codes observed so far would
// have quietly stopped retrying the first time a gateway invented a new one.
for (const s of [400, 401, 403, 404, 413, 422]) {
  assert(T.classifyError(err({ status: s })).retryable === false, `HTTP ${s} is NOT retried — re-sending an identical bad request reproduces it`);
}

// Property check over the whole set rather than the six statuses spelled out above: adding a status
// to NEVER_RETRY while the classifier disagrees would be a silent contradiction between a list and
// the code that consumes it. Iterating the real export is what makes them impossible to drift apart.
assert(T.NEVER_RETRY.size > 0, 'NEVER_RETRY is non-empty — an empty set would make the loop below vacuous');
for (const s of T.NEVER_RETRY) {
  assert(T.classifyError(err({ status: s })).retryable === false, `NEVER_RETRY member ${s} is genuinely not retried`);
}

// THE anti-prose assertion. A 400 whose message happens to read "Overloaded" must stay non-retryable:
// if this ever flips, someone has started matching on message text and the policy will silently
// change the day Anthropic rewords an error string.
assert(T.classifyError(err({ status: 400, message: 'Overloaded' })).retryable === false,
  'a 400 whose MESSAGE says "Overloaded" is still not retryable — classification reads status, not prose');
assert(T.classifyError(err({ status: 529, message: 'some wording nobody predicted' })).retryable === true,
  'and a 529 is retryable regardless of how its message is worded');

// --- abort: ours vs the caller's ------------------------------------------------------------------
const ourTimeout = err({ name: 'AbortError', timedOut: true, message: 'request exceeded the 300s client timeout' });
assert(T.classifyError(ourTimeout).kind === 'timeout', 'our own fetch timeout classifies as retryable/timeout');
const callerAbort = err({ name: 'AbortError', message: 'This operation was aborted' });
assert(T.classifyError(callerAbort).retryable === false,
  'a caller-initiated AbortError is NOT retried — retrying a deliberate cancel defies the canceller');
// These two are the SAME name and nearly the same message. Only the `timedOut` flag separates them,
// which is exactly why fetchWithTimeout has to set it (asserted in the wiring section below).

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
  assert(T.classifyError(err({ code })).kind === 'network', `${code} classifies as retryable/network`);
}
assert(T.classifyError(err({ cause: { code: 'ECONNRESET' } })).kind === 'network',
  'a network code nested under .cause is found too — undici wraps socket errors that way');
assert(T.classifyError(new Error('who knows')).retryable === false, 'an unrecognised error is NOT retried by default');

// --- attempt budgets are per-kind, and a timeout gets the stingiest ---------------------------------
const opts = { elapsedMs: 0, maxTotalMs: Infinity, nextTimeoutMs: 0, rand: () => 0.5 };
assert(T.shouldRetry(err({ status: 529 }), 1, opts).retry === true, 'overloaded: attempt 1 retries');
assert(T.shouldRetry(err({ status: 529 }), 2, opts).retry === true, 'overloaded: attempt 2 retries');
assert(T.shouldRetry(err({ status: 529 }), 3, opts).retry === false, 'overloaded: attempt 3 is the last (3 total)');

assert(T.shouldRetry(ourTimeout, 1, opts).retry === true, 'timeout: attempt 1 retries once');
assert(T.shouldRetry(ourTimeout, 2, opts).retry === false,
  'timeout: attempt 2 does NOT retry — each try burns the whole timeout window, so the budget is 2 total');
assert(T.POLICY.timeout.attempts < T.POLICY.overloaded.attempts,
  'a timeout is allowed strictly fewer attempts than an overload — cost per attempt is minutes vs seconds');

// --- the wall-clock ceiling is real, not decorative -------------------------------------------------
const nearDeadline = T.shouldRetry(err({ status: 529 }), 1, {
  elapsedMs: 880000, maxTotalMs: 900000, nextTimeoutMs: 300000, rand: () => 0.5,
});
assert(nearDeadline.retry === false, 'a retry that provably cannot fit the total budget is refused up front');
assert(/exceed/.test(nearDeadline.reason), 'and it SAYS the budget is why, so the log distinguishes it from an exhausted attempt count');
// Without this check the ceiling would be theatre: we would start a 5-minute attempt with 20 seconds
// of budget left, fail anyway, and have spent the 20 seconds to learn nothing.

// --- backoff bounds, and jitter that actually varies -------------------------------------------------
for (const attempt of [1, 2, 3]) {
  const d = T.backoffDelayMs('overloaded', attempt, { rand: () => 1 });
  assert(d > 0 && d <= T.POLICY.overloaded.maxDelayMs, `overloaded backoff attempt ${attempt} = ${d}ms, within [1, maxDelay]`);
}
assert(T.backoffDelayMs('overloaded', 3, { rand: () => 1 }) > T.backoffDelayMs('overloaded', 1, { rand: () => 1 }),
  'backoff grows with attempt number');
assert(T.backoffDelayMs('overloaded', 5, { rand: () => 1 }) <= T.POLICY.overloaded.maxDelayMs,
  'and is clamped — exponential growth without a ceiling parks a stage indefinitely');
const lo = T.backoffDelayMs('overloaded', 2, { rand: () => 0 });
const hi = T.backoffDelayMs('overloaded', 2, { rand: () => 1 });
assert(lo < hi, 'jitter varies the delay — three stages that started in the same millisecond must not retry in lockstep');
// Not cosmetic: G1 parallelism is confirmed on the VPS (two stages began at 06:14:45.580 exactly).
// Synchronised retries after a shared capacity blip re-collide, which is how a retry deepens an outage.

// --- Retry-After is an instruction, but a clamped one -------------------------------------------------
assert(T.parseRetryAfter('7') === 7000, 'Retry-After delta-seconds parses to ms');
const future = new Date(Date.now() + 5000).toUTCString();
const fromDate = T.parseRetryAfter(future, Date.now());
assert(fromDate !== null && fromDate >= 3000 && fromDate <= 6000, `Retry-After HTTP-date parses to ~5000ms (got ${fromDate})`);
assert(T.parseRetryAfter('not-a-date') === null && T.parseRetryAfter(null) === null && T.parseRetryAfter('') === null,
  'a malformed or absent Retry-After yields null, falling back to our own curve');
assert(T.backoffDelayMs('overloaded', 1, { retryAfterMs: 3600000 }) <= T.POLICY.overloaded.maxDelayMs,
  'an absurd Retry-After is CLAMPED — a hostile or buggy header must not park a paid stage for an hour');
assert(T.backoffDelayMs('overloaded', 1, { retryAfterMs: 2000, rand: () => 1 }) === 2000,
  'a sane Retry-After is honoured exactly, overriding our curve');

// --- BEHAVIOUR: actually run the loop ---------------------------------------------------------------
// Everything above inspects a pure function; everything below runs the thing that will be in the
// request path. Both matter — but only this half would have caught a loop that classified perfectly
// and then rethrew anyway. Verification has to come from a different direction than production.
const noSleep = { sleep: async () => {}, rand: () => 0.5 };

async function behaviour() {
  // the 529 case from run-1785910447282, which a human retried by hand and it worked
  let calls = 0;
  const out = await T.withRetry(async () => {
    calls++;
    if (calls < 3) throw err({ status: 529, message: 'Overloaded' });
    return { ok: true, calls };
  }, noSleep);
  assert(out.ok === true && calls === 3, `a 529-529-200 sequence returns the 200 after ${calls} attempts`);

  // the run-1786085226550 case: our own timeout, retried exactly once
  let tCalls = 0;
  const tOut = await T.withRetry(async () => {
    tCalls++;
    if (tCalls < 2) throw err({ name: 'AbortError', timedOut: true, message: 'client timeout' });
    return 'recovered';
  }, noSleep);
  assert(tOut === 'recovered' && tCalls === 2, 'a single timeout is retried once and succeeds');

  // exhaustion rethrows the ORIGINAL error, unwrapped — callers parse these (the refusal check, the
  // budget branch), so a helpful wrapper would break every one of them.
  let eCalls = 0;
  let caught = null;
  try {
    await T.withRetry(async () => { eCalls++; throw err({ status: 529, message: 'Overloaded' }); }, noSleep);
  } catch (e) { caught = e; }
  assert(eCalls === T.POLICY.overloaded.attempts, `an unrecoverable overload stops after exactly ${T.POLICY.overloaded.attempts} attempts (made ${eCalls})`);
  assert(caught && caught.status === 529 && caught.message === 'Overloaded',
    'and rethrows the ORIGINAL error unwrapped — callers already parse these');

  // a 400 must cost exactly one attempt: retrying an identical bad body reproduces it
  let bCalls = 0;
  try { await T.withRetry(async () => { bCalls++; throw err({ status: 400, message: 'bad request' }); }, noSleep); } catch { /* expected */ }
  assert(bCalls === 1, 'a 400 is attempted exactly once — no latency spent reaching the same failure');

  // a first-try success must not sleep, retry, or otherwise touch the policy
  let sCalls = 0;
  const sOut = await T.withRetry(async () => { sCalls++; return 'fine'; }, noSleep);
  assert(sOut === 'fine' && sCalls === 1, 'the happy path makes exactly one call');

  // logging must never be able to break the request it is describing
  const noisy = await T.withRetry(async (n) => {
    if (n < 2) throw err({ status: 529 });
    return 'ok';
  }, { ...noSleep, onRetry: () => { throw new Error('logger exploded'); } });
  assert(noisy === 'ok', 'a throwing onRetry callback does NOT break the call — a log line must never be the thing that fails');

  // the deadline is enforced by the LOOP, not just computable by the classifier
  let dCalls = 0;
  const clock = (() => { let t = 0; return () => (t += 400000); })(); // each check advances 400s
  try {
    await T.withRetry(async () => { dCalls++; throw err({ status: 529 }); },
      { ...noSleep, now: clock, maxTotalMs: 500000, nextTimeoutMs: 300000 });
  } catch { /* expected */ }
  assert(dCalls === 1, `the wall-clock ceiling stops the loop even with attempts left (made ${dCalls})`);

  // THE SEAM: a real HTTP response, over a real socket, through real fetch/undici. Everything else
  // in this file uses hand-built error objects, which cannot catch the failure that actually
  // happened — a classifier that works perfectly on an error whose `status` was never attached.
  const http = require('http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/529') { res.writeHead(529, { 'retry-after': '3', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Overloaded' } })); }
    if (req.url === '/400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'bad body' } })); }
    res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gateway');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r529 = await fetch(`${base}/529`);
    const e529 = T.httpError(r529, await r529.json().catch(() => ({})), 'Anthropic');
    assert(e529.status === 529, 'a real 529 response yields an error carrying status 529');
    assert(e529.message === 'Overloaded', 'and the provider message');
    assert(e529.retryAfterMs === 3000, `and its Retry-After as ms (got ${e529.retryAfterMs})`);
    assert(T.classifyError(e529).kind === 'overloaded', 'and it classifies as retryable end-to-end');

    const r400 = await fetch(`${base}/400`);
    const e400 = T.httpError(r400, await r400.json().catch(() => ({})), 'Anthropic');
    assert(T.classifyError(e400).retryable === false, 'a real 400 response classifies as non-retryable end-to-end');
    assert(e400.retryAfterMs === undefined, 'and carries no retryAfterMs when the header is absent');

    // An unparseable body must still produce a usable, named error rather than "undefined".
    const r502 = await fetch(`${base}/502`);
    const e502 = T.httpError(r502, await r502.json().catch(() => ({})), 'Anthropic');
    assert(e502.message === 'Anthropic HTTP 502', `a non-JSON error body falls back to a named message (got "${e502.message}")`);
    assert(T.classifyError(e502).kind === 'server', 'and still classifies as retryable/server');
  } finally {
    await new Promise((r) => srv.close(r));
  }

  // delays are actually awaited, in the order the policy dictates
  const slept = [];
  let pCalls = 0;
  await T.withRetry(async () => { pCalls++; if (pCalls < 3) throw err({ status: 529 }); return 1; },
    { rand: () => 1, sleep: async (ms) => slept.push(ms) });
  assert(slept.length === 2 && slept[1] > slept[0],
    `the loop awaits a growing backoff between attempts (${slept.join('ms, ')}ms)`);
}

// --- WIRING: the policy is reachable from a real provider call ------------------------------------------
const src = serverSource();

assert(/timedOut = true; ctrl\.abort\(\)/.test(src),
  'fetchWithTimeout marks its OWN abort — the only thing separating our timeout from a caller cancel');
const timeoutBranch = (src.match(/if \(timedOut && e && e\.name === 'AbortError'\)[\s\S]{0,700}?\n    \}/) || [''])[0];
assert(/new Error\(/.test(timeoutBranch) && !/e\.message =/.test(timeoutBranch),
  'the timeout error is a NEW Error, not a mutated DOMException — DOMException.message is getter-only, so assigning to it is a silent no-op');
assert(/err\.timedOut = true/.test(timeoutBranch), 'and it carries timedOut so the classifier can see it');

assert(/throw transientErrors\.httpError\(res, await res\.json\(\)\.catch\(\(\) => \(\{\}\)\), 'Anthropic'\)/.test(src),
  'a non-OK response is turned into an error by transientErrors.httpError — which attaches the status the classifier decides on');
assert(/transientErrors\.withRetry\(/.test(src), 'server.js actually calls withRetry — the policy is reached, not merely defined');

// The retry must sit at the shared choke point, so a tool-loop TURN retries without discarding the
// turns already banked in `messages`. Retrying one layer up would re-pay for every tool call so far.
// The property is "the retry sits at the ONE call site both callers share", not "it sits in a
// function of a particular name". anthropicMessagesFetch later gained a thin wrapper for
// provider-limit bookkeeping and delegates to ...Inner; an assertion pinned to the outer function's
// body went red although nothing about the sharing had changed. Pin the property: both callers go
// through anthropicMessagesFetch, and the retry is in what it delegates to.
assert((src.match(/await anthropicMessagesFetch\(apiKey, body/g) || []).length === 3,
  'callAnthropic and both callAnthropicWithTools call sites go through anthropicMessagesFetch');
const retryFn = (src.match(/async function anthropicMessagesFetchInner[\s\S]*?\n\}/) || [''])[0];
assert(retryFn.length > 0 && /withRetry/.test(retryFn),
  'and the retry lives in the single function they all reach — so a retried tool-loop TURN keeps the turns already banked in `messages`');
assert(/maxTotalMs: AGENT_CALL_MAX_TOTAL_MS/.test(retryFn), 'and it passes the wall-clock ceiling');
assert(/nextTimeoutMs: timeoutMs/.test(retryFn),
  'and the per-attempt timeout, so the deadline check knows what the next attempt would cost');
// Matched on the CALL, not on its exact argument object — the wrapper later gained an
// `onAttemptFailed` hook for cost metering and an assertion pinned to the old two-key literal went
// red although the delegation was unchanged.
assert(/await anthropicMessagesFetchInner\(apiKey, body, \{[^}]*timeoutMs[^}]*\}\)/.test(src),
  'and the outer wrapper really delegates to it — a wrapper that swallowed the call would leave the retry unreachable');

// --- the longer ceiling is opt-in, exactly like maxToolIters ---------------------------------------------
assert(/const PIPELINE_STAGE_FETCH_TIMEOUT_MS = parseInt\(process\.env\.PIPELINE_STAGE_FETCH_TIMEOUT_MS, 10\) \|\| 300000;/.test(src),
  'PIPELINE_STAGE_FETCH_TIMEOUT_MS is 300000 and env-overridable');
assert(/const AGENT_FETCH_TIMEOUT_MS = parseInt\(process\.env\.AGENT_FETCH_TIMEOUT_MS, 10\) \|\| 120000;/.test(src),
  'the GLOBAL default is still 120s — the fix is a per-call option, not a raised ceiling for every caller on the box');

const stageDispatches = src.match(/executeAgent\([^)]*maxToolIters: PIPELINE_STAGE_TOOL_ITERS[^)]*\)/g) || [];
assert(stageDispatches.length === 2, `both pipeline stage dispatch sites found (${stageDispatches.length})`);
for (const d of stageDispatches) {
  assert(/timeoutMs: PIPELINE_STAGE_FETCH_TIMEOUT_MS/.test(d),
    'a stage dispatch passes the longer timeout alongside the larger tool budget');
}

// Blast radius, stated as a test rather than a hope: the scheduled agents must NOT pick up the
// five-minute ceiling. Same assertion shape that caught this for useRepoTools.
// The scheduled path's executeAgent call is in dispatchSkillRun, NOT in runScheduledAgent — which
// only picks a dispatcher and handles the result. Two drafts of this assertion were wrong before
// this one: the first matched `async function runScheduledAgent` (it is not async) and so tested an
// empty string; the second found the right function but demanded a call it does not contain. Both
// PASSED the timeoutMs check vacuously. Assert the extraction is non-empty AND contains the thing
// being constrained, or the guard is decoration.
for (const fn of ['dispatchSkillRun', 'dispatchIntelBriefRun']) {
  const body = (src.match(new RegExp(`\\nasync function ${fn}[\\s\\S]*?\\n\\}`)) || [''])[0];
  assert(body.length > 0 && /executeAgent\(/.test(body), `${fn} located and really contains an executeAgent dispatch`);
  assert(!/timeoutMs/.test(body),
    `${fn} does NOT pass timeoutMs — tech-radar / research-brief / intel-brief / uptime-check keep the 120s default`);
}

assert(/timeoutMs: options\.timeoutMs/.test(src), 'executeAgent threads its caller\'s timeoutMs through to the provider call');
// Matched as `timeoutMs` followed by a comma or the closing brace — i.e. NO `=` default. Deliberately
// not the whole destructuring literal: the assertion this replaced in test-repo-tools.js pinned the
// entire parameter list and went red purely because a neighbouring option was added. Pin the subject.
assert(/async function callAnthropicWithTools\([^)]*\{[^}]*\btimeoutMs\s*[,}]/.test(src),
  'callAnthropicWithTools takes timeoutMs with NO default — so an unset caller falls through to AGENT_FETCH_TIMEOUT_MS rather than silently inheriting a stage ceiling');
assert(/async function anthropicMessagesFetch\([^)]*timeoutMs = AGENT_FETCH_TIMEOUT_MS/.test(src),
  'and that fall-through is explicit: anthropicMessagesFetch defaults timeoutMs to the 120s global');

behaviour().then(done, (e) => { console.error('FAIL: behaviour suite threw:', e); process.exitCode = 1; done(); });
