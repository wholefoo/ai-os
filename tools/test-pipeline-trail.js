// The run-scoped paper trail — G4 of .magent/vault/wiki/graph-engineering-eval.md.
//
// `pipelineRuns` is `new Map()`: in memory, never persisted. Before this, a restart lost every run,
// and a FAILED run left nothing at all because the .docx export only fires in completePipelineRun.
// A pipeline that died at stage 4 discarded the three stages that had succeeded — the work a rerun
// least needs to redo.
//
// So the property under test is not "files exist". It is **a stage's work survives the run**: it is
// written as the stage completes, and it is still there after a later stage fails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const trail = require('../lib/pipeline-trail');
const { assert, cleanupAndFinish, serverSource } = require('./test-util');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-'));
const src = serverSource();

// --- PATH SAFETY. A stage id comes from a YAML file and reaches the filesystem. -------------------
assert(trail.safeSegment('../../etc/passwd') === 'etcpasswd',
  'a traversal attempt is flattened, not escaped — the segment cannot leave its parent directory');
assert(trail.safeSegment('..') === 'unnamed' && trail.safeSegment('.') === 'unnamed',
  'a segment of only dots becomes the fallback rather than the parent or current directory');
assert(trail.safeSegment('.hidden') === 'hidden', 'leading dots are stripped — no hidden files');
assert(trail.safeSegment('a/b\\c') === 'abc', 'both separators are removed');
assert(trail.safeSegment('') === 'unnamed' && trail.safeSegment(null) === 'unnamed', 'empty and null get a usable fallback');
assert(trail.safeSegment('research-2_A.md') === 'research-2_A.md', 'ordinary ids survive intact');
assert(!path.relative(TMP, trail.runDir(TMP, '../../escape')).startsWith('..'),
  'and runDir() of a hostile id still resolves INSIDE the base directory');

// --- a stage is written as it completes -----------------------------------------------------------
const run = {
  id: 'run-123', pipeline: 'security-sweep', description: 'd', params: { domain: 'x.test' },
  status: 'running', startedAt: '2026-08-03T10:00:00.000Z', cost: 0.42,
  stages: [
    { id: 'architecture', agent: 'security-auditor', status: 'completed', output: 'ARCH FINDINGS', completedAt: '2026-08-03T10:01:00.000Z', model: 'opus' },
    { id: 'dependencies', agent: 'security-auditor', status: 'completed', output: 'DEP FINDINGS', completedAt: '2026-08-03T10:01:00.000Z' },
    { id: 'compile-report', agent: 'writer', depends_on: ['architecture', 'dependencies'], status: 'failed', error: 'agent failed' },
  ],
};

const f1 = trail.writeStage(TMP, run, run.stages[0], 1);
const f2 = trail.writeStage(TMP, run, run.stages[1], 1);
assert(f1 && fs.existsSync(f1), 'a completed stage is written to disk');
assert(path.basename(f1) === '01-architecture.md' && path.basename(f2) === '01-dependencies.md',
  'the filename carries the LAYER, so two files sharing a prefix ran concurrently — a graph has no single "line 3"');

const body = fs.readFileSync(f1, 'utf8');
assert(body.includes('ARCH FINDINGS'), 'the deliverable itself is in the file');
assert(/- \*\*run\*\*: run-123 \(security-sweep\)/.test(body), 'with a header a human can read without opening the manifest');
assert(/produced by\*\*: security-auditor/.test(body), '...naming what produced it');
assert(/depends on\*\*: nothing \(root stage\)/.test(body), '...and its declared dependencies, or that it is a root');
assert(/depends on\*\*: architecture, dependencies/.test(
  fs.readFileSync(trail.writeStage(TMP, run, { ...run.stages[2], output: 'X', id: 'compile-report' }, 2), 'utf8')),
  'a joining stage records the edges it was given');

assert(trail.writeStage(TMP, run, { id: 'empty' }, 1) === null, 'a stage with no output writes nothing rather than an empty file');

// --- THE POINT: the failed run keeps its finished work ---------------------------------------------
run.status = 'failed';
run.error = 'compile-report failed';
run.completedAt = '2026-08-03T10:05:00.000Z';
const mf = trail.writeManifest(TMP, run, [['architecture', 'dependencies'], ['compile-report']]);
assert(fs.existsSync(mf), 'the manifest is written even for a failed run');

const m = trail.readManifest(TMP, 'run-123');
assert(m && m.status === 'failed' && m.error === 'compile-report failed', 'and records that it failed, and why');
assert(fs.existsSync(f1) && fs.readFileSync(f1, 'utf8').includes('ARCH FINDINGS'),
  'THE PROPERTY: the two stages that succeeded are still on disk after a later stage failed — that work is what a rerun does not have to redo');

assert(JSON.stringify(m.layers) === JSON.stringify([['architecture', 'dependencies'], ['compile-report']]),
  'the manifest carries the SCHEDULE — two ids in one layer is the only record that they ran concurrently');
assert(m.stages.find((s) => s.id === 'compile-report').status === 'failed', 'per-stage status survives');
assert(m.cost === 0.42 && m.params.domain === 'x.test', 'cost and params survive');

// The manifest must not become a second copy of the output — that is the drift shape phase 2 removed.
assert(!JSON.stringify(m).includes('ARCH FINDINGS'),
  'the manifest records hasOutput, NOT the output — the .md files are the single copy');
assert(m.stages[0].hasOutput === true, '...but does say which stages produced something');

// --- listing, so the trail is not write-only --------------------------------------------------------
const run2 = { id: 'run-456', pipeline: 'content', status: 'completed', startedAt: '2026-08-03T11:00:00.000Z', stages: [] };
trail.writeManifest(TMP, run2, []);
const listed = trail.listRuns(TMP);
assert(listed.length === 2, `both runs are listed (${listed.length})`);
assert(listed[0].id === 'run-456', 'newest first');
assert(trail.readManifest(TMP, 'nope') === null, 'an unknown run reads as null rather than throwing');
assert(trail.listRuns(path.join(TMP, 'does-not-exist')).length === 0, 'a missing base directory lists empty rather than throwing');

// --- the runner is wired to it ----------------------------------------------------------------------
assert(/pipelineTrail\.writeStage\(PIPELINE_RUNS_DIR, run, stage, layer\)/.test(src),
  'server.js writes each stage as it completes, with its layer');
assert(/runPipelineStage\(run, stage, li \+ 1\)/.test(src), 'and the layer index comes from the scheduler, not a guess');
assert(/savePipelineManifest\(run\)/.test(src), 'the manifest is refreshed on completion, failure and gate');
assert(/catch \(e\) \{ appendLog\(`\[pipeline-trail\]/.test(src),
  'a disk problem is logged, never allowed to fail an otherwise-good stage');
assert(/fromTrail: true/.test(src), 'runs recovered from disk are marked, since they carry no stage output');
assert(/PIPELINE_RUNS_DIR = path\.join\(MAGENT_DIR, 'runs'\)/.test(src), 'the trail lives under .magent/runs');

const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
assert(/^\.magent\/runs\/$/m.test(gitignore), '.magent/runs/ is gitignored — run output is data, not source');

cleanupAndFinish(TMP);
