// Validates every agent handbook in .claude/agents against lib/handbooks/schema.js.
//
// P0 of .magent/vault/wiki/agent-handbooks-design.md. The direction: agents pursue OUTCOMES against
// STANDARDS, rather than executing procedures. A procedure says which button to press next; a
// standard says what good looks like and what is out of bounds. Only the first rots when the model
// improves.
//
// This suite is the thing that keeps a handbook honest. Two claims a handbook makes are checkable
// from outside, and both are checked here:
//
//   1. Its `gates:` name actions the server ACTUALLY refuses. A guardrail written only as prose is
//      a suggestion to a language model — this codebase learned that the expensive way, which is
//      why clone boundaries are enforced in code and why gateAction exists. A gate id that is not
//      in the approval registry reads like enforcement in review and enforces nothing at runtime,
//      which is strictly worse than promising nothing.
//   2. Its body fits the token budget. The body is the system prompt on EVERY call that agent
//      makes, so a line added is paid for on every future call, forever.
//
// The corpus is mid-migration by design (P1 converts the rest), so an UNCONVERTED agent is not a
// failure here. What is a failure is a handbook that claims a standard and does not have one, or
// that lies about a gate.
const fs = require('fs');
const path = require('path');
const schema = require('../lib/handbooks/schema');
const approval = require('../lib/safety/approval');
const { assert, done } = require('./test-util');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const RUBRICS = path.join(__dirname, '..', '.claude', 'rules', 'verification-rubrics.yaml');

// --- the parsing primitives ----------------------------------------------------------------------
// Tested directly because every judgement below rests on them: a bug in sectionBullets does not
// throw, it silently reports zero criteria for a handbook that has ten, and the corpus check goes
// green while checking nothing.

assert(schema.ARCHETYPES.length === 5 && schema.ARCHETYPES.includes('sweeper'),
  'the five archetypes are the source doc\'s: prototyper, builder, sweeper, grower, maintainer');
assert(schema.MIN_CRITERIA >= 2, 'a standard needs more than one criterion to be a standard');
assert(schema.SECTION.criteria === 'What good looks like', 'the criteria heading is fixed in one place');

const fm = schema.split('---\nname: x\ntags: [a, b]\n---\n\nBODY LINE\n');
assert(fm.hasFrontmatter && fm.body === 'BODY LINE', 'split separates frontmatter from body');
assert(schema.split('no frontmatter').hasFrontmatter === false, 'and reports its absence rather than guessing');

const meta = schema.parseFrontmatter('name: x\narchetype: [builder, grower]\nrubric: default\n# a comment\nempty:');
assert(meta.name === 'x' && meta.rubric === 'default', 'scalar keys parse');
assert(Array.isArray(meta.archetype) && meta.archetype.length === 2, 'list keys parse into arrays');
assert(meta.empty === '', 'a valueless key is empty, not undefined — so a blank `name:` still fails validation');
assert(schema.parseFrontmatter('description: Use when X; do NOT use for Y: see Z').description === 'Use when X; do NOT use for Y: see Z',
  'a value containing colons survives — every agent description in this corpus has them');

// An empty list's trailing comment is the most valuable part of it: it records that the question
// was CONSIDERED. So lists tolerate one, while scalars keep every character.
const commented = schema.parseFrontmatter('gates: []   # nothing irreversible here\ntags: [a, b]  # two');
assert(Array.isArray(commented.gates) && commented.gates.length === 0, 'an empty list with a trailing comment parses as empty');
assert(commented.tags.length === 2 && commented.tags[1] === 'b', 'a populated list ignores its trailing comment');
assert(schema.parseFrontmatter('color: #ef4444').color === '#ef4444',
  'a scalar keeps its # — stripping comments everywhere would eat colours and "#1" in descriptions');

const bullets = schema.sectionBullets('## A\n- one\n* two\n\n## B\n- three\n', 'A');
assert(bullets.length === 2 && bullets[0] === 'one', 'bullets are collected under their own heading only');
assert(schema.sectionBullets('## A\n- one\n', 'Missing').length === 0, 'an absent section is empty, not an error');
assert(schema.sectionBullets('## what good looks like\n- x\n- y\n', 'What good looks like').length === 2,
  'heading match is case-insensitive — a handbook should not fail on capitalisation');

// --- the module's own rules, on fixtures ---------------------------------------------------------
// Exercised on hand-written content rather than only on the corpus, so the validator is proven to
// FAIL when it should. A validator only ever run against valid input is an untested validator.

const gateIds = Object.keys(approval.ACTION_RISK);
assert(gateIds.length > 0, 'the approval registry exports its action ids for validation');
assert(Object.isFrozen(approval.ACTION_RISK), 'and exports them frozen — a registry, not a scratchpad');

