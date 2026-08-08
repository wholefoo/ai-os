// lib/pipeline-trail.js
// ============================================================
//  The run-scoped paper trail: one file per stage, under one directory per run.
//
//  G4 of .magent/vault/wiki/graph-engineering-eval.md. Before this, a pipeline stage's output lived
//  in `pipelineRuns`, which is `new Map()` — **in memory, never persisted**. Two consequences that
//  are worse than "not diffable":
//
//    1. A restart lost every run. Five stages of Opus output, gone, because the process bounced.
//    2. A FAILED run left nothing at all. The .docx export runs only in completePipelineRun, so a
//       pipeline that died at stage 4 threw away the three stages that had succeeded — the exact
//       work most worth keeping, since the rerun does not need to redo it.
//
//  So stages are written AS THEY COMPLETE, not at the end. A run that fails still leaves its
//  finished work on disk, which is the whole point of a paper trail: it survives the thing that
//  produced it.
//
//  Layout, per run:
//    .magent/runs/<runId>/run.json        manifest — pipeline, params, status, timings, cost, graph
//    .magent/runs/<runId>/01-<stageId>.md one per completed stage, numbered in schedule order
//
//  Numbered because a graph has no single "line 3": the prefix records the LAYER a stage ran in, so
//  a directory listing shows the shape of the run — two files sharing a number ran concurrently.
//
//  PATH SAFETY. runId and stageId reach the filesystem, and stageId comes from a YAML file. Both are
//  reduced to [A-Za-z0-9._-] and any leading dots stripped, so a stage id of `../../etc/passwd`
//  becomes `etcpasswd` and stays inside the run directory. The repo's seclint carries a
//  path-traversal ERROR rule for exactly this shape; the sanitiser is not decoration.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

/** Reduce an untrusted id to something that cannot escape its parent directory. */
function safeSegment(v, fallback = 'unnamed') {
  const s = String(v == null ? '' : v)
    .replace(/[^A-Za-z0-9._-]/g, '')   // kills / \ .. and everything else
    .replace(/^\.+/, '')               // no leading dots — no `.` , `..`, or hidden files
    .slice(0, 80);
  return s || fallback;
}

/** The directory for one run. Created on demand. */
function runDir(baseDir, runId) {
  return path.join(baseDir, safeSegment(runId, 'run'));
}

/**
 * Write one stage's output. Called as the stage completes, so a later failure cannot erase it.
 *
 * @param {string} baseDir   e.g. .magent/runs
 * @param {object} run       the run record
 * @param {object} stage     the completed stage
 * @param {number} layer     1-based schedule layer, for the filename prefix
 * @returns {string|null}    the file written, or null if there was nothing to write
 */
