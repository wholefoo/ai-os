// Tests lib/outcomes/intake — an operator states an OUTCOME and never names an agent.
//
// P5 of .magent/vault/wiki/agent-handbooks-design.md, and the end of the arc. Two things here are
// load-bearing and neither is obvious from the module:
//
//   1. `stakes` is the signal P4 could not find. P4 tried to drive verification depth from the lead
//      agent's archetype and measured that 13 of 19 skills would drop to 6 checks with no
//      adversarial pass. Depth follows what the OUTPUT is worth; an archetype says how an AGENT
//      works. This is the second question, asked of the work.
//   2. The orchestrator picks the team FREELY from a roster, so it will eventually name an agent that
//      does not exist. That is the P3 defect recurring at runtime, and the drop-and-record behaviour
//      is what keeps it from reaching executeAgent, which fails hard on an unknown name.
const fs = require('fs');
const path = require('path');
const intake = require('../lib/outcomes/intake');
const archetype = require('../lib/handbooks/archetype');
const { assert, done, serverSource } = require('./test-util');

const GOOD = {
  goal: 'A one-page competitor brief a salesperson can open on a call tomorrow morning.',
  criteria: ['Every claim cites a source retrieved in this run.', 'No competitor appears without its pricing.'],
  guardrails: ['Never state a private company\'s revenue as fact.'],
  stakes: 'standard',
};

// --- the outcome parses and normalises ------------------------------------------------------------
const v = intake.validateOutcome(GOOD);
assert(v.ok, `a stated outcome validates: ${v.errors.join('; ')}`);
assert(v.outcome.criteria.length === 2 && v.outcome.guardrails.length === 1, 'criteria and guardrails are read');
assert(intake.validateOutcome({ ...GOOD, criteria: 'one line\ntwo lines' }).outcome.criteria.length === 2,
  'a newline-separated textarea is accepted — this is a form field, not an API contract');

// --- what BLOCKS ----------------------------------------------------------------------------------
const errs = (o) => intake.validateOutcome(o).errors.join(' | ');
assert(/state the outcome/.test(errs({ ...GOOD, goal: '' })), 'no goal is an error');
assert(/too short to act on/.test(errs({ ...GOOD, goal: 'do seo' })), 'a goal too short to act on is an error');
assert(/at least 2 things/.test(errs({ ...GOOD, criteria: ['only one'] })),
  'fewer than two criteria is an error — without them verification falls back to generic checks');
assert(/unknown stakes "cheap"/.test(errs({ ...GOOD, stakes: 'cheap' })),
  'an unrecognised stakes value is NAMED, not silently defaulted — the same rule P3 settled on for `kind:`');

// --- stakes drive verification depth, and `standard` is the default -------------------------------
assert(intake.STAKES.join() === 'probe,standard,critical', 'the stakes vocabulary is exactly three levels, ordered by what the result is worth');
assert(intake.validateOutcome({ ...GOOD, stakes: '' }).outcome.stakes === 'standard',
  'saying nothing about stakes gets FULL verification — lowering the bar has to be a stated choice');
for (const s of intake.STAKES) {
  assert(['light', 'full'].includes(intake.depthForStakes(s).depth), `every stakes level maps to a real depth (${s})`);
}
const probe = intake.depthForStakes('probe');
const std = intake.depthForStakes('standard');
const crit = intake.depthForStakes('critical');
assert(probe.depth === 'light' && probe.adversarial === false, 'a probe is graded lightly and not adversarially reviewed');
assert(std.depth === 'full' && std.adversarial === true, 'standard work gets the full bar');
assert(crit.depth === 'full' && crit.strictness === 'strict', 'critical work is graded strictly');
assert(std.maxChecks === crit.maxChecks && crit.maxChecks > probe.maxChecks, 'critical differs from standard by STRICTNESS, not by check count');
assert(intake.depthForStakes('nonsense').depth === 'full', 'an unknown stakes value degrades to full, never to light');
assert(intake.validateOutcome({ ...GOOD, stakes: 'probe' }).warnings.some((w) => /do not ship/.test(w)),
  'and choosing probe warns that the result is not shippable');

