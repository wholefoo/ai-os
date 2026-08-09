// Which provider failures are worth trying again, and how long to wait.
//
// WHY THIS EXISTS. run-1786085226550 cost $1.06 and returned nothing: the `dependencies` stage
// completed with 6716 real chars, then `architecture` died at 255s with "This operation was aborted"
// — a client-side AbortError from our own 120s fetch timeout, not an Anthropic error. One stage
// failing marks the whole run `failed`, so the completed work went with it. Separately, the very
// first production security-sweep (run-1785910447282) died in under 5s on an Anthropic 529
// `Overloaded` and an immediate manual retry succeeded. Both are transient; neither was retried.
//
// TWO PROPERTIES THIS MODULE EXISTS TO HOLD:
//
// 1. CLASSIFY ON STATUS, NEVER ON MESSAGE TEXT. "Overloaded" is a string Anthropic chose and can
//    reword; a `/overloaded/i` test would pass today and silently stop retrying the day it changes,
//    which presents as "retry doesn't work" long after anyone is looking. Status codes are a
//    contract. The ONE exception is the abort/network family, which has no status at all — those are
//    matched on `name`/`code`, which are Node's own stable identifiers, not prose.
//
// 2. A RETRY BUDGET IS A TIME BUDGET, NOT JUST A COUNT. A timeout retry costs the FULL timeout
//    again, so "3 attempts" at a 5-minute ceiling is a 15-minute stage. Attempts are therefore
//    per-kind (a timeout gets fewer than an overload, because each one is far more expensive), and
//    `shouldRetry` additionally refuses once the elapsed total would blow `maxTotalMs`. A retry
//    policy that can outlive the thing it is retrying for is not a fix.

// Attempts are TOTAL tries, not retries — `attempts: 3` means the original call plus 2 retries.
// Spelled that way because "maxRetries: 3" reads as 3 or 4 calls depending on who wrote the loop,
// and that ambiguity is how a 2x cost overrun ships.
const POLICY = {
  // 429 rate-limit / 529 overloaded / 503. Cheap to retry: these fail FAST (the sweep's 529 came
  // back in under 5s), so spending two more attempts costs seconds, not minutes.
  overloaded: { attempts: 3, baseDelayMs: 1000, maxDelayMs: 20000 },
  // 500/502/504 — a server-side blip. Same shape as overloaded but no Retry-After to honour.
  server: { attempts: 3, baseDelayMs: 1000, maxDelayMs: 20000 },
  // Connection reset / DNS / socket hangup before a response. Usually instant; retry fast.
  network: { attempts: 3, baseDelayMs: 500, maxDelayMs: 10000 },
  // OUR OWN fetch timeout. Deliberately the STINGIEST budget on the list: every attempt burns the
  // entire timeout window before failing, so this is the one kind where retrying can cost minutes
  // and produce nothing. One retry covers the genuine boundary case (a request that happened to
  // land just past the ceiling); a second would mostly buy a longer wait for the same answer.
  timeout: { attempts: 2, baseDelayMs: 1000, maxDelayMs: 5000 },
};

// Statuses that retrying CANNOT help, listed so the default is explicit rather than implied.
// 400 means the body is wrong and re-sending the identical body reproduces it exactly; 401/403 mean
// the key is wrong; 404 the route. Retrying any of these burns latency to reach the same failure.
const NEVER_RETRY = new Set([400, 401, 403, 404, 405, 413, 422]);

/**
 * Classify a thrown provider error.
 * @returns {{ retryable: boolean, kind: string|null, status: number|null, retryAfterMs: number|null }}
 */
function classifyError(err) {
  const status = typeof (err && err.status) === 'number' ? err.status : null;
  const retryAfterMs = typeof (err && err.retryAfterMs) === 'number' && err.retryAfterMs >= 0
    ? err.retryAfterMs
    : null;

  if (status !== null) {
    if (NEVER_RETRY.has(status)) return { retryable: false, kind: null, status, retryAfterMs: null };
    if (status === 429 || status === 529 || status === 503) {
      return { retryable: true, kind: 'overloaded', status, retryAfterMs };
    }
    // Any other 5xx. Written as a RANGE, not a list of the four codes seen so far: an enumerated
    // guard here would silently stop retrying the first time a gateway invents a 508.
    if (status >= 500 && status < 600) return { retryable: true, kind: 'server', status, retryAfterMs };
    return { retryable: false, kind: null, status, retryAfterMs: null };
  }

  // No status = the request never got a response. `timedOut` is set by our own fetch wrapper when
  // ITS timer fired — checked before the generic AbortError test so that a caller-initiated abort
  // (a future cancel button, a shutdown signal) is NOT mistaken for a timeout and retried against
  // the user's explicit wish to stop.
  if (err && err.timedOut === true) return { retryable: true, kind: 'timeout', status: null, retryAfterMs: null };
  if (err && err.name === 'AbortError') return { retryable: false, kind: null, status: null, retryAfterMs: null };

  const code = String((err && (err.code || (err.cause && err.cause.code))) || '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return { retryable: true, kind: 'network', status: null, retryAfterMs: null };
  }
  return { retryable: false, kind: null, status: null, retryAfterMs: null };
}

