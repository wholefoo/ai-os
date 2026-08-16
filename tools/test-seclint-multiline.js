// tools/test-seclint-multiline.js
// ============================================================
//  seclint's `innerhtml-multiline` rule — the file-level companion to `innerhtml-unescaped`.
//
//  WHY IT EXISTS. The line-based rule only fires on a line containing `.innerHTML`. Three real XSS
//  bugs hid in exactly that gap, because the assignment sat many lines above the interpolation:
//    - agent-created artifact filenames (6bdae70)
//    - the free-audit result renderer (fccb0b6)
//    - both SEO-audit renderers (fccb0b6)
//  Each was found by hand. This rule finds that shape mechanically.
//
//  THE REFINEMENT IS THE DIFFERENCE BETWEEN A GATE AND NOISE. Flagging every unescaped
//  interpolation in these spans gives 52 findings across 256 values. Restricting to property reads
//  plus non-allowlisted calls gives 25, and triage has since brought it to 13. The bare locals it drops are pre-built HTML fragments and
//  computed class names. A 52-item list gets switched off, which is the same reasoning that keeps
//  --audit-level at high in CI.
//
//  Function calls are included because the dangerous case is a PASS-THROUGH helper that looks like
//  a formatter. A first draft checked property reads only, and the capitalize() test below failed:
//  it fell through BOTH rules, since the line rule cannot see a value on a different line from the
//  innerHTML. That test is why the rule has its current shape.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SECLINT = path.join(__dirname, 'seclint.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seclint-ml-'));
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

/** Run seclint over a fixture; return the ids+lines it reported. */
function scan(src) {
  const f = path.join(TMP, 'fixture.js');
  fs.writeFileSync(f, src);
  let out = '';
  try { out = execFileSync('node', [SECLINT, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  return [...out.matchAll(/fixture\.js:(\d+)\s+\((innerhtml-multiline|innerhtml-unescaped)\)/g)]
    .map((m) => ({ line: Number(m[1]), rule: m[2] }));
}

const BT = '`';

// --- THE SHAPE THAT HID THREE REAL BUGS. ------------------------------------------------------
ok('FLAGS an unescaped property read in a multi-line innerHTML assignment', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div class="x">',
    '      <span>${a.filename}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  const hits = scan(src);
  assert.ok(hits.some((h) => h.rule === 'innerhtml-multiline'), `expected a multiline finding, got ${JSON.stringify(hits)}`);
});

ok('does NOT flag when every property read is escaped', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${escapeHtml(a.filename)}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scan(src).filter((h) => h.rule === 'innerhtml-multiline'), []);
});

// --- THE REFINEMENT. Bare locals are pre-built HTML / computed classes, not data. --------------
ok('does NOT flag bare locals — that is what keeps this list reviewable', () => {
  const src = [
    'function render() {',
    '  el.innerHTML = ' + BT + '',
    '    <div class="${scoreClass}">',
    '      ${agentCards}',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scan(src).filter((h) => h.rule === 'innerhtml-multiline'), []);
});

// --- The allowlisted formatters must not fire. ------------------------------------------------
ok('does NOT flag timeAgo / Number / encodeURIComponent', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${timeAgo(a.created)}</span>',
    '      <span>${Number(a.count)}</span>',
    '      <a href="/x/${encodeURIComponent(a.slug)}">go</a>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scan(src).filter((h) => h.rule === 'innerhtml-multiline'), []);
});

// --- capitalize() must STILL fire: it is a pass-through, not a formatter. ----------------------
// It cost 8 unescaped sites (4edb175). If someone adds it to the allowlist "because it looks like a
// formatter", this test is what stops them.
ok('DOES flag capitalize() — it returns its input, so it is not a safe formatter', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${capitalize(a.name)}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  // This test FAILED against the first draft of the rule, which checked property reads only: the
  // call fell through both rules. Including non-allowlisted calls is the fix, so assert the
  // MULTILINE rule specifically — asserting "something caught it" would pass again if the call
  // handling were removed and the line rule happened to fire.
  const hits = scan(src).filter((h) => h.rule === 'innerhtml-multiline');
  assert.ok(hits.length > 0, 'capitalize() is a pass-through and must be flagged in a multi-line span');
});

