// Per-account login lockout with progressive delay. SOC 2 gap-list item 10 (CC3.3, CC6.6, PI1.2).
//
// WHAT THE IP LIMITER ON /api/auth/login DOES NOT DO. `authLimiter` allows 20 failures per IP per
// 15 minutes. One attacker with a modest proxy pool gets unlimited guesses at ONE account, because
// nothing ever counted failures against the account. This does. It is keyed on the normalised email,
// not the IP, so rotating IPs does not reset it.
//
// POLICY (defaults; every number is a constructor option so a test can shrink them):
//   - 5 failures inside a 15-minute window lock the account for 15 minutes.
//   - Each further lock while the entry lives DOUBLES the duration (15m, 30m, 1h, ... capped at 24h),
//     so a persistent attacker is throttled harder over time while a user who fat-fingers once is
//     inconvenienced for a quarter hour.
//   - A successful login clears the entry entirely, escalation included.
//
// THE TRADE-OFF THIS BUYS INTO, stated so nobody rediscovers it as a bug: an attacker who knows a
// victim's email can lock the victim out for 15 minutes at a time by failing five logins. That is the
// standard account-lockout denial-of-service and the short base window is the mitigation. The
// alternative (no per-account counter) is worse: it makes every account brute-forceable.
//
// STATE IS IN MEMORY. A restart forgets every lock and every counter. Sessions are in memory too, so
// this matches the platform's existing posture rather than inventing a new store for it; the
// activity log is where the durable evidence lives (the login route writes there on every failure).
//
// BOUNDED. An attacker cannot grow the map without limit by failing logins against ten thousand
// made-up addresses: past `maxEntries`, UNLOCKED entries are evicted first, then the oldest. Only
// the second step can evict a live lock, so a flooder would need more than `maxEntries` accounts
// SIMULTANEOUSLY locked — 50k+ failures inside one window, from behind the per-IP limiter — and even
// then the target's counter merely restarts at zero. Documented rather than solved further: a
// persistent store is the real fix and belongs with the rest of gap-list item 12.

const DEFAULTS = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
  maxLockMs: 24 * 60 * 60 * 1000,
  maxEntries: 10000,
});

const keyOf = (email) => String(email || '').trim().toLowerCase();

/**
 * @param {object} [opts] any of DEFAULTS, plus `now` (a clock returning ms) for tests.
 */
function createLockout(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const map = new Map(); // key -> { failures, firstAt, lockedUntil, locks }

  const fresh = (t) => ({ failures: 0, firstAt: t, lockedUntil: 0, locks: 0 });

  /** Is this account currently locked? Call BEFORE verifying the password, so a locked account
   *  costs no bcrypt work and yields no information about whether the password was right. */
  function check(email) {
    const e = map.get(keyOf(email));
    const t = now();
    if (e && e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t };
    return { locked: false, retryAfterMs: 0 };
  }

  /** Count one failure. Returns the new state, including whether this failure tripped a lock. */
  function recordFailure(email) {
    const k = keyOf(email);
    const t = now();
    let e = map.get(k);
    // A failure outside the window, on an entry that is not locked, starts a new window but KEEPS
    // the escalation count: the doubling is the point, and a fresh window must not reset it.
    if (!e) e = fresh(t);
    else if (e.lockedUntil <= t && t - e.firstAt > cfg.windowMs) { e.failures = 0; e.firstAt = t; }
    e.failures += 1;
    let tripped = false;
    if (e.failures >= cfg.maxFailures) {
      e.locks += 1;
      const duration = Math.min(cfg.lockMs * 2 ** (e.locks - 1), cfg.maxLockMs);
      e.lockedUntil = t + duration;
      e.failures = 0;
      e.firstAt = t;
      tripped = true;
    }
    map.set(k, e);
    if (map.size > cfg.maxEntries) prune(t, k);
    return { locked: e.lockedUntil > t, tripped, retryAfterMs: Math.max(0, e.lockedUntil - t), failures: e.failures, locks: e.locks };
  }

  /** A correct password clears everything for the account, escalation included. */
  function recordSuccess(email) { map.delete(keyOf(email)); }

  // Evict UNLOCKED entries first (expired or merely counting), then oldest. A live lock is the most
  // valuable state in the map and goes last. The first draft evicted "expired, then oldest", and the
  // test flooded it with in-window junk that was neither — the victim's live lock went first.
  //
  // `keep` is the entry that was JUST written. Without it, once the map is full of live locks the
  // newest counter is the only unlocked entry and evicts itself on every failure — so a 6th account
  // could never be locked at all. Caught by the test that pins the documented eviction limit.
  function prune(t, keep) {
    for (const [k, e] of map) {
      if (map.size <= cfg.maxEntries) return;
      if (k !== keep && e.lockedUntil <= t) map.delete(k);
    }
    for (const k of map.keys()) { // oldest insertion first
      if (map.size <= cfg.maxEntries) return;
      if (k !== keep) map.delete(k);
    }
  }

  return { check, recordFailure, recordSuccess, size: () => map.size, config: Object.freeze({ ...cfg }) };
}

module.exports = { createLockout, LOCKOUT_DEFAULTS: DEFAULTS };
