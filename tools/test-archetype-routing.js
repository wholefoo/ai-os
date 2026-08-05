// Tests lib/handbooks/archetype — what an agent's `archetype:` actually does.
//
// P4 of .magent/vault/wiki/agent-handbooks-design.md. P1 declared an archetype on all 68 agents and
// nothing read it. This wires it to model effort, with the reasoning tier as a floor.
//
// The corpus assertions at the bottom are the ones that matter. The design that looked right in a
// table — "sweepers are cheap" — would have demoted `reviewer` and `security-auditor`, and a later
// draft would have taken 13 of 19 skills down to 6 verification checks. Both were caught by
// measuring against the real files, neither by reasoning about the rule.
const fs = require('fs');
const path = require('path');
const arch = require('../lib/handbooks/archetype');
const schema = require('../lib/handbooks/schema');
const brief = require('../lib/skills/brief');
const { assert, done, serverSource } = require('./test-util');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills');

// --- the ladder -----------------------------------------------------------------------------------
assert(arch.EFFORT_LADDER.join() === 'low,medium,high,xhigh', 'the ladder is four rungs, ascending');
assert(arch.shiftEffort('high', -1) === 'medium', 'one rung down from high is medium, not low');
assert(arch.shiftEffort('high', 0) === 'high', 'no shift is no change');
assert(arch.shiftEffort('low', -1) === 'low', 'the bottom rung clamps rather than falling off');
assert(arch.shiftEffort('xhigh', +1) === 'xhigh', 'and so does the top');
assert(arch.shiftEffort('xhigh', -1, 'xhigh') === 'xhigh', 'a floor holds the effort UP against a downward shift');
assert(arch.shiftEffort('anything-else', -1) === 'anything-else',
  'an effort the ladder does not know is returned untouched — silently mapping it onto a rung would bill at a rate nobody chose');

// --- the tier floor protects the agents that grade everyone else ----------------------------------
// This is the whole reason archetype modulates a tier instead of replacing it.
const stratSweeper = arch.routeArchetype('sweeper', { tier: 'strategic', effort: 'xhigh' });
assert(stratSweeper.effort === 'xhigh',
  'a STRATEGIC sweeper stays at xhigh — `reviewer` and `security-auditor` are strategic sweepers, and demoting them would make verification cheaper exactly where it must not be');
assert(stratSweeper.floored === true, 'and the report says the floor is what held it, so "why is this sweeper still xhigh" has an answer in the data');
const profSweeper = arch.routeArchetype('sweeper', { tier: 'professional', effort: 'high' });
assert(profSweeper.effort === 'medium' && profSweeper.floored === false, 'a professional sweeper does shift');

// --- the DoD: same tier, different archetype, different model -------------------------------------
const b = arch.routeArchetype('builder', { tier: 'professional', effort: 'high' });
const s = arch.routeArchetype('sweeper', { tier: 'professional', effort: 'high' });
assert(b.effort !== s.effort,
  'a builder and a sweeper on the same tier resolve to DIFFERENT effort — identical task text, different spend');

// --- unknown / missing archetypes degrade to the pre-P4 behaviour ---------------------------------
assert(arch.DEFAULT_ARCHETYPE === 'builder', 'the default archetype is the neutral one');
assert(arch.routeArchetype('nonsense', { tier: 'professional', effort: 'high' }).effort === 'high',
  'an unrecognised archetype routes as builder — no shift, i.e. exactly as the platform behaved before P4');
assert(arch.archetypeOf({}) === 'builder', 'a handbook with no archetype is a builder');
assert(arch.archetypeOf({ archetype: ['sweeper'] }) === 'sweeper', 'the list form used by the corpus is read');
assert(arch.archetypeOf({ archetype: 'sweeper' }) === 'sweeper', 'and a bare scalar too');
assert(arch.routeArchetype('builder', { tier: 'creative', effort: null }).effort === null,
  'an agent with no effort (creative/Gemini) is left alone rather than given one');

// --- verification depth ---------------------------------------------------------------------------
// The machinery is real and wired. NOTHING lowers it yet, and that is the deliberate outcome of two
// measurements against the corpus — see the header of lib/handbooks/archetype.js.
for (const a of schema.ARCHETYPES) {
  assert(arch.depthFor(a).depth === 'full', `${a} verifies at FULL depth`);
}
assert(arch.DEPTH.light.adversarial === false && arch.DEPTH.full.adversarial === true,
  'the light/full distinction exists and turns on the adversarial pass — 3 reviewer calls per verification');
assert(arch.DEPTH.light.maxChecks < arch.DEPTH.full.maxChecks, 'and on how many checks are graded');
assert(arch.DEPTH.full.strictness === null, 'full depth keeps the CALLER\'s strictness rather than imposing one');

// --- against the REAL corpus ----------------------------------------------------------------------
const src = serverSource();
const block = src.match(/const EFFORT_ROUTING = \{[\s\S]*?\n\};/)[0];
const tierOf = {}; const tierEffort = {};
for (const line of block.split('\n')) {
  const m = line.match(/^\s*(\w+):\s*\{(.*)\}/);
  if (!m) continue;
  const eff = (m[2].match(/effort:\s*'(\w+)'/) || [])[1];
  const agents = (m[2].match(/agents:\s*\[(.*?)\]/) || [])[1];
  if (!agents) continue;
  for (const a of agents.split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean)) { tierOf[a] = m[1]; tierEffort[a] = eff; }
}
const baseFor = (n) => (tierOf[n] ? { tier: tierOf[n], effort: tierEffort[n] } : { tier: 'professional', effort: 'high' });
const archOf = (n) => arch.archetypeFor(fs.readFileSync(path.join(AGENTS_DIR, n + '.md'), 'utf8'));