function writeStage(baseDir, run, stage, layer = 0) {
  if (!stage || !stage.output) return null;
  const dir = runDir(baseDir, run && run.id);
  fs.mkdirSync(dir, { recursive: true });

  const prefix = String(Math.max(0, layer)).padStart(2, '0');
  const file = path.join(dir, `${prefix}-${safeSegment(stage.id, 'stage')}.md`);

  // A header a human can read without the manifest open, then the raw deliverable.
  const head = [
    `# ${stage.id}`,
    '',
    `- **run**: ${run.id} (${run.pipeline})`,
    `- **produced by**: ${stage.pattern ? `pattern \`${stage.pattern}\`` : (stage.agent || 'unknown')}`,
    stage.model ? `- **model**: ${stage.model}` : null,
    stage.depends_on && stage.depends_on.length ? `- **depends on**: ${stage.depends_on.join(', ')}` : '- **depends on**: nothing (root stage)',
    `- **completed**: ${stage.completedAt || ''}`,
    stage.patternMeta ? `- **pattern result**: ${JSON.stringify(stage.patternMeta).slice(0, 400)}` : null,
    '',
    '---',
    '',
  ].filter((l) => l !== null).join('\n');

  fs.writeFileSync(file, head + String(stage.output), 'utf8');
  return file;
}

/**
 * Write (or rewrite) the run manifest. Cheap, so it is refreshed on every stage — a run killed
 * mid-flight still has an accurate manifest for the stages that finished.
 *
 * Deliberately excludes stage OUTPUT: that is what the .md files are for, and duplicating it here
 * would make the manifest the second copy that drifts.
 */
function writeManifest(baseDir, run, layers = []) {
  const dir = runDir(baseDir, run && run.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.json');
  const manifest = {
    id: run.id,
    pipeline: run.pipeline,
    description: run.description || '',
    params: run.params || {},
    status: run.status,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    cost: run.cost || 0,
    error: run.error || null,
    // The schedule itself — the thing that makes a graph run reviewable rather than a list of files.
    layers,
    stages: (run.stages || []).map((s) => ({
      id: s.id,
      agent: s.agent || null,
      pattern: s.pattern || null,
      dependsOn: Array.isArray(s.depends_on) ? s.depends_on : [],
      status: s.status,
      model: s.model || null,
      startedAt: s.startedAt || null,
      completedAt: s.completedAt || null,
      error: s.error || null,
      hasOutput: !!s.output,
    })),
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

/** Read a run back off disk — the trail is only useful if something can consume it. */
function readManifest(baseDir, runId) {
  const file = path.join(runDir(baseDir, runId), 'run.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The exact separator writeStage puts between its human-readable header and the raw deliverable.
// Split on the FIRST occurrence only: a deliverable may legitimately contain `---` of its own
// (every stage this pipeline produces is markdown), and splitting on the last — or on all — would
// silently truncate the output it is supposed to recover. The header always precedes the body, so
// the first occurrence is always the right one.
//
// It is `\n---\n` — ONE trailing newline. writeStage joins its header array on '\n' and ends that
// array with ['', '---', ''], yielding `…\n\n---\n`, with the output concatenated straight on. A
// first draft of this constant assumed `\n---\n\n`; that matched the first `---` INSIDE the
// deliverable instead of the header's, silently returning a fragment of the report. Two of the
// tests in tools/test-pipeline-resume.js passed on that broken behaviour — only the byte-for-byte
// round trip caught it. That is why the round trip is the load-bearing test here.
const HEADER_SEP = '\n---\n';

/**
 * Recover one stage's OUTPUT from its .md file.
 *
 * The manifest deliberately excludes output (see writeManifest), so a run rehydrated from disk has
 * every stage's status and none of its work. That was fine while the trail was only for reading;
 * it is not fine now that a failed run can be resumed, because a downstream stage is built from its
 * upstream stages' output and would otherwise resume against empty inputs — producing a confident
 * report derived from nothing. Recovering the text is what makes resume-after-restart honest.
 *
 * Filenames carry a layer prefix (`03-code-scan.md`), and the layer a stage ran in is not
 * necessarily known to the caller, so match on the suffix rather than reconstructing the name.
 *
 * @returns {string|null} the deliverable, or null if there is no file / no recoverable body
 */
function readStageOutput(baseDir, runId, stageId) {
  const dir = runDir(baseDir, runId);
  if (!fs.existsSync(dir)) return null;
  const want = `-${safeSegment(stageId, 'stage')}.md`;
  const file = fs.readdirSync(dir).find((f) => f.endsWith(want));
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
  const i = text.indexOf(HEADER_SEP);
  // No separator means the file is not in the shape writeStage produces. Return null rather than
  // the whole file: handing back a header as though it were the deliverable would feed a stage's
  // own metadata into the next stage as content.
  if (i === -1) return null;
  return text.slice(i + HEADER_SEP.length);
}

/** Every run on disk, newest first. */
function listRuns(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir)
    .map((id) => readManifest(baseDir, id))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

module.exports = { safeSegment, runDir, writeStage, writeManifest, readManifest, readStageOutput, listRuns };
