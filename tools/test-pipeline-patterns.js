// Pattern stages — G2 of .magent/vault/wiki/graph-engineering-eval.md.
//
// lib/orchestrator.js implemented the Diamond Pattern's primitives from the day it was written, and
// FIVE OF ITS SEVEN EXPORTS HAD NO CONSUMER ANYWHERE (tournament, loopUntilDone, classifyAndAct,
// generateAndFilter, runSequential) — which is why they all sit in .fallowrc.json's ignoreExports.
// The kernel was unreachable: fanning out or running a skeptic panel required a bespoke server
// route, and a pipeline could not ask for either. `pattern:` is the way in.
//
// Every assertion drives the REAL kernel through a mock runAgent, so the wiring is exercised end to
// end without spending a token. That matters more than it sounds: a mock at the pattern boundary
// would only prove this file agrees with itself.
const fs = require('fs');
const path = require('path');
const p = require('../lib/pipeline-patterns');
const { assert, done, serverSource } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const src = serverSource();

// A mock agent runner. `script` maps agent name -> reply (string) or a function of the task.
const mockDeps = (script, seen = []) => ({
  runAgent: async (agent, task) => {
    seen.push({ agent, task });
    const r = script[agent];
    if (r === undefined) return { ok: false, error: `no mock for ${agent}` };
    const content = typeof r === 'function' ? r(task) : r;
    return { ok: true, content, model: 'mock', inputTokens: 10, outputTokens: 10 };
  },
  broadcast: () => {}, log: () => {},
});

// --- config validation refuses what would fail at run time ----------------------------------------
assert(p.validatePatternStage({ id: 's' }).length === 0, 'a stage with no pattern is not a pattern stage and is left alone');

const unknown = p.validatePatternStage({ id: 's', pattern: 'diamond' });
assert(unknown.length === 1 && /unknown pattern "diamond"/.test(unknown[0]), 'an unknown pattern name is refused and the message lists the real ones');
assert(/fan-out/.test(unknown[0]), '...including fan-out, so the fix is visible in the error');

assert(p.validatePatternStage({ id: 's', pattern: 'skeptic' }).some((e) => /no depends_on/.test(e)),
  'a skeptic with nothing to refute is refused — a panel with no subject is the decorative guardrail this codebase keeps finding');
assert(p.validatePatternStage({ id: 's', pattern: 'tournament' }).some((e) => /no depends_on/.test(e)),
  'so is a tournament with no candidates');
assert(p.validatePatternStage({ id: 's', pattern: 'skeptic', depends_on: ['a'] }).length === 0, '...and both are fine once they declare one');

assert(p.validatePatternStage({ id: 's', pattern: 'fan-out', workers: ['solo'] }).some((e) => /at least 2/.test(e)),
  'a fan-out of one agent is not a fan-out');
assert(p.validatePatternStage({ id: 's', pattern: 'classify', routes: { a: {} } }).some((e) => /at least 2/.test(e)),
  'a classify with one route has nothing to classify');
assert(p.validatePatternStage({ id: 's', pattern: 'skeptic', depends_on: ['a'], on_refute: 'ignore' }).some((e) => /on_refute/.test(e)),
  'an unknown on_refute mode is refused rather than silently treated as the default');

// --- loop-until-done and runSequential are deliberately NOT exposed --------------------------------
assert(!p.PATTERNS.includes('loop-until-done'),
  'loop-until-done is NOT a YAML pattern — it takes functions, and expressing a predicate in YAML means inventing a language');
assert(!p.PATTERNS.includes('sequential'),
  'runSequential is NOT a pattern — it is what the pipeline runner already is, and a second scheduler inside a stage would compete with the first');
// Five kernel patterns + the three reasoning engines from lib/reasoning (verified-steps, reflexion,
// tree-search). The count is asserted rather than the membership alone so that ADDING a pattern is a
// deliberate edit here — a new `pattern:` key is a new public surface and a new way to spend money.
assert(p.PATTERNS.length === 8, `eight patterns are exposed (${p.PATTERNS.join(', ')})`);
['verified-steps', 'reflexion', 'tree-search'].forEach((name) =>
  assert(p.PATTERNS.includes(name), `${name} is reachable from YAML — an unreachable engine is the mistake this file exists to record`));

