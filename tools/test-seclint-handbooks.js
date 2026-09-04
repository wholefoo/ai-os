// seclint's handbook-privilege rule (R6): an agent handbook whose tools:, gates: or escalates_to:
// differ from the committed version is an ERROR until a human acknowledges it.
//
// Why this exists: the 2026-09-03 agent rename edited three handbooks with a node patch script run
// through Bash, and no Edit-tool deny rule ever saw it. A directory-wide deny would have blocked the
// harmless rename and still missed that route. What actually matters is the CATEGORY of edit — an
// agent widening what it may call, dropping an approval gate, or rerouting its escalation — so the
// rule diffs exactly those lines against HEAD and lets prose, descriptions and renames through.
//
// Three layers, each tested here:
//   1. the pure diff (fixtures, no git) — what counts as a privilege change and what does not;
//   2. the real CLI over a throwaway git repo — HEAD is read correctly, new files are reported;
//   3. the shipped hook and --handbooks modes over THIS repo — the wiring, not just the logic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { assert, done, repoRoot } = require('./test-util');
const { handbookPrivilegeDiff, privilegeOf } = require('./seclint');

const SECLINT = path.join(__dirname, 'seclint.js');
const HB = (extra) => `---\nname: sample\ndescription: "x"\nmodel: claude-opus-5\n${extra}\n---\n\n# Sample\n\nBody.\n`;
const BASE = HB('tools: [Read, Write]\nescalates_to: orchestrator\ngates: [mcp.tool-call]   # considered: fires webhooks');

// --- 1. the pure diff ----------------------------------------------------------------------------
assert(handbookPrivilegeDiff(BASE, BASE).length === 0, 'identical handbook: no finding');
assert(handbookPrivilegeDiff(BASE, BASE.replace('# Sample', '# Renamed').replace('name: sample', 'name: renamed')).length === 0,
  'rename + body edit: no finding (the 2026-09-03 rename must pass)');
assert(handbookPrivilegeDiff(BASE, BASE.replace('model: claude-opus-5', 'model: claude-sonnet-5')).length === 0,
  'model swap: no finding (cost decision, not privilege)');
assert(handbookPrivilegeDiff(BASE, BASE.replace('# considered: fires webhooks', '# considered: reworded')).length === 0,
  'trailing comment reworded on gates: no finding');
assert(handbookPrivilegeDiff(BASE, BASE.replace(/\n/g, '\r\n')).length === 0, 'CRLF checkout of the same file: no finding');

const widened = handbookPrivilegeDiff(BASE, BASE.replace('tools: [Read, Write]', 'tools: [Read, Write, Bash]'));
assert(widened.length === 1 && /^tools: \[Read, Write\] -> \[Read, Write, Bash\]$/.test(widened[0]), `tools widened is reported with both values: ${widened[0]}`);
const ungated = handbookPrivilegeDiff(BASE, BASE.replace('gates: [mcp.tool-call]', 'gates: []'));
assert(ungated.length === 1 && /^gates: \[mcp\.tool-call\] -> \[\]$/.test(ungated[0]), `gate emptied is reported: ${ungated[0]}`);
const dropped = handbookPrivilegeDiff(BASE, BASE.replace('gates: [mcp.tool-call]   # considered: fires webhooks\n', ''));
assert(dropped.length === 1 && /^gates: \[mcp\.tool-call\] -> \(absent\)$/.test(dropped[0]), `gate line DELETED is reported, not treated as unchanged: ${dropped[0]}`);
const rerouted = handbookPrivilegeDiff(BASE, BASE.replace('escalates_to: orchestrator', 'escalates_to: sample'));
assert(rerouted.length === 1 && /^escalates_to: orchestrator -> sample$/.test(rerouted[0]), 'escalation rerouted is reported');
assert(handbookPrivilegeDiff(BASE, BASE.replace('tools: [Read, Write]', 'tools: [Read, Write, Bash]').replace('gates: [mcp.tool-call]', 'gates: []')).length === 2,
  'two keys changed: two findings, not one');
