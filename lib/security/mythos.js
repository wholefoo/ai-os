// lib/security/mythos.js
// ============================================================
//  Constrained Node -> Python bridge to the `mythos` security CLI (github.com/wholefoo/mythos-defense).
//  AI OS shells out to mythos for AI-driven security assessment (STRIDE threat model -> red/blue team
//  -> patch -> verify -> supply-chain -> deployment-hardening) and parses its structured findings.
//
//  SAFETY (paramount):
//   - spawn() with an ARG ARRAY, never a shell string (no command injection).
//   - the target workspace MUST resolve (realpath) inside an explicit allow-list of roots — never an
//     arbitrary path (no traversal, no scanning the whole disk).
//   - `mythos assess` APPLIES PATCHES IN-PLACE. Callers decide the mode: report-only contexts must use
//     threatModel()/audit()/assess({patch:false-equivalent via a copy}). NEVER point assess at the live
//     AI OS tree — the caller is responsible for passing a disposable copy when patching is desired.
//   - per-run timeout + output-size caps; ANTHROPIC_API_KEY injected from settings, never logged.
//   - degrades gracefully: if the CLI isn't installed, every call returns { ok:false, available:false }.
// ============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let CFG = {
  enabled: false,
  bin: 'mythos',
  adapter: 'semgrep',          // 'semgrep' (real static analysis) | 'mock' (fixtures)
  maxTokens: 200000,           // per-assessment token budget (cost cap)
  maxIterations: 3,
  anthropicKey: '',
  outDir: null,                // base dir for run artifacts (under .magent/state/security)
  allowRoots: [],              // realpath-resolved roots a workspace may live under
  timeoutMs: 15 * 60 * 1000,   // 15 min hard cap per assessment
  semgrepBin: 'semgrep',       // fast READ-ONLY scanner for the publish gate (mythos's red-team engine)
  semgrepConfig: 'auto',       // semgrep ruleset passed to --config
};

function configure(opts = {}) { CFG = { ...CFG, ...opts }; if (CFG.outDir) { try { fs.mkdirSync(CFG.outDir, { recursive: true }); } catch {} } }
function isEnabled() { return !!CFG.enabled; }

// Resolve + validate a workspace path: must be a real dir inside one of the allowed roots.
function resolveSafeWorkspace(ws, { requireSubdir = false } = {}) {
  if (!ws) throw new Error('workspace is required');
  const real = fs.realpathSync(path.resolve(ws));
  // requireSubdir=true forbids an allow-root itself (only a sub-path) — used by assess() so the
  // in-place patcher can NEVER run on the live tree, only on a disposable copy beneath it.
  const ok = (CFG.allowRoots || []).some((root) => {
    try { const r = fs.realpathSync(root); return requireSubdir ? real.startsWith(r + path.sep) : (real === r || real.startsWith(r + path.sep)); } catch { return false; }
  });
  if (!ok) throw new Error(requireSubdir ? 'workspace must be a sub-directory of an allowed root (not the root itself)' : 'workspace is outside the allowed roots');
  if (!fs.statSync(real).isDirectory()) throw new Error('workspace is not a directory');
  return real;
}

// Low-level runner. Returns { code, out, err, killed }. Never throws.
function runBin(bin, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: '1', PYTHONUNBUFFERED: '1' };
    if (CFG.anthropicKey) env.ANTHROPIC_API_KEY = CFG.anthropicKey;
    // Put the configured mythos/semgrep dirs on PATH so the mythos CLI can find its semgrep adapter
    // even when the parent (e.g. a PM2 service user) has a minimal PATH that omits the venv bin dir.
    const extraDirs = [CFG.bin, CFG.semgrepBin].filter((b) => b && path.isAbsolute(b)).map((b) => path.dirname(b));
    if (extraDirs.length) env.PATH = [...new Set(extraDirs)].join(path.delimiter) + path.delimiter + (env.PATH || '');
    let child;
    try {
      child = spawn(bin, args, { cwd, env, windowsHide: true });
    } catch (e) { return resolve({ code: -1, out: '', err: e.message, killed: false }); }
    let out = '', err = '', killed = false;
    const cap = (s, max) => (s.length > max ? s.slice(-max) : s);
    const t = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs || CFG.timeoutMs);
    child.stdout.on('data', (d) => { out = cap(out + d, 8e6); });
    child.stderr.on('data', (d) => { err = cap(err + d, 2e6); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message || String(e), killed }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, killed }); });
  });
}
const run = (args, opts) => runBin(CFG.bin, args, opts); // mythos CLI