(async () => {
  // --- fan-out: parallel workers, then a synthesizer ------------------------------------------------
  let seen = [];
  const fan = await p.runPattern(
    { id: 'gather', pattern: 'fan-out', workers: ['researcher', 'scout', 'social-intel'] },
    { task: 'find the market' },
    mockDeps({ researcher: 'R findings', scout: 'S findings', 'social-intel': 'X findings', synthesis: 'MERGED' }, seen));
  assert(fan.ok && fan.output === 'MERGED', 'fan-out returns the SYNTHESIS, not the raw parts');
  assert(seen.filter((c) => c.agent !== 'synthesis').length === 3, 'all three workers ran');
  const synthCall = seen.find((c) => c.agent === 'synthesis');
  assert(/R findings/.test(synthCall.task) && /X findings/.test(synthCall.task), 'and the synthesizer received every worker\'s output');
  assert(fan.meta.failed === 0, 'the meta records how many workers failed');

  // A partial fan-out is still a result — the kernel only fails when EVERY worker failed.
  const partial = await p.runPattern({ id: 'g', pattern: 'fan-out', workers: ['researcher', 'ghost'] },
    { task: 't' }, mockDeps({ researcher: 'ok', synthesis: 'MERGED' }));
  assert(partial.ok && partial.meta.failed === 1, 'one dead worker degrades the fan-out, it does not fail the stage');

  // --- skeptic: the panel, and what happens when it refutes -------------------------------------------
  const sound = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['draft'], n: 3 },
    { subject: 'the claim' }, mockDeps({ reviewer: 'SOUND — the numbers check out' }));
  assert(sound.ok && /0\/3 refuted/.test(sound.output), 'a panel that finds nothing passes, and the output shows the tally');

  const refuted = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['draft'], n: 3 },
    { subject: 'the claim' }, mockDeps({ reviewer: 'REFUTED — the source is stale' }));
  assert(!refuted.ok && refuted.verdict === 'refuted', 'a refuted panel FAILS the stage by default — refuted work must not flow downstream');
  assert(/3\/3 refuted/.test(refuted.output) && /stale/.test(refuted.output), '...and the output carries the panel\'s reasons, which is the point of running it');

  const gated = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['d'], on_refute: 'gate' },
    { subject: 'c' }, mockDeps({ reviewer: 'REFUTED — no' }));
  assert(gated.verdict === 'gated', 'on_refute: gate escalates to a human instead, per .claude/rules/adversarial-verification.md');
  const warned = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['d'], on_refute: 'warn' },
    { subject: 'c' }, mockDeps({ reviewer: 'REFUTED — no' }));
  assert(warned.ok && !warned.verdict, 'on_refute: warn records the refutation and continues');

  // THE ASSERTION THAT MATTERS. A panel nobody answered is not a pass.
  const silent = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['d'], n: 3 },
    { subject: 'c' }, mockDeps({}));   // reviewer has no mock -> every call fails
  assert(!silent.ok && /treated as a block/.test(silent.output),
    'a panel where NO skeptic answered is a BLOCK, never a silent ship — the repo\'s own rule, enforced here');

  // --- generate-filter, tournament, classify -----------------------------------------------------------
  const gf = await p.runPattern({ id: 'draft', pattern: 'generate-filter', n: 3, generator: 'writer' },
    { task: 'write a hook' }, mockDeps({ writer: (t) => `option for ${t.slice(0, 12)}`, reviewer: '2' }));
  assert(gf.ok && gf.meta.candidates === 3, 'generate-filter produces n candidates and picks one');

  const tour = await p.runPattern({ id: 'pick', pattern: 'tournament', depends_on: ['a', 'b'] },
    { candidates: ['alpha text', 'beta text'] }, mockDeps({ reviewer: 'B' }));
  assert(tour.ok && tour.output === 'beta text', 'tournament judges the dependencies\' outputs pairwise and returns the winner');
  assert(tour.meta.rounds === 1, 'two candidates is one round');

  const cls = await p.runPattern({ id: 'route', pattern: 'classify', routes: { bug: { agent: 'coder' }, doc: { agent: 'writer' } } },
    { task: 'fix the crash' }, mockDeps({ scout: 'bug', coder: 'PATCHED' }));
  assert(cls.ok && cls.output === 'PATCHED' && cls.meta.routeKey === 'bug', 'classify picks a route and runs that agent');

  // --- the three reasoning patterns actually RUN through runPattern -------------------------------------
  // Declaring a pattern and validating its config proves nothing about whether the stage executes.
  // This file's own header is about an engine that was correct and unreachable for months, so these
  // three drive the real lib/reasoning engines through the real runPattern with a mock runner.
  const vs = await p.runPattern({ id: 'diagnose', pattern: 'verified-steps', max_steps: 2 },
    { task: 'find the bug' }, mockDeps({ architect: '1. reproduce it', coder: 'reproduced on input X', reviewer: 'STATUS: CORRECT\nSCORE: 0.9' }));
  assert(vs.ok && /reproduced on input X/.test(vs.output), 'verified-steps runs the PRM engine and returns the rendered trace');
  assert(vs.meta.budget && vs.meta.budget.calls === 3,
    `and reports the stage's REAL cost (${vs.meta.budget && vs.meta.budget.calls} calls, not 1) — a multi-call stage that reported one call's tokens would under-report spend on exactly the stages that spend most`);

  const rfx = await p.runPattern({ id: 'draft', pattern: 'reflexion', max_attempts: 2 },
    { task: 'write it' }, mockDeps({ coder: 'a draft', reviewer: 'VERDICT: PASS\nSCORE: 0.9\nCRITIQUE: fine' }));
  assert(rfx.ok && rfx.output === 'a draft' && rfx.meta.attempts === 1, 'reflexion runs the Actor-Evaluator loop and stops as soon as it passes');

  const tree = await p.runPattern({ id: 'explore', pattern: 'tree-search', breadth: 2, max_depth: 1 },
    { task: 'pick an approach' }, mockDeps({ architect: '1. approach one\n2. approach two', reviewer: 'SCORE: 0.9 SOLVED' }));
  assert(tree.ok && /approach one/.test(tree.output), 'tree-search runs the ToT engine and returns the chosen path');
  assert(typeof tree.meta.backtracks === 'number', 'and carries the search telemetry a reader needs to judge it');

  const badStrategy = await p.runPattern({ id: 'x', pattern: 'tree-search', strategy: 'astar' }, { task: 't' }, mockDeps({}));
  assert(!badStrategy.ok, 'a stage that slipped past validation with a bad strategy still fails safely rather than searching wrongly');

  // --- the runner is wired to this ---------------------------------------------------------------------
  assert(/pipelinePatterns\.runPattern\(stage,/.test(src), 'server.js dispatches pattern stages to the kernel');
  assert(/pipelinePatterns\.validatePatternStage\(s\)/.test(src), '...and validates their config at load time, with the graph');
  assert(/if \(stage\.pattern\) \{/.test(src), 'a non-pattern stage still takes the plain executeAgent path');
  assert(/candidates: inputs\.map\(\(s\) => s\.output\)/.test(src), 'tournament candidates come from the SAME inputsFor() G1 uses — one definition of "what this stage depends on"');
  assert(/if \(!stage\.pattern\) \{/.test(src) && /already accumulated their cost/.test(src),
    'a pattern stage is not re-costed after the fact — its sub-calls were metered as they happened');
  assert(/if \(stage\.agent\) broadcast\(\{ event: 'fleet_update'/.test(src),
    'fleet broadcasts tolerate a stage with no single agent — a fan-out has workers, not an agent');

  // Every exposed pattern must actually exist in the kernel. A pattern naming a function that is not
  // there would be the same defect class as a gates: id that names no action.
  // Patterns now resolve to TWO implementing modules: the orchestration kernel and lib/reasoning.
  // The invariant is unchanged and the coverage check below is what enforces it — every exposed
  // pattern must name a function that exists, in whichever module owns it.
  const kernel = require('../lib/orchestrator');
  const reasoning = require('../lib/reasoning');
  const MAP = {
    'fan-out': [kernel, 'fanOutAndSynthesize'], skeptic: [kernel, 'adversarialVerify'],
    'generate-filter': [kernel, 'generateAndFilter'], tournament: [kernel, 'tournament'], classify: [kernel, 'classifyAndAct'],
    'verified-steps': [reasoning, 'reason'], reflexion: [reasoning, 'reason'], 'tree-search': [reasoning, 'reason'],
  };
  assert(Object.keys(MAP).length === p.PATTERNS.length && p.PATTERNS.every((n) => MAP[n]),
    'every exposed pattern is covered by this map — otherwise a new pattern could be added with no existence check at all, which is the hole the check exists to close');
  for (const name of p.PATTERNS) {
    const [mod, fn] = MAP[name];
    assert(typeof mod[fn] === 'function', `pattern "${name}" maps to ${fn}(), which exists`);
  }

  console.log(`  info: ${p.PATTERNS.length} patterns wired to the kernel; 2 (loop-until-done, runSequential) deliberately not exposed`);
  done();
})();
