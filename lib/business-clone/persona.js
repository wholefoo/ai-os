// lib/business-clone/persona.js
// ============================================================
//  The persona schema behind an AI Business Clone — a structured replica of a specific business
//  owner's voice, expertise, and decision-making, used to draft work in their name.
//
//  Design decision worth understanding before changing anything here: a persona is DATA, not a
//  prompt. It would be far less code to store a blob of prose and paste it into a system message.
//  We don't, for three reasons that all show up later:
//    - the owner must be able to SEE what their clone believes about them, field by field. Prose
//      can't be reviewed; a boundary buried in paragraph four is a boundary nobody audits.
//    - the clone EVOLVES. Evolution means proposing a diff and having a human approve it. You can
//      diff `voice.avoidPhrases`; you cannot meaningfully diff two paragraphs of regenerated prose.
//    - boundaries have to be ENFORCED, not just stated. A red line that exists only as a sentence
//      in a prompt is a suggestion to a language model. Here it is a field this module checks
//      output against (see checkRedLines) — belt as well as braces.
//
//  Everything is capped. Persona fields are compiled into a system prompt on every single clone
//  call, so an unbounded `faq` array is both a cost bug and a context-exhaustion bug. Caps are
//  enforced in validate(), not left to the caller.
//
//  Nothing in this file talks to a model, the filesystem, or the network — it is pure schema,
//  validation, and scoring, so it can be unit-tested without a provider key.
// ============================================================

'use strict';

// ---- Caps -------------------------------------------------------------------
// Sized so a fully-populated persona compiles to roughly 2-4k tokens. Raising these raises the
// per-call cost of EVERY draft the clone produces, forever — treat them as a budget, not a limit.
const CAPS = {
  shortText: 200,        // a name, a role, a signoff
  mediumText: 600,       // a mission statement, a rationale
  longText: 2000,        // an FAQ answer
  listItems: 20,         // items in any one list field
  faqItems: 30,
  opinionItems: 15,
  tradeoffRules: 15,
};

const HUMOR_STYLES = ['none', 'dry', 'warm', 'playful'];
const SENTENCE_LENGTHS = ['short', 'varied', 'long'];
const RISK_POSTURES = ['conservative', 'balanced', 'aggressive'];
const PRICING_DISCLOSURE = ['none', 'ranges', 'full'];

// The five dimensions. Order matters — it is the order the interview walks them and the order the
// compiler emits them. Identity first (grounds everything), boundaries last (read most recently,
// which for a language model is the strongest position for a constraint).
const DIMENSIONS = ['identity', 'voice', 'expertise', 'decisionStyle', 'boundaries'];

// Fields that must be present for a dimension to count as covered, and what each is worth toward
// that dimension's completeness. The interview engine (P1) uses this to decide what to ask next,
// so "what makes a persona good enough to use" is defined HERE, once, rather than being implicit
// in interview prompt text where it would silently drift.
const COMPLETENESS_WEIGHTS = {
  identity: { ownerName: 1, role: 1, businessName: 1, industry: 1, whatTheyDo: 2, yearsExperience: 1 },
  voice: { formality: 1, directness: 1, warmth: 1, humor: 1, signaturePhrases: 2, avoidPhrases: 2, signoff: 1 },
  expertise: { domains: 2, methodologies: 1, strongOpinions: 2, faq: 3, credentials: 1 },
  decisionStyle: { priorities: 2, tradeoffRules: 2, riskPosture: 1, escalationTriggers: 2 },
  boundaries: { neverSay: 2, neverPromise: 2, requiresHuman: 3, pricingDisclosure: 1 },
};

// ---- Normalisation ----------------------------------------------------------
//
// Field semantics worth knowing, since the normalisers below are mechanical:
//   identity.whatTheyDo     one paragraph in the owner's own words, NOT marketing copy
//   voice.formality         1 (casual) .. 5 (formal); same 1-5 scale for directness and warmth
//   voice.signaturePhrases  things they actually say often — the highest-signal voice field there is
//   voice.avoidPhrases      things they would never say; frequently more diagnostic than the above
//   expertise.strongOpinions  where the owner disagrees with their own field — what makes a clone
//                             sound like a person instead of an industry brochure
//   decisionStyle.priorities  ORDERED, most important first. The ordering IS the signal.
//   boundaries.requiresHuman  topics that route to a person regardless of the clone's confidence

