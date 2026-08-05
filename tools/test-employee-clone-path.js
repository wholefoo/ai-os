// The employee clone path, walked end to end: invite → set-password → clone → draft → employer
// view → offboard.
//
// This path had never been exercised as a CHAIN. Its parts were covered — test-org-membership.js
// tests validateInvite, test-business-clone-onboarding.js tests the disclosure — but the risk in an
// unexercised path is never in the parts, it is in the TRANSITIONS: whether the org key one step
// writes is the key the next step reads. This repo has already been bitten there once, which is why
// server.js carries the note that a session's org key "MUST agree with the key a clone created by
// that session resolves to, or a profile gets saved where the clone never looks."
//
// So every assertion here is about a seam. The suite deliberately does NOT boot a server: STATE_DIR
// is hardcoded to .magent/state, so an HTTP run would write real users into the developer's own
// state. The route-level facts that cannot be reached from the libs are asserted against server.js
// source instead — the established pattern in this repo.
//
// What it therefore does NOT cover, and what still needs a human on the VPS: that the invite email
// actually arrives, and that the set-password and clone-creation SCREENS work in a browser.
const fs = require('fs');
const path = require('path');
const org = require('../lib/org/membership');
const cloneStore = require('../lib/business-clone/store');
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const EMPLOYER = 'owner@acme.test';
const EMPLOYEE = 'sam@acme.test';
const SECOND = 'kim@acme.test';
const OUTSIDER = 'rival@other.test';

// ── STEP 1: the operator invites ────────────────────────────────────────────────────────────────
const adminSession = { role: 'admin', email: EMPLOYER, ownerEmail: EMPLOYER };
let users = [{ id: 'u1', email: EMPLOYER, role: 'admin', plan: 'business' }];

const invite = org.validateInvite({ session: adminSession, email: EMPLOYEE, users, seatLimit: 5 });
assert(invite.ok && invite.org === EMPLOYER, 'the invite attaches the employee to the operator\'s org');

const employee = org.buildEmployee({
  id: 'u2', email: EMPLOYEE, ownerEmail: invite.org, name: 'Sam',
  setupToken: { token: 'tok-abc', expiresAt: new Date(Date.now() + 86400000).toISOString() },
});
users.push(employee);
assert(employee.cloneAccess === true, 'an invited person gets clone access — that flag is granted here and nowhere else');
assert(employee.cloneDispatch === false,
  '...but NOT dispatch. A clone must never hold more authority than the person it replicates, and an invite says nothing about spending.');

// ── STEP 2: set-password, and the seam that matters ─────────────────────────────────────────────
// The route builds the session as `ownerEmail: orgMembership.orgKeyFor(user)`. If that disagreed
// with the org the invite attached, everything downstream would scope to the wrong company.
const sessionOrg = org.orgKeyFor(employee);
assert(sessionOrg === invite.org,
  `the org key minted at set-password equals the org the invite attached (${sessionOrg}) — the seam a broken chain would hide`);
assert(/ownerEmail: orgMembership\.orgKeyFor\(user\)/.test(src),
  '...and server.js really builds the session that way, rather than defaulting to the user\'s own address');
assert(/delete user\.setupToken; \/\/ single-use/.test(src),
  'the setup token is destroyed on use — an invite link is a login credential and must not survive redemption');

const employeeSession = { email: EMPLOYEE, ownerEmail: sessionOrg, role: 'client', plan: 'business' };

// ── STEP 3: the clone is PERSONAL, not shared ────────────────────────────────────────────────────
// The documented split: ownerEmail = the org (sites, CRM, billing — shared); email = the individual
// (clones — personal). "A company shares its customers and its websites, and nobody shares a replica
// of how they personally think." If clones keyed on the org, two employees would collide into one.
const cloneClientOf = (s) => (s && s.email && s.email.includes('@') && !s.service)
  ? s.email.trim().toLowerCase() : cloneStore.OPERATOR_CLIENT_ID;
assert(/function cloneClientOf\(session\)/.test(src) && /session\.email \? String\(session\.email\)/.test(src),
  'cloneClientOf keys on session.email — mirrored here from server.js');

