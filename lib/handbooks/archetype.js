// lib/handbooks/archetype.js — what an agent's `archetype:` actually DOES.
//
// P4 of .magent/vault/wiki/agent-handbooks-design.md. P1 put an `archetype:` on all 70 agents and
// nothing read it — a declaration with no consumer, which is the same failure mode as a `gates:` key
// naming an action the registry has never heard of.
//
// An archetype is a MODE OF WORK, orthogonal to which department an agent belongs to. It sets how
// much the platform spends thinking and how hard it checks the result. It does NOT set identity —
// that is the agent's handbook — and it does NOT override the reasoning tier.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULATES A TIER INSTEAD OF REPLACING IT
//
// The obvious design — archetype maps straight to an effort level — is wrong here, and the corpus
// says so plainly. Cross-tabbing the existing EFFORT_ROUTING tiers against the declared archetypes:
//
//     strategic  {builder: 3, maintainer: 1, sweeper: 2}
//
// `reviewer` and `security-auditor` are strategic-tier SWEEPERS. Under "sweeper means cheap" both
// would have been demoted — the agent that grades every other agent's work, and the one that finds
// vulnerabilities. Verification would have got cheaper exactly where it must not, and nothing would
// have failed; the scores would just have quietly got less trustworthy.
//
// So: the tier sets a FLOOR, the archetype shifts within it. A strategic agent cannot be shifted
// below xhigh no matter what mode of work it is doing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Pure: shapes and arithmetic. No I/O, no model calls — the caller owns the filesystem.

'use strict';

const schema = require('./schema');

/**
 * The effort ladder, ascending.
 *
 * `medium` is included because the API supports it and the ledger now prices it. It was missing from
 * COST_RATES until P4, which made the usable ladder three rungs and turned any shift into a cliff:
 * `high` -> `low` is a much bigger drop than a sweeper warrants. Rates are FLAT per model family
 * (effort changes how many tokens are spent thinking, not the price per token), so adding the rung
 * is exact rather than an estimate.
 */
const EFFORT_LADDER = Object.freeze(['low', 'medium', 'high', 'xhigh']);

/**
 * The lowest effort a tier may be shifted to. Only `strategic` has one: those agents are on that tier
 * precisely because their judgement is the thing being bought. Everything else floors at the bottom
 * of the ladder.
 */
const TIER_FLOOR = Object.freeze({ strategic: 'xhigh' });

/**
 * What each archetype does.
 *
 *   effortShift  rungs on EFFORT_LADDER, applied to the tier's effort, floored by TIER_FLOOR
 *   verification 'light' | 'full' — how hard the result is checked
 *   reviewPass   whether an independent adversarial pass runs at all
 *
 * EVERY archetype currently verifies FULL. The depth machinery below is real, wired and tested — but
 * nothing lowers it yet, and that is a deliberate stop rather than an oversight. Two measurements
 * against the real corpus, in order, are why:
 *
 *   1. The first draft made `sweeper` light, arguing its output IS findings and that adversarially
 *      reviewing a review is the circularity §8 warns about. Measuring it: 13 of 19 dispatchable
 *      skills would have dropped to 6 checks with no adversarial pass, including `security-audit`
 *      (lead `safety`) and `seo-audit` (lead `seo-technical`). The circularity claim is true of
 *      `reviewer` grading a review; it does not generalise to an agent that sweeps the outside world
 *      and produces a deliverable a customer reads.
 *
 *   2. Retreating to `prototyper`-only still took 4 skills light, all led by `researcher` or
 *      `research-architect` — including `research-brief`, which on production scored 63 against 16
 *      checks with two hard failures. At light depth (6 checks, lenient 70/50 bands) that same output
 *      would most likely have read as PASS.
 *
 * The second measurement exposes the structural fault, not just a bad value: depth here is set by the
 * LEAD AGENT's archetype, but an archetype describes how an AGENT works, while verification depth
 * should follow what the OUTPUT is worth. `researcher` is tagged prototyper and a cited research
 * brief is a deliverable. Those are different questions and this field cannot answer the second one.
 *
 * So P4 ships the effort modulation, which the corpus supports, and leaves depth uniform. Lowering it
 * needs a signal that belongs to the SKILL, not the agent — the natural home is P5's outcome intake,
 * where stakes are stated with the outcome. Until then, over-verifying is the safe direction to be
 * wrong in: it costs money, where the alternative silently costs trust in every score.
 *
 * builder, grower and maintainer are listed separately rather than collapsed because they are
 * expected to diverge (a maintainer wants regression sensitivity a builder does not), and collapsing
 * them now would make that a schema change instead of a value change.
 */