/**
 * How long to wait before the next attempt. Exponential with full jitter.
 *
 * Jitter is not decoration: the pipeline fires up to 3 stages in the same millisecond (G1 parallelism
 * is confirmed on the VPS — two stages started at 06:14:45.580 exactly). Without jitter, three stages
 * overloaded by the same capacity blip would retry in lockstep and re-collide, which is the classic
 * way a retry makes an outage worse. `rand` is injectable so tests can assert the bounds rather than
 * the draw.
 */
function backoffDelayMs(kind, attempt, { rand = Math.random, retryAfterMs = null } = {}) {
  const policy = POLICY[kind];
  if (!policy) return 0;
  // A server-sent Retry-After is an instruction, not a hint — honour it over our own curve, but still
  // clamp it so a malformed or hostile header cannot park a stage for an hour.
  if (retryAfterMs !== null && retryAfterMs >= 0) return Math.min(retryAfterMs, policy.maxDelayMs);
  const exp = Math.min(policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), policy.maxDelayMs);
  return Math.round(exp * (0.5 + rand() * 0.5)); // full-ish jitter: 50–100% of the curve
}

/**
 * The single decision point: given a failure, may we try again?
 *
 * @param err            the thrown error
 * @param attempt        which attempt just FAILED (1-based)
 * @param elapsedMs      total ms spent on this call so far, across all attempts
 * @param maxTotalMs     hard wall-clock ceiling for the whole call including retries
 * @param nextTimeoutMs  the per-attempt timeout the NEXT try would use, so the deadline check can
 *                       refuse a retry that provably cannot finish in the remaining time
 */
function shouldRetry(err, attempt, { elapsedMs = 0, maxTotalMs = Infinity, nextTimeoutMs = 0, rand = Math.random } = {}) {
  const c = classifyError(err);
  if (!c.retryable) return { retry: false, delayMs: 0, kind: c.kind, reason: c.status ? `status ${c.status} is not retryable` : 'not a transient failure' };

  const policy = POLICY[c.kind];
  if (attempt >= policy.attempts) {
    return { retry: false, delayMs: 0, kind: c.kind, reason: `${c.kind}: ${attempt}/${policy.attempts} attempts used` };
  }

  const delayMs = backoffDelayMs(c.kind, attempt, { rand, retryAfterMs: c.retryAfterMs });
  // Refuse a retry we can already prove will not fit. Without this the wall-clock ceiling is
  // decorative: we would start a 5-minute attempt with 20 seconds of budget left and fail anyway,
  // having spent the 20 seconds. Better to surface the original error now.
  if (elapsedMs + delayMs + nextTimeoutMs > maxTotalMs) {
    return { retry: false, delayMs: 0, kind: c.kind, reason: `${c.kind}: would exceed the ${maxTotalMs}ms total budget` };
  }
  return { retry: true, delayMs, kind: c.kind, reason: `${c.kind}: retrying attempt ${attempt + 1}/${policy.attempts} after ${delayMs}ms` };
}

// Statuses where the provider DECLINED TO SERVE the request rather than failing partway through it.
// Nothing was inferred, so nothing was billed: the cost of such an attempt is known, not unknown.
//
// 503 and 529 sit here despite being 5xx. Both mean "capacity, come back later" — the request was
// turned away at the gate, exactly like a 4xx. Grouping them by numeric range instead of meaning
// would misfile the single most common transient failure this platform sees.
const REFUSED_STATUSES = new Set([400, 401, 403, 404, 405, 408, 409, 413, 422, 429, 503, 529]);

/**
 * Could this failed attempt have cost money we cannot measure?
 *
 * WHY THIS EXISTS. `4801fb8` marked every discarded attempt as making its row's cost a lower bound.
 * The first real production sample — 46 rows from the account-usage-limit outage — was **100% false
 * positives**: a usage-limit 400 is refused at the gate, so those attempts cost exactly $0, and
 * flagging them as unmeasured buried the signal under noise. That is precisely the failure the
 * feature's own comment warned about ("a permanent caveat trains everyone to ignore it").
 *
 * The distinction is not 4xx-versus-5xx but REFUSED-versus-INTERRUPTED:
 *   - refused        → the provider never started work. Cost is known.
 *   - interrupted    → we sent a request the provider may well have processed, and never got the
 *                      answer. Cost is unknowable, and the row must say so.
 *
 * A client-side timeout is the clearest interrupted case: the request was accepted and in flight,
 * and our own `AbortController` gave up on it — the tokens may have been generated and billed with
 * nobody to receive them. That is the case `4801fb8` exists for, and it is now the case that
 * actually gets flagged.
 *
 * 500/502/504 are genuinely ambiguous — a gateway timeout in particular suggests upstream WAS
 * working. They are treated as interrupted **deliberately**: under-reporting spend is the defect
 * being fixed, so where the evidence is unclear the honest answer is "unknown", not "free".
 */