const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
assert(files.every((f) => schema.ARCHETYPES.includes(archOf(f.replace(/\.md$/, '')))),
  'every agent declares a REAL archetype — one that resolved to the default would be routed by a value nobody wrote');

const gatesOf = (n) => arch.holdsGates(fs.readFileSync(path.join(AGENTS_DIR, n + '.md'), 'utf8'));
const routeOf = (n) => arch.routeArchetype(archOf(n), baseFor(n), { holdsGates: gatesOf(n) });

// NO AGENT ON THE IRREVERSIBLE-ACTION CONTROL PATH MAY BE MADE CHEAPER.
//
// Two sides of the same path, and P4 would have downshifted one of each before this was caught:
//   - agents that TAKE irreversible actions declare `gates:` — derived, so a newly-gated agent is
//     covered automatically rather than when someone remembers to add it to a list
//   - `safety` BLOCKS them; it holds no gates of its own, and is on the strategic tier for that reason
for (const f of files) {
  const n = f.replace(/\.md$/, '');
  if (!gatesOf(n)) continue;
  const base = baseFor(n);
  if (!base.effort) continue;
  assert(routeOf(n).effort === base.effort,
    `${n} declares gates and must not shift down — it can take an irreversible, outward-facing action`);
}
assert(routeOf('safety').effort === 'xhigh',
  'the `safety` sentinel routes at xhigh — it issues VETO verdicts on irreversible actions, and P4 would have dropped it to medium as a professional-tier sweeper');
assert(baseFor('safety').tier === 'strategic', 'which is why P4 moved it onto the strategic tier');

// `qa` is the operator's call, not a correctness rule: it takes no action and blocks nothing
// automatically, so it is not on the irreversible-action path. But its pass/fail verdicts gate
// delivery, and a verifier that reasons less is a verifier that misses more.
assert(routeOf('qa').effort === 'xhigh' && baseFor('qa').tier === 'strategic',
  '`qa` routes at xhigh — its verdicts gate delivery, and P4 had shifted it to medium as a professional-tier sweeper');

// The agents the tier floor exists for. Named explicitly: if either is retiered or retagged, this
// should fail loudly rather than let their effort drop unnoticed.
for (const critical of ['reviewer', 'security-auditor']) {
  const r = routeOf(critical);
  assert(r.effort === 'xhigh', `${critical} routes at xhigh — it is a strategic ${r.archetype}, and the floor is what keeps it there`);
}

// Every resolved effort must be priced, or the ledger bills at a fallback rate and the cost report
// silently lies. This is the assertion that would have caught `medium` missing from COST_RATES.
const rates = src.match(/const COST_RATES = \{[\s\S]*?\n\};/)[0];
const efforts = new Set();
for (const f of files) {
  const n = f.replace(/\.md$/, '');
  const base = baseFor(n);
  if (!base.effort) continue;
  efforts.add(arch.routeArchetype(archOf(n), base).effort);
}
for (const e of efforts) {
  for (const family of ['opus-5', 'sonnet-5']) {
    assert(rates.includes(`'${family}-${e}'`), `COST_RATES prices ${family}-${e} — an unpriced effort bills at the fallback rate and misreports spend`);
  }
}

// The server actually consults the archetype. The module can be perfect while getAgentEffort ignores it.
assert(/handbookArchetype\.routeArchetype\(facts\.archetype, base, \{ holdsGates: facts\.holdsGates \}\)/.test(src),
  'getAgentEffort modulates the tier by the archetype AND passes the gate flag — without the flag a gated agent silently shifts down');
assert(/function getAgentRoutingFacts/.test(src) && /mtimeMs/.test(src),
  'and the handbook facts are cached by mtime — getAgentEffort runs on every model call, and an operator edit must take effect without a restart');
assert(/function baseTierFor/.test(src), 'and the unmodulated tier lookup is still available separately');
assert(/runRealVerification\(report, rubric, output, strictness, depth\)/.test(src),
  'and verification receives a depth');
assert(/if \(d\.adversarial\) try \{/.test(src),
  'which gates the adversarial pass — the 3 reviewer calls that ran unconditionally before P4');

// --- the corpus-wide effect, as VALUES not counts ---------------------------------------------------
const shifted = [];
for (const f of files) {
  const n = f.replace(/\.md$/, '');
  const base = baseFor(n);
  if (!base.effort) continue;
  const r = routeOf(n);
  if (r.effort !== base.effort) shifted.push(`${n}:${base.effort}->${r.effort}`);
}
assert(shifted.length > 0 && shifted.length < files.length / 2,
  `a minority of agents shift, not none and not most (got ${shifted.length}/${files.length})`);
assert(!shifted.some((x) => /^reviewer:|^security-auditor:/.test(x)),
  'and neither of the two agents the floor protects is among them');

// No dispatchable skill loses verification depth. This is the regression the second measurement
// found: `research-brief` scored 63 on production against 16 checks with two hard failures, and at
// light depth would most likely have read as a pass.
const agentNames = files.map((f) => f.replace(/\.md$/, ''));
for (const f of fs.readdirSync(SKILLS_DIR).filter((x) => x.endsWith('.md'))) {
  const v = brief.validateBrief(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'), { agentNames });
  if (!v.brief.dispatchable) continue;
  assert(arch.depthFor(archOf(v.brief.lead)).depth === 'full',
    `${f} still verifies at full depth (lead ${v.brief.lead})`);
}

console.log(`  info: ${shifted.length} of ${files.length} agents shift effort — ${shifted.join(', ')}`);
done();
