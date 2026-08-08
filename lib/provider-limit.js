// Remember when the PROVIDER has cut us off, so our own dashboards stop reading healthy.
//
// WHY THIS EXISTS. On 2026-08-08 every Anthropic call was failing with
//
//   HTTP 400 invalid_request_error
//   "You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC."
//
// while `/api/costs` reported monthly spend of $18.49 against a $1000 budget and `/api/health` said
// `hardBudgetTripped:false`. The platform believed it had ~$981 of headroom; it had none. Every
// number on the cost dashboard was accurate and the picture they added up to was false, because AI
// OS tracks only ITS OWN spend against a budget a human typed in, and the binding constraint was a
// limit set in the Anthropic console that nothing here could see. Anyone debugging from those
// numbers goes looking for a code fault that does not exist.
//
// The fix is not to guess the provider's ceiling — we cannot read it — but to record the moment the
// provider tells us we have hit it, and to surface that everywhere the budget is shown.
//
// DELIBERATELY ADVISORY: this never blocks a call. Two reasons, and the first is decisive:
//   1. The state clears when a call SUCCEEDS, which is the only trustworthy evidence access is back.
//      If it also blocked calls, nothing could ever produce that evidence and the platform would
//      wedge itself until someone restarted it. Self-healing beats self-locking.
//   2. Detection here matches on message text, which is exactly the fragility lib/transient-errors.js
//      refuses for retry decisions. It is unavoidable — a usage-limit refusal and a malformed-request
//      refusal are both HTTP 400, so status cannot separate them — but it means a false positive is
//      possible, and a false positive that only mislabels a banner is recoverable while one that
//      halts all work is not. Match narrowly, fail open.

// Both parts must match. `usage limit` alone appears in rate-limit prose too; requiring the
// "reached"/"exceeded" verb alongside keeps this to the account-ceiling case that motivated it.
const LIMIT_PATTERNS = [
  /you have reached your specified api usage limits?/i,
  /(?:reached|exceeded).{0,40}(?:usage limit|spend limit|credit balance)/i,
  /credit balance is too low/i,
];

// "You will regain access on 2026-09-01 at 00:00 UTC."
const RESET_RE = /regain access on (\d{4})-(\d{2})-(\d{2})(?:\s+at\s+(\d{2}):(\d{2}))?\s*(UTC)?/i;

/**
 * Is this error the provider saying "you are out of budget", as opposed to any other refusal?
 * @returns {{limited: boolean, resetsAt: string|null, message: string|null}}
 */
function detect(err) {
  const message = String((err && err.message) || '');
  if (!message) return { limited: false, resetsAt: null, message: null };

  // A 5xx or a timeout is never this — those are transient and belong to lib/transient-errors.js.
  // Checking the status first keeps the prose matching to the narrow window where it is the only
  // signal available (4xx refusals).
  const status = err && typeof err.status === 'number' ? err.status : null;
  if (status !== null && (status >= 500 || status < 400)) return { limited: false, resetsAt: null, message: null };

  if (!LIMIT_PATTERNS.some((re) => re.test(message))) return { limited: false, resetsAt: null, message: null };

  let resetsAt = null;
  const m = message.match(RESET_RE);
  if (m) {
    const [, y, mo, d, hh = '00', mm = '00'] = m;
    const t = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:00Z`);
    if (!Number.isNaN(t)) resetsAt = new Date(t).toISOString();
  }
  return { limited: true, resetsAt, message: message.slice(0, 300) };
}

/**
 * One provider's remembered state. Kept per provider name so a Gemini outage cannot be reported as
 * an Anthropic one — the platform calls six providers and they have independent billing.
 */
function createTracker({ now = Date.now } = {}) {
  const state = new Map();

  /** Record a failure. Returns the detection so a caller can log it without re-running the match. */
  function note(provider, err) {
    const d = detect(err);
    if (!d.limited) return d;
    const prev = state.get(provider);
    state.set(provider, {
      provider,
      // `since` survives repeated failures: the first refusal is when access actually stopped, and
      // overwriting it on every subsequent 400 would make an outage look like it just began.
      since: (prev && prev.since) || new Date(now()).toISOString(),
      resetsAt: d.resetsAt || (prev && prev.resetsAt) || null,
      message: d.message,
      failures: ((prev && prev.failures) || 0) + 1,
    });
    return d;
  }

  /**
   * A successful call is proof access is back — clear it. This is what makes a false positive
   * self-correcting rather than sticky, and it is why nothing here gates a request.
   * @returns {boolean} whether anything was actually cleared (so the caller can log the recovery)
   */
  function clear(provider) {
    return state.delete(provider);
  }

  /**
   * Current state for one provider, or null. An entry whose reset time has passed is dropped on
   * read: continuing to report a lapsed block would be the same class of stale-but-confident claim
   * this module exists to prevent.
   */
  function get(provider) {
    const e = state.get(provider);
    if (!e) return null;
    if (e.resetsAt && Date.parse(e.resetsAt) <= now()) { state.delete(provider); return null; }
    return { ...e };
  }

  /** Every provider currently believed to be limited, for the health/cost payloads. */
  function all() {
    return [...state.keys()].map(get).filter(Boolean);
  }

  return { note, clear, get, all };
}

module.exports = { detect, createTracker, LIMIT_PATTERNS };
