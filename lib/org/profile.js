// lib/org/profile.js
// ============================================================
//  What the COMPANY says, as distinct from what a PERSON says.
//
//  Two things belong to the business rather than to any individual:
//    - identity facts: what the company is called, what industry it is in, what it actually does
//    - boundary policy: what nobody here may say, promise, or disclose
//
//  MERGED AT USE, NEVER COPIED INTO A PERSONA. This is the central decision and everything else
//  follows from it.
//
//  Copying org values into each employee's persona would be simpler and wrong twice over. It would
//  drift — change the company policy and ten stale copies keep the old rule. And it would make
//  "locked" a thing we had to enforce, because a copied value sits in the persona where the
//  correction form, the extraction merge, and the evolution loop can all reach it. Three guards to
//  write, three to keep correct, one to eventually forget.
//
//  Merging at the point of use makes the lock STRUCTURAL instead. Org boundaries are never in the
//  employee's persona, so there is nothing for any of those three paths to remove. An employee can
//  add limits; the company's limits are simply always there.
//
//  The consequence to respect: every place that reads a persona to DECIDE or to SPEAK must read the
//  effective one — compiling the prompt, checking output against red lines, screening an inbound
//  message. A single site left reading the raw persona is a company policy silently not applied.
//
//  Pure module: shapes and merges. No state, no I/O.
// ============================================================

'use strict';

const persona = require('../business-clone/persona');

/** Identity fields that belong to the company, not the person. */
const ORG_IDENTITY_FIELDS = ['businessName', 'industry', 'whatTheyDo'];

/** Boundary fields the company can set for everyone. Every one of them is additive-only. */
const ORG_BOUNDARY_LISTS = ['neverSay', 'neverPromise', 'requiresHuman', 'confidentialTopics'];

function emptyProfile(ownerEmail) {
  return {
    ownerEmail: String(ownerEmail || '').trim().toLowerCase(),
    identity: { businessName: '', industry: '', whatTheyDo: '' },
    boundaries: {
      neverSay: [], neverPromise: [], requiresHuman: [], confidentialTopics: [],
      pricingDisclosure: '', competitorPolicy: '',
    },
    // Where a field came from, when it was not typed by hand: [{ field, value, documentId, filename,
    // at }]. Recorded so the Company screen can say "this limit came from supplier-terms.docx"
    // rather than appearing to know things — a profile partly derived from documents that cannot
    // say which parts is one nobody can audit.
    sources: [],
    updatedAt: null,
  };
}

const MAX_SOURCES = 500;

/** Provenance entries, validated like everything else — they are written from model-derived data. */
function normalizeSources(input) {
  return (Array.isArray(input) ? input : [])
    .filter((s) => s && typeof s === 'object' && s.field)
    .map((s) => ({
      field: String(s.field).slice(0, 60),
      value: String(s.value == null ? '' : s.value).slice(0, 300),
      documentId: s.documentId ? String(s.documentId).slice(0, 64) : null,
      filename: String(s.filename || '').slice(0, 200),
      at: s.at || null,
    }))
    .slice(-MAX_SOURCES);
}

/**
 * Normalise a profile by running it through the persona normaliser.
 *
 * Deliberately reuses persona.normalize rather than re-implementing caps and enum validation: the
 * company's boundary list and a person's are the same kind of data and must obey the same limits.
 * A second implementation is a second set of caps to drift.
 */
function normalizeProfile(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const viaPersona = persona.normalize({ identity: src.identity || {}, boundaries: src.boundaries || {} });
  const out = emptyProfile(src.ownerEmail);
  for (const f of ORG_IDENTITY_FIELDS) out.identity[f] = viaPersona.identity[f];
  for (const f of ORG_BOUNDARY_LISTS) out.boundaries[f] = viaPersona.boundaries[f];
  out.boundaries.pricingDisclosure = viaPersona.boundaries.pricingDisclosure;
  out.boundaries.competitorPolicy = viaPersona.boundaries.competitorPolicy;
  out.sources = normalizeSources(src.sources);
  out.updatedAt = src.updatedAt || null;
  return out;
}