const ARCHETYPE_ROUTING = Object.freeze({
  prototyper: { effortShift: -1, verification: 'full', reviewPass: true },
  builder:    { effortShift:  0, verification: 'full', reviewPass: true },
  sweeper:    { effortShift: -1, verification: 'full', reviewPass: true },
  grower:     { effortShift:  0, verification: 'full', reviewPass: true },
  maintainer: { effortShift:  0, verification: 'full', reviewPass: true },
});

/** The default when an agent declares no archetype — behave exactly as before P4. */
const DEFAULT_ARCHETYPE = 'builder';

/**
 * Verification depth settings.
 *
 * `maxChecks` bounds the grading bill: every check is its own model call. `adversarial` is the
 * bigger lever — that pass is 3 further calls and, until P4, ran unconditionally on every single
 * verification in the platform.
 */
const DEPTH = Object.freeze({
  light: { maxChecks: 6, adversarial: false, strictness: 'lenient' },
  full: { maxChecks: 16, adversarial: true, strictness: null },   // null = keep the caller's strictness
});

/** Shift an effort level by `delta` rungs, clamped to the ladder and never below `floor`. */
function shiftEffort(effort, delta, floor) {
  const at = EFFORT_LADDER.indexOf(effort);
  if (at === -1) return effort;                       // an effort we do not price — leave it alone
  const moved = Math.min(EFFORT_LADDER.length - 1, Math.max(0, at + (delta || 0)));
  const floorAt = floor ? EFFORT_LADDER.indexOf(floor) : -1;
  return EFFORT_LADDER[floorAt >= 0 ? Math.max(moved, floorAt) : moved];
}

/** Normalise whatever the frontmatter holds — `[sweeper]`, `sweeper`, absent — to a known archetype. */
function archetypeOf(meta) {
  const raw = Array.isArray(meta && meta.archetype) ? meta.archetype[0] : (meta && meta.archetype);
  const name = String(raw || '').trim().toLowerCase();
  return schema.ARCHETYPES.includes(name) ? name : DEFAULT_ARCHETYPE;
}

/** The archetype declared by a handbook's raw text. */
function archetypeFor(content) {
  return archetypeOf(schema.parseFrontmatter(schema.split(content).frontmatter));
}

/** Does this handbook declare any enforced gate? Drives the no-downshift rule in routeFor. */
function holdsGates(content) {
  const meta = schema.parseFrontmatter(schema.split(content).frontmatter);
  return Array.isArray(meta.gates) ? meta.gates.filter(Boolean).length > 0 : !!meta.gates;
}

/**
 * Resolve an agent's routing: the tier's effort, shifted by the archetype, floored by the tier.
 *
 * @param {string} archetype
 * @param {{tier:string, effort:string}} tierRouting  what EFFORT_ROUTING resolved for this agent
 * @returns {{archetype, effort, effortShift, floored, verification, reviewPass}}
 */
function routeArchetype(archetype, tierRouting = {}, opts = {}) {
  const name = schema.ARCHETYPES.includes(archetype) ? archetype : DEFAULT_ARCHETYPE;
  const rule = ARCHETYPE_ROUTING[name];
  const tier = tierRouting.tier || 'professional';
  const base = tierRouting.effort;
  const floor = TIER_FLOOR[tier] || null;

  // An agent that holds an ENFORCED GATE never shifts down. It can take an irreversible, outward-
  // facing action, and the reasoning that decides whether to take it is the thing being bought.
  //
  // Derived from the handbook's own `gates:` rather than an enumerated list of agent names, on
  // purpose: a list protects the members someone remembered to add, and the next agent to be given a
  // gate would silently route cheaper. The category is "can do something irreversible", and that is
  // exactly what `gates:` declares.
  const shift = opts.holdsGates ? Math.max(0, rule.effortShift) : rule.effortShift;
  const effort = base ? shiftEffort(base, shift, floor) : base;
  return {
    archetype: name,
    effort,
    effortShift: shift,
    gateHeld: !!(opts.holdsGates && rule.effortShift < 0),
    // True when the tier floor actually held the effort up — the reviewer/security-auditor case, and
    // worth surfacing so "why is this sweeper still xhigh" has an answer in the data.
    floored: !!(base && rule.effortShift < 0 && effort === base && floor),
    verification: rule.verification,
    reviewPass: rule.reviewPass,
  };
}

/** Depth settings for a verification, given the lead agent's archetype. */
function depthFor(archetype) {
  const name = schema.ARCHETYPES.includes(archetype) ? archetype : DEFAULT_ARCHETYPE;
  return { ...DEPTH[ARCHETYPE_ROUTING[name].verification], depth: ARCHETYPE_ROUTING[name].verification };
}

module.exports = {
  EFFORT_LADDER, DEFAULT_ARCHETYPE, DEPTH,
  shiftEffort, archetypeOf, archetypeFor, holdsGates, routeArchetype, depthFor,
};
