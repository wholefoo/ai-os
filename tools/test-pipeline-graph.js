// The pipeline dependency graph — G1 of .magent/vault/wiki/graph-engineering-eval.md.
//
// `.claude/pipelines/*.yaml` declared `depends_on` on almost every stage and **no JavaScript read
// the field anywhere in the repo**. The runner was `for (let i = startIdx; i < run.stages.length;
// i++)` and threaded EVERY prior stage's output into every later stage. A file that read as a DAG
// in review executed as a queue: `security-sweep`'s two independent audits ran one after the other
// for no reason, and stage five received four deliverables it never asked for.
//
// The speedup is the obvious half. The half that matters more is **state narrowing**: a stage now
// receives only its declared dependencies, so the assertions below check the PROMPT, not the clock.
// Timing is a flaky proxy for parallelism; what a node was handed is the actual contract.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const g = require('../lib/pipeline-graph');
const { assert, done, serverSource } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const src = serverSource();

// --- validation refuses the graphs that would fail mid-run --------------------------------------
const ok = g.validateGraph([{ id: 'a' }, { id: 'b', depends_on: ['a'] }]);
assert(ok.ok, 'a well-formed graph validates');

const unknown = g.validateGraph([{ id: 'a', depends_on: ['ghost'] }]);
assert(!unknown.ok && /not a stage in this pipeline/.test(unknown.errors[0]),
  'a depends_on naming a stage that does not exist is refused, and the message names it');

const cyclic = g.validateGraph([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }]);
assert(!cyclic.ok && /cycle/.test(cyclic.errors[0]), 'a cycle is refused — otherwise the scheduler would spin forever');
assert(/a, b/.test(cyclic.errors[0]), '...and the message names the stages involved, which is what makes it fixable');

assert(!g.validateGraph([{ id: 'a' }, { id: 'a' }]).ok, 'duplicate stage ids are refused — a dependency could not name one unambiguously');
assert(!g.validateGraph([{ id: 'a', depends_on: ['a'] }]).ok, 'a stage cannot depend on itself');
assert(g.layersOf([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }]).length === 0,
  'an invalid graph yields NO layers rather than a partial schedule — the runner fails the run instead of half-executing it');

// --- layering ------------------------------------------------------------------------------------
const diamond = [
  { id: 'plan' },
  { id: 'left', depends_on: ['plan'] },
  { id: 'right', depends_on: ['plan'] },
  { id: 'merge', depends_on: ['left', 'right'] },
];
const layers = g.layersOf(diamond);
assert(layers.length === 3, `the diamond schedules in 3 layers, not 4 stages (got ${JSON.stringify(layers)})`);
assert(layers[1].length === 2 && layers[1].includes('left') && layers[1].includes('right'),
  'the two independent arms share a layer — that IS the parallelism');
assert(layers[2][0] === 'merge', 'the join waits for both arms');

// --- THE OPT-IN RULE. An un-annotated pipeline must not silently become parallel ------------------
const edgeless = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
assert(!g.declaresEdges(edgeless), 'a pipeline with no depends_on anywhere declares no edges');
const seqLayers = g.layersOf(edgeless);
assert(seqLayers.length === 3 && seqLayers.every((l) => l.length === 1),
  'and runs strictly sequentially, one stage per layer — absence of a declaration is not evidence of independence');
assert(g.inputsFor(edgeless[2], edgeless).map((s) => s.id).join(',') === 'a,b',
  '...receiving every earlier stage, exactly the pre-2026-08-03 behaviour');

// --- state narrowing: a stage gets ONLY what it declared ------------------------------------------
assert(g.inputsFor(diamond[3], diamond).map((s) => s.id).sort().join(',') === 'left,right',
  'the join receives its two declared arms');
assert(!g.inputsFor(diamond[3], diamond).some((s) => s.id === 'plan'),
  'and NOT the planner it never declared — dependencies are direct, not transitive. Inferring transitively would quietly rebuild the everything-forward blob this replaces.');
assert(g.inputsFor(diamond[0], diamond).length === 0, 'a root stage receives no prior output at all');

// --- concurrency is actually bounded ---------------------------------------------------------------
(async () => {
  let inFlight = 0, peak = 0;
  await g.mapLimited([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return n * 2;
  });
  assert(peak <= 3, `mapLimited never exceeds its limit (peak ${peak}) — a 3-way split at Strategic tier is 3 simultaneous Opus calls`);
  assert(peak > 1, `...and does run concurrently (peak ${peak}), or the cap would be hiding a serial loop`);

  const order = await g.mapLimited([3, 1, 2], 3, async (n) => { await new Promise((r) => setTimeout(r, n * 5)); return n; });
  assert(order.join(',') === '3,1,2', 'results come back in INPUT order, not completion order — the layer runner reads verdicts positionally');

  // --- the real corpus ------------------------------------------------------------------------------
  const dir = path.join(ROOT, '.claude', 'pipelines');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  assert(files.length >= 3, `the pipeline corpus was found (${files.length})`);

  let parallelisable = 0;
  for (const f of files) {
    const p = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    const v = g.validateGraph(p.stages);
    assert(v.ok, `${f} declares a valid graph${v.ok ? '' : ` — ${v.errors.join('; ')}`}`);
    const ls = g.layersOf(p.stages);
    if (ls.some((l) => l.length > 1)) parallelisable++;
  }
  assert(parallelisable >= 1,
    `at least one shipped pipeline genuinely parallelises (${parallelisable}) — otherwise this change is capability with no demonstrated effect`);

  // security-sweep is the concrete one: two independent audits that used to run back to back.
  const sweep = yaml.load(fs.readFileSync(path.join(dir, 'security-sweep.yaml'), 'utf8'));
  const sweepLayers = g.layersOf(sweep.stages);
  assert(sweepLayers[0].length === 2 && sweepLayers[0].includes('architecture') && sweepLayers[0].includes('dependencies'),
    `security-sweep starts with TWO roots in one layer (${JSON.stringify(sweepLayers[0])}) — declared since the file was written, executed only now`);
  assert(sweepLayers.length < sweep.stages.length,
    `and schedules in ${sweepLayers.length} layers for ${sweep.stages.length} stages`);

  // --- the runner is wired to this, not to array order -------------------------------------------------
  // Comments are stripped first: the replacement runner QUOTES the old loop in its header to explain
  // what changed, and the first draft of this assertion matched that prose and failed. A guard that
  // cannot tell code from a comment about code is checking the wrong thing.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert(!/for \(let i = startIdx; i < run\.stages\.length; i\+\+\)/.test(code),
    'the index loop is gone from server.js CODE — it was the thing that ignored the edges');
  assert(/pipelineGraph\.layersOf\(run\.stages\)/.test(src), 'the runner schedules by layer');
  assert(/pipelineGraph\.inputsFor\(stage, run\.stages\)/.test(src),
    'and builds each stage prompt from its declared inputs — the state-narrowing half');
  assert(!/run\.stages\.slice\(0, i\)\.filter\(\(s\) => s\.output\)/.test(src),
    'the everything-forward context blob is gone');
  assert(/mapLimited\(todo, pipelineGraph\.MAX_CONCURRENT_STAGES/.test(src), 'concurrency is capped in the runner, not unbounded');
  assert(/graphValid === false/.test(src), '/execute refuses an invalid graph before spending a token');
  assert(/run\.stages\.some\(s => s\.status === 'awaiting_approval'\)/.test(src),
    'approving one gate does not release a run that still has another pending — a layer can hold two');

  done();
})();
