// lib/outcomes/intake.js — a first-class OUTCOME an operator can state without naming an agent.
//
// P5 of .magent/vault/wiki/agent-handbooks-design.md, and the end of the arc that started with
// "delete the procedure, keep the standards". P3 made a SKILL an outcome brief; this makes an
// arbitrary request one, so the operator does not have to find a skill that fits either.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS ROUTES TO THE ORCHESTRATOR AND NOT TO A DEPARTMENT
//
// §7 of the design doc says the orchestrator "receives and routes to a department". The corpus does
// not support that today, and pretending otherwise would encode an org chart nobody agreed to.
//
// All 68 handbooks declare a `department:`, but those values are a TAXONOMY, not a team structure:
//   board      reviewer, security-auditor, synthesis, report-compiler, research-architect, mentor
//   product    the seven LLM consultants, plus product-factory and researcher
//   operations bulk workers, plus the `safety` sentinel
//
// And a department LEAD is not derivable: `escalates_to` appears on 27 of 68 agents, four
// departments declare none at all, and the escalation tally names no in-department lead for 5 of 11.
// Engineering is a two-way tie. Inventing the missing leads would put a fabricated org chart in the
// routing path, which is the same class of claim P3 deleted when it found teams of `**Researcher**`
// that resolved to no file.
//
// So an outcome goes to the ORCHESTRATOR, whose stated job is exactly this — interview, decompose,
// design the team, dispatch — and which selects from the real agent corpus. Department routing stays
// available as a later refinement once departments describe teams rather than tags.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Pure: shapes and validation. No I/O, no model calls.

'use strict';

const schema = require('../handbooks/schema');

/**
 * How much the result is worth, which is the ONLY thing permitted to lower verification depth.
 *
 * This field is why P4 shipped its depth machinery unused. P4 tried to drive depth from the lead
 * agent's `archetype:` and measured the consequence: 13 of 19 skills would have dropped to 6 checks
 * with no adversarial pass, including the security audit. The fault was structural — an archetype
 * says how an AGENT works, while depth should follow what the OUTPUT is worth, and those are
 * different questions. `stakes` is the second question, asked of the work rather than the worker.
 *
 *   probe      a throwaway look. Cheap to run, cheap to be wrong, nobody ships it.
 *   standard   the default. Real work, fully verified.
 *   critical   irreversible, outward-facing, or expensive to get wrong. Strictest grading.
 *
 * `standard` is the default on purpose: an operator who says nothing gets full verification, and
 * lowering the bar has to be a stated choice. Defaulting the other way would make silence cheap.
 */
const STAKES = Object.freeze(['probe', 'standard', 'critical']);
const DEFAULT_STAKES = 'standard';

/** stakes -> the verification settings the runner applies. Mirrors lib/handbooks/archetype DEPTH. */
const STAKES_DEPTH = Object.freeze({
  probe: { depth: 'light', maxChecks: 6, adversarial: false, strictness: 'lenient' },
  standard: { depth: 'full', maxChecks: 16, adversarial: true, strictness: 'standard' },
  critical: { depth: 'full', maxChecks: 16, adversarial: true, strictness: 'strict' },
});

/** Minimum criteria for an outcome to be gradeable at all — same bar as a handbook. */
const MIN_CRITERIA = schema.MIN_CRITERIA;

/** Ceilings. A stated outcome is operator input, so every free-text field is bounded. */
const MAX_GOAL = 2000;
const MAX_ITEM = 400;
const MAX_ITEMS = 12;

/** The hard ceiling on what one outcome may spend, whatever it asks for. */
const MAX_BUDGET_USD = 50;

function clean(s, cap) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, cap);
}

function list(v, cap) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split('\n'));
  return arr.map((x) => clean(x, MAX_ITEM)).filter(Boolean).slice(0, cap);
}

/**
 * Normalise whatever the dashboard posted into a canonical outcome.
 *
 * Never throws — an operator typing into a form should get a validation message, not a stack trace.
 */
function parseOutcome(input = {}) {
  const rawStakes = clean(input.stakes, 24).toLowerCase();
  const budget = Number(input.budgetUsd);
  const deadline = clean(input.deadline, 40);
  return {
    goal: clean(input.goal, MAX_GOAL),
    criteria: list(input.criteria, MAX_ITEMS),
    guardrails: list(input.guardrails, MAX_ITEMS),
    // An unrecognised value is KEPT so validate() can name it, rather than silently becoming the
    // default — the same rule P3 settled on for `kind:` after a comment silently made a reference a job.
    stakes: rawStakes || DEFAULT_STAKES,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, MAX_BUDGET_USD) : null,
    budgetCapped: Number.isFinite(budget) && budget > MAX_BUDGET_USD,
    deadline: deadline || null,
  };
}

/**
 * Validate a stated outcome.
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], outcome:object}}
 */