// `mythos doctor` — availability + tool checks. Always resolves (never throws).
async function doctor() {
  if (!CFG.enabled) return { available: false, reason: 'disabled in settings' };
  const r = await run(['doctor'], { timeoutMs: 30000 });
  if (r.code === -1) return { available: false, reason: 'mythos CLI not found (install Python 3.11+ and `pip install mythos-defense`)', detail: r.err.slice(0, 300) };
  const text = `${r.out}\n${r.err}`;
  const passed = (label) => new RegExp(`pass[^\\n]*${label}|${label}[^\\n]*pass`, 'i').test(text);
  return {
    available: true,
    anthropicKey: passed('ANTHROPIC_API_KEY') || !!CFG.anthropicKey,
    semgrep: passed('semgrep'),
    adapter: CFG.adapter,
    raw: text.trim().slice(0, 1500),
  };
}

// Write a brief to a temp file (mythos -b accepts a path or inline; a file is safest for long briefs).
function writeBrief(runDir, brief) {
  const p = path.join(runDir, 'brief.md');
  fs.writeFileSync(p, String(brief || 'Security assessment.'));
  return p;
}

function newRunDir(label) {
  const id = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(CFG.outDir || path.join(process.cwd(), '.security'), id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

// `mythos threat-model -b <brief>` — READ-ONLY (no scan, no patches). Returns the STRIDE model JSON.
async function threatModel({ brief } = {}) {
  if (!CFG.enabled) return { ok: false, available: false };
  const { dir } = newRunDir('tm');
  try {
    const briefPath = writeBrief(dir, brief);
    const r = await run(['threat-model', '-b', briefPath], { timeoutMs: 5 * 60 * 1000 });
    if (r.code === -1) return { ok: false, available: false, error: r.err.slice(0, 300) };
    let model = null; try { model = JSON.parse(r.out); } catch { /* mythos prints JSON to stdout */ }
    return { ok: !!model, model, raw: model ? undefined : r.out.slice(0, 2000), error: model ? undefined : (r.err.slice(0, 300) || 'could not parse threat model JSON') };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// `mythos assess` — full loop. WARNING: applies patches IN-PLACE in `workspace`. Pass a disposable copy
// if you don't want the originals modified. Returns parsed report.json. options: { workspace, brief,
// adapter, maxTokens, maxIterations }.
async function assess({ workspace, brief, adapter, maxTokens, maxIterations } = {}) {
  if (!CFG.enabled) return { ok: false, available: false };
  const ws = resolveSafeWorkspace(workspace, { requireSubdir: true }); // assess patches in-place — never an allow-root itself
  const { dir } = newRunDir('assess');
  const outBase = path.join(dir, 'out');
  try {
    const briefPath = writeBrief(dir, brief);
    const args = [
      'assess', '-w', ws, '-b', briefPath,
      '-a', adapter || CFG.adapter,
      '-o', outBase,
      '--max-tokens', String(maxTokens || CFG.maxTokens),
      '--max-iterations', String(maxIterations || CFG.maxIterations),
    ];
    const r = await run(args);
    // assess exit: 0 = clean, 2 = unresolved findings, 1 = no API key, -1 = not installed.
    if (r.code === -1) return { ok: false, available: false, error: r.err.slice(0, 300) };
    if (r.killed) return { ok: false, available: true, error: 'assessment timed out', timedOut: true };
    const report = readReport(outBase);
    if (!report) return { ok: false, available: true, exitCode: r.code, error: r.err.slice(0, 400) || 'no report.json produced' };
    return { ok: true, exitCode: r.code, ...summarizeReport(report), report };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// `mythos audit -w <ws> --deps npm,pip` — SBOM + dependency vuln audit (read-only unless --fix).
async function audit({ workspace, deps } = {}) {
  if (!CFG.enabled) return { ok: false, available: false };
  const ws = resolveSafeWorkspace(workspace);
  const { dir } = newRunDir('audit');
  const outBase = path.join(dir, 'reports');
  try {
    const r = await run(['audit', '-w', ws, '--deps', deps || 'npm', '-o', outBase], { timeoutMs: 8 * 60 * 1000 });
    if (r.code === -1) return { ok: false, available: false, error: r.err.slice(0, 300) };
    return { ok: true, exitCode: r.code, out: r.out.slice(-4000) };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// assess writes its report to <outBase>/<wf-id>/report.json — find + read the single run subdir.
function readReport(outBase) {
  try {
    const subs = fs.readdirSync(outBase).filter((d) => d.startsWith('wf-'));
    for (const s of subs) {
      const p = path.join(outBase, s, 'report.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {}
  return null;
}

// Flatten the report into a compact summary AI OS can store + display.
function summarizeReport(report) {
  const allFindings = [];
  for (const iter of (report.iterations || [])) for (const f of (iter || [])) allFindings.push(f);
  // Dedup by finding_id (it can recur across iterations).
  const byId = new Map();
  for (const f of allFindings) if (f && f.finding_id && !byId.has(f.finding_id)) byId.set(f.finding_id, f);
  const findings = [...byId.values()].map((f) => ({
    id: f.finding_id, severity: f.severity, vulnClass: f.vuln_class, title: f.title,
    file: (f.affected_locations && f.affected_locations[0] && f.affected_locations[0].path) || null,
    cwe: f.cwe_ids || [], source: f.source,
  }));
  const sev = (s) => findings.filter((f) => f.severity === s).length;
  const unresolvedIds = new Set((report.unresolved || []).map((f) => f.finding_id));
  return {
    status: report.status,                                   // CONVERGED | ITERATION_CAP | BUDGET_EXHAUSTED | ERROR
    durationSeconds: report.duration_seconds,
    counts: { total: findings.length, critical: sev('CRITICAL'), high: sev('HIGH'), medium: sev('MEDIUM'), low: sev('LOW'), info: sev('INFO'), unresolved: unresolvedIds.size, patched: (report.patches || []).length },
    findings,
    unresolved: (report.unresolved || []).map((f) => ({ id: f.finding_id, severity: f.severity, title: f.title })),
    threatModel: report.threat_model || null,
    supplyChain: report.supply_chain || null,
    deployment: report.deployment || null,
  };
}

// Fast READ-ONLY static scan of a directory via semgrep (mythos's red-team engine) — the Web Studio
// publish gate. No AI cost, seconds not minutes; semgrep never modifies files (no copy needed).
// Returns { available, findings:[{id,severity,title,file,line}], counts:{total,error,warning,info} }.
async function semgrepScan(dir, { config } = {}) {
  const real = resolveSafeWorkspace(dir); // read-only — permissive (dir or sub-path of an allow-root)
  const cfg = config || CFG.semgrepConfig || 'auto';
  const r = await runBin(CFG.semgrepBin || 'semgrep', ['--config', cfg, '--json', '--quiet', '--timeout', '120', real], { timeoutMs: 5 * 60 * 1000 });
  if (r.code === -1) return { available: false, reason: 'semgrep not found' };
  let parsed = null; try { parsed = JSON.parse(r.out); } catch {}
  if (!parsed || !Array.isArray(parsed.results)) return { available: false, reason: 'could not parse semgrep output', detail: (r.err || '').slice(0, 300) };
  const findings = parsed.results.map((f) => ({
    id: f.check_id || 'rule',
    severity: ((f.extra && f.extra.severity) || 'INFO').toUpperCase(),
    title: (f.extra && f.extra.message) ? String(f.extra.message).slice(0, 180) : (f.check_id || 'finding'),
    file: f.path ? path.relative(real, f.path) : null,
    line: (f.start && f.start.line) || null,
  }));
  const n = (s) => findings.filter((x) => x.severity === s).length;
  return { available: true, findings, counts: { total: findings.length, error: n('ERROR'), warning: n('WARNING'), info: n('INFO') } };
}

module.exports = { configure, isEnabled, doctor, threatModel, assess, audit, semgrepScan, resolveSafeWorkspace };