assert(handbookPrivilegeDiff(null, BASE).length === 3, 'a NEW handbook reports every privilege line it declares');
assert(handbookPrivilegeDiff(null, HB('')).length === 0, 'a new handbook declaring no privilege: no finding');
assert(handbookPrivilegeDiff(BASE, BASE.replace('Body.', 'Body.\n\ntools: [Bash]')).length === 0,
  'a "tools:" line in the BODY is prose, not frontmatter — only the frontmatter block is read');
assert(privilegeOf('no frontmatter at all').tools === undefined, 'a file with no frontmatter yields no privilege keys');

// --- 2. the real CLI over a throwaway git repo ---------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seclint-handbooks-'));
const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const agentsDir = path.join(tmp, '.claude', 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
const hbFile = path.join(agentsDir, 'sample.md');
const cli = (env = {}) => {
  try {
    const out = execFileSync('node', [SECLINT, hbFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
try {
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(hbFile, BASE);
  let r = cli();
  assert(r.code === 1 && /handbook-privilege/.test(r.out), 'UNTRACKED handbook with privilege lines: CLI exits 1 (a new agent is a grant)');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  r = cli();
  assert(r.code === 0 && !/handbook-privilege/.test(r.out), 'committed and unchanged: CLI exits 0');
  fs.writeFileSync(hbFile, BASE.replace('# Sample', '# Sample — Renamed'));
  r = cli();
  assert(r.code === 0, 'prose change vs HEAD: CLI exits 0');
  fs.writeFileSync(hbFile, BASE.replace('gates: [mcp.tool-call]', 'gates: []'));
  r = cli();
  assert(r.code === 1 && /gates: \[mcp\.tool-call\] -> \[\]/.test(r.out), 'gate emptied vs HEAD: CLI exits 1 and names the change');
  r = cli({ HANDBOOK_PRIVILEGE_OK: '1' });
  assert(r.code === 0 && /\[warn \].*handbook-privilege/.test(r.out), 'HANDBOOK_PRIVILEGE_OK=1 downgrades to a visible warning, not silence');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- 3. the shipped wiring over THIS repo -------------------------------------------------------
const hook = (filePath) => {
  try {
    execFileSync('node', [SECLINT, '--hook'], { input: JSON.stringify({ tool_input: { file_path: filePath } }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, err: '' };
  } catch (e) { return { code: e.status, err: String(e.stderr || '') }; }
};
const realAgents = path.join(repoRoot, '.claude', 'agents');
const fixture = path.join(realAgents, 'zz-seclint-fixture-delete-me.md');
try {
  fs.writeFileSync(fixture, HB('tools: [Read, Write, Bash]\ngates: []'));
  const r = hook(fixture);
  assert(r.code === 2 && /handbook-privilege/.test(r.err), 'the PostToolUse hook scans a handbook (.md) and surfaces the finding with exit 2');
} finally {
  fs.rmSync(fixture, { force: true });
}
const anyReal = fs.readdirSync(realAgents).filter((f) => f.endsWith('.md') && !f.startsWith('zz-')).map((f) => path.join(realAgents, f))[0];
assert(anyReal && hook(anyReal).code === 0, 'the hook over an unchanged committed handbook exits 0');
assert(hook(path.join(repoRoot, 'README.md')).code === 0, 'the hook still ignores ordinary .md files');

// The gate itself. This asserts every handbook's privilege lines match HEAD right now, which is the
// property the rule exists to hold. If you are here because it failed: that is the rule working —
// read the diff it names and, if a person decided it, run with HANDBOOK_PRIVILEGE_OK=1.
let gate;
try { execFileSync('node', [SECLINT, '--handbooks'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); gate = 0; }
catch (e) { gate = e.status; console.error(String(e.stdout || '') + String(e.stderr || '')); }
assert(gate === 0, 'seclint --handbooks: every handbook privilege line in this checkout matches HEAD');

done();