function validateOutcome(input = {}) {
  const outcome = parseOutcome(input);
  const errors = [];
  const warnings = [];

  if (!outcome.goal) errors.push('state the outcome — what must be TRUE when this is done');
  else if (outcome.goal.length < 15) errors.push('the outcome is too short to act on — say what the finished thing must be true of');

  if (outcome.criteria.length < MIN_CRITERIA) {
    errors.push(`give at least ${MIN_CRITERIA} things that must be true of the result — they become the checks it is graded against, and without them it falls back to generic ones`);
  }

  if (!STAKES.includes(outcome.stakes)) {
    errors.push(`unknown stakes "${outcome.stakes}" — must be one of ${STAKES.join(', ')}`);
  }

  if (outcome.budgetCapped) {
    warnings.push(`budget capped at $${MAX_BUDGET_USD} — a single outcome cannot authorise more than that`);
  }
  if (!outcome.guardrails.length) {
    warnings.push('no guardrails stated — the agents\' own handbooks still apply, but anything specific to THIS job needs saying');
  }
  if (outcome.stakes === 'probe') {
    warnings.push('probe stakes: graded lightly and not adversarially reviewed — do not ship this result');
  }

  return { ok: errors.length === 0, errors, warnings, outcome };
}

/** The verification settings an outcome's stakes call for. */
function depthForStakes(stakes) {
  return { ...STAKES_DEPTH[STAKES.includes(stakes) ? stakes : DEFAULT_STAKES] };
}

/**
 * The task text handed to the orchestrator.
 *
 * It receives the outcome and the roster, and chooses the team. Deliberately no procedure and no
 * suggested agents: picking the team is the orchestrator's job, and a hint here would quietly become
 * the routing rule while looking like advice.
 */
function buildIntakeTask(outcome, roster = []) {
  return [
    `OUTCOME: ${outcome.goal}`,
    outcome.criteria.length ? `\nThis will be graded against:\n${outcome.criteria.map((c) => `- ${c}`).join('\n')}` : '',
    outcome.guardrails.length ? `\nHARD LIMITS:\n${outcome.guardrails.map((g) => `- ${g}`).join('\n')}` : '',
    outcome.deadline ? `\nDEADLINE: ${outcome.deadline}` : '',
    `\nSTAKES: ${outcome.stakes}`,
    roster.length ? `\nAGENTS AVAILABLE (name — what they are for):\n${roster.map((r) => `- ${r.name} — ${r.description}`).join('\n')}` : '',
    '\nChoose the smallest team that can deliver this and say why each member is on it.',
    'Reply with ONLY a JSON object: {"team":[{"agent":"<exact name from the list>","why":"<what they own here>"}]}',
    'Every agent name must appear in the list above verbatim. Do not invent one.',
  ].filter(Boolean).join('\n');
}

/**
 * Read the orchestrator's team selection back, keeping only agents that really exist.
 *
 * An unknown name is DROPPED rather than passed through: `executeAgent` fails hard on a name with no
 * file, and P3 found every skill in the corpus had been shipping exactly that kind of unresolvable
 * name for the life of the feature. A model choosing freely will do it too.
 */
function parseTeamSelection(text, knownNames = [], maxTeam = 5) {
  const known = new Set(knownNames);
  const out = [];
  const dropped = [];
  let parsed = null;
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  const team = parsed && Array.isArray(parsed.team) ? parsed.team : [];
  for (const t of team) {
    const name = clean(t && t.agent, 60);
    if (!name) continue;
    if (!known.has(name)) { dropped.push(name); continue; }
    if (out.some((x) => x.name === name)) continue;
    out.push({ name, why: clean(t.why, MAX_ITEM) });
    if (out.length >= maxTeam) break;
  }
  return { team: out, dropped, parsed: !!parsed };
}

/**
 * How many times to ASK for a team before giving up. 2 = one retry.
 *
 * The failure this exists for is a FORMAT failure — the orchestrator answering in prose instead of
 * the requested JSON, observed once in three live attempts. That is worth one more ask. It is not
 * worth a loop: if the model cannot produce a parseable team twice, a third attempt is unlikely to
 * differ and the operator is better served by seeing the failure than by paying for more of it.
 * Each attempt is a full-roster prompt, so the ceiling is a real bill, not a formality.
 */
const MAX_SELECTION_ATTEMPTS = 2;

/**
 * The follow-up ask, after a reply that yielded no usable team.
 *
 * Deliberately NOT a repeat of the first prompt. A blind retry is the same coin flip; this one names
 * what went wrong so the second attempt differs from the first in the way that matters. The two
 * failure modes need different corrections and are distinguished here:
 *   - replied in prose      -> the shape was wrong
 *   - named unknown agents  -> the names were wrong, and they are quoted back
 */
function buildRetryTask(outcome, roster, previous = {}) {
  const dropped = (previous.dropped || []).filter(Boolean);
  const problem = dropped.length
    ? `Your previous reply named ${dropped.length} agent(s) that do not exist: ${dropped.join(', ')}. Every name must be copied EXACTLY from the list.`
    : 'Your previous reply was not valid JSON, so no team could be read from it. Reply with the JSON object and nothing else — no preamble, no explanation, no code fence.';
  return `${problem}\n\n${buildIntakeTask(outcome, roster)}`;
}

module.exports = {
  STAKES, MAX_BUDGET_USD, MAX_GOAL, MAX_SELECTION_ATTEMPTS,
  validateOutcome, depthForStakes, buildIntakeTask, buildRetryTask, parseTeamSelection,
};
