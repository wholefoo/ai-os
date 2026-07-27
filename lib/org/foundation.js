// lib/org/foundation.js
// ============================================================
//  The order things have to happen in, in one place.
//
//  A company profile, then the founder's clone, then everyone else. Both gates, and the reason each
//  exists, because they are NOT the same reason and conflating them is how one gets quietly dropped:
//
//  1. THE COMPANY PROFILE COMES FIRST, and gates every clone including the founder's. It is the
//     foundation: the facts and limits that every clone on the instance inherits at the point of use.
//     Building a clone before it exists means interviewing a person about their business, storing
//     their answer inside their own persona, and then doing it again for the next person — five
//     private, diverging accounts of one company. The profile is a separate artifact from any clone
//     precisely so it can be authored once and inherited, rather than discovered five times.
//
//     It also changes what an interview is FOR. With the company on file, no interview needs to ask
//     what the business does, so every question is about the PERSON — their voice, their judgement,
//     their limits. That is the whole point of a clone, and it only holds if the company is known
//     first. (The interview already suppresses company-answered fields; this is what makes that
//     suppression fire for the founder too, not just employees.)
//
//  2. THE FOUNDER'S CLONE COMES SECOND, before any employee's. This gate does NOT establish
//     anything — the profile above does. It is here so the owner runs the whole flow on themselves
//     before asking anyone who works for them to sit through it, which is the same rule E7 applies
//     to dispatch. Weaker justification than the first gate, deliberately so, and worth remembering
//     if it ever needs relaxing: dropping it costs the owner's dogfooding, not the foundation.
//
//  The founder needs no field of its own: they are the person whose clone is keyed to the ORG key,
//  which is exactly how membership.js already tells an owner from an employee. A second notion of
//  "who the founder is" would be a second thing to keep in sync.
//
//  Pure module: reads state, decides, explains. No I/O.
// ============================================================

'use strict';

const persona = require('../business-clone/persona');
const profileLib = require('./profile');

// The stages, in order, are 'profile' -> 'founder' -> 'ready', and the order is the point.
//
// What a profile needs before it can be called a foundation: the same three fields every clone
// inherits — a profile missing them inherits nothing and the gate would be theatre.
const REQUIRED_PROFILE_FIELDS = ['businessName', 'industry', 'whatTheyDo'];

const LABELS = {
  businessName: 'the business name',
  industry: 'the industry',
  whatTheyDo: 'what the business does',
};

function normEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** Which foundation facts are still blank. */
function profileGaps(profile) {
  const p = profileLib.normalizeProfile(profile || {});
  return REQUIRED_PROFILE_FIELDS.filter((f) => !p.identity[f]);
}

function isProfileEstablished(profile) {
  return profileGaps(profile).length === 0;
}

/**
 * The founder's clone: the one keyed to the org itself. Returns null before they have built it,
 * which is a stage rather than an error.
 */
function founderCloneOf(clones, orgKey) {
  const key = normEmail(orgKey);
  if (!key) return null;
  return (clones || []).find((c) => c && normEmail(c.clientId) === key) || null;
}

/**
 * Where this organisation is up to, and what is standing in the way.
 *
 * Readiness is judged on the EFFECTIVE persona — the founder's own answers plus the company profile
 * they just wrote — because that is what the clone actually speaks with. Judging the raw persona
 * would demand the founder personally re-state facts the company has already established, which is
 * the exact duplication the first gate exists to prevent.
 */
function status({ profile, clones, orgKey } = {}) {
  const key = normEmail(orgKey);
  const gaps = profileGaps(profile);
  const profileReady = gaps.length === 0;

  const founderClone = founderCloneOf(clones, key);
  const effective = founderClone ? profileLib.effectivePersona(founderClone.persona, profile) : null;
  const usable = effective ? persona.isUsable(effective) : { usable: false, reasons: [], completeness: 0 };
  const founderReady = !!founderClone && usable.usable;

  const stage = !profileReady ? 'profile' : (!founderReady ? 'founder' : 'ready');

  const blockers = [];
  if (!profileReady) {
    blockers.push(`The company profile still needs ${gaps.map((f) => LABELS[f] || f).join(', ')}.`);
  } else if (!founderClone) {
    blockers.push('The owner has not built their clone yet, and theirs comes first.');
  } else if (!founderReady) {
    // isUsable's reasons are already written for a person; passing them through beats paraphrasing
    // them into something that drifts from what the interview screen says.
    blockers.push(...usable.reasons);
  }

  return {
    stage,
    complete: stage === 'ready',
    founderEmail: key,
    profileReady,
    profileMissing: gaps,
    founderClone: founderClone
      ? { id: founderClone.id, name: founderClone.name, completeness: usable.completeness, status: founderClone.status }
      : null,
    founderReady,
    blockers,
  };
}

/**
 * May this person create a clone right now?
 *
 * FAILS CLOSED on a missing org key: without one there is no company to have a profile and no way to
 * tell a founder from an employee, so there is nothing to check against and the answer is no.
 *
 * The errors name what is missing and, where it is somebody else's move, WHOSE — an employee told
 * only "not yet" has no idea whether to wait or to go and ask someone.
 */
function mayCreateClone({ profile, clones, orgKey, clientId } = {}) {
  const key = normEmail(orgKey);
  const who = normEmail(clientId);
  if (!key || !who) {
    return { ok: false, stage: 'profile', error: 'This account is not attached to an organisation, so there is no company profile to build on.' };
  }

  const s = status({ profile, clones, orgKey: key });
  const isFounder = who === key;

  if (!s.profileReady) {
    return {
      ok: false,
      stage: 'profile',
      error: isFounder
        ? `Set up the company profile first — it still needs ${s.profileMissing.map((f) => LABELS[f] || f).join(', ')}. Every clone inherits it, so it comes before the first one.`
        : `${key} has not finished the company profile yet. Every clone is built on it, so nobody can start until it is done.`,
    };
  }

  // The founder is never blocked by the founder gate — it exists to hold everyone ELSE until they
  // have gone first.
  if (isFounder) return { ok: true, stage: s.stage };

  if (!s.founderReady) {
    return {
      ok: false,
      stage: 'founder',
      error: s.founderClone
        ? `${key} is still building their own clone, which comes first. Once theirs is ready, yours can start.`
        : `${key} has not built their clone yet, and the owner's comes first.`,
    };
  }

  return { ok: true, stage: 'ready' };
}

module.exports = {
  profileGaps,
  isProfileEstablished,
  founderCloneOf,
  status,
  mayCreateClone,
};