const rubricKeys = fs.readFileSync(RUBRICS, 'utf8')
  .split('\n').filter((l) => /^[a-z_-]+:\s*$/.test(l)).map((l) => l.replace(':', '').trim());
assert(rubricKeys.includes('default'), `rubric keys were parsed (got: ${rubricKeys.join(', ')})`);

const ctx = { gateIds, rubricKeys };
const good = [
  '---',
  'name: fixture',
  'description: A fixture agent.',
  'archetype: [builder]',
  `gates: [${gateIds[0]}]`,
  'rubric: default',
  '---',
  'ROLE: fixture',
  'OUTCOME: something a person can check.',
  '',
  '## What good looks like',
  '- Every claim carries a source or is labelled an assumption.',
  '- No section is left empty.',
  '',
  '## Never without asking',
  '- Tearing down a live site.',
].join('\n');

assert(schema.validate(good, ctx).ok, 'a well-formed handbook validates');

const bad = (mutate) => schema.validate(mutate(good), ctx);

// A gate that does not exist — THE assertion this whole file is built around.
const fakeGate = bad((s) => s.replace(gateIds[0], 'content.publish'));
assert(!fakeGate.ok && fakeGate.errors.some((e) => /approval registry/.test(e)),
  'a gate id absent from ACTION_RISK is a BLOCKING error — a handbook cannot promise a guardrail the server does not enforce');

// This is not hypothetical: `content.publish` and `email.send` are exactly what the design doc's
// own example used before the ids were checked against the code. The validator caught the design.
assert(!gateIds.includes('content.publish') && !gateIds.includes('email.send'),
  'the ids the design doc first guessed are indeed not real — kept as a standing reminder that prose about code drifts from code');

// An explicit `gates: []` is a DECISION ("nothing this agent does is irreversible"); an absent
// `gates:` key is an OMISSION (nobody looked). They must not read the same, or a corpus of 68
// unconsidered agents reports as fully guard-railed. The coverage report caught exactly this: the
// reference agent writes design docs and has nothing to gate, and forcing a guardrail onto it would
// have been the decorative promise this schema exists to prevent.
const declared = schema.validate(good.replace(`gates: [${gateIds[0]}]`, 'gates: []'), ctx);
assert(declared.ok && declared.meta.declaresGates && declared.meta.gates.length === 0,
  'an empty `gates: []` is a recorded decision, not an absence');
assert(declared.meta.keys[3], '...and it satisfies key 3 — guardrails were considered');
const omitted = schema.validate(good.replace(`gates: [${gateIds[0]}]\n`, ''), ctx);
assert(!omitted.meta.declaresGates, 'an absent `gates:` key is an omission');

const badArch = bad((s) => s.replace('[builder]', '[wizard]'));
assert(!badArch.ok && badArch.errors.some((e) => /unknown archetype/.test(e)), 'an unknown archetype is refused');

const badRubric = bad((s) => s.replace('rubric: default', 'rubric: nonexistent'));
assert(!badRubric.ok && badRubric.errors.some((e) => /verification-rubrics/.test(e)), 'an unknown rubric key is refused');

// --- key 5: shared business memory ------------------------------------------------------------------
// Same discipline as `gates:` — a source that does not exist reads in review as grounding the agent
// does not have.
const withMemory = good.replace('rubric: default', 'rubric: default\nmemory: [org-profile, canonical-facts]');
assert(schema.validate(withMemory, ctx).ok, 'a handbook may declare the shared memory it works from');
const badMemory = schema.validate(good.replace('rubric: default', 'rubric: default\nmemory: [everything]'), ctx);
assert(!badMemory.ok && badMemory.errors.some((e) => /memory source/.test(e)), 'an invented memory source is refused');

// The library stores come FROM the catalog, so a store renamed there cannot leave a stale
// vocabulary here. Asserted against the real module rather than a copied list.
const catalog = require('../lib/library/catalog');
for (const store of catalog.VALID_STORES) {
  assert(schema.MEMORY_SOURCES.includes(`library:${store}`),
    `library:${store} is a declarable memory source, derived from catalog.VALID_STORES rather than restated`);
}

// The safety property that makes this field honest: it is a DECLARATION, not a grant. Nothing in
// this module widens read access — the catalog's `readers` allowlist decides that, in code, at read
// time. If validate() ever starts returning something that looks like an access decision, this
// assertion is the place that should have stopped it.
const memResult = schema.validate(withMemory, ctx);
assert(!('allowed' in memResult) && !('access' in memResult) && Array.isArray(memResult.meta.memory),
  'validate() reports declared memory and makes NO access decision — a handbook cannot widen its own reads');

