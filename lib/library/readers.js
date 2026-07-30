// lib/library/readers.js
// ============================================================
//  Who may read a library record.
//
//  This module answers one question — "may this requester see this record?" — and it is the only
//  place in the library that answers it. That is deliberate: the moment two modules both decide
//  access, they diverge, and the one that drifts permissive is the one nobody notices.
//
//  The model is an ALLOWLIST, built entry by entry, for the reason lib/org/visibility.js records:
//  a denylist leaks the day someone adds a field. On this module the stakes are higher than on a
//  clone view, because the library's whole purpose is that every agent reads it. A record that
//  leaks here leaks platform-wide.
//
//  Three rules, and there is no fourth:
//
//    1. FAIL CLOSED. Anything malformed, unrecognised, or absent means NO. An empty reader list is
//       an unreadable record, not a public one. A requester whose kind we do not recognise is
//       refused rather than guessed at.
//    2. THE LIST IS THE TRUTH. canRead consults `readers` and nothing else. Not `owner`, not
//       `sensitivity`, not an admin flag. `sensitivity` is a human-facing label; if it ever became
//       an enforcement input we would have two access systems disagreeing. Ownership is expressed
//       by buildReaders PUTTING the owner in the list, so there is one mechanism, auditable by
//       reading one array.
//    3. NO BYPASS LIVES HERE. Operator override is a ROUTE-level decision (`requireAdmin OR
//       canRead`), written where a reviewer can see it. A backdoor inside canRead would be
//       invisible to every caller and would make the allowlist decorative.
//
//  The 'all-agents' sentinel is the one broad grant, and it is deliberately narrow in effect: it
//  admits AGENTS, never people. Agent reads are fenced as untrusted data by the caller, so a
//  hostile document reaching an agent is contained by the fence; a document reaching the wrong
//  PERSON is not contained by anything. Those two risks are not interchangeable, so they do not
//  share a grant.
//
//  Pure module: shapes and predicates only. No state, no I/O.
// ============================================================

'use strict';

const { findLeaks } = require('../org/visibility');

/**
 * The two broad grants, and why there are exactly two rather than one.
 *
 * ALL_AGENTS admits agents. ALL_OPERATORS admits authenticated operators (the humans who run the
 * instance). They are SEPARATE because the risks are not interchangeable: an agent read is wrapped in
 * the untrusted fence, so a hostile document reaching an agent is contained; a document reaching the
 * wrong PERSON is contained by nothing. One sentinel covering both would mean every grant to a bot
 * silently became a grant to a human.
 *
 * Neither sentinel admits a plain `person` — a non-operator human such as a managed client. That
 * principal must be named explicitly, every time.
 */
const ALL_AGENTS = 'all-agents';
const ALL_OPERATORS = 'all-operators';

/**
 * Requester kinds we recognise. Anything else fails closed.
 *  - 'agent'    — an AI agent; the caller fences its reads as untrusted data
 *  - 'operator' — an authenticated admin/operator human running this instance
 *  - 'person'   — any other human principal (client, employee); named grants only
 */
const REQUESTER_KINDS = Object.freeze(['agent', 'operator', 'person']);

/** Which sentinel, if any, admits each requester kind. A table rather than branches, so adding a
 *  kind forces an explicit decision about its broad grant instead of quietly inheriting one. */
const KIND_SENTINEL = Object.freeze({
  agent: ALL_AGENTS,
  operator: ALL_OPERATORS,
  person: null,          // no broad grant exists for a non-operator human, by design
});

/**
 * Normalise a reader entry for comparison.
 *
 * Emails are compared case-insensitively because the org layer stores orgKeys lower-cased
 * (see lib/org/membership.js) and a record hand-edited with a capitalised address must not
 * silently become unreadable to its own owner. Agent names are lower-cased for the same reason.
 * Everything is trimmed, because a trailing space in a hand-edited catalog is not a new principal.
 */
function normalizeEntry(entry) {
  return String(entry == null ? '' : entry).trim().toLowerCase();
}

/**
 * Build a reader allowlist, entry by entry.
 *
 * There is no "everyone" option and no way to express a negation. The absence of an entry is the
 * only way to deny, which is what makes this auditable: the array IS the policy.
 *
 * @param {object}   opts
 * @param {string}  [opts.owner]        The record's owner (orgKey/email). Included when present, so
 *                                      ownership needs no separate rule in canRead.
 * @param {string}  [opts.contributor]  Whoever added it, if different from the owner.
 * @param {string[]}[opts.principals]   Explicitly named people or agents.
 * @param {boolean} [opts.allAgents]    Grant the ALL_AGENTS sentinel. Must be an explicit, deliberate
 *                                      choice at the call site — it is never the default, because a
 *                                      default-broad grant is how a contribution path leaks.
 * @returns {string[]} de-duplicated, normalised, stable-ordered allowlist
 */
