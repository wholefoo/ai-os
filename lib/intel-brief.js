// lib/intel-brief.js — Daily LLM-consultant intelligence brief → Communications Director statement → .docx
//
// The pipeline the org chart already documents, made real:
//   1. FAN OUT: all 7 LLM provider consultants report the latest intel on their own provider
//      (each runs on its own provider's model via server.js CONSULTANT_PROVIDER routing).
//   2. SYNTHESIZE: the synthesis agent reduces 7 reports into one de-duplicated intel picture.
//   3. REVIEW: the Orchestrator gives a strategic assessment; the Architect turns it into
//      concrete suggested implementations for THIS platform.
//   4. STATEMENT: the Communications Director writes the official daily statement.
//   5. RENDER: the statement becomes a .docx (via the pinned `docx` package) saved under
//      data/intel-briefs/ with a JSON sidecar the dashboard lists for download.
//
// Composed over the injected-runner orchestration kernel (lib/orchestrator.js) so the whole run
// shares executeAgent's routing, cost ledger, and Auto-Mode gates — no bespoke model calls here.

const fs = require('fs');
const path = require('path');
const { fanOutAndSynthesize } = require('./orchestrator');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat } = require('docx');

const CONSULTANTS = [
  'consultant-anthropic', 'consultant-openai', 'consultant-gemini',
  'consultant-deepseek', 'consultant-grok', 'consultant-perplexity', 'consultant-manus',
];

// Download/delete route allowlist — only filenames this module itself generates are servable.
const KINDS = {
  'intel-brief': 'Daily Intelligence Statement',
  'tech-radar': 'Daily Intelligence Sweep',
  'research-brief': 'Daily Research Brief',
};
const FILE_RE = /^(intel-brief|tech-radar|research-brief)-\d{4}-\d{2}-\d{2}(-\d+)?\.docx$/;

// ---------- markdown-ish → docx ----------
// The comms-director writes prose with #/## headings and - bullets; render those faithfully and
// treat everything else as body paragraphs. Deliberately simple — no tables, no inline styling
// beyond **bold**, so a weird model output degrades to plain readable paragraphs, never a crash.
function mdRuns(line) {
  const runs = [];
  const parts = String(line).split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    runs.push(new TextRun({ text: m ? m[1] : p, bold: !!m }));
  }
  return runs.length ? runs : [new TextRun('')];
}