/** Pricing permissiveness, lowest first. Mirrors the same ordering the evolution guard uses. */
const PRICING_ORDER = { none: 0, ranges: 1, full: 2, '': 3 };

/**
 * The persona a clone actually speaks with: the person's own, plus whatever the company imposes.
 *
 * Identity — the company's facts FILL IN blanks but never overwrite. An employee who described the
 * business in their own words keeps their words; one who was never asked inherits the company's.
 *
 * Boundaries — union, so the company's limits are always present and an employee's additions are
 * kept. Pricing takes whichever of the two is MORE restrictive, because a company saying "ranges
 * only" and a person saying "never" should produce "never", not an argument.
 */
function effectivePersona(personaInput, profileInput) {
  const p = persona.normalize(personaInput);
  if (!profileInput) return p;
  const org = normalizeProfile(profileInput);

  for (const f of ORG_IDENTITY_FIELDS) {
    if (!p.identity[f] && org.identity[f]) p.identity[f] = org.identity[f];
  }

  for (const f of ORG_BOUNDARY_LISTS) {
    const seen = new Set(p.boundaries[f].map((x) => String(x).toLowerCase()));
    for (const v of org.boundaries[f]) {
      if (!seen.has(String(v).toLowerCase())) { seen.add(String(v).toLowerCase()); p.boundaries[f].push(v); }
    }
  }

  const mine = PRICING_ORDER[p.boundaries.pricingDisclosure] ?? 3;
  const theirs = PRICING_ORDER[org.boundaries.pricingDisclosure] ?? 3;
  if (org.boundaries.pricingDisclosure && theirs < mine) {
    p.boundaries.pricingDisclosure = org.boundaries.pricingDisclosure;
  }

  if (!p.boundaries.competitorPolicy && org.boundaries.competitorPolicy) {
    p.boundaries.competitorPolicy = org.boundaries.competitorPolicy;
  }

  return persona.normalize(p);
}

/**
 * Which effective values came from the company. The UI shows these as inherited and non-editable —
 * an employee seeing a limit they cannot remove should be told where it came from, rather than
 * discovering that deleting it silently does nothing.
 */
function inheritedFrom(profileInput) {
  const org = normalizeProfile(profileInput || {});
  const out = { identity: {}, boundaries: {} };
  for (const f of ORG_IDENTITY_FIELDS) if (org.identity[f]) out.identity[f] = org.identity[f];
  for (const f of ORG_BOUNDARY_LISTS) if (org.boundaries[f].length) out.boundaries[f] = org.boundaries[f];
  if (org.boundaries.pricingDisclosure) out.boundaries.pricingDisclosure = org.boundaries.pricingDisclosure;
  if (org.boundaries.competitorPolicy) out.boundaries.competitorPolicy = org.boundaries.competitorPolicy;
  return out;
}

/** Which persona fields an employee's interview can skip, because the company already answered. */
function inheritedIdentityFields(profileInput) {
  const org = normalizeProfile(profileInput || {});
  return ORG_IDENTITY_FIELDS.filter((f) => !!org.identity[f]);
}

function getProfile(profiles, ownerEmail) {
  const key = String(ownerEmail || '').trim().toLowerCase();
  if (!key) return null;
  return (profiles || []).find((p) => p && p.ownerEmail === key) || null;
}

module.exports = {
  // ORG_IDENTITY_FIELDS / ORG_BOUNDARY_LISTS stay internal — they describe this module's own
  // merge rules, and exporting them invites a caller to reimplement the merge instead of calling it.
  emptyProfile,
  normalizeProfile,
  effectivePersona,
  inheritedFrom,
  inheritedIdentityFields,
  getProfile,
};
