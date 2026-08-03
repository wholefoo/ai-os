// Tests lib/handbooks/rubric — turning a handbook's criteria into verification checks.
//
// P2 of .magent/vault/wiki/agent-handbooks-design.md. Verification used to grade against six generic
// SKILL-CATEGORY buckets, so a pass told you the output was "actionable" and "well formatted"
// without ever asking whether THIS agent did ITS job. It also keyed on a skill, which P3 removes as
// an execution unit — a category-keyed rubric would lose its key entirely.
const fs = require('fs');
const path = require('path');
const rubric = require('../lib/handbooks/rubric');
const schema = require('../lib/handbooks/schema');
const { assert, done, serverSource } = require('./test-util');

const HB = [
  '---', 'name: fixture', 'description: d', 'rubric: research', '---', '',
  'OUTCOME: something checkable.', '',
  '## What good looks like',
  '- Every claim carries a source or is labelled an assumption.',
  '- No section is left empty.',
  '- A number reported was computed, never estimated.',
].join('\n');

// --- criteria become checks the grader can use ---------------------------------------------------
const checks = rubric.checksFromHandbook(HB);
assert(checks.length === 3, 'each criterion becomes one check');
assert(checks[0].description === 'Every claim carries a source or is labelled an assumption.',
  'the check carries the FULL criterion text — that is what the grader is asked to judge against');
assert(checks[0].name && checks[0].name.length <= 72, 'and a short label for display');
assert(checks.every((c) => c.source === 'handbook'), 'every check knows where it came from');
assert(checks.every((c) => c.weight === rubric.HANDBOOK_WEIGHT), 'all handbook criteria carry the same weight');
assert(rubric.HANDBOOK_WEIGHT >= 3,
  'handbook criteria outweigh generic checks — an agent-specific standard must not be outvoted on volume by "formatting"');

// The label is what a person scanning a failed report sees first, so it has to carry the SUBJECT of
// the criterion — which lives in its first clause, before the explanation of why it matters.
assert(rubric.shortLabel('Every claim carries a source. Otherwise it is an assumption.') === 'Every claim carries a source',
  'the label is the first clause — where the subject is');
assert(rubric.shortLabel('No section is left empty') === 'No section is left empty', 'a single-clause criterion is its own label');
assert(rubric.shortLabel('x'.repeat(200)).length <= 72, 'and it is bounded for display');
assert(rubric.shortLabel('x'.repeat(200)).endsWith('…'), 'with an ellipsis when truncated, so nobody reads it as the whole criterion');
assert(rubric.shortLabel('Short. Tail.') === 'Short. Tail.',
  'a very short first clause does NOT become the label — "Short" tells a reader nothing, so the whole line is kept instead');
assert(rubric.shortLabel('') === '' && rubric.shortLabel(null) === '', 'and empty input does not throw');

assert(rubric.checksFromHandbook('---\nname: x\n---\n\nno criteria here').length === 0,
  'a handbook with no criteria section yields no checks, so the caller can fall back rather than grade against nothing');

// --- ids are stable across runs and tied to the TEXT ----------------------------------------------
// This is what makes §9 item 14 answerable: criteria and Gotchas overlap in many handbooks, nobody
// knows which formulation a model acts on, and the way to settle it is to watch which criteria ever
// actually fail. That needs an id that survives between runs.
assert(rubric.criterionId('abc') === rubric.criterionId('abc'), 'the same text always gets the same id');
assert(rubric.criterionId('abc') !== rubric.criterionId('abd'), 'different text gets a different id');
const reordered = rubric.checksFromHandbook(HB.replace(
  '- Every claim carries a source or is labelled an assumption.\n- No section is left empty.',
  '- No section is left empty.\n- Every claim carries a source or is labelled an assumption.'));
assert(reordered.map((c) => c.id).sort().join() === checks.map((c) => c.id).sort().join(),
  'REORDERING a list does not renumber its criteria — history follows the criterion, not its position');
const edited = rubric.checksFromHandbook(HB.replace('No section is left empty.', 'No section is left empty, ever.'));
assert(!edited.map((c) => c.id).includes(checks[1].id),
  'EDITING a criterion gives it a new id — an edited criterion is a different claim and its old history no longer applies');

// --- the floor the handbook names -----------------------------------------------------------------
assert(rubric.floorNameFor(HB) === 'research', 'the floor comes from the handbook\'s own `rubric:` key');
assert(rubric.floorNameFor('---\nname: x\n---\nbody') === 'default', 'and defaults when unstated');

// --- merging: handbook over floor -----------------------------------------------------------------
const floor = {
  name: 'Research Quality', category: 'research',
  checks: [
    { id: 'completeness', name: 'Completeness', description: 'All sections present', weight: 3 },
    { id: 'source_count', name: 'Minimum Sources', description: 'At least 5 sources', weight: 3 },
  ],
};
const merged = rubric.mergeRubric(checks, floor, { agent: 'researcher' });
assert(merged.checks.length === 5, 'handbook checks and floor checks are both present');
assert(merged.checks.slice(0, 3).every((c) => c.source === 'handbook'),
  'handbook checks come FIRST — a grader reading in order meets the specific standards before the generic ones');
