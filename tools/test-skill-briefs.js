// Tests lib/skills/brief — a skill stated as an OUTCOME BRIEF rather than a `## Process`.
//
// P3 of .magent/vault/wiki/agent-handbooks-design.md. The step-runner executed a skill's numbered
// steps one model call at a time; this replaces that with a goal, the criteria the result is graded
// against, and a team of real agents.
//
// The corpus assertions at the bottom are the ones that matter. Two defects that lived in the skill
// files for the life of the feature were both invisible to any unit test and both caught by walking
// the real directory: team names that resolve to no agent file, and a `## Process` left beside a
// brief so nothing states which one governs.
const fs = require('fs');
const path = require('path');
const brief = require('../lib/skills/brief');
const schema = require('../lib/handbooks/schema');
const { assert, done, serverSource } = require('./test-util');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills');
const agentNames = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

const GOOD = [
  '---', 'name: fixture', 'category: research', '---', '',
  '# Fixture', '',
  '## Goal', 'A reader can act on the result the same day.', '',
  '## What good looks like',
  '- Every claim carries a source or is labelled an assumption.',
  '- No section is left empty.', '',
  '## Guardrails',
  '- Never present an estimate as a measurement.', '',
  '## Team',
  '- **researcher** — gathers and verifies the external evidence',
  '- **writer** — turns the evidence into the deliverable', '',
  '## Output',
  '- `.magent/artifacts/docs/fixture.md` — the report',
].join('\n');

// --- parsing ------------------------------------------------------------------------------------
const b = brief.parseBrief(GOOD);
assert(b.goal === 'A reader can act on the result the same day.', 'the goal is the prose under `## Goal`');
assert(b.criteria.length === 2, 'criteria come from the shared `What good looks like` heading');
assert(b.guardrails.length === 1 && b.hasGuardrailsSection, 'guardrails are read and their section presence is recorded separately');
assert(b.team.length === 2 && b.team[0].name === 'researcher', 'team members parse to bare agent slugs');
assert(b.team[0].why === 'gathers and verifies the external evidence', 'and carry what they own in THIS job');
assert(b.lead === 'researcher', 'the lead is the first member — the one the deliverable is attributed to');
assert(b.outputs.length === 1, 'outputs are read');
assert(b.retired.length === 0, 'a converted brief has no retired sections');

// A skill brief and an agent handbook use the SAME criteria heading, so one rubric engine reads both.
// If these two ever drift apart, skill criteria stop becoming verification checks and nothing errors.
assert(brief.BRIEF_SECTION.criteria === schema.SECTION.criteria,
  'skill briefs and handbooks share the criteria heading — the rubric engine has one parser, not two');

// --- validation ---------------------------------------------------------------------------------
const ok = brief.validateBrief(GOOD, { agentNames });
assert(ok.ok, `the fixture validates: ${ok.errors.join('; ')}`);

function errs(mut) { return brief.validateBrief(mut, { agentNames }).errors.join(' | '); }

assert(/no `## Goal`/.test(errs(GOOD.replace('## Goal', '## Objective'))), 'a brief with no goal is an error');
assert(/only 1 criteria/.test(errs(GOOD.replace('- No section is left empty.\n', ''))),
  'fewer than MIN_CRITERIA is an error — verification would silently fall back to generic checks');
assert(/no `## Team`/.test(errs(GOOD.replace('## Team', '## Cast'))),
  'no team is an error — the runner would fall back to a generic writer, which is the defect P3 fixes');

// The two real corpus defects, as unit cases.
assert(/not a valid agent name/.test(errs(GOOD.replace('**researcher**', '**Researcher**'))),
  'a CAPITALISED name is an error — .claude/agents/Researcher.md resolves on Windows and not on the Linux VPS');
assert(/not a valid agent name/.test(errs(GOOD.replace('**researcher**', '**Browser Agent**'))),
  'a name with a space is an error — that is prose, and no file is named that');
assert(/is not a real agent/.test(errs(GOOD.replace('**researcher**', '**nonexistent-agent**'))),
  'a well-formed name with no file is an error — executeAgent fails hard on an unknown name');
assert(/listed twice/.test(errs(GOOD.replace('**writer**', '**researcher**'))),
  'a duplicated member would be dispatched twice and billed twice');
assert(/retired step-runner shape/.test(errs(GOOD + '\n\n## Process\n1. **Do a thing** — details')),
  'a leftover `## Process` is an error — two shapes in one file and nothing says which governs');
assert(/retired step-runner shape/.test(errs(GOOD + '\n\n## Agents Used\n- **researcher**: x')),
  'so is a leftover `## Agents Used` — that heading is the one the old parser read');

