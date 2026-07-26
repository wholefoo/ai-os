// Tests lib/org/membership: an employee is a user whose ownerEmail points at somebody else, and
// every refusal in validateInvite exists to stop an account being created that would surprise
// someone. Also pins the ownerEmail-vs-email split the whole clone feature depends on.
const org = require('../lib/org/membership');

const { assert, done } = require('./test-util');

const owner = { email: 'dana@whitfield.com' };                                   // no ownerEmail = own org
const emp1 = { email: 'sam@whitfield.com', ownerEmail: 'dana@whitfield.com' };
const emp2 = { email: 'jo@whitfield.com', ownerEmail: 'DANA@Whitfield.com' };    // casing must not matter
const outsider = { email: 'rival@other.com' };
const users = [owner, emp1, emp2, outsider];

// --- org key resolution
assert(org.orgKeyFor(owner) === 'dana@whitfield.com', 'a user with no ownerEmail is their own org — every existing account');
assert(org.orgKeyFor(emp1) === 'dana@whitfield.com', 'an employee resolves to their employer');
assert(org.orgKeyFor(emp2) === 'dana@whitfield.com', 'org keys compare case-insensitively, as wsOwns does');
assert(org.orgKeyFor(null) === '', 'no user, no org');
assert(org.orgKeyFor({ email: 'X@Y.COM' }) === 'x@y.com', 'keys are normalised');

// sessions resolve the same way wsOwns does — ownerEmail first, own address as fallback
assert(org.orgKeyForSession({ email: 'sam@whitfield.com', ownerEmail: 'dana@whitfield.com' }) === 'dana@whitfield.com', 'a session prefers ownerEmail');
assert(org.orgKeyForSession({ email: 'dana@whitfield.com' }) === 'dana@whitfield.com', 'a session without ownerEmail falls back to its own address');
assert(org.orgKeyForSession(null) === '', 'no session, no org');

// --- employee predicate
assert(org.isEmployee(emp1) === true, 'pointing at someone else makes you an employee');
assert(org.isEmployee(owner) === false, 'pointing at yourself does not');
assert(org.isEmployee({ email: 'a@b.com', ownerEmail: 'A@B.com' }) === false, 'self-reference in different casing is still self-reference');

// --- rosters
assert(org.membersOf(users, 'dana@whitfield.com').length === 3, 'the roster includes the owner');
assert(org.employeesOf(users, 'dana@whitfield.com').length === 2, 'the employee list excludes the owner');
assert(org.membersOf(users, 'dana@whitfield.com').every((u) => u !== outsider), 'another org is not in the roster');
assert(org.membersOf(users, '').length === 0, 'an empty org key matches nobody rather than everybody');
assert(org.membersOf(null, 'dana@whitfield.com').length === 0, 'a missing user list is empty, not a throw');

// --- validateInvite refusals
const admin = { role: 'admin', email: 'dana@whitfield.com' };

const good = org.validateInvite({ session: admin, email: 'New.Hire@Whitfield.com', users });
assert(good.ok && good.email === 'new.hire@whitfield.com', 'a fresh address is invitable and normalised');
assert(good.org === 'dana@whitfield.com', 'the invite attaches to the inviter\'s org');

const byEmployee = org.validateInvite({ session: { role: 'client', email: 'sam@whitfield.com', ownerEmail: 'dana@whitfield.com' }, email: 'x@y.com', users });
assert(!byEmployee.ok, 'an employee cannot invite — that is a privilege-escalation path');

// An API token is automation, not a person. Caught live: the service session carries a synthetic
// address, so inviting through it attached a real employee to an org keyed on 'service@api-token'.
const byToken = org.validateInvite({ session: { role: 'admin', email: 'service@api-token', service: true }, email: 'x@y.com', users });
assert(!byToken.ok, 'an API token cannot invite — minting a login credential for a person requires a person');
assert(/API token/.test(byToken.error), 'and the refusal says why');

assert(!org.validateInvite({ session: admin, email: 'not-an-email', users }).ok, 'a malformed address is refused');
assert(!org.validateInvite({ session: admin, email: '', users }).ok, 'an empty address is refused');
assert(!org.validateInvite({ session: admin, email: 'dana@whitfield.com', users }).ok, 'the owner cannot be made their own employee');

const dupe = org.validateInvite({ session: admin, email: 'SAM@whitfield.com', users });
assert(!dupe.ok && /already has an account/.test(dupe.error), 'an existing address is refused rather than silently re-pointed into another company');
assert(!org.validateInvite({ session: admin, email: 'rival@other.com', users }).ok, 'that holds for someone in a different org too');

// seat limit
assert(!org.validateInvite({ session: admin, email: 'third@whitfield.com', users, seatLimit: 2 }).ok, 'the seat limit is enforced');
assert(org.validateInvite({ session: admin, email: 'third@whitfield.com', users, seatLimit: 25 }).ok, 'and does not fire below it');
assert(org.validateInvite({ session: admin, email: 'third@whitfield.com', users, seatLimit: null }).ok, 'no limit supplied means no limit applied');

// --- buildEmployee
const built = org.buildEmployee({ id: 'u1', email: 'New.Hire@Whitfield.com', ownerEmail: 'Dana@Whitfield.com', name: 'New Hire', setupToken: { token: 't', expiresAt: 'x' } });
assert(built.email === 'new.hire@whitfield.com' && built.ownerEmail === 'dana@whitfield.com', 'addresses are normalised on the record');
assert(built.role === 'client', 'an employee gets the non-admin role');
assert(built.cloneAccess === true, 'an INVITED person gets clone access — the counterpart to the entitlement gate');
assert(!built.passwordHash, 'no password until they set one');
assert(!!built.setupToken, 'the single-use invite token is attached, reusing the existing set-password flow');
assert(org.isEmployee(built), 'the built record reads as an employee');

// --- roster shape leaks nothing
const safe = org.summarizeMember({ ...built, passwordHash: 'SECRET-HASH' });
assert(safe.passwordHash === undefined, 'the roster never carries a password hash');
assert(safe.setupToken === undefined, 'nor a live invite token — that is a login credential');
assert(safe.invitePending === false, 'someone with a password is not pending');
assert(org.summarizeMember(built).invitePending === true, 'someone without one is');
assert(org.summarizeMember(owner).isOwner === true && org.summarizeMember(emp1).isOwner === false, 'the roster distinguishes the owner');

done();