assert(merged.handbookCheckCount === 3 && merged.floorCheckCount === 2,
  'the split is reported, so a report can say what it was actually graded against');
assert(merged.agent === 'researcher', 'and which agent it belongs to');
assert(merged.category === 'research', 'the floor category is carried through');

// A floor check with the same id as a handbook check is DROPPED, not graded twice — otherwise the
// same standard counts twice in the weighted aggregate without anyone choosing that.
const collide = rubric.mergeRubric(
  [{ id: 'completeness', name: 'Mine', description: 'my version', weight: 3, source: 'handbook' }], floor, {});
assert(collide.checks.filter((c) => c.id === 'completeness').length === 1, 'a duplicate id is not graded twice');
assert(collide.checks[0].description === 'my version', 'and the HANDBOOK version wins — it says the same thing more specifically');

// Merging with no floor at all must still produce a usable rubric.
const noFloor = rubric.mergeRubric(checks, null, { agent: 'x' });
assert(noFloor.checks.length === 3 && noFloor.category === 'default', 'a missing floor degrades to the handbook alone');

// --- the ceiling ----------------------------------------------------------------------------------
// Each check is a separate grading model call, so an unbounded list is an unbounded bill.
const many = ['---', 'name: x', '---', '', '## What good looks like',
  ...Array.from({ length: 30 }, (_, i) => `- Criterion number ${i} holds.`)].join('\n');
assert(rubric.checksFromHandbook(many).length === rubric.MAX_HANDBOOK_CHECKS,
  `no more than ${rubric.MAX_HANDBOOK_CHECKS} checks — each one is a separate model call`);

// --- against the REAL corpus ----------------------------------------------------------------------
// Every agent must produce a usable rubric. An agent whose criteria yield zero checks would fall
// back to a generic bucket silently, which is the state P2 exists to end.
const dir = path.join(__dirname, '..', '.claude', 'agents');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
const empty = [];
let totalChecks = 0;
for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  const c = rubric.checksFromHandbook(content);
  totalChecks += c.length;
  if (!c.length) empty.push(f);
  const name = rubric.floorNameFor(content);
  assert(typeof name === 'string' && name.length > 0, `${f} names a floor rubric`);
}
assert(empty.length === 0, `every agent yields at least one check${empty.length ? ` — empty: ${empty.join(', ')}` : ''}`);

// Every floor a handbook names must EXIST in the rubric file, or verification silently falls back to
// default and the agent is graded against a bar nobody chose. Same discipline as `gates:`.
const rubricsYaml = fs.readFileSync(path.join(__dirname, '..', '.claude', 'rules', 'verification-rubrics.yaml'), 'utf8');
const rubricKeys = rubricsYaml.split('\n').filter((l) => /^[a-z_-]+:\s*$/.test(l)).map((l) => l.replace(':', '').trim());
for (const f of files) {
  const name = rubric.floorNameFor(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert(rubricKeys.includes(name), `${f} names a floor rubric that exists in verification-rubrics.yaml (got "${name}")`);
}

// --- the server actually uses it -------------------------------------------------------------------
// The module can be perfect while the route keeps grading by category. That gap IS the phase.
const src = serverSource();
assert(/function getRubricForAgent\(/.test(src), 'server.js resolves a rubric for an agent');
// P3 moved this out of the route into startVerification, which the skill runner also calls, and added
// a third layer on top: a SKILL brief's own criteria. The precedence to protect is unchanged —
// most-specific first, never an empty check list, which would score 0 and read as a total failure.
assert(/getRubricForAgent\(agent\) \|\| getRubricForCategory\(category\)/.test(src),
  'verification PREFERS the agent handbook and falls back to the category — never to an empty check list');
assert(/getRubricForSkillRun\(skillCriteria, agent\)/.test(src),
  'and a skill run layers the brief\'s own criteria on top of that');
assert(/function getRubricForSkillRun/.test(src) && /getRubricForAgent\(agentName\) \|\| getRubricForCategory\('default'\)/.test(src),
  'whose floor is itself the agent-then-category chain, so the three levels compose rather than replace each other');
assert(/agent: rubric\.agent \|\| agent \|\| null/.test(src) && /handbookChecks: rubric\.handbookCheckCount/.test(src),
  'the report records which standard it was graded against — "scored 72" is unreadable without it');
// P3 added the `|| agent` arm: when a SKILL brief's criteria are the top layer, mergeRubric names the
// rubric after the agent it was built for, but a run graded on a floor-only rubric still has a lead
// agent worth recording. Without it the report would say the standard belonged to nobody.

console.log(`  info: ${totalChecks} criteria across ${files.length} handbooks are now gradeable checks`);
done();
