// Resuming a FAILED pipeline run without re-paying for the stages that succeeded.
//
// THE DEFECT. Everything needed for this existed and was unreachable. `runPipelineStages` already
// skips completed stages ("Resume is index-free"), and `writeStage` already persists each
// deliverable the moment it lands, under a comment promising "a pipeline that dies at stage 4 keeps
// the three that succeeded — the work a rerun does not need to redo". Nothing could act on that
// promise: `/approve` was the only re-entry point and it requires status 'awaiting_approval'. A
// failed run could be READ but not CONTINUED.
//
// It cost real work twice in two days, and neither failure was the stage's fault:
//   run-1786085226550 — a 120s client timeout killed `architecture`; `dependencies` had completed
//                       with 6716 chars.
//   run-1786158988267 — an Anthropic account limit killed `dependencies`; `architecture` had
//                       completed with 7080 chars (recovered by hand).
//
// Same shape as `depends_on`, `required: true`, and the handbooks' `tools:` line: the vocabulary was
// there, the enforcement was not. A promise in a comment is not a feature.
const fs = require('fs');
const os = require('os');
const path = require('path');
const trail = require('../lib/pipeline-trail');
const { assert, done, serverSource, readRepoFile } = require('./test-util');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
const run = { id: 'run-1786158988267', pipeline: 'security-sweep' };

// --- the round trip that resume depends on ------------------------------------------------------
// A rehydrated stage is only trustworthy if its output comes back EXACTLY. Anything less feeds a
// downstream stage a corrupted upstream and produces a confident report built on damage.
const body = '## Stage Deliverable\n\nFindings below.\n\n---\n\n### F-01\nSeverity: Medium\n\n---\n\nEnd.';
trail.writeStage(base, run, { id: 'architecture', agent: 'security-auditor', model: 'opus-5-xhigh', output: body, completedAt: 'x' }, 1);

const back = trail.readStageOutput(base, run.id, 'architecture');
assert(back === body, 'a stage output round-trips byte-for-byte through writeStage/readStageOutput');
// The load-bearing case: the deliverable CONTAINS the same `\n---\n\n` that separates the header.
// Splitting on the last occurrence, or on all of them, would silently truncate real findings — and
// a shortened report is exactly the failure this repo has already shipped once (the 4000-char cut).
assert(back.includes('### F-01') && back.includes('End.'),
  'including when the deliverable itself contains the header separator — the split takes the FIRST only');
assert(!back.startsWith('# architecture') && !back.includes('**produced by**'),
  'and the human-readable header is NOT returned as content — handing metadata downstream as a deliverable is worse than returning nothing');

assert(trail.readStageOutput(base, run.id, 'no-such-stage') === null, 'a stage with no file reads back null');
assert(trail.readStageOutput(base, 'run-does-not-exist', 'architecture') === null, 'an absent run reads back null');

// A file that is not in writeStage's shape must yield null, NOT the whole file.
const dir = trail.runDir(base, run.id);
fs.writeFileSync(path.join(dir, '09-malformed.md'), 'no separator anywhere in this file');
assert(trail.readStageOutput(base, run.id, 'malformed') === null,
  'a file without the header separator yields null rather than its own header text');

// Layer prefixes vary and the caller does not know them, so the match is on the suffix.
trail.writeStage(base, run, { id: 'code-scan', agent: 'security-auditor', output: 'scan result', completedAt: 'x' }, 3);
assert(trail.readStageOutput(base, run.id, 'code-scan') === 'scan result',
  'a stage is found regardless of which layer prefix its filename carries');

// --- the manifest still must NOT carry output ----------------------------------------------------
// readStageOutput exists precisely BECAUSE the manifest excludes output. If someone "helpfully" adds
// it there, the .md files become a second copy that drifts — and this test should stop them.
trail.writeManifest(base, { ...run, status: 'failed', stages: [{ id: 'architecture', status: 'completed', output: body }] }, []);
const manifest = trail.readManifest(base, run.id);
assert(manifest.stages[0].hasOutput === true, 'the manifest records THAT a stage has output');
assert(manifest.stages[0].output === undefined, 'but never the output itself — the .md file stays the single copy');