function isBillableUncertain(err) {
  if (!err) return false;
  // Our own timeout: the request was in flight when we abandoned it.
  if (err.timedOut === true) return true;
  const status = typeof err.status === 'number' ? err.status : null;
  if (status !== null) return !REFUSED_STATUSES.has(status);
  // No status = no response reached us. A caller-initiated abort is a deliberate cancel of work that
  // may already have been done, so it counts too; a pre-flight failure (DNS, refused connection)
  // never reached the provider and does not.
  const code = String((err.code || (err.cause && err.cause.code)) || '');
  if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return false;
  return true;
}

/** Parse a Retry-After header (RFC 7231: delta-seconds or an HTTP-date) into ms. */
function parseRetryAfter(headerValue, nowMs) {
  if (!headerValue) return null;
  const s = String(headerValue).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const when = Date.parse(s);
  if (!Number.isNaN(when)) return Math.max(0, when - (typeof nowMs === 'number' ? nowMs : Date.now()));
  return null;
}

/**
 * Build the Error for a non-OK provider response, carrying the metadata the classifier needs.
 *
 * This is the seam between our code and undici, and it is the ONE piece that a pure unit test of
 * `classifyError` cannot cover: the classifier can be perfect and still never fire if the status
 * never makes it onto the error. That is precisely what the old code did — it threw
 * `new Error(err.error?.message || ...)` and dropped `res.status` on the floor, which is why a 529
 * `Overloaded` was indistinguishable from a 400 by the time any caller saw it.
 *
 * Takes the Response (for status/headers) and the already-parsed body separately, because reading
 * the body is async and the caller has to do it anyway.
 *
 * @param res       the fetch Response
 * @param errBody   its parsed JSON body ({} if unparseable)
 * @param provider  label for the fallback message, e.g. 'Anthropic'
 */
function httpError(res, errBody, provider) {
  const err = new Error((errBody && errBody.error && errBody.error.message) || `${provider} HTTP ${res.status}`);
  err.status = res.status;
  const ra = parseRetryAfter(res.headers && res.headers.get ? res.headers.get('retry-after') : null);
  if (ra !== null) err.retryAfterMs = ra;
  // If a failed response happens to report usage, keep it — those tokens were generated and billed,
  // and dropping them is how spend goes unrecorded. Anthropic errors usually carry NO usage block,
  // so this recovers little in practice; it exists so that when a provider does report it we bank
  // real numbers instead of estimating. Nothing downstream may invent usage when this is absent.
  if (errBody && errBody.usage && typeof errBody.usage === 'object') err.usage = errBody.usage;
  return err;
}

/**
 * Run `attemptFn` and retry it while the policy says so.
 *
 * Lives HERE rather than inline in server.js so the retry can be executed by a test, not merely
 * inspected by one. The wiring assertions in tools/test-transient-retry.js can prove server.js calls
 * this; only running it proves a 529-then-200 sequence actually returns the 200. Every silent-omission
 * defect in this repo got through because something was verified by reading rather than by running.
 *
 * @param attemptFn  async () => result; must throw errors carrying `status` / `timedOut` / `code`
 * @param onRetry    optional (info) => void, for logging. Never throws into the loop.
 */
async function withRetry(attemptFn, {
  maxTotalMs = Infinity,
  nextTimeoutMs = 0,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  rand = Math.random,
  onRetry = null,
  onGiveUp = null,
  onAttemptFailed = null,
} = {}) {
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (e) {
      // Fires for EVERY failed attempt, retried or not — the callers that meter cost need the count
      // of attempts thrown away, and onRetry/onGiveUp between them are easy to get subtly wrong
      // (onRetry misses the last failure; onGiveUp misses every earlier one). One hook, one meaning.
      if (onAttemptFailed) { try { onAttemptFailed(e, attempt); } catch { /* metering must never break the call */ } }
      const decision = shouldRetry(e, attempt, { elapsedMs: now() - startedAt, maxTotalMs, nextTimeoutMs, rand });
      if (!decision.retry) {
        // The original error is rethrown UNWRAPPED. Callers already parse these (the refusal check,
        // the budget-exceeded branch), and wrapping would break every one of them for the sake of a
        // tidier message.
        if (onGiveUp) { try { onGiveUp({ ...decision, attempt, error: e }); } catch { /* logging must never break the call */ } }
        throw e;
      }
      if (onRetry) { try { onRetry({ ...decision, attempt, error: e }); } catch { /* ditto */ } }
      await sleep(decision.delayMs);
    }
  }
}

module.exports = { classifyError, shouldRetry, backoffDelayMs, parseRetryAfter, httpError, withRetry, isBillableUncertain, POLICY, NEVER_RETRY, REFUSED_STATUSES };
