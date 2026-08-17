// tools/test-seclint-dataflow.js
// ============================================================
//  seclint's `innerhtml-dataflow` rule — the hole the other two rules cannot cover.
//
//  `innerhtml-unescaped` needs the value on the `.innerHTML` line. `innerhtml-multiline` needs it
//  inside the assigned template, and DELIBERATELY IGNORES bare locals like ${rows} (flagging them
//  gave 52 findings nobody would read). That exclusion is precisely what opens this gap:
//
//      const rows = items.map((r) => `<td>${r.name}</td>`).join('');   // the unsafe value
//      el.innerHTML = `<table>${rows}</table>`;                        // the sink, lines later
//
//  Neither existing rule sees it. This one resolves the local back to its nearest preceding
//  assignment and scans THAT template.
//
//  IT FOUND 4 REAL SITES ON ITS FIRST RUN, and 3 of the 4 had an ESCAPED NEIGHBOUR (`v.scene`,
//  `s.name`, `a.grade` escaped while the value beside them was not). An escaped neighbour means
//  someone made a per-field judgement on that line — it is NOT evidence the line is safe.
//
//  One of the 4 sat directly above a `seclint-ok` span suppression: the suppression silenced the
//  SINK while the fragment feeding it went unchecked. Concrete argument for hoisting over
//  suppressing.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SECLINT = path.join(__dirname, 'seclint.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seclint-df-'));
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };
const BT = '`';

function scan(src) {
  const f = path.join(TMP, 'fixture.js');
  fs.writeFileSync(f, src);
  let out = '';
  try { out = execFileSync('node', [SECLINT, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  return (out.match(/\(innerhtml-dataflow\)/g) || []).length;
}

// --- SINK A: a bare local interpolated into the assigned template. ----------------------------
ok('FLAGS map-into-local then ${local} inside the innerHTML template', () => {
  assert.ok(scan([
    'function render(items) {',
    '  const rows = items.map((r) => ' + BT + '<td>${r.name}</td>' + BT + ').join("");',
    '  el.innerHTML = ' + BT + '<table>${rows}</table>' + BT + ';',
    '}',
  ].join('\n')) > 0, 'the fragment feeding the sink must be scanned');
});

// --- SINK B: the local assigned directly to innerHTML. ----------------------------------------
ok('FLAGS `el.innerHTML = html;` where html was built from an unescaped value', () => {
  assert.ok(scan([
    'function render(a) {',
    '  const html = ' + BT + '<div>${a.title}</div>' + BT + ';',
    '  el.innerHTML = html;',
    '}',
  ].join('\n')) > 0, 'direct assignment of a local is the other half of the shape');
});

ok('FLAGS the .join() variant of the direct sink', () => {
  assert.ok(scan([
    'function render(items) {',
    '  const parts = ' + BT + '<li>${items.label}</li>' + BT + ';',
    '  el.innerHTML = parts.join("");',
    '}',
  ].join('\n')) > 0);
});

// --- Escaped fragments must stay quiet, or the rule is noise. ---------------------------------
ok('does NOT flag when the fragment escapes its values', () => {
  assert.strictEqual(scan([
    'function render(items) {',
    '  const rows = items.map((r) => ' + BT + '<td>${escapeHtml(r.name)}</td>' + BT + ').join("");',
    '  el.innerHTML = ' + BT + '<table>${rows}</table>' + BT + ';',
    '}',
  ].join('\n')), 0);
});

ok('does NOT flag a fragment whose only values are arithmetic', () => {
  assert.strictEqual(scan([
    'function render(a) {',
    '  const bar = ' + BT + '<div style="width:${Math.round(a.pct)}%"></div>' + BT + ';',
    '  el.innerHTML = ' + BT + '<div>${bar}</div>' + BT + ';',
    '}',
  ].join('\n')), 0);
});

// --- Suppression is honoured on the ASSIGNMENT line, which is where the finding is reported. ---
ok('respects seclint-disable-next-line above the fragment assignment', () => {
  assert.strictEqual(scan([
    'function render(a) {',
    '  // seclint-disable-next-line innerhtml-dataflow',
    '  const html = ' + BT + '<div>${a.title}</div>' + BT + ';',
    '  el.innerHTML = html;',
    '}',
  ].join('\n')), 0);
});

// --- The repo is clean, AND the rule can fail a build. ----------------------------------------
ok('the repo has ZERO innerhtml-dataflow findings', () => {
  let out = '';
  try { out = execFileSync('node', [SECLINT, '--ci'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const n = (out.match(/\(innerhtml-dataflow\)/g) || []).length;
  assert.strictEqual(n, 0, `expected ZERO innerhtml-dataflow findings, got ${n}:\n${out}`);
});

// A zero from a rule that cannot fire is indistinguishable from a clean repo — the mistake that
// nearly shipped the `error` promotion as cosmetic. Assert the exit code too.
ok('a dataflow finding makes seclint EXIT NON-ZERO', () => {
  const f = path.join(TMP, 'ci-fixture.js');
  fs.writeFileSync(f, [
    'function render(a) {',
    '  const html = ' + BT + '<div>${a.title}</div>' + BT + ';',
    '  el.innerHTML = html;',
    '}',
  ].join('\n'));
  let code = 0;
  try { execFileSync('node', [SECLINT, f], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status || 1; }
  assert.notStrictEqual(code, 0, 'the rule is at `error`; it must be able to fail a build');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL TESTS PASSED\n${pass} assertions`);