// --- the route: wiring, and the conditions it refuses ---------------------------------------------
const src = serverSource();
const route = (src.match(/app\.post\('\/api\/pipelines\/runs\/:id\/resume'[\s\S]*?\n\}\);/) || [''])[0];
assert(route.length > 0 && /runPipelineStages\(run\)/.test(route),
  'POST /api/pipelines/runs/:id/resume exists and really re-enters runPipelineStages');
assert(/requireAdmin/.test(route), 'and is admin-gated like every other mutating pipeline route');

assert(/run\.status !== 'failed'/.test(route), "it resumes ONLY a 'failed' run");
assert(/use \/approve/.test(route),
  "and sends an awaiting_approval run to /approve — routing around the gate would SKIP a human decision rather than satisfy it");

assert(/s\.status = 'pending'; s\.error = undefined/.test(route),
  'stages being retried are reset to pending and their previous error cleared — a stale error must not survive into a run that then succeeds');
assert(/const done = run\.stages\.filter\(\(s\) => s\.status === 'completed'\)/.test(route),
  'completed stages are identified and KEPT — that is the entire point');
assert(!/status = 'pending'[\s\S]*?run\.stages\.forEach/.test(route), 'and nothing resets the whole stage list');

assert(/every stage already completed/.test(route), 'a run with nothing left to do is refused rather than silently re-running');
assert(/PIPELINE_RESUME/.test(route) && /kept:/.test(route) && /retrying:/.test(route),
  'the log names which stages were kept and which are being retried — a resume that does not say what it skipped is unauditable');

// --- rehydration: the half that survives a restart ---------------------------------------------------
const rehy = (src.match(/function rehydrateRunFromTrail[\s\S]*?\n\}\n/) || [''])[0];
assert(rehy.length > 0 && /readStageOutput/.test(rehy),
  'rehydrateRunFromTrail reads each completed stage OUTPUT back, not just its status');
assert(/no longer defines stage\(s\)/.test(rehy),
  'and REFUSES when the pipeline YAML no longer defines a stage the run had — resuming half an old graph into half a new one matches neither');
assert(/if \(m\.hasOutput && !output\) return stage;/.test(rehy),
  'a stage recorded completed whose deliverable cannot be read back is RE-RUN, not resumed with a hole');
assert(/pipelineRuns\.get\(req\.params\.id\)/.test(route) && /rehydrateRunFromTrail\(req\.params\.id\)/.test(route),
  'the route prefers the live in-memory run and falls back to the trail only when the process no longer has it');

// The in-memory Map is why this matters: a restart erases every live run, and both real incidents
// happened on a box that restarts on every deploy.
assert(/pipelineRuns\.set\(run\.id, run\)/.test(route), 'a rehydrated run is put back in the live Map so later calls see it');

// --- the route must be REACHABLE from the UI ---------------------------------------------------------
// The bug this whole commit fixes was a capability that existed and could not be invoked. Shipping
// the fix as an endpoint with no caller would reproduce it one layer up. See the standing lesson
// that a thing existing is not the same as a user being able to use it.
const ui = readRepoFile('dashboard/js/app.js');
assert(/async function resumePipelineRun\(runId\)/.test(ui), 'the dashboard defines resumePipelineRun');
assert(/\/api\/pipelines\/runs\/\$\{runId\}\/resume`, \{ method: 'POST' \}/.test(ui), 'and POSTs to the resume route');
assert(/onclick="resumePipelineRun\('\$\{run\.id\}'\)"/.test(ui), 'and a button actually calls it');
assert(/run\.status === 'failed'/.test(ui), 'the button appears only on a FAILED run');
assert(/keep \$\{keep\}, retry \$\{redo\}/.test(ui),
  'and its label states how many stages are kept vs retried — "Resume" alone is indistinguishable from a full re-dispatch, which is what everyone did before this existed');
assert(/if \(r && r\.error\) \{ alert\(r\.error\); return; \}/.test(ui),
  'a refusal from the server is shown, not swallowed into a button that appears to do nothing');

fs.rmSync(base, { recursive: true, force: true });
done();
