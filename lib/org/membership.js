// lib/org/membership.js
// ============================================================
//  Who belongs to which company on this instance.
//
//  There is no organisation TABLE, and this does not add one. The platform already identifies an
//  owner by email — web-studio's wsOwns resolves `session.ownerEmail || session.email`, and every
//  session already carries an ownerEmail field. Until now that field has been self-referential:
//  every user is their own owner. An EMPLOYEE is simply a user whose ownerEmail points at somebody
//  else. That is the whole model.
//
//  Choosing this over a real org table is deliberate. A second notion of "who owns this" would let
//  two subsystems disagree about which records a person may see, and the existing predicate already
//  reads ownerEmail first — so pointing it at an employer makes sites, CRM and analytics scope to
//  the company for free, with no changes to any of them.
//
//  The split that falls out of it, and which the rest of the feature depends on:
//    ownerEmail  = the ORG        — sites, CRM, brand, billing, limits. Shared.
//    email       = the INDIVIDUAL — clones. Personal. cloneClientOf keys on this, not on ownerEmail.
//
//  So a company shares its customers and its websites, and nobody shares a replica of how they
//  personally think. That is the correct default and it was already half-built.
//
//  Pure module: predicates and validation. No state, no I/O.
// ============================================================

'use strict';

/** Normalise an address for comparison. wsOwns compares case-insensitively; so does everything here. */
function normEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.\w+$/;

function isEmail(v) {
  return EMAIL_RE.test(normEmail(v));
}

/**
 * The org a user belongs to. Their employer if they have one, otherwise themselves.
 * A user with no ownerEmail is their own org — which is every account that exists today, so this
 * is backward-compatible by construction.
 */
function orgKeyFor(user) {
  if (!user) return '';
  return normEmail(user.ownerEmail) || normEmail(user.email);
}

/** The org for a live session, preferring the same field wsOwns prefers. */
function orgKeyForSession(session) {
  if (!session) return '';
  return normEmail(session.ownerEmail) || normEmail(session.email);
}

/** Is this user an employee of somebody — i.e. does their org key differ from their own address? */
function isEmployee(user) {
  const own = normEmail(user && user.email);
  const org = orgKeyFor(user);
  return !!own && !!org && own !== org;
}

/** Everyone in one org, the owner included. */
function membersOf(users, ownerEmail) {
  const org = normEmail(ownerEmail);
  if (!org) return [];
  return (users || []).filter((u) => u && orgKeyFor(u) === org);
}

/** Employees only — the owner excluded. */
function employeesOf(users, ownerEmail) {
  return membersOf(users, ownerEmail).filter(isEmployee);
}

/**
 * Can this invite be issued?
 *
 * Refusals here are all about not creating an account that would surprise someone:
 *  - only an admin invites, because an employee inviting employees is a privilege-escalation path
 *  - an address that already has an account is refused rather than silently re-pointed, which would
 *    move an existing person into someone else's company without their knowledge
 *  - an owner cannot be made their own employee
 */
function validateInvite({ session, email, users, seatLimit }) {
  const addr = normEmail(email);
  if (!session || session.role !== 'admin') {
    return { ok: false, error: 'only the operator can invite people' };
  }
  // An API token is automation, not a person. Its session carries a synthetic address
  // ('service@api-token'), so inviting through it would attach real employees to an org keyed on an
  // address nobody owns — and it would let a token mint login credentials for humans. Minting a
  // credential for a person should require a person.
  if (session.service) {
    return { ok: false, error: 'invites must come from a signed-in operator account, not an API token' };
  }
  if (!isEmail(addr)) return { ok: false, error: 'a valid email address is required' };

  const org = orgKeyForSession(session);
  if (!org) return { ok: false, error: 'the inviting account has no address to attach people to' };
  if (addr === org) return { ok: false, error: 'that is the owner\'s own address' };

  if ((users || []).some((u) => u && normEmail(u.email) === addr)) {
    return { ok: false, error: 'that address already has an account on this instance' };
  }

  if (seatLimit != null && employeesOf(users, org).length >= seatLimit) {
    return { ok: false, error: `this licence covers ${seatLimit} people` };
  }

  return { ok: true, org, email: addr };
}

/**
 * The user record for a new employee.
 *
 * cloneAccess is granted HERE and only here. That is the counterpart to the entitlement gate: a
 * Stripe-created managed customer never passes through this function, so they never get the flag,
 * while everyone who does pass through it was deliberately invited by the operator.
 */
function buildEmployee({ id, email, ownerEmail, name = '', plan = 'business', setupToken }) {
  return {
    id,
    email: normEmail(email),
    name: String(name || '').trim().slice(0, 120),
    ownerEmail: normEmail(ownerEmail),
    role: 'client',        // the platform's non-admin role; the client surface guard already fences it
    plan,
    cloneAccess: true,     // invited people get clones; purchased managed customers do not
    // Having a clone and letting it commission work from agents are different amounts of authority.
    // The second starts OFF and is granted per person by the employer — a clone must never hold more
    // authority than the person it replicates, and an invite is not a statement about spending.
    cloneDispatch: false,
    createdAt: new Date().toISOString(),
    setupToken,            // single-use, reuses the existing /set-password flow
  };
}

/** Safe shape for an org roster — never the password hash or the live setup token. */
function summarizeMember(user) {
  return {
    email: normEmail(user.email),
    name: user.name || '',
    isOwner: !isEmployee(user),
    cloneAccess: user.cloneAccess === true,
    cloneDispatch: user.cloneDispatch === true,
    hasPassword: !!user.passwordHash,
    invitePending: !user.passwordHash && !!user.setupToken,
    createdAt: user.createdAt || null,
  };
}

module.exports = {
  // normEmail / isEmail stay internal: normEmail would collide with lib/crm/repo.js's export of
  // the same name, and two identically-named helpers is an ambiguity waiting to be imported wrong.
  orgKeyFor,
  orgKeyForSession,
  isEmployee,
  membersOf,
  employeesOf,
  validateInvite,
  buildEmployee,
  summarizeMember,
};