function str(v, cap) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, cap);
}

function strList(v, cap = CAPS.shortText, maxItems = CAPS.listItems) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = str(item, cap);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue; // dedupe — repeated entries cost tokens on every call and add nothing
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function scale(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

function oneOf(v, allowed) {
  const s = String(v || '').trim().toLowerCase();
  return allowed.includes(s) ? s : '';
}

// One normaliser per dimension. Split deliberately: a single normalize() covering all five was a
// 60-line branch pile that no reviewer reads carefully, and the five dimensions genuinely have
// nothing to do with each other. Each returns a fully-populated dimension object.

function normIdentity(i = {}) {
  const yrs = parseInt(i.yearsExperience, 10);
  return {
    ownerName: str(i.ownerName, CAPS.shortText),
    role: str(i.role, CAPS.shortText),
    businessName: str(i.businessName, CAPS.shortText),
    industry: str(i.industry, CAPS.shortText),
    whatTheyDo: str(i.whatTheyDo, CAPS.mediumText),
    yearsExperience: (Number.isFinite(yrs) && yrs >= 0 && yrs <= 80) ? yrs : null,
    location: str(i.location, CAPS.shortText),
  };
}

function normVoice(v = {}) {
  return {
    formality: scale(v.formality),
    directness: scale(v.directness),
    warmth: scale(v.warmth),
    humor: oneOf(v.humor, HUMOR_STYLES),
    sentenceLength: oneOf(v.sentenceLength, SENTENCE_LENGTHS),
    vocabulary: strList(v.vocabulary),
    signaturePhrases: strList(v.signaturePhrases),
    avoidPhrases: strList(v.avoidPhrases),
    greeting: str(v.greeting, CAPS.shortText),
    signoff: str(v.signoff, CAPS.shortText),
  };
}

function normExpertise(e = {}) {
  return {
    domains: strList(e.domains),
    methodologies: strList(e.methodologies),
    credentials: strList(e.credentials),
    strongOpinions: (Array.isArray(e.strongOpinions) ? e.strongOpinions : [])
      .map((o) => ({ claim: str(o && o.claim, CAPS.mediumText), rationale: str(o && o.rationale, CAPS.mediumText) }))
      .filter((o) => o.claim)
      .slice(0, CAPS.opinionItems),
    faq: (Array.isArray(e.faq) ? e.faq : [])
      .map((f) => ({ question: str(f && f.question, CAPS.mediumText), answer: str(f && f.answer, CAPS.longText) }))
      .filter((f) => f.question && f.answer)
      .slice(0, CAPS.faqItems),
  };
}

function normDecisionStyle(d = {}) {
  return {
    priorities: strList(d.priorities, CAPS.mediumText),
    riskPosture: oneOf(d.riskPosture, RISK_POSTURES),
    escalationTriggers: strList(d.escalationTriggers, CAPS.mediumText),
    tradeoffRules: (Array.isArray(d.tradeoffRules) ? d.tradeoffRules : [])
      .map((r) => ({
        when: str(r && r.when, CAPS.mediumText),
        prefer: str(r && r.prefer, CAPS.shortText),
        over: str(r && r.over, CAPS.shortText),
      }))
      .filter((r) => r.when && r.prefer)
      .slice(0, CAPS.tradeoffRules),
  };
}

function normBoundaries(b = {}) {
  return {
    neverSay: strList(b.neverSay, CAPS.mediumText),
    neverPromise: strList(b.neverPromise, CAPS.mediumText),
    requiresHuman: strList(b.requiresHuman, CAPS.mediumText),
    pricingDisclosure: oneOf(b.pricingDisclosure, PRICING_DISCLOSURE),
    competitorPolicy: str(b.competitorPolicy, CAPS.mediumText),
    confidentialTopics: strList(b.confidentialTopics, CAPS.mediumText),
  };
}

/**
 * Coerce arbitrary input into a valid persona. Unknown fields are DROPPED, not preserved — this
 * object is compiled into a prompt, so an unrecognised key is an injection surface, not a feature.
 */
function normalize(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    identity: normIdentity(src.identity || {}),
    voice: normVoice(src.voice || {}),
    expertise: normExpertise(src.expertise || {}),
    decisionStyle: normDecisionStyle(src.decisionStyle || {}),
    boundaries: normBoundaries(src.boundaries || {}),
  };
}