// The two depth vocabularies must not drift — a skill run resolves depth through archetype, an
// outcome through stakes, and they meet in the same runRealVerification.
assert(std.maxChecks === archetype.DEPTH.full.maxChecks && probe.maxChecks === archetype.DEPTH.light.maxChecks,
  'stakes depth and archetype depth agree on check ceilings — two engines with different budgets would grade the same output differently');

// --- budget is capped, not trusted ----------------------------------------------------------------
const rich = intake.validateOutcome({ ...GOOD, budgetUsd: 100000 });
assert(rich.outcome.budgetUsd === intake.MAX_BUDGET_USD, `a budget over the cap is clamped to $${intake.MAX_BUDGET_USD}`);
assert(rich.warnings.some((w) => /capped/.test(w)), 'and the operator is told it was clamped rather than silently obeyed');
assert(intake.validateOutcome({ ...GOOD, budgetUsd: -5 }).outcome.budgetUsd === null, 'a negative budget is no budget, not a negative one');
assert(intake.validateOutcome({ ...GOOD, goal: 'x'.repeat(9000) }).outcome.goal.length <= intake.MAX_GOAL, 'free text is bounded');

// --- the team the orchestrator picks --------------------------------------------------------------
const known = ['researcher', 'writer', 'reviewer'];
const sel = intake.parseTeamSelection('Here you go:\n{"team":[{"agent":"researcher","why":"evidence"},{"agent":"writer","why":"the brief"}]}', known);
assert(sel.team.length === 2 && sel.team[0].name === 'researcher', 'a JSON team embedded in prose is read');
assert(sel.team[0].why === 'evidence', 'and each member keeps what they own');

const invented = intake.parseTeamSelection('{"team":[{"agent":"researcher","why":"x"},{"agent":"Growth Hacker","why":"y"}]}', known);
assert(invented.team.length === 1 && invented.dropped.join() === 'Growth Hacker',
  'an agent that does not exist is DROPPED and recorded — executeAgent fails hard on an unknown name, which is exactly the P3 defect');
assert(intake.parseTeamSelection('{"team":[{"agent":"researcher"},{"agent":"researcher"}]}', known).team.length === 1,
  'a duplicate is dispatched once, not billed twice');
assert(intake.parseTeamSelection('I think researcher should do it', known).team.length === 0,
  'prose with no JSON yields no team rather than a guess');
assert(intake.parseTeamSelection('', known).team.length === 0, 'and empty input does not throw');
const many = intake.parseTeamSelection(JSON.stringify({ team: known.concat(known).map((n) => ({ agent: n, why: 'x' })) }), known, 2);
assert(many.team.length === 2, 'the team is capped — every member is a parallel model call');

// --- the bounded retry ------------------------------------------------------------------------------
// Team selection is a model call and IS non-deterministic: one live dispatch answered in prose
// instead of JSON and the identical retry succeeded. The bound matters as much as the retry — each
// attempt is a full-roster prompt, so an unbounded loop is an unbounded bill.
assert(intake.MAX_SELECTION_ATTEMPTS >= 2, 'there is at least one retry');
assert(intake.MAX_SELECTION_ATTEMPTS <= 3,
  'and a hard ceiling — if the model cannot produce a parseable team twice, a third attempt is unlikely to differ and the operator is better served seeing the failure than paying for more of it');

const proseRetry = intake.buildRetryTask(GOOD, [{ name: 'researcher', description: 'x' }], { dropped: [] });
const namesRetry = intake.buildRetryTask(GOOD, [{ name: 'researcher', description: 'x' }], { dropped: ['Growth Hacker'] });
assert(/not valid JSON/.test(proseRetry), 'a prose reply is corrected as a SHAPE problem');
assert(/do not exist: Growth Hacker/.test(namesRetry), 'an invented name is quoted back — a different problem needing a different correction');
assert(proseRetry !== namesRetry,
  'the two corrections DIFFER — a blind repeat of the first prompt is the same coin flip, not a retry');