const thin = bad((s) => s.replace('- No section is left empty.\n', ''));
assert(!thin.ok && thin.errors.some((e) => /at least/.test(e)),
  'a "What good looks like" section with one criterion is refused — a standard of one is decoration');

const noFm = schema.validate('ROLE: no frontmatter here', ctx);
assert(!noFm.ok && noFm.errors.some((e) => /frontmatter/.test(e)),
  'a file with no frontmatter is refused — loadAgentPrompt would send the header as part of the prompt');

const fat = bad((s) => s + '\n' + Array.from({ length: schema.MAX_BODY_LINES + 5 }, () => '- filler').join('\n'));
assert(!fat.ok && fat.errors.some((e) => /budget/.test(e)),
  'an over-budget body is refused — the handbook is the system prompt on every call this agent makes');

// Procedural criteria WARN rather than block: the heuristic reads wording, not meaning, so it must
// not be able to fail a build on a false positive.
const proc = schema.validate(good.replace('- No section is left empty.', '- Research the competitors, then write a summary.'), ctx);
assert(proc.ok, 'a procedural-sounding criterion does not BLOCK — the check reads wording, not meaning');
assert(proc.warnings.some((w) => /procedure/.test(w)), '...but it does warn, because that is how a procedure sneaks back in');
assert(schema.looksProcedural('1. Run the audit') && !schema.looksProcedural('Every claim carries a source'),
  'the heuristic separates a numbered step from a standard');

// A guardrail section with no declared gate is the decorative case the design exists to prevent.
const decorative = schema.validate(good.replace(`gates: [${gateIds[0]}]\n`, ''), ctx);
assert(decorative.ok && decorative.warnings.some((w) => /nothing enforces/.test(w)),
  'guardrail prose with no `gates:` warns that nothing enforces it');

// --- the real corpus ------------------------------------------------------------------------------
const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
assert(files.length > 0, 'the agent corpus was found');

const results = files.map((f) => ({ file: f, r: schema.validate(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'), ctx) }));
const broken = results.filter((x) => !x.r.ok);
assert(broken.length === 0,
  `every handbook in the corpus validates${broken.length ? ` — failing: ${broken.map((b) => `${b.file}: ${b.r.errors[0]}`).join(' | ')}` : ''}`);

// --- the reference conversion ----------------------------------------------------------------------
const architect = results.find((x) => x.file === 'architect.md');
assert(architect && architect.r.meta.converted, 'architect is converted to the handbook shape (the P0 reference)');
assert(architect.r.meta.criteria >= 5, `architect states a real standard (${architect.r.meta.criteria} criteria)`);
assert(architect.r.meta.archetypes.includes('builder'), 'and carries an archetype');
assert(architect.r.meta.gotchas >= 6,
  `its hard-won Gotchas SURVIVED conversion (${architect.r.meta.gotchas}) — the whole risk of this migration is scar tissue being discarded as "procedure"`);
assert(architect.r.warnings.length === 0, `and it produces no warnings${architect.r.warnings.length ? `: ${architect.r.warnings.join(' | ')}` : ''}`);

// The reference must cover all five keys of the source document, or it is not a reference.
const KEY_NAMES = {
  1: 'the specific outcome', 2: 'criteria for success', 3: 'guardrails',
  4: 'access to tools and files', 5: 'shared business memory',
};
for (const [n, label] of Object.entries(KEY_NAMES)) {
  assert(architect.r.meta.keys[n], `architect covers key ${n} — ${label}`);
}
assert(architect.r.meta.keysCovered === 5, 'all five keys, in one handbook');

// --- migration progress, reported not enforced -----------------------------------------------------
// P1 converts the rest. Printing the counts keeps the phase honest without failing the build on work
// that is deliberately not done yet. Reported per KEY, because "converted" is too coarse to plan
// with — the corpus may be strong on guardrails and empty on criteria, and that is the fact that
// decides what P1 actually does.
const converted = results.filter((x) => x.r.meta.converted).length;
console.log(`  info: ${converted}/${files.length} agents converted to the handbook shape (P1 converts the remainder)`);
for (const [n, label] of Object.entries(KEY_NAMES)) {
  const n_ = results.filter((x) => x.r.meta.keys[n]).length;
  console.log(`  info: key ${n} (${label}): ${n_}/${files.length}`);
}
const warned = results.filter((x) => x.r.warnings.length);
for (const w of warned) console.log(`  warn: ${w.file} — ${w.r.warnings[0]}`);

done();