/**
 * A persona with every field present and empty. Defined AS normalize({}) rather than as its own
 * literal so the two can never drift — a field added to a normaliser but forgotten in a duplicated
 * empty-shape literal is exactly the kind of divergence that shows up much later as a field the
 * compiler silently never emits.
 */
function emptyPersona() {
  return normalize({});
}

// ---- Completeness -----------------------------------------------------------

function fieldFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/**
 * Per-dimension completeness (0-100) plus the specific unfilled fields. The interview engine turns
 * `missing` straight into its next questions, which is why this returns field names and not just a
 * score — a bare percentage tells the interviewer nothing about what to ask.
 */
function completeness(persona) {
  const p = normalize(persona);
  const byDimension = {};
  let totalEarned = 0;
  let totalPossible = 0;

  for (const dim of DIMENSIONS) {
    const weights = COMPLETENESS_WEIGHTS[dim];
    let earned = 0;
    let possible = 0;
    const missing = [];
    for (const [field, weight] of Object.entries(weights)) {
      possible += weight;
      if (fieldFilled(p[dim][field])) earned += weight;
      else missing.push(field);
    }
    byDimension[dim] = {
      score: possible ? Math.round((earned / possible) * 100) : 0,
      missing,
    };
    totalEarned += earned;
    totalPossible += possible;
  }

  return {
    overall: totalPossible ? Math.round((totalEarned / totalPossible) * 100) : 0,
    byDimension,
  };
}

// The bar below which a clone must not be allowed to draft anything in someone's name. A persona
// this thin produces generic chatbot output wearing the owner's signature, which is worse than
// obviously-generic output because it is passed off as theirs.
const MIN_USABLE_COMPLETENESS = 60;

/** Boundaries are the safety dimension: usable also requires the owner to have set SOME red lines. */
function isUsable(persona) {
  const c = completeness(persona);
  const p = normalize(persona);
  const reasons = [];
  if (c.overall < MIN_USABLE_COMPLETENESS) {
    reasons.push(`persona is ${c.overall}% complete, needs ${MIN_USABLE_COMPLETENESS}%`);
  }
  if (!p.boundaries.requiresHuman.length) {
    reasons.push('no escalation topics defined — the clone has no situation in which it defers to a human');
  }
  // Named separately rather than as one either/or reason. Now that the company profile supplies
  // whatTheyDo to every clone, the only one of these a person can actually still be missing is their
  // own name — and telling them "the owner name or what the business does" when they have already
  // filled in what the business does reads as the form ignoring them.
  if (!p.identity.ownerName) reasons.push('nobody has said whose clone this is — it needs their name');
  if (!p.identity.whatTheyDo) reasons.push('there is no description of what the business does, and no company profile supplying one');
  return { usable: reasons.length === 0, reasons, completeness: c.overall };
}

// ---- Red lines --------------------------------------------------------------

