// Pipeline-report export: slugify/filename derivation, docx rendering for edge-case run shapes
// (zero completed stages, missing params, empty-output stages), the real saveRunDocx integration
// (docx + JSON sidecar written to disk, overwrite-by-run-id semantics, summary derivation stripping
// markdown headings), deleteRunReport (sidecar cleanup + allowlist refusal), listRunReports
// (newest-first, missing-dir tolerance), and the FILE_RE download/delete allowlist itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const pipeline_reports = require('../lib/pipeline-reports');
const { runToDoc, saveRunDocx, deleteRunReport, listRunReports, reportFileFor, slugify, REPORT_FILE_RE: FILE_RE } = pipeline_reports;

const mkRun = (over = {}) => ({
  id: 'run-1700000000000',
  pipeline: 'research-to-report',
  params: { topic: 'AI agent orchestration', citation_style: 'APA' },
  status: 'completed',
  startedAt: '2026-07-18T10:00:00.000Z',
  completedAt: '2026-07-18T10:30:00.000Z',
  cost: 0.42,
  stages: [
    { id: 'research', agent: 'researcher', model: 'opus-5-high', status: 'completed', output: '# Findings\n- point one\n- point two' },
    { id: 'synthesize', agent: 'synthesis', model: 'opus-5-high', status: 'completed', output: 'Synthesis prose with **bold** text.' },
    { id: 'review', agent: 'reviewer', status: 'running', output: null }, // NOT completed — must be excluded
  ],
  ...over,
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-reports-'));

  // --- slugify()
  assert(slugify('Research To Report!!') === 'research-to-report', `lowercases + collapses non-alnum runs (${slugify('Research To Report!!')})`);
  assert(slugify('  --Leading and Trailing--  ') === 'leading-and-trailing', `strips leading/trailing hyphens (${slugify('  --Leading and Trailing--  ')})`);
  assert(slugify('a'.repeat(100)) === 'a'.repeat(60), 'truncates to 60 chars');
  assert(slugify('') === 'pipeline' && slugify(null) === 'pipeline' && slugify(undefined) === 'pipeline', 'empty/null/undefined falls back to "pipeline"');

  // --- reportFileFor()
  const run1 = mkRun({ pipeline: 'Research To Report', id: 'run-1700000000000' });
  const f1 = reportFileFor(run1);
  assert(FILE_RE.test(f1), `reportFileFor output matches FILE_RE (${f1})`);
  assert(f1 === 'pipeline-research-to-report-run-1700000000000.docx', `slugifies pipeline name into filename (${f1})`);
  const numericPart = String(run1.id).replace(/^run-/, '');
  assert(f1.includes(numericPart), `run id's numeric part appears in the filename (${f1})`);

  // --- runToDoc(): must not throw for various run shapes
  assert(!!runToDoc(mkRun()), 'runToDoc returns a truthy Document for a normal run (2 completed + 1 non-completed stage)');
  assert(!!runToDoc(mkRun({ stages: [{ id: 'x', agent: 'a', status: 'running', output: null }] })), 'runToDoc does not throw for zero completed stages');
  const runNoParams = mkRun();
  delete runNoParams.params;
  assert(!!runToDoc(runNoParams), 'runToDoc does not throw when run has no params key at all');
  assert(!!runToDoc(mkRun({ stages: [{ id: 'empty', agent: 'a', status: 'completed', output: '' }] })), 'runToDoc does not throw for a completed stage with empty-string output');

  // --- saveRunDocx(): the real integration test
  const meta = await saveRunDocx(mkRun(), dir);
  for (const k of ['file', 'runId', 'pipeline', 'status', 'params', 'startedAt', 'completedAt', 'cost', 'stageCount', 'totalStages', 'createdAt', 'summary']) {
    assert(k in meta, `meta object has "${k}"`);
  }
  assert(meta.stageCount === 2, `stageCount counts only completed stages with output (got ${meta.stageCount})`);
  assert(meta.totalStages === 3, `totalStages counts all stages (got ${meta.totalStages})`);

  const docxPath = path.join(dir, meta.file);
  assert(fs.existsSync(docxPath), 'docx file actually exists on disk');
  const buf = fs.readFileSync(docxPath);
  assert(buf.length > 1000, `docx is non-trivial in size (${buf.length} bytes)`);
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'docx starts with PK zip magic bytes');

  const sidecarPath = docxPath.replace(/\.docx$/, '.json');
  assert(fs.existsSync(sidecarPath), 'JSON sidecar file exists');
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert(sidecar.file === meta.file && sidecar.runId === meta.runId && sidecar.stageCount === meta.stageCount, 'sidecar JSON matches the returned meta');

  assert(typeof meta.summary === 'string' && meta.summary.length > 0, 'summary is a non-empty string');
  assert(!/^#/.test(meta.summary), 'summary does not start with a markdown heading line');
  assert(meta.summary.includes('Synthesis prose'), `summary is derived from the LAST completed stage's output (${meta.summary})`);

  // --- overwrite-by-run-id: re-saving the SAME run overwrites, no numbered duplicate
  const before = fs.readdirSync(dir).filter((f) => FILE_RE.test(f));
  await saveRunDocx(mkRun(), dir);
  const after = fs.readdirSync(dir).filter((f) => FILE_RE.test(f));
  assert(before.length === 1 && after.length === 1 && after[0] === before[0], 'saving the same run twice overwrites the same file, no duplicate');

  // --- two different run ids produce two different files, both exist
  const runB = mkRun({ id: 'run-1700000000001' });
  const metaB = await saveRunDocx(runB, dir);
  assert(metaB.file !== meta.file, `different run ids produce different filenames (${meta.file} vs ${metaB.file})`);
  assert(fs.existsSync(path.join(dir, meta.file)) && fs.existsSync(path.join(dir, metaB.file)), 'both files exist after saving two different runs');

  // --- deleteRunReport()
  assert(deleteRunReport(dir, metaB.file) === true, 'deleteRunReport removes an existing report');
  assert(!fs.existsSync(path.join(dir, metaB.file)) && !fs.existsSync(path.join(dir, metaB.file.replace(/\.docx$/, '.json'))), 'both docx AND json sidecar are gone');
  assert(deleteRunReport(dir, metaB.file) === false, 'deleting the same file again returns false (already gone)');
  assert(deleteRunReport(dir, 'pipeline-never-existed-run-999.docx') === false, 'deleting a file that never existed returns false');
  assert(deleteRunReport(dir, '../../etc/passwd') === false, 'deleteRunReport refuses non-allowlisted traversal names without touching the filesystem');
  assert(deleteRunReport(dir, 'evil.docx') === false, 'deleteRunReport refuses non-allowlisted plain names');
  assert(deleteRunReport(dir, 'pipeline-x-run-abc.docx') === false, 'deleteRunReport refuses a non-digit run number');

  // --- listRunReports()
  // Re-seed a clean pair of runs for listing checks (meta.file was left behind above; add a second).
  // A tiny artificial delay guarantees a distinct createdAt tick so the newest-first sort is
  // deterministic rather than relying on incidental wall-clock drift between the two saves.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const metaC = await saveRunDocx(mkRun({ id: 'run-1700000000002' }), dir);
  const list = listRunReports(dir);
  assert(list.length === 2, `listRunReports returns 2 entries after saving 2 runs (got ${list.length})`);
  for (const entry of list) {
    for (const k of ['file', 'runId', 'pipeline', 'status', 'size', 'createdAt', 'stageCount', 'totalStages', 'summary']) {
      assert(k in entry, `listRunReports entry has "${k}"`);
    }
  }
  assert(new Date(list[0].createdAt).getTime() >= new Date(list[1].createdAt).getTime(), 'listRunReports is sorted newest-first by createdAt');
  assert(list[0].file === metaC.file, `most-recently-saved run (${metaC.file}) sorts first (got ${list[0].file})`);

  assert(deleteRunReport(dir, metaC.file) === true, 'deleteRunReport removes the newer report');
  const listAfterDelete = listRunReports(dir);
  assert(listAfterDelete.length === 1 && listAfterDelete[0].file === meta.file, 'after deletion, listRunReports returns only the remaining one');

  const missingDir = path.join(dir, 'does-not-exist-at-all');
  assert(Array.isArray(listRunReports(missingDir)) && listRunReports(missingDir).length === 0, 'listRunReports on a nonexistent directory returns [] without throwing');

  // --- FILE_RE allowlist sanity
  for (const bad of ['../../etc/passwd', 'pipeline-x-run-1.docx.exe', 'evil.docx', 'run-123.docx']) {
    assert(!FILE_RE.test(bad), `allowlist rejects "${bad}"`);
  }
  for (const good of ['pipeline-research-to-report-run-1700000000000.docx', 'pipeline-a-run-1.docx']) {
    assert(FILE_RE.test(good), `allowlist accepts "${good}"`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