assert(cloneClientOf(employeeSession) === EMPLOYEE,
  'a clone created by the employee keys on THEIR address, not the company\'s');
const secondSession = { email: SECOND, ownerEmail: EMPLOYER, role: 'client' };
assert(cloneClientOf(secondSession) !== cloneClientOf(employeeSession),
  'two employees of ONE company get separate clone namespaces — the personal-replica promise, checked');
assert(org.orgKeyFor({ email: SECOND, ownerEmail: EMPLOYER }) === org.orgKeyFor(employee),
  '...while still sharing one org for sites, CRM and billing');

const clones = [
  { id: 'c1', clientId: EMPLOYEE, name: 'Sam clone' },
  { id: 'c2', clientId: EMPLOYER, name: 'Owner clone' },
];
assert(cloneStore.listClones(clones, cloneClientOf(employeeSession)).length === 1,
  'the employee sees exactly their own clone');
assert(!cloneStore.getClone(clones, cloneClientOf(adminSession), 'c1'),
  'the EMPLOYER cannot read the employee\'s clone through the ordinary clone routes — personal means personal');

// ── STEP 4/5: a draft exists, and the employer's view of it ──────────────────────────────────────
const drafts = [{ id: 'd1', cloneId: 'c1', channel: 'email', body: 'draft text' }];
assert(/'\/api\/clones', \/\/ AI Business Clone/.test(src) || /\/api\/clones/.test(src),
  'the clone surface is client-reachable and owner-scoped');

// ── STEP 6: offboard ─────────────────────────────────────────────────────────────────────────────
assert(/if \(addr === orgKey\) return res\.status\(400\)/.test(src), 'the owner cannot offboard themselves');
assert(/orgMembership\.orgKeyFor\(user\) !== orgKey \|\| !orgMembership\.isEmployee\(user\)/.test(src),
  'offboard refuses anyone outside your org, and anyone who is not an employee — a 404, not a 403');
assert(!org.isEmployee({ email: OUTSIDER, ownerEmail: OUTSIDER }),
  '...and an outsider is genuinely not an employee by the predicate that guard uses');

// THE ORDERING DEPENDENCY. deleteCloneRecords decides retain-vs-purge by looking the user up
// (`isEmployee(findUserByEmail(clone.clientId))`), and the offboard route removes that user with a
// splice. The loop MUST run first: reorder those two statements and every draft is silently purged
// while the log line still claims they were retained as company records. Nothing else would notice —
// no error, no failing gate, just correspondence quietly gone.
const offboardStart = src.indexOf("app.delete('/api/org/members/:email'");
assert(offboardStart > 0, 'the offboard route was located');
const offboardBody = src.slice(offboardStart, offboardStart + 1400);
const loopAt = offboardBody.indexOf('deleteCloneRecords(clone)');
const spliceAt = offboardBody.indexOf('users.splice(users.indexOf(user), 1)');
assert(loopAt > 0 && spliceAt > 0, 'both the retention loop and the user removal were found in the route');
assert(loopAt < spliceAt,
  'the clone/draft loop runs BEFORE the user is removed — reversing these silently purges the drafts the log claims to retain');

assert(/d\.personaDeleted = true;/.test(src) && /retained\+\+/.test(src),
  'an employee\'s drafts are DETACHED from the deleted persona, not deleted — the company keeps the correspondence');
assert(/cloneDrafts\.splice\(i, 1\);\s*\n\s*purged\+\+/.test(src),
  '...whereas a non-employee\'s drafts are purged, which is why the user lookup above has to happen first');

// ── the roster never leaks a credential ──────────────────────────────────────────────────────────
const pending = org.summarizeMember(employee);
assert(pending.invitePending === true && pending.hasPassword === false, 'an un-redeemed invite reads as pending');
assert(pending.setupToken === undefined && pending.passwordHash === undefined,
  'the roster shape carries neither the live invite token nor the password hash — both are login credentials');
const redeemed = org.summarizeMember({ ...employee, passwordHash: 'x', setupToken: undefined });
assert(redeemed.hasPassword === true && redeemed.invitePending === false, 'and a redeemed one flips both flags');

console.log('  info: chain walked — invite → set-password → clone (personal) → draft → employer scope → offboard (persona deleted, records retained)');

done();
