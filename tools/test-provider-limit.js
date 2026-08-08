// The provider's ceiling, and the two ways the cost dashboard was lying about it.
//
// On 2026-08-08 every Anthropic call failed with an account usage limit, and simultaneously:
//   /api/costs   reported monthly $18.49 against a $1000 budget
//   /api/health  reported hardBudgetTripped:false
// Every number was correct and the picture was false. Two separate defects:
//
//   1. AI OS tracks only ITS OWN spend against a budget a human typed in. The binding constraint was
//      set in the Anthropic console and nothing here could see it — so the platform believed it had
//      ~$981 of headroom while it had none.
//   2. `hardBudgetTripped` did not report TRIPPING. It was `settings.security.hard_budget === 'true'`
//      — whether the kill-switch is ENABLED. A box with it switched off reported `false`, which
//      reads as "spending is fine" and actually means "nothing is guarding spend at all". Reading it
//      the obvious way gives you the opposite of the truth.
const pl = require('../lib/provider-limit');
const { assert, done, serverSource } = require('./test-util');

const err = (message, status) => Object.assign(new Error(message), status === null ? {} : { status });
const REAL = 'You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.';

// --- detection: narrow, and on the real message ----------------------------------------------------
const d = pl.detect(err(REAL, 400));
assert(d.limited === true, 'the real Anthropic usage-limit message is detected');
assert(d.resetsAt === '2026-09-01T00:00:00.000Z', `and its reset instant is parsed (${d.resetsAt})`);
assert(pl.detect(err('Your credit balance is too low to access the API', 400)).limited === true,
  'an exhausted credit balance counts too — same operator situation, different wording');

// Everything else must NOT match. A false positive here mislabels a banner, which is recoverable —
// but only because nothing gates on it. Keep the matcher narrow anyway.
for (const [m, s] of [
  ['Overloaded', 529],
  ['Anthropic HTTP 500', 500],
  ['Invalid request: messages.0.content is required', 400],
  ['request exceeded the 300s client timeout (This operation was aborted)', null],
  ['authentication_error: invalid x-api-key', 401],
]) {
  assert(pl.detect(err(m, s)).limited === false, `NOT a provider limit: "${m.slice(0, 44)}" (status ${s})`);
}
// A 5xx is transient and belongs to lib/transient-errors.js. Checked by STATUS before any prose
// matching, so a provider that ever puts "usage limit" in a 503 body cannot be misfiled as an
// account cutoff and stop the dashboard reporting a real outage.
assert(pl.detect(err(REAL, 503)).limited === false,
  'even the exact limit message is ignored on a 5xx — status is checked first, because 5xx is transient');
assert(pl.detect(err(REAL, undefined)).limited === true,
  'but a limit error with no status attached is still detected — statusless does not mean 5xx');
assert(pl.detect(err('', 400)).limited === false && pl.detect({}).limited === false && pl.detect(null).limited === false,
  'an empty, malformed, or null error is not a provider limit');

// Every pattern must earn its place. A regex with a typo, or one made redundant by a later edit,
// would sit in the list looking like coverage while matching nothing — and because the fallback is
// "not a limit", it would fail silently in the direction of the original bug.
const SAMPLES = [
  REAL,
  'Your credit balance is too low to access the API',
  'You have exceeded your monthly usage limit for this workspace',
];
pl.LIMIT_PATTERNS.forEach((re, i) => {
  assert(SAMPLES.some((s) => re.test(s)), `LIMIT_PATTERNS[${i}] matches at least one real-world message — no dead pattern posing as coverage`);
});
assert(SAMPLES.every((s) => pl.detect(err(s, 400)).limited), 'and every sample message is detected by the set as a whole');

// A message with no parseable reset still counts — losing the date must not lose the outage.
const noDate = pl.detect(err('You have reached your specified API usage limits.', 400));
assert(noDate.limited === true && noDate.resetsAt === null, 'a limit with no stated reset is still a limit, with resetsAt null');

// --- the tracker: sticky enough to be useful, self-healing enough to be safe --------------------------
let clock = Date.parse('2026-08-08T03:00:00Z');
const tr = pl.createTracker({ now: () => clock });

assert(tr.get('anthropic') === null && tr.all().length === 0, 'a fresh tracker reports nothing limited');
assert(tr.note('anthropic', err('Overloaded', 529)).limited === false && tr.get('anthropic') === null,
  'a transient failure does NOT mark the provider as limited');

tr.note('anthropic', err(REAL, 400));
const first = tr.get('anthropic');
clock += 600000;
tr.note('anthropic', err(REAL, 400));
const second = tr.get('anthropic');
assert(second.since === first.since,
  '`since` stays at the FIRST refusal — overwriting it on every later 400 would make a 10-hour outage look like it just started');
assert(second.failures === 2, 'and repeated refusals are counted');
assert(second.resetsAt === '2026-09-01T00:00:00.000Z', 'the reset instant is retained');