function buildReaders(opts) {
  const o = opts || {};
  const out = [];
  const add = (entry) => {
    const e = normalizeEntry(entry);
    // Reject empties, and refuse to let either sentinel arrive through a principal list — a broad
    // grant must go through its explicit flag so it is visible at every call site that makes one.
    if (!e || e === ALL_AGENTS || e === ALL_OPERATORS) return;
    if (!out.includes(e)) out.push(e);
  };

  add(o.owner);
  add(o.contributor);
  if (Array.isArray(o.principals)) o.principals.forEach(add);
  if (o.allAgents === true) out.push(ALL_AGENTS);
  if (o.allOperators === true) out.push(ALL_OPERATORS);

  return out;
}

/**
 * May this requester read this record?
 *
 * @param {object} record            A library record (needs `readers`).
 * @param {object} requester         `{ kind: 'agent'|'person', id: string }`
 * @returns {boolean}
 */
function canRead(record, requester) {
  // Fail closed on anything we cannot positively evaluate.
  if (!record || typeof record !== 'object') return false;
  if (!requester || typeof requester !== 'object') return false;

  const kind = normalizeEntry(requester.kind);
  const id = normalizeEntry(requester.id);
  if (!REQUESTER_KINDS.includes(kind)) return false;
  if (!id) return false;

  // A non-array or empty `readers` is an unreadable record. This is the branch that turns a
  // migration bug or a hand-edited catalog into a denial rather than a disclosure.
  const readers = Array.isArray(record.readers) ? record.readers.map(normalizeEntry) : [];
  if (!readers.length) return false;

  // The broad grant for this kind, if the kind has one and the record made it. Looked up in the
  // table so 'person' cannot acquire a sentinel by someone adding a branch.
  const sentinel = KIND_SENTINEL[kind];
  if (sentinel && readers.includes(sentinel)) return true;

  // Otherwise the principal must be named. Note this is the ONLY other way through — no owner
  // shortcut, no sensitivity check, no admin flag. See rule 2 in the header.
  return readers.includes(id);
}

/**
 * Filter a record list to what this requester may read.
 *
 * Used by every list/search route. Kept here rather than in catalog.js so that access filtering
 * cannot drift away from canRead — one predicate, one place.
 */
function readableBy(records, requester) {
  if (!Array.isArray(records)) return [];
  return records.filter((r) => canRead(r, requester));
}

/**
 * Refuse anything carrying persona-shaped fields.
 *
 * A clone contributing to a library that every agent reads is the highest-leverage way to leak a
 * named person's psychological profile across the whole instance. This is the same tripwire
 * lib/org/visibility.js uses, applied over the WHOLE payload rather than field by field, because
 * the field most likely to be added to a contribution is another piece of the persona.
 *
 * Returns the offending key paths. An empty array means clean. Callers refuse on any hit and
 * surface the reason — a silent drop teaches the contributor nothing and hides a real signal.
 *
 * (P2 owns the contribution route; this lives here in P0 so the invariant exists and is tested
 * before anything can write to the library.)
 */
function findPersonaLeaks(payload) {
  const leaks = findLeaks(payload);
  // `personaDerived` is an always-false invariant on the record. A true value has bypassed
  // catalog.normalize, which means something constructed a record by hand — report it as a leak
  // so the same refusal path catches it.
  if (payload && typeof payload === 'object' && payload.personaDerived === true) {
    leaks.push('personaDerived');
  }
  return leaks;
}

/**
 * Sources the operator's override may reach — an ALLOWLIST, not a list of exclusions.
 *
 * `/api/library/record/:id/content` lets an admin read past `readers`, which is right for the
 * instance's own material: the operator uploaded the company docs, owns the vault, and runs the
 * agents that wrote the artifacts. It is NOT right for anything a person or their clone contributed.
 * Those carry a narrow reader set precisely so the contributor decides who sees them, and an
 * operator override would make that set decorative — the same cross-account view the clone doctrine
 * already refuses (an employer sees a clone's WORK, never the clone).
 *
 * Written as an allowlist because the alternative fails silently: name the two contribution sources
 * as exclusions instead, and the next source anyone adds — P3's imports, a future integration —
 * becomes operator-readable by default, with nobody noticing. Adding a member here is a decision;
 * forgetting to add one denies rather than discloses.
 */
const OPERATOR_OVERRIDABLE_SOURCES = Object.freeze(['company-doc', 'agent-output', 'canonical-fact']);

/** May the operator's override read past `readers` on this record? */
function operatorMayOverride(record) {
  if (!record || typeof record !== 'object') return false;
  return OPERATOR_OVERRIDABLE_SOURCES.includes(normalizeEntry(record.source));
}

/** True when the payload is safe to store. Convenience wrapper — the leak paths are the useful part. */
function isPublishable(payload) {
  return findPersonaLeaks(payload).length === 0;
}

module.exports = {
  ALL_AGENTS,
  ALL_OPERATORS,
  REQUESTER_KINDS,
  KIND_SENTINEL,
  OPERATOR_OVERRIDABLE_SOURCES,
  buildReaders,
  canRead,
  operatorMayOverride,
  readableBy,
  findPersonaLeaks,
  isPublishable,
};