function statementToDoc({ title, dateLabel, statement }) {
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(title)] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: `Office of the Communications Director — ${dateLabel}`, italics: true })] }),
  ];
  for (const raw of String(statement).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1].length - 1];
      children.push(new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: mdRuns(h[2]) }));
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) {
      children.push(new Paragraph({ numbering: { reference: 'brief-bullets', level: 0 }, children: mdRuns(b[1]) }));
      continue;
    }
    children.push(new Paragraph({ spacing: { after: 120 }, children: mdRuns(line) }));
  }
  return new Document({
    numbering: {
      config: [{
        reference: 'brief-bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
}

// ---------- the run ----------
// deps = { runAgent, log?, broadcast? } — runAgent is server.js executeAgent.
async function runIntelBrief(deps, { dir, useMcpTools = true } = {}) {
  const log = (deps && deps.log) || (() => {});
  const date = new Date().toISOString().slice(0, 10);
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // 1+2. Consultants fan out, synthesis reduces. Each consultant sticks to ITS provider.
  const fanTask = 'Report the latest verified intelligence on YOUR provider (releases, model/API changes, pricing, deprecations, capabilities) from roughly the last 7 days, and note anything directly relevant to the AI OS platform. Be factual and cite what you verified; say "no significant updates" if that is the truth.';
  const fan = await fanOutAndSynthesize(fanTask, CONSULTANTS.map((agent) => ({ agent })), deps, {
    agentOpts: { useMcpTools, maxTokens: 2500, skill: 'intel-brief:consultant' },
    synthOpts: { maxTokens: 4000, skill: 'intel-brief:synthesis' },
  });
  if (!fan.ok || !fan.synthesis) throw new Error(fan.error || 'consultant fan-out produced no synthesis');
  const reported = fan.parts.filter((p) => p.ok).length;
  log(`[intel-brief] ${reported}/${CONSULTANTS.length} consultants reported; synthesis ready`);

  // 3. Strategic review — Orchestrator assesses, Architect proposes implementations.
  const run = (agent, task, maxTokens) => deps.runAgent(agent, task, { maxTokens, skill: `intel-brief:${agent}` });
  const [assess, impl] = await Promise.all([
    run('orchestrator', `Today's synthesized LLM-provider intelligence is below. Give a concise strategic assessment for the AI OS platform: what matters, what is noise, and what deserves action. Under 400 words.\n\n--- INTEL ---\n${fan.synthesis}`, 2000),
    run('architect', `Today's synthesized LLM-provider intelligence is below. Propose the top 3-5 concrete suggested implementations for the AI OS platform (what to change, where, expected benefit, rough effort). Only propose things this intel actually justifies. Under 500 words.\n\n--- INTEL ---\n${fan.synthesis}`, 2500),
  ]);

  // 4. The Communications Director's statement.
  const comms = await run('comms-director', [
    `Write today's official daily statement for the platform owner, as the Communications Director.`,
    `Structure it in markdown with exactly these sections:`,
    `# Daily Intelligence Statement — ${dateLabel}`,
    `## Executive Summary  (3-5 sentences)`,
    `## Latest Provider Updates  (bulleted, grouped by provider, only what the intel supports)`,
    `## Strategic Assessment  (from the Orchestrator's review)`,
    `## Suggested Implementations  (from the Architect's proposals — keep their concrete detail)`,
    `## Sources & Confidence  (what was verified vs. unconfirmed; which consultants had no updates)`,
    ``,
    `Be precise and readable — this is a decision document, not marketing copy. Do not invent facts beyond the inputs.`,
    ``,
    `--- SYNTHESIZED INTEL ---\n${fan.synthesis}`,
    `--- ORCHESTRATOR ASSESSMENT ---\n${(assess && assess.ok && assess.content) || '(orchestrator review unavailable)'}`,
    `--- ARCHITECT PROPOSALS ---\n${(impl && impl.ok && impl.content) || '(architect proposals unavailable)'}`,
  ].join('\n'), 4000);
  if (!comms || !comms.ok || !comms.content) throw new Error((comms && comms.error) || 'comms-director produced no statement');

  // 5. Render + persist.
  const meta = await saveBriefDocx({
    dir, kind: 'intel-brief', statement: comms.content,
    extraMeta: { consultantsReported: reported, consultantsTotal: CONSULTANTS.length },
  });
  log(`[intel-brief] wrote ${meta.file}`);
  return meta;
}

// Render any agent-produced markdown-ish statement to a .docx in the briefs dir. Shared by the
// intel-brief pipeline and the scheduler's tech-radar / research-brief runs. Never overwrites an
// earlier same-day file — suffixes instead.
async function saveBriefDocx({ dir, kind, statement, extraMeta = {} }) {
  if (!KINDS[kind]) throw new Error(`unknown brief kind: ${kind}`);
  const date = new Date().toISOString().slice(0, 10);
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  fs.mkdirSync(dir, { recursive: true });
  let file = `${kind}-${date}.docx`;
  for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${kind}-${date}-${n}.docx`;
  const doc = statementToDoc({ title: `AI OS ${KINDS[kind]}`, dateLabel, statement });
  fs.writeFileSync(path.join(dir, file), await Packer.toBuffer(doc));
  const meta = {
    file, kind, date, createdAt: new Date().toISOString(), ...extraMeta,
    summary: String(statement).replace(/^#.*$/gm, '').trim().slice(0, 500),
  };
  fs.writeFileSync(path.join(dir, file.replace(/\.docx$/, '.json')), JSON.stringify(meta, null, 2));
  return meta;
}

// Delete one brief (docx + sidecar). Caller must have validated `file` against FILE_RE.
function deleteBrief(dir, file) {
  if (!FILE_RE.test(file)) return false;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  try { fs.unlinkSync(full.replace(/\.docx$/, '.json')); } catch {}
  return true;
}

function listBriefs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => FILE_RE.test(f))
      .map((f) => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.docx$/, '.json')), 'utf8')); } catch {}
        const stat = fs.statSync(path.join(dir, f));
        const m = f.match(FILE_RE);
        const kind = meta.kind || (m && m[1]) || 'intel-brief';
        return {
          file: f, kind, kindLabel: KINDS[kind] || kind, size: stat.size,
          createdAt: meta.createdAt || stat.mtime.toISOString(),
          date: meta.date || ((f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || ''),
          consultantsReported: meta.consultantsReported ?? null, summary: meta.summary || '',
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { return []; }
}

module.exports = { runIntelBrief, saveBriefDocx, deleteBrief, listBriefs, FILE_RE, CONSULTANTS };
