// Account deprovisioning: admin disable/enable/revoke-sessions, and bulk session revocation on
// offboarding — SOC 2 gap-list item 15 (CC6.2).
//
// The hole this closes was found while surveying, not in the gap list's wording: employee
// offboarding (DELETE /api/org/members/:email) removed the user record and left every session it
// had minted valid for up to 30 days. "Deleted" was not "gone".
//
// Shape is pinned here as text (repo convention); the behaviour is proven end to end on a
// throwaway-token instance in the commit that lands this (create → set password → disable → 401).
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

// revokeSessionsFor: iterates the RAW map and persists once.
const rev = between('function revokeSessionsFor(', '\n}\n');
assert(rev.length > 50, 'revokeSessionsFor located');
assert(/for \(const \[k, sess\] of _sessionMap\)/.test(rev), 'it walks the raw session map, not the wrapper');
assert(/_sessionMap\.delete\(k\)/.test(rev) && /if \(n\) _persistSessions\(\)/.test(rev), 'deletes matching sessions and persists once, only if something changed');
assert(/toLowerCase\(\)/.test(rev), 'email match is case-insensitive');

// isValidSession: a disabled account's session is dead even if revocation was missed.
const ivs = between('function isValidSession(token)', '\n}\n');
assert(/findUserByEmail\(session\.email\)/.test(ivs) && /owner\.disabled/.test(ivs), 'isValidSession consults the user record\'s disabled flag');
assert(ivs.indexOf('owner.disabled') > ivs.indexOf('expiresAt'), 'the disabled check sits after the expiry check');
assert(/owner && owner\.disabled\) \{\s*sessions\.delete\(token\);\s*return false;/.test(ivs), 'a disabled owner\'s session is deleted and the call returns false');

// Login: disabled is only revealed after the password verified.
const login = between("app.post('/api/auth/login'", "app.post('/api/auth/logout'");
const dis = login.indexOf('if (user.disabled)');
assert(dis !== -1, 'login checks user.disabled');
assert(dis > login.indexOf('bcrypt.compare(') && dis > login.indexOf("failed('bad-password')"), 'the disabled check comes AFTER the password check — no enumeration oracle');
assert(/status\(403\)\.json\(\{ error: 'Account disabled/.test(login), 'a disabled account with the right password gets 403 Account disabled');
assert(/Login refused: account disabled/.test(login), 'the refusal is logged');

// set-password: a setup link cannot resurrect a disabled account.
const setpw = between("app.post('/api/auth/set-password'", "app.get('/set-password'");
assert(/if \(user\.disabled\) return res\.status\(403\)/.test(setpw), 'set-password refuses a disabled account');
assert(setpw.indexOf('user.disabled') < setpw.indexOf('bcrypt.hash('), 'and refuses BEFORE hashing/storing a new password');

// Offboarding revokes sessions.
const off = between("app.delete('/api/org/members/:email'", '// --- Admin: account state');
assert(/revokeSessionsFor\(addr\)/.test(off), 'offboarding revokes the employee\'s sessions');
assert(off.indexOf('revokeSessionsFor(addr)') > off.indexOf('users.splice('), 'revocation happens after the record is removed (no window where a refreshed session could be re-minted)');
assert(/revokedSessions/.test(off) && /session\(s\) revoked/.test(off), 'the count is returned and logged');

// Admin routes.
const admin = between('// --- Admin: account state', '// --- Onboarding');
for (const r of ['/api/admin/users', '/api/admin/users/:email/disable', '/api/admin/users/:email/enable', '/api/admin/users/:email/revoke-sessions']) {
  assert(new RegExp(`app\\.(get|post)\\('${r.replace(/[/:]/g, (c) => '\\' + c)}', requireAdmin`).test(admin), `${r} exists and is requireAdmin`);
}
const summary = between('function adminUserSummary(u)', '\n}\n');
assert(!/passwordHash:|setupToken:/.test(summary) && /hasPassword: !!u\.passwordHash/.test(summary) && /pendingSetup: !!u\.setupToken/.test(summary), 'the listing exposes booleans, never the hash or the setup token');
assert(/you cannot change the state of your own account/.test(admin), 'an admin cannot disable/enable/revoke themselves');
assert(/cannot disable the last enabled admin/.test(admin), 'the last enabled admin cannot be disabled (lockout-of-everyone guard)');
const disable = between("app.post('/api/admin/users/:email/disable'", "app.post('/api/admin/users/:email/enable'");
assert(disable.indexOf('saveState(') < disable.indexOf('revokeSessionsFor('), 'disable persists the flag BEFORE revoking — a crash between the two leaves the account disabled, never the reverse');
assert(/disabledBy = req\.session\.email/.test(disable), 'who disabled it is recorded on the user');
assert(/Account disabled: \$\{user\.email\}/.test(disable), 'disable is written to the activity log');

done();