// --- METHOD CALLS ON A PROPERTY PATH. The gap that hid four spans. ----------------------------
// `${e.model.replace('a','b')}` fell through BOTH detectors: isPropertyRead rejects anything with
// parens, isCall requires the expression to START with `ident(`. It was live at app.js:2655, on the
// SAME LINE as a value the rule did report — so the span looked reviewed. The string methods are
// pass-throughs (`.replace()` returns the input unchanged when the pattern misses), which is the
// capitalize lesson wearing different clothes.
ok('FLAGS a method call on a property path — the .replace() pass-through gap', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    "      <span>${a.model.replace('x', 'y')}</span>",
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  const hits = scan(src).filter((h) => h.rule === 'innerhtml-multiline');
  assert.ok(hits.length > 0, 'obj.prop.method(...) must be flagged — .replace() escapes nothing');
});

// Arithmetic is a language-level guarantee, so it must NOT fire once method calls are in scope.
ok('does NOT flag Math.round(...) or .toFixed(n)', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${Math.round(a.confidence * 100)}%</span>',
    '      <span>${a.cost.toFixed(2)}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scan(src).filter((h) => h.rule === 'innerhtml-multiline'), []);
});

// .toLocaleString() is the trap: it LOOKS like .toFixed()'s sibling but it is Object.prototype's,
// so on a string it returns that string unchanged. That is how v.score reached innerHTML unescaped
// (8759382). If someone adds it beside .toFixed in safeInterp, this test is what stops them.
ok('DOES flag .toLocaleString() — a no-op pass-through on a string, not a formatter', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${a.views.toLocaleString()}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  const hits = scan(src).filter((h) => h.rule === 'innerhtml-multiline');
  assert.ok(hits.length > 0, '.toLocaleString() on a string returns it unchanged — must be flagged');
});

// --- A nested template literal must not truncate the scan. ------------------------------------
// A naive indexOf('`') stops at the first nested template and silently checks only part of the span.
ok('handles a nested template literal without truncating the span', () => {
  const src = [
    'function render(rows, a) {',
    '  el.innerHTML = ' + BT + '',
    '    <ul>',
    '      ${rows.map(r => ' + BT + '<li>${escapeHtml(r.n)}</li>' + BT + ').join("")}',
    '    </ul>',
    '    <span>${a.unsafeTail}</span>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  const hits = scan(src).filter((h) => h.rule === 'innerhtml-multiline');
  assert.ok(hits.length > 0, 'the value AFTER the nested template must still be seen');
});

// --- Suppression works on the reported line. --------------------------------------------------
ok('respects a seclint-ok comment on the innerHTML line', () => {
  const src = [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '' + '  // seclint-ok: fixture',
    '    <span>${a.filename}</span>',
    '  ' + BT + ';',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scan(src).filter((h) => h.rule === 'innerhtml-multiline'), []);
});

// --- ZERO, AND THE RULE IS NOW `error`. -------------------------------------------------------
// The ratchet is retired: the count went 25 -> 18 -> 17 -> 14 -> 13 -> 0 and the rule was promoted
// from `warn` to `error`. There is no number to update any more — the target is zero and CI
// enforces it. If this fails, do NOT raise a threshold and do NOT reach for `continue-on-error`
// (see DEP-04): escape the value, or fix the rule if the finding is wrong.
ok('the repo has ZERO innerhtml-multiline findings', () => {
  let out = '';
  try { out = execFileSync('node', [SECLINT, '--ci'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const n = (out.match(/\(innerhtml-multiline\)/g) || []).length;
  assert.strictEqual(n, 0, `expected ZERO innerhtml-multiline findings, got ${n}:\n${out}`);
});

// The promotion is only worth something if the rule actually FAILS the build. A rule at `error`
// that still exits 0 is the same false comfort as a rule with a blind spot — assert the exit code,
// not just the finding count.
ok('a new unescaped multi-line span makes seclint EXIT NON-ZERO, not just warn', () => {
  const f = path.join(TMP, 'ci-fixture.js');
  fs.writeFileSync(f, [
    'function render(a) {',
    '  el.innerHTML = ' + BT + '',
    '    <div>',
    '      <span>${a.filename}</span>',
    '    </div>',
    '  ' + BT + ';',
    '}',
  ].join('\n'));
  let code = 0;
  try { execFileSync('node', [SECLINT, f], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status || 1; }
  assert.notStrictEqual(code, 0, 'seclint must exit non-zero on an innerhtml-multiline finding now '
    + 'that the rule is at `error` — otherwise the promotion is cosmetic');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL TESTS PASSED\n${pass} assertions`);
