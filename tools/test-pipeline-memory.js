// tools/test-pipeline-memory.js
// ============================================================
//  Compounding memory: a stage learns from ITS OWN failures on previous runs of the same pipeline.
//  The docx's last contract component.
//
//  THE ASSERTION THAT MATTERS MOST is the negative one. Injected memory changes what an agent does,
//  so remembering the wrong thing is worse than remembering nothing:
//
//    - ENVIRONMENTAL failures are NOT remembered. The real trail on this machine contains
//      run-1786164291515, which failed with "You have reached your specified API usage limits".
//      Injecting that would tell an agent it failed before and advise a tighter deliverable —
//      advice that is actively WRONG, because the account was out of credit and nothing about the
//      work caused or can fix it. That case was found in the DATA, not imagined, and it is pinned
//      below with the verbatim string.
//    - SUCCESS is not remembered either. A stage that has worked five times needs no reminder, and
//      saying so would crowd out the one line that matters.
//    - NO history means NO injection, so a first run's prompt is unchanged from before this
//      feature existed. Memory must be additive or it is a silent rewrite of every prompt.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const trail = require('../lib/pipeline-trail.js');
const memory = require('../lib/pipeline-memory.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-mem-'));

/** Write a run to the trail with the real writer, so fixtures cannot drift from the format. */
let seq = 0;
function writeRun(pipeline, stages, status = 'completed') {
  const run = {
    id: `run-fixture-${++seq}`,
    pipeline,
    status,
    startedAt: new Date(1700000000000 + seq * 1000).toISOString(),
    params: {},
    stages,
  };
  trail.writeManifest(TMP, run, []);
  return run.id;
}

ok('no history -> no injection (a first run is unchanged)', () => {
  assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: 'nothing-here', stageId: 'a' }), '');
});

ok('a stage that only SUCCEEDED is not remembered', () => {
  writeRun('p-success', [{ id: 'draft', status: 'completed', error: null }]);
  assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: 'p-success', stageId: 'draft' }), '');
});

ok('a real FAILURE is remembered, with its reason', () => {
  writeRun('p-fail', [{ id: 'draft', status: 'failed', error: 'output exceeded the 12000 token limit' }], 'failed');
  const n = memory.priorStageNotes(TMP, { pipeline: 'p-fail', stageId: 'draft' });
  assert.ok(n.includes('failed'), 'the note must say it failed');
  assert.ok(/token limit/.test(n), `the reason must survive: ${n}`);
});

// THE CASE FOUND IN THE REAL TRAIL — verbatim.
ok('an ENVIRONMENTAL failure is NOT remembered (spend cap is weather, not a lesson)', () => {
  writeRun('p-env', [{
    id: 'architecture',
    status: 'failed',
    error: 'You have reached your specified API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.',
  }], 'failed');
  assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: 'p-env', stageId: 'architecture' }), '',
    'a spend cap must not become "you failed before, produce a tighter deliverable"');
});

ok('other environmental shapes are filtered too (rate limit, 503, ECONNREFUSED)', () => {
  for (const err of ['429 rate limit exceeded', 'Service Unavailable (503)', 'connect ECONNREFUSED 127.0.0.1:443', 'upstream overloaded']) {
    const p = `p-env-${err.slice(0, 6).replace(/\W/g, '')}`;
    writeRun(p, [{ id: 's', status: 'failed', error: err }], 'failed');
    assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: p, stageId: 's' }), '', `not filtered: ${err}`);
  }
});

ok('memory is scoped to the STAGE — another stage\'s failure is not injected', () => {
  writeRun('p-scope', [
    { id: 'research', status: 'failed', error: 'research blew up' },
    { id: 'compile', status: 'completed', error: null },
  ], 'failed');
  assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: 'p-scope', stageId: 'compile' }), '',
    'compile must not hear about research');
  assert.ok(memory.priorStageNotes(TMP, { pipeline: 'p-scope', stageId: 'research' }).includes('blew up'));
});

ok('memory is scoped to the PIPELINE — another pipeline\'s failure is not injected', () => {
  writeRun('p-other', [{ id: 'draft', status: 'failed', error: 'unrelated explosion' }], 'failed');
  const n = memory.priorStageNotes(TMP, { pipeline: 'p-success', stageId: 'draft' });
  assert.ok(!/unrelated explosion/.test(n), 'history must not leak across pipelines');
});

ok('the CURRENT run is excluded — a run is not its own history', () => {
  const id = writeRun('p-self', [{ id: 'draft', status: 'failed', error: 'self reference' }], 'failed');
  assert.strictEqual(memory.priorStageNotes(TMP, { pipeline: 'p-self', stageId: 'draft', excludeRunId: id }), '');
});

ok('notes are bounded — long reasons are clipped, and at most MAX_NOTES are listed', () => {
  const long = 'x'.repeat(600);
  for (let i = 0; i < memory.MAX_NOTES + 3; i++) {
    writeRun('p-bound', [{ id: 'draft', status: 'failed', error: long }], 'failed');
  }
  const n = memory.priorStageNotes(TMP, { pipeline: 'p-bound', stageId: 'draft' });
  assert.ok((n.match(/- run /g) || []).length <= memory.MAX_NOTES, 'too many notes');
  assert.ok(!n.includes(long), 'a 600-char reason must be clipped, not pasted whole');
  // The clip must respect MAX_REASON, or "bounded" is a claim rather than a limit. `fallow
  // dead-code` flagged MAX_REASON as an unused export, which was correct: the bound was not
  // actually being asserted anywhere.
  for (const line of n.split('\n').filter((l) => l.startsWith('- run '))) {
    assert.ok(line.length <= memory.MAX_REASON + 80,
      `a note line exceeded the clip budget (${line.length}): ${line.slice(0, 60)}…`);
  }
});

ok('the lookback window is MAX_RUNS — an older failure falls out of memory', () => {
  // One ancient failure, then MAX_RUNS more recent runs that all SUCCEEDED. The failure is now
  // outside the window and must not be reported: memory is recent history, not a permanent record.
  writeRun('p-window', [{ id: 'draft', status: 'failed', error: 'ancient breakage' }], 'failed');
  for (let i = 0; i < memory.MAX_RUNS; i++) {
    writeRun('p-window', [{ id: 'draft', status: 'completed', error: null }]);
  }
  const n = memory.priorStageNotes(TMP, { pipeline: 'p-window', stageId: 'draft' });
  assert.ok(!/ancient breakage/.test(n),
    `a failure older than MAX_RUNS (${memory.MAX_RUNS}) runs must fall out of the window, got: ${n}`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL TESTS PASSED\n${pass} assertions`);