// Per provider: the platform calls six, with independent billing. One being cut off says nothing
// about the others, and reporting otherwise would send someone debugging the wrong vendor.
tr.note('gemini', err(REAL, 400));
assert(tr.get('anthropic').failures === 2 && tr.get('gemini').failures === 1, 'providers are tracked independently');
assert(tr.all().length === 2, 'and all() lists each one');

// THE SELF-HEALING PROPERTY. This is what makes it safe for detection to rest on message text, and
// it is why nothing in the codebase gates a request on this state: if it blocked calls, no call
// could ever succeed to clear it and the platform would wedge itself until someone restarted.
assert(tr.clear('anthropic') === true, 'a successful call clears the limit');
assert(tr.get('anthropic') === null, 'and the provider is no longer reported as limited');
assert(tr.clear('anthropic') === false, 'clearing an already-clear provider reports that nothing changed (so recovery is logged once, not every call)');
assert(tr.get('gemini') !== null, 'clearing one provider does not clear another');

// A lapsed block must not keep being reported — that would be the same stale-but-confident claim
// this module exists to prevent, just pointing the other way.
clock = Date.parse('2026-09-01T00:00:01Z');
assert(tr.get('gemini') === null, 'once the stated reset time passes, the block is dropped on read');
assert(tr.all().length === 0, 'and all() is empty again');

// --- wiring: it is recorded, surfaced, and NEVER gates a call ------------------------------------------
const src = serverSource();

assert(/providerLimits\.note\('anthropic', e\)/.test(src), 'a failed Anthropic call is offered to the tracker');
assert(/if \(providerLimits\.clear\('anthropic'\)\) appendLog/.test(src),
  'a successful call clears it, and the recovery is logged exactly once');
assert(/providerLimits: providerLimits\.all\(\)/.test(src), 'the state is surfaced on the payloads');
assert((src.match(/providerLimits: providerLimits\.all\(\)/g) || []).length === 2,
  'on BOTH /api/health and /api/costs — the misleading numbers live on the cost payload, so surfacing it only on health would leave the lie in place');

// The load-bearing negative. If this ever fails, the self-healing property above is gone and a false
// positive becomes a platform-wide outage that cannot clear itself.
const agentFn = (src.match(/async function executeAgent[\s\S]*?\n  const systemPrompt =/) || [''])[0];
assert(agentFn.length > 0, 'executeAgent located');
assert(!/providerLimits/.test(agentFn),
  'executeAgent does NOT consult providerLimits — this is advisory. Gating on it would prevent the successful call that clears it, wedging the platform on a false positive');

// --- hardBudgetTripped now reports TRIPPING, not enablement ---------------------------------------------
assert(/hardBudgetTripped: trippedPeriod !== null/.test(src),
  'health reports hardBudgetTripped from the actual budget state');
assert(/hardBudgetEnabled: hardBudgetEnabled\(\)/.test(src),
  'and reports enablement SEPARATELY — the two were conflated, so "false" meant "unguarded" while reading as "fine"');
assert(/hardBudgetTrippedPeriod: trippedPeriod/.test(src), 'and names WHICH period tripped, so the number is actionable');
assert(!/hardBudgetTripped: \(settings\.security/.test(src), 'the old enablement-as-tripped expression is gone');

// One definition, two readers: the health snapshot and the enforcement path must not be able to
// disagree about whether the budget is tripped. They were separate copies of the same expression,
// which is how the health field drifted in the first place.
assert(/function hardBudgetTrippedPeriod\(\)/.test(src), 'hardBudgetTrippedPeriod is a single named predicate');
assert(/const overPeriod = hardBudgetTrippedPeriod\(\);/.test(src), 'and executeAgent enforces using that same predicate');
assert(!/const over = \['daily', 'weekly', 'monthly'\]\.find/.test(src), 'the duplicated inline copy in executeAgent is gone');
assert(/const trippedPeriod = hardBudgetTrippedPeriod\(\);/.test(src),
  'health computes it ONCE — it walks the whole cost ledger and /api/health is polled');

// --- the operator can actually see it -----------------------------------------------------------------
const ui = require('fs').readFileSync(require('path').join(__dirname, '..', 'dashboard', 'js', 'app.js'), 'utf8').replace(/\r\n?/g, '\n');
assert(/summary\.providerLimits \|\| \[\]/.test(ui), 'the dashboard reads providerLimits off the cost summary');
assert(/Provider access blocked/.test(ui), 'and renders a banner when a provider has cut us off');
assert(/NOT the binding constraint/.test(ui),
  'which says the spend figures are not the binding constraint — the whole failure was believing accurate numbers that did not matter');
assert(/no budget change here will lift it/.test(ui),
  'and that changing an AI OS budget will not lift it, since the limit lives with the provider');
assert(/limitBanner \+ periods\.map/.test(ui), 'the banner renders ABOVE the spend cards, not as a fourth card among them');

done();
