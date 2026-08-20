// lib/pipeline-reports.js — export a Pipeline Engine run as a downloadable, deletable .docx.
//
// The Pipeline Engine (.claude/pipelines/*.yaml, server.js's executePipeline/runPipelineStages)
// has no UI to actually READ a stage's output text — only a status-dot flow diagram. Worse, run
// HISTORY itself lives only in an in-memory Map (server.js `pipelineRuns`), so a run's results are
// gone forever on the next restart unless captured to disk. This renders the full run — every
// completed stage as its own section, in reading order — to a real .docx the moment the run
// completes, so results are durable, readable, and shareable regardless of what happens to the
// live process afterward.
//
// Filename identity rides the run's own id (`run-<timestamp>`), which is unique by construction —
// no date-collision/suffixing logic needed, unlike lib/intel-brief.js's once-per-kind-per-day files.

const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const { markdownToParagraphs, bulletNumberingConfig } = require('./docx-markdown');
const { writeDocxPair, deleteDocxPair, listDocxPairs } = require('./docx-store');

// Download/delete route allowlist — only filenames this module itself generates are servable.
const REPORT_FILE_RE = /^pipeline-[a-z0-9-]+-run-\d+\.docx$/;

function slugify(s) {
  return String(s || 'pipeline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pipeline';
}

function reportFileFor(run) {
  const runNum = String(run.id || '').replace(/^run-/, '').replace(/[^0-9]/g, '') || Date.now();
  return `pipeline-${slugify(run.pipeline)}-run-${runNum}.docx`;
}

// Render every completed stage (in order) as its own H1 section, agent/model attributed, with the
// stage's raw markdown-ish output rendered underneath. A run with zero completed stages still
// produces a valid (near-empty) document rather than throwing.
function runToDoc(run) {
  const stages = (run.stages || []).filter((s) => s.status === 'completed' && s.output);
  const paramsLine = run.params && Object.keys(run.params).length
    ? Object.entries(run.params).map(([k, v]) => `${k}: ${v}`).join('   |   ')
    : '';

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(String(run.pipeline || 'Pipeline').replace(/-/g, ' '))] }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: paramsLine ? 60 : 300 },
      children: [new TextRun({ text: `Run ${run.id} — ${run.status}${run.completedAt ? ' — ' + new Date(run.completedAt).toLocaleString() : ''}`, italics: true })],
    }),
  ];
  if (paramsLine) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: paramsLine, italics: true })] }));
  }
  if (!stages.length) {
    children.push(new Paragraph({ children: [new TextRun('This run has no completed stage output yet.')] }));
  }
  for (const s of stages) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 },
      children: [new TextRun(`${s.id} (${s.agent}${s.model ? ' — ' + s.model : ''})`)],
    }));
    children.push(...markdownToParagraphs(s.output));
  }

  return new Document({
    numbering: { config: [bulletNumberingConfig()] },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
}

// Render + persist to `dir`. Always overwrites the SAME run's file (re-exporting/re-completing a
// run should refresh its report, not pile up duplicates — unlike intel-brief's once-per-day files).
async function saveRunDocx(run, dir) {
  const file = reportFileFor(run);
  const completedStages = (run.stages || []).filter((s) => s.status === 'completed');
  const lastOutput = completedStages.length ? String(completedStages[completedStages.length - 1].output || '') : '';
  return writeDocxPair({
    dir, file, doc: runToDoc(run),
    meta: {
      file, runId: run.id, pipeline: run.pipeline, status: run.status, params: run.params || {},
      startedAt: run.startedAt || null, completedAt: run.completedAt || null, cost: run.cost || 0,
      stageCount: completedStages.length, totalStages: (run.stages || []).length,
      createdAt: new Date().toISOString(),
      summary: lastOutput.replace(/^#.*$/gm, '').trim().slice(0, 500),
    },
  });
}

function deleteRunReport(dir, file) {
  return deleteDocxPair(dir, file, REPORT_FILE_RE);
}

function listRunReports(dir) {
  return listDocxPairs(dir, REPORT_FILE_RE, (f, meta) => ({
    runId: meta.runId || null, pipeline: meta.pipeline || 'pipeline',
    status: meta.status || 'unknown',
    startedAt: meta.startedAt || null, completedAt: meta.completedAt || null,
    cost: meta.cost || 0, stageCount: meta.stageCount ?? null, totalStages: meta.totalStages ?? null,
  }));
}

module.exports = { runToDoc, saveRunDocx, deleteRunReport, listRunReports, reportFileFor, slugify, REPORT_FILE_RE };