const big = GOOD.replace('- **writer** — turns the evidence into the deliverable',
  agentNames.slice(0, brief.MAX_TEAM + 1).map((n) => `- **${n}** — x`).join('\n'));
assert(/exceeds MAX_TEAM/.test(errs(big)), 'an oversized team is an error — every member is a parallel model call');

// Warnings do not block.
const noGuard = brief.validateBrief(GOOD.replace('## Guardrails', '## Notes'), { agentNames });
assert(noGuard.ok && noGuard.warnings.some((w) => /Guardrails/.test(w)),
  'a missing Guardrails section warns but does not block — an omission is worth flagging, not refusing');
const proc = brief.validateBrief(GOOD.replace('- No section is left empty.', '- Research the competitors and write it up.'), { agentNames });
assert(proc.warnings.some((w) => /reads as a step/.test(w)), 'a criterion written as a step is linted');

// --- the task handed to an agent ----------------------------------------------------------------
const task = brief.buildTask(b, { role: b.team[0].why, params: { url: 'example.com' }, skillName: 'fixture' });
assert(task.includes('A reader can act on the result the same day.'), 'the task carries the outcome');
assert(task.includes('Every claim carries a source'), 'and the FULL criteria text — the agent sees what it will be graded on');
assert(task.includes('gathers and verifies the external evidence'), 'and this member\'s own part, so a fan-out does not produce N copies of one answer');
assert(task.includes('example.com'), 'and the inputs');
assert(task.includes('Never present an estimate as a measurement.'), 'and the guardrails');
assert(!/step|Step \d/.test(task.replace(/not a plan/, '')), 'and no procedure — that is the whole point');

// --- the real corpus ----------------------------------------------------------------------------
// Every skill file must be a valid brief. A skill that fails here cannot be dispatched at all under
// the new runner, which is deliberate: the old runner "succeeded" by silently routing everything to
// a generic writer, and that is the failure this phase exists to make impossible.
const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));
const bad = [];
const jobs = [];
const refs = [];
let teamSlots = 0;
for (const f of files) {
  const content = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
  const v = brief.validateBrief(content, { agentNames });
  if (!v.ok) bad.push(`${f}: ${v.errors.join('; ')}`);
  (v.brief.dispatchable ? jobs : refs).push(f);
  teamSlots += v.brief.team.length;
}
assert(bad.length === 0, `every skill is a valid outcome brief\n    ${bad.join('\n    ')}`);
assert(jobs.length > 0 && refs.length > 0,
  'the corpus holds both kinds — if every file were a job the reference kind would be untested, and if every file were a reference nothing would dispatch');

// The retired shape is gone from every DISPATCHABLE skill, not merely unused. The DoD is explicit:
// an unused `## Process` in a job is a procedure a reader will still follow. A reference keeps its
// procedure on purpose — it is aimed at a person, and a person needs the steps.
const leftovers = jobs.filter((f) => brief.parseBrief(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')).retired.length);
assert(leftovers.length === 0, `no dispatchable skill retains a retired section — found in: ${leftovers.join(', ')}`);
assert(refs.some((f) => brief.parseBrief(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')).retired.includes('Process')),
  'at least one reference DOES keep a `## Process` — proving the exemption is real and not just unexercised');

// A reference must be refused by the execute route rather than dispatched to nobody.
const srcRoute = serverSource();
assert(/if \(!v\.brief\.dispatchable\)/.test(srcRoute), 'the execute route refuses a reference before spending a token');
assert(/skillBrief\.validateBrief\(content, \{ agentNames \}\)/.test(srcRoute),
  'and validates the brief against the REAL agent files first — the check that would have caught the unresolvable team names');

// The runner must pass the execution under the key startVerification destructures (`exec`). Getting
// this wrong graded the output correctly and attached the verdict to nothing, so a completed skill
// showed no result — a defect no unit test saw and only a live run did.
assert(/startVerification\(\{[\s\S]{0,600}?\n\s*exec: execution,/.test(srcRoute),
  'the runner links the verdict back onto the execution by passing `exec:`, not `execution:`');
assert(/skillCriteria: brief\.criteria/.test(srcRoute),
  'and hands over the brief\'s own criteria, so the run is graded on what the agent was told it would be graded on');

// And the server no longer carries the machinery that read it.
const src = serverSource();
assert(!/function parseSkillSteps/.test(src), 'parseSkillSteps is deleted — the step parser is gone, not orphaned');
assert(!/function runSkillExecution/.test(src), 'runSkillExecution is deleted');
assert(/function runSkillOutcome/.test(src), 'and replaced by the outcome runner');

console.log(`  info: ${jobs.length} dispatchable skills across ${teamSlots} named agent slots; ${refs.length} references (${refs.join(', ')})`);
done();