assert(proseRetry.includes('AGENTS AVAILABLE') && namesRetry.includes('AGENTS AVAILABLE'),
  'and each still carries the full ask, so the retry is self-contained rather than relying on conversation history the call does not have');

// --- the server actually wires it -----------------------------------------------------------------
const src = serverSource();
assert(/app\.post\('\/api\/outcomes', requireAdmin, heavyLimiter/.test(src),
  'the intake route exists and is admin-only + rate-limited — it spends real money on arbitrary operator text');
assert(/outcomeIntake\.validateOutcome\(req\.body \|\| \{\}\)/.test(src), 'and refuses an outcome that cannot be run as stated');
assert(/async function runStatedOutcome/.test(src), 'a stated outcome has a runner');
// The task is built before the call now (attempt 1 uses the intake ask, later attempts the
// corrective one), so this pins BOTH halves rather than their adjacency.
assert(/executeAgent\('orchestrator', task/.test(src),
  'which asks the ORCHESTRATOR to choose the team — the operator names no agent, which is the whole point');
assert(/outcomeIntake\.buildIntakeTask\(outcome, roster\)/.test(src),
  'and the first attempt is the plain intake ask');
assert(/outcomeIntake\.parseTeamSelection\(pick\.content, known, skillBrief\.MAX_TEAM\)/.test(src),
  'and the selection is filtered against the REAL roster before anything is dispatched');

// The retry loop is bounded by the module's constant, not by a number typed into the server.
assert(/attempt <= outcomeIntake\.MAX_SELECTION_ATTEMPTS/.test(src),
  'the selection loop is bounded by MAX_SELECTION_ATTEMPTS — a literal here could drift from the constant the tests pin');
assert(/buildRetryTask\(outcome, roster, \{ dropped:/.test(src),
  'and a second attempt uses the CORRECTIVE prompt, not the original');

// The distinction that matters more than the count: a failed CALL is not retryable. Budget
// exhaustion, a provider error or a missing agent will not fix themselves, and retrying them spends
// the money twice before failing anyway.
assert(/if \(!pick\.ok\) throw new Error\(`team selection failed: \$\{pick\.error\}`\);\s*\/\/ not retryable/.test(src),
  'a failed CALL throws immediately and is never retried — only an unreadable REPLY is');
assert(/return runSkillOutcome\(execution, \{/.test(src),
  'then runs through the SAME P3 runner — an outcome and a skill differ only in where the team came from');
assert(/depthOverride: outcomeIntake\.depthForStakes\(outcome\.stakes\)/.test(src), 'with depth set by the stated stakes');
assert(/depthOverride\s*\|\|\s*\(agent \?/.test(src),
  'and startVerification prefers the stated stakes over the archetype default, rather than the other way round');

// The roster must come from the real agent files, not a hand-maintained list that can drift.
assert(/function agentRoster\(\)/.test(src) && /readdirSync\(dir\)\.filter\(\(f\) => f\.endsWith\('\.md'\)\)/.test(src),
  'the roster is read from .claude/agents — a second list would drift from the corpus');

// --- against the real corpus ----------------------------------------------------------------------
const AGENTS = path.join(__dirname, '..', '.claude', 'agents');
const names = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
assert(names.includes('orchestrator'), 'the orchestrator exists — every stated outcome is routed through it');
assert(names.length > 20, `the roster is the real corpus (${names.length} agents)`);
// A selection naming every real agent must still be capped and must keep only real names.
const all = intake.parseTeamSelection(JSON.stringify({ team: names.map((n) => ({ agent: n, why: 'x' })) }), names, 5);
assert(all.team.length === 5 && all.dropped.length === 0, 'a greedy selection over the real roster is capped with nothing dropped');

console.log(`  info: outcomes route to the orchestrator, which picks from ${names.length} real agents; stakes probe/standard/critical set verification depth`);
done();
