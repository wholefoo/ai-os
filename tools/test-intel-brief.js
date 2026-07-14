// Intel-brief pipeline: mock-runner end-to-end (no API calls) — verifies the consultant fan-out
// composes, the comms-director statement renders to a real .docx, the sidecar metadata + listing
// work, and the download-route filename allowlist can't be walked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const { runIntelBrief, listBriefs, FILE_RE, CONSULTANTS } = require('../lib/intel-brief');

const STATEMENT = [
  '# Daily Intelligence Statement — Test Day',
  '## Executive Summary',
  'All providers **stable**. One pricing change detected.',
  '## Latest Provider Updates',
  '- Anthropic: Opus 4.8 unchanged',
  '- OpenAI: new mini tier',
  '## Suggested Implementations',
  '- Bump COST_RATES for the new tier',
].join('\n');

function mockRunner({ failAgents = [] } = {}) {
  const calls = [];
  return {
    calls,
    runAgent: async (agent, task, opts) => {
      calls.push({ agent, opts });
      if (failAgents.includes(agent)) return { ok: false, error: 'simulated outage' };
      if (agent === 'comms-director') return { ok: true, content: STATEMENT };
      return { ok: true, content: `${agent} report: no significant updates.` };
    },
    log: () => {},
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-brief-'));

  // --- happy path: all 7 consultants report, docx + sidecar written, listing sees it
  const deps = mockRunner();
  const meta = await runIntelBrief(deps, { dir, useMcpTools: false });
  assert(FILE_RE.test(meta.file), `filename matches allowlist (${meta.file})`);
  assert(meta.consultantsReported === CONSULTANTS.length, `all ${CONSULTANTS.length} consultants reported`);
  const buf = fs.readFileSync(path.join(dir, meta.file));
  assert(buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b, 'docx is a real non-trivial zip (PK magic)');
  assert(fs.existsSync(path.join(dir, meta.file.replace(/\.docx$/, '.json'))), 'metadata sidecar written');
  const consulted = deps.calls.filter((c) => c.agent.startsWith('consultant-')).map((c) => c.agent);
  assert(CONSULTANTS.every((c) => consulted.includes(c)), 'every consultant was actually called');
  assert(deps.calls.some((c) => c.agent === 'orchestrator') && deps.calls.some((c) => c.agent === 'architect'), 'orchestrator + architect both reviewed');
  assert(deps.calls.filter((c) => c.agent === 'comms-director').length === 1, 'comms-director wrote exactly one statement');

  // --- listing: newest first, carries summary + count
  const briefs = listBriefs(dir);
  assert(briefs.length === 1 && briefs[0].file === meta.file, 'listBriefs returns the brief');
  assert(briefs[0].consultantsReported === CONSULTANTS.length && briefs[0].summary.length > 0, 'listing carries metadata');

  // --- same-day rerun never overwrites: suffixing kicks in
  const meta2 = await runIntelBrief(mockRunner(), { dir, useMcpTools: false });
  assert(meta2.file !== meta.file && /-2\.docx$/.test(meta2.file), `same-day rerun suffixes (${meta2.file})`);
  assert(listBriefs(dir).length === 2, 'both briefs listed');

  // --- graceful degradation: two consultants down → run still completes and reports the shortfall
  const partial = await runIntelBrief(mockRunner({ failAgents: ['consultant-grok', 'consultant-manus'] }), { dir, useMcpTools: false });
  assert(partial.consultantsReported === CONSULTANTS.length - 2, 'partial consultant outage degrades gracefully');

  // --- hard failure: comms-director down → run throws (no empty docx is ever written)
  const before = fs.readdirSync(dir).length;
  let threw = false;
  try { await runIntelBrief(mockRunner({ failAgents: ['comms-director'] }), { dir, useMcpTools: false }); } catch { threw = true; }
  assert(threw, 'comms-director failure aborts the run');
  assert(fs.readdirSync(dir).length === before, 'aborted run writes no files');

  // --- download allowlist: traversal / foreign names rejected
  for (const bad of ['../../etc/passwd', 'intel-brief-2026-07-13.docx.exe', 'evil.docx', 'intel-brief-20260713.docx']) {
    assert(!FILE_RE.test(bad), `allowlist rejects "${bad}"`);
  }
  assert(FILE_RE.test('intel-brief-2026-07-13.docx') && FILE_RE.test('intel-brief-2026-07-13-2.docx'), 'allowlist accepts our own names');

  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
