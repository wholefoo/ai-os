// The guidance corpus must not contradict the repo it describes.
//
// Phase 2 of .magent/vault/wiki/model-fit-2026-design.md. That phase was scoped as "de-duplicate
// rules material out of agent bodies" and the audit found there was almost none to remove — P1's
// handbook conversion had already done it. The duplication was INSIDE `.claude/rules/`, and both
// instances had drifted into being FALSE:
//
//   1. `testing.md`, `engineering-workflow.md` AND `.claude/skills/self-check.md` each asserted
//      "this repo has no unit-test suite", by which point 55 suite files gated CI. The claim did
//      not merely go stale — it told agents not to run the thing that would have caught it.
//   2. `cost-routing.md` restated the model/price table as a single model at a flat $5/$25, while
//      `.claude/context/runtime.md` and `engineering-workflow.md` both correctly described
//      `balanced` mode routing professional and scout work to Sonnet 5 at different rates. The
//      stale copy was the one an agent reads when deciding where to send work.
//
// Both were fixed by DELETING the copy and pointing at one canonical home, not by syncing them —
// syncing three copies is how it broke. This suite pins the properties that made the drift
// possible, so the next copy fails a build instead of quietly misinforming an agent for months.
//
// It cannot check "no contradictions" in general. It checks SPECIFIC claims against the repo's own
// observable state, which is the only kind of check that would actually have fired here.
const fs = require('fs');
const path = require('path');
const { assert, done } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

// Every file that describes how to work in this repo. Derived, not listed: a rule file added
// tomorrow is covered without anyone remembering to add it here.
const GUIDANCE = [
  ...fs.readdirSync(path.join(ROOT, '.claude', 'rules')).map((f) => path.join('.claude', 'rules', f)),
  ...fs.readdirSync(path.join(ROOT, '.claude', 'context')).map((f) => path.join('.claude', 'context', f)),
  ...fs.readdirSync(path.join(ROOT, '.claude', 'skills')).map((f) => path.join('.claude', 'skills', f)),
  path.join('.claude', 'claude.md'),
  'CLAUDE.md',
].filter((p) => p.endsWith('.md') && fs.existsSync(path.join(ROOT, p)));

assert(GUIDANCE.length >= 30, `the guidance corpus was found (${GUIDANCE.length} files)`);

// --- 1. the suite claim ------------------------------------------------------------------------------
// Checked against the repo's actual state rather than a remembered fact, so it stays true if the
// suites are ever genuinely removed.
const suiteFiles = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => /^test-.*\.js$/.test(f));
const hasSuites = suiteFiles.length > 0 && fs.existsSync(path.join(ROOT, 'tools', 'test-all.js'));
assert(hasSuites, `the repo has a regression suite (${suiteFiles.length} files + test-all.js)`);

// The exact phrasing that was wrong in three places. A file may DISCUSS the old claim historically
// (testing.md now does, as a warning) — what must not survive is an assertion in the present tense.
const DENIALS = [/repo has \*\*no unit-test suite\*\*/i, /there are none to\s*\nrun/i, /not claim "tests pass"/i];
const denying = GUIDANCE.filter((p) => {
  const body = read(path.join(ROOT, p)).replace(/^>.*$/gm, '');   // block quotes are historical notes
  return DENIALS.some((re) => re.test(body));
});
assert(denying.length === 0,
  `no guidance file denies the regression suite exists${denying.length ? ` — still denying: ${denying.join(', ')}` : ''}`);

// And the positive: the two files an agent reads before committing must name the command.
for (const f of ['.claude/rules/testing.md', '.claude/rules/engineering-workflow.md']) {
  assert(read(path.join(ROOT, f)).includes('tools/test-all.js'),
    `${f} names the command that runs the suites — knowing they exist is useless without it`);
}

// --- 2. one canonical home for model routing and price -------------------------------------------------
// The drift that mattered most, because it is the file consulted when routing work. `runtime.md` is
// canonical; `cost-routing.md` owns the DECISION MATRIX and must not restate the table.
const costRouting = read(path.join(ROOT, '.claude', 'rules', 'cost-routing.md'));
const runtime = read(path.join(ROOT, '.claude', 'context', 'runtime.md'));

assert(runtime.includes('resolveAnthropicModel') && runtime.includes('Sonnet 5'),
  'runtime.md is the canonical model-routing home and describes the real routing');
assert(costRouting.includes('.claude/context/runtime.md'),
  'cost-routing.md points at the canonical home rather than restating it');

// The specific falsehood: a flat single-model rate. Historical notes in block quotes are exempt.
const costBody = costRouting.replace(/^>.*$/gm, '');
assert(!/single model/i.test(costBody),
  'cost-routing.md no longer claims a single model — balanced mode routes professional/scout to Sonnet 5');
assert(!/\$5\/\$25|\$5\/1M/.test(costBody),
  'cost-routing.md no longer carries a price table — prices live in ONE place and this was the copy that went stale');

// It must still own what it is for. Deleting the stale half should not have gutted the file.
for (const owned of ['Routing Decision Matrix', 'Anti-Patterns', 'Economy']) {
  assert(costRouting.includes(owned), `cost-routing.md still owns "${owned}" — the fix removed a duplicate, not the file's purpose`);
}

// --- 3. the general property ---------------------------------------------------------------------------
// Prices are the most drift-prone fact in this corpus (they change under us, and they read as
// harmless detail), so only two KINDS of file may carry a per-million rate: a provider consultant,
// whose entire job is that provider's model facts, and runtime.md, for what this platform bills.
// Anywhere else is a copy waiting to go stale — precisely what cost-routing.md did.
//
// Written as a derived category rather than the file list it currently matches. The first draft of
// this assertion WAS a list — `consultant-anthropic.md` plus runtime.md — and it failed on the other
// six consultants, which own their own providers' pricing entirely legitimately. An enumerated guard
// losing to the members nobody enumerated is a defect class this repo has hit before; here it cost a
// test run instead of a live incident, which is the point of running it red first.
const isCanonPriceHome = (p) => p === '.claude/context/runtime.md' || /^\.claude\/agents\/consultant-[a-z]+\.md$/.test(p);
const pricey = GUIDANCE
  .concat(fs.readdirSync(path.join(ROOT, '.claude', 'agents')).map((f) => path.join('.claude', 'agents', f)))
  .filter((p) => p.endsWith('.md'))
  .filter((p) => /\$\d[\d.]*\/\$?\d/.test(read(path.join(ROOT, p)).replace(/^>.*$/gm, '')))
  .map((p) => p.split(path.sep).join('/'))
  .filter((p) => !isCanonPriceHome(p));
assert(pricey.length === 0,
  `per-million rates appear only in runtime.md or a provider consultant${pricey.length ? ` — also found in: ${[...new Set(pricey)].join(', ')}` : ''}`);

console.log(`  info: ${GUIDANCE.length} guidance files checked; ${suiteFiles.length} regression suites present`);

done();