/** Escape a user-supplied phrase for literal use in a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phrases that constitute a promise regardless of how the owner phrased their neverPromise entry.
// This is a backstop for the common case ("never promise a refund") where the owner names the
// SUBJECT but not the promise language the model might actually emit.
const PROMISE_MARKERS = [
  'i guarantee', 'we guarantee', 'guaranteed', 'i promise', 'we promise',
  'you will definitely', 'there is no risk', 'risk-free', 'i can assure you', 'we can assure you',
];

/**
 * Check drafted output against the persona's boundaries.
 *
 * This runs on the clone's OUTPUT, after generation — deliberately, and in addition to the same
 * boundaries being compiled into the system prompt. Instructing a model not to say something
 * reduces the odds; it does not make it impossible. Anything that leaves in the owner's name gets
 * checked by code as well.
 *
 * Returns violations rather than throwing: the caller decides whether to block the draft, strip it,
 * or surface it to the owner flagged. P3 routes violations to the owner rather than silently
 * discarding work, because a false positive that eats a good draft is its own failure.
 */
/**
 * Literal, word-boundary-anchored containment check for an owner-supplied phrase.
 *
 * Exported because the INBOUND screen in drafts.js asks the same question and must answer it the
 * same way. It did not: it used a plain substring match, so a short topic matched inside unrelated
 * words — a requiresHuman entry of "AI" escalating every message containing "said" or "again". Two
 * matchers for one question, and the loose one ran first and decided whether to escalate.
 */
function mentions(lowerBody, phrase) {
  return new RegExp(`\\b${escapeRe(String(phrase).toLowerCase())}`, 'i').test(String(lowerBody).toLowerCase());
}

/**
 * Who set this limit: the company, or the person themselves.
 *
 * PHRASING ONLY — nothing here decides whether a limit applies, only how a refusal is worded. It
 * exists because "which you asked to handle personally" is simply untrue for an employee reading it:
 * the limit came from the company profile, they never chose it, and telling them they did is both
 * confusing and slightly insulting. Both screens that produce those sentences use this one function
 * so the vocabulary cannot drift between them.
 *
 * Company topics are supplied by the caller (the org profile's boundaries). With none supplied the
 * answer is 'person', which is correct for a one-person business and is the pre-existing behaviour.
 */
function limitSource(topic, companyTopics) {
  const t = String(topic == null ? '' : topic).toLowerCase();
  return (companyTopics || []).some((c) => String(c).toLowerCase() === t) ? 'company' : 'person';
}

/** Simple "phrase appears → this severity" rules, which is most of them. */
function flatRule(lowerBody, phrases, kind, severity) {
  return phrases
    .filter((phrase) => mentions(lowerBody, phrase))
    .map((phrase) => ({ kind, phrase, severity }));
}

/**
 * neverPromise is the one rule that isn't a flat phrase match, because the SUBJECT appearing is
 * not itself wrong. An owner who bans promising refunds still has to be able to discuss refunds.
 * Subject + promise language is a block; subject alone is a flag for human review.
 */
function promiseRule(lowerBody, subjects) {
  const out = [];
  for (const subject of subjects) {
    if (!lowerBody.includes(subject.toLowerCase())) continue;
    const marker = PROMISE_MARKERS.find((m) => lowerBody.includes(m)) || null;
    out.push({
      kind: 'neverPromise',
      phrase: subject,
      severity: marker ? 'block' : 'review',
      matchedMarker: marker,
    });
  }
  return out;
}

function checkRedLines(text, persona) {
  const lower = String(text || '').toLowerCase();
  const b = normalize(persona).boundaries;

  const violations = [
    ...flatRule(lower, b.neverSay, 'neverSay', 'block'),
    ...promiseRule(lower, b.neverPromise),
    ...flatRule(lower, b.confidentialTopics, 'confidential', 'block'),
    ...flatRule(lower, b.requiresHuman, 'requiresHuman', 'escalate'),
  ];

  return {
    violations,
    blocked: violations.some((v) => v.severity === 'block'),
    needsHuman: violations.some((v) => v.severity === 'escalate'),
  };
}

module.exports = {
  CAPS,
  DIMENSIONS,
  COMPLETENESS_WEIGHTS,
  HUMOR_STYLES,
  SENTENCE_LENGTHS,
  RISK_POSTURES,
  PRICING_DISCLOSURE,
  MIN_USABLE_COMPLETENESS,
  mentions,
  limitSource,
  emptyPersona,
  normalize,
  completeness,
  isUsable,
  checkRedLines,
};
