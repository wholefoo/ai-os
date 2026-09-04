// Per-account login lockout (lib/security/login-lockout.js) and its wiring into /api/auth/login.
//
// SOC 2 gap-list items 4 and 10: failed logins were never logged, and the only brute-force control
// was a 20-per-IP limiter that an attacker with a proxy pool never meets. The module is tested with
// an injected clock so every window and every doubling is exercised exactly, not approximately; the
// route is checked as text (this repo's convention — no suite boots server.js) for ORDER, which is
// the part a code review would miss: the lock check must run before bcrypt, and both 401 branches
// must count.
const { assert, done, serverSource } = require('./test-util');
const { createLockout, LOCKOUT_DEFAULTS: DEFAULTS } = require('../lib/security/login-lockout');

// --- 1. the module, on a fake clock --------------------------------------------------------------
let t = 1_000_000;
const clock = () => t;
const MIN = 60 * 1000;
const L = createLockout({ now: clock, maxFailures: 3, windowMs: 10 * MIN, lockMs: 10 * MIN, maxLockMs: 40 * MIN, maxEntries: 5 });

assert(L.check('a@x.io').locked === false, 'unknown account: not locked');
assert(L.recordFailure('a@x.io').locked === false, 'failure 1 of 3: not locked');
assert(L.recordFailure('a@x.io').locked === false, 'failure 2 of 3: not locked');
const trip = L.recordFailure('a@x.io');
assert(trip.locked === true && trip.tripped === true && trip.retryAfterMs === 10 * MIN, `failure 3 trips a 10-minute lock (retryAfter ${trip.retryAfterMs})`);
assert(L.check('A@X.IO ').locked === true, 'the lock is keyed on the NORMALISED email — case and whitespace do not evade it');
assert(L.check('b@x.io').locked === false, 'another account is unaffected');

t += 9 * MIN;
assert(L.check('a@x.io').locked === true && L.check('a@x.io').retryAfterMs === MIN, 'still locked at minute 9, one minute remaining');
t += MIN;
assert(L.check('a@x.io').locked === false, 'at exactly lockedUntil the lock has expired (strict > comparison)');

// Escalation: the next lock doubles, the one after doubles again, then caps.
for (let i = 0; i < 3; i++) L.recordFailure('a@x.io');
assert(L.check('a@x.io').retryAfterMs === 20 * MIN, 'second lock is 20 minutes (doubled)');
t += 20 * MIN;
for (let i = 0; i < 3; i++) L.recordFailure('a@x.io');
assert(L.check('a@x.io').retryAfterMs === 40 * MIN, 'third lock is 40 minutes');
t += 40 * MIN;
for (let i = 0; i < 3; i++) L.recordFailure('a@x.io');
assert(L.check('a@x.io').retryAfterMs === 40 * MIN, 'fourth lock is CAPPED at maxLockMs, not 80');
t += 40 * MIN;

// The window: failures spread wider than windowMs do not accumulate...
L.recordFailure('a@x.io');
L.recordFailure('a@x.io');
t += 11 * MIN;
const late = L.recordFailure('a@x.io');
assert(late.locked === false && late.failures === 1, 'a failure after the window restarts the count at 1');
// ...but the escalation count survives the restart, so the NEXT lock is still the capped length.
L.recordFailure('a@x.io'); L.recordFailure('a@x.io');
assert(L.check('a@x.io').retryAfterMs === 40 * MIN, 'a new window keeps the escalation level — a repeat offender is not reset by waiting');

// Success clears everything, escalation included.
L.recordSuccess('a@x.io');
assert(L.check('a@x.io').locked === false, 'success clears the lock');
for (let i = 0; i < 3; i++) L.recordFailure('a@x.io');
assert(L.check('a@x.io').retryAfterMs === 10 * MIN, 'after a success the escalation is back to the base duration');
L.recordSuccess('a@x.io');

// Failures while ALREADY locked extend nothing and do not double-count into the next window.
for (let i = 0; i < 3; i++) L.recordFailure('c@x.io');
const during = L.check('c@x.io').retryAfterMs;
L.recordFailure('c@x.io');
assert(L.check('c@x.io').retryAfterMs === during, 'a failure during a lock does not extend it');
t += during;
assert(L.check('c@x.io').locked === false, 'and the lock still expires on schedule');
L.recordSuccess('c@x.io');

// Bounded: flooding with distinct addresses evicts expired entries first, and never exceeds maxEntries.
for (let i = 0; i < 3; i++) L.recordFailure('victim@x.io');   // a live lock
for (let i = 0; i < 20; i++) L.recordFailure(`junk${i}@x.io`);
assert(L.size() <= 5, `map is bounded at maxEntries (size ${L.size()})`);
assert(L.check('victim@x.io').locked === true, 'unlocked junk (even in-window) was evicted before the live lock');
// The stated limit, pinned so it is a known number and not a surprise: MORE than maxEntries live
// locks at once will push the oldest one out.
for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) L.recordFailure(`locked${i}@x.io`);
assert(L.check('victim@x.io').locked === false, 'a flood of more than maxEntries SIMULTANEOUS locks evicts the oldest live lock (documented limit)');
L.recordSuccess('victim@x.io');

assert(DEFAULTS.maxFailures === 5 && DEFAULTS.lockMs === 15 * MIN && DEFAULTS.maxLockMs === 24 * 60 * MIN, 'shipped defaults: 5 failures, 15-minute base lock, 24-hour cap');
assert(Object.isFrozen(L.config), 'config is frozen — a caller cannot loosen a running lockout');

// --- 2. the wiring in server.js, checked for ORDER -----------------------------------------------
const src = serverSource();
const route = src.slice(src.indexOf("app.post('/api/auth/login'"), src.indexOf("app.post('/api/auth/logout'"));
assert(route.length > 0, 'login route located');
const at = (needle) => route.indexOf(needle);
assert(at('loginLockout.check(') !== -1, 'the route consults the lockout');
assert(at('loginLockout.check(') < at('bcrypt.compare('), 'the lock check runs BEFORE bcrypt — a locked account costs no hashing and leaks nothing');
assert(at('loginLockout.check(') < at('findUserByEmail('), 'the lock check runs before the user lookup too');
assert(/status\(429\)/.test(route) && /Retry-After/.test(route), 'a locked account gets 429 with a Retry-After header');
// Both 401 branches route through one `failed(reason)` helper, which is where the counting and the
// logging live — so assert the helper has both, and that both branches call it.
const helper = route.slice(at('const failed = '), at('const user = findUserByEmail('));
assert(helper.includes('loginLockout.recordFailure(') && helper.includes("logActivity('auth', 'Login failed'"), 'the failed() helper both counts the failure and logs it (gap-list item 4)');
assert(/failed\('unknown-user'\)/.test(route) && /failed\('bad-password'\)/.test(route), 'BOTH 401 branches (unknown user, wrong password) call failed()');
assert(at("failed('unknown-user')") < at('bcrypt.compare(') && at("failed('bad-password')") > at('bcrypt.compare('), 'unknown-user is counted before bcrypt, bad-password after');
assert(at('loginLockout.recordSuccess(') > at('bcrypt.compare('), 'success is recorded only after the password verified');
assert(/logActivity\('auth', 'Account locked'/.test(route), 'a tripped lock is written to the activity log as its own event');
assert(!/error: 'Invalid credentials'[^}]*email/.test(route), 'the 401 body never echoes the email');
assert(/require\('\.\/lib\/security\/login-lockout'\)/.test(src), 'server.js constructs the lockout from the module');

done();
