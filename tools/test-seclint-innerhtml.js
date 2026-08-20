// tools/test-seclint-innerhtml.js
// ============================================================
//  seclint's `innerhtml-unescaped` rule (AS-02, security-sweep run-1786080073868).
//
//  THE RULE SKIPPED THE MOST DANGEROUS SHAPE IT EXISTS TO CATCH. Two defects compounded:
//    1. `/\.map\(/` sat in the safe() list, so ANY expression containing `.map(` was waved through
//       — and a row builder is the likeliest place for unescaped user data in the whole codebase.
//    2. Interpolations were extracted with /\$\{([^}]*)\}/, whose `[^}]*` stops at the FIRST `}`.
//       Given `${rows.map(r => `<li>${r.name}</li>`).join('')}` it captured the fragment
//       "rows.map(r => `<li>${r.name" — a single expression containing `.map(`, therefore "safe".
//       The inner `${r.name}` was never seen as an expression at all.
//
//  Verified against the REAL linter before the fix: the flat `${u.name}` was flagged while both
//  nested cases passed clean. These tests run the CLI rather than a copy of the logic, so they
//  cannot pass while the shipped linter fails.
//
//  KNOWN LIMIT, ASSERTED BELOW RATHER THAN LEFT IMPLICIT: this rule is line-based and only fires on
//  lines containing `.innerHTML`. HTML built into a variable and assigned later — which is what
//  dashboard/js/crm.js:92-110 actually does — is invisible to it. That is a real gap, not an
//  oversight, and the test pins it so nobody mistakes a clean run for full coverage.
// ============================================================

const assert = require('assert');
const { seclintFixture } = require('./test-util');

const seclint = seclintFixture('seclint-');

/** Run the real seclint CLI over a fixture; return the lines it flagged. */
function scan(source) {
  return [...seclint.run(source).matchAll(/fixture\.js:(\d+)\s+\(innerhtml-unescaped\)/g)].map((m) => Number(m[1]));
}

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// Built with concatenation, not nested template literals — this file would otherwise be an
// unreadable thicket of escaped backticks, and a mis-escaped fixture silently tests the wrong thing.
const BT = '`';
const line = (s) => s;

const FIXTURE = [
  /* 1 */ 'const x = 1;',
  /* 2 */ 'el.innerHTML = ' + BT + '<b>${escapeHtml(u.name)}</b>' + BT + ';',
  /* 3 */ 'el.innerHTML = ' + BT + '<b>${u.name}</b>' + BT + ';',
  /* 4 */ 'el.innerHTML = ' + BT + '<ul>${rows.map(r => ' + BT + '<li>${r.name}</li>' + BT + ').join("")}</ul>' + BT + ';',
  /* 5 */ 'el.innerHTML = ' + BT + '<ul>${rows.map(r => ' + BT + '<li>${escapeHtml(r.name)}</li>' + BT + ').join("")}</ul>' + BT + ';',
  /* 6 */ 'el.innerHTML = ' + BT + '<i>${ids.map(i => i.raw).join(",")}</i>' + BT + ';',
  /* 7 */ 'el.innerHTML = ' + BT + '<b>${"literal"}</b>' + BT + ';',
  /* 8 */ 'el.innerHTML = ' + BT + '<b>${42}</b>' + BT + ';',
].map(line).join('\n');

const flagged = scan(FIXTURE);

ok('flags a bare unescaped leaf', () => assert.ok(flagged.includes(3)));

// THE REGRESSION THAT MATTERS. Both of these passed clean before the fix.
ok('FLAGS an unescaped value nested inside a .map() template (the old blind spot)', () => {
  assert.ok(flagged.includes(4), `line 4 must be flagged; flagged=${JSON.stringify(flagged)}`);
});
ok('FLAGS a .map() whose result is raw values, not a template (the `.map(` exemption)', () => {
  assert.ok(flagged.includes(6), `line 6 must be flagged; flagged=${JSON.stringify(flagged)}`);
});

// --- Correctly-escaped code must NOT be flagged, or the rule gets suppressed wholesale. --------
ok('does NOT flag an escaped leaf', () => assert.ok(!flagged.includes(2)));
ok('does NOT flag an escaped value inside a .map() template', () => {
  assert.ok(!flagged.includes(5), 'the container expression must not be flagged for its own sake');
});
ok('does NOT flag string or numeric literals', () => {
  assert.ok(!flagged.includes(7));
  assert.ok(!flagged.includes(8));
});

// --- The repo itself must stay clean under the STRICTER rule. ---------------------------------
// Tightening a linter is only real if the codebase then passes it. If this goes red, either a
// regression landed or the rule became too aggressive — both worth stopping for.
ok('the whole default file set passes the tightened rule', () => {
  const { out, code } = seclint.ci();
  assert.strictEqual(code, 0, `seclint --ci must pass: ${out.slice(0, 400)}`);
  assert.ok(!/innerhtml-unescaped/.test(out), `no innerHTML findings expected, got: ${out.slice(0, 400)}`);
});

// --- THE KNOWN LIMIT, pinned so a clean run is not mistaken for coverage. ----------------------
// crm.js:92-110 builds rows in a variable and assigns innerHTML nine lines later. This rule cannot
// see that, and no line-based rule can. Documented in the audit follow-up rather than silently
// tolerated; if someone later teaches the rule to track this, THIS assertion is what should flip.
ok('KNOWN GAP: HTML built into a variable and assigned later is NOT covered', () => {
  const detached = [
    'const rows = items.map(p => ' + BT + '<td>${p.name}</td>' + BT + ').join("");',
    'box.innerHTML = rows;',
  ].join('\n');
  assert.deepStrictEqual(scan(detached), [],
    'if this starts flagging, the rule gained multi-statement coverage — update this test and the docs');
});

seclint.cleanup();
console.log(`\nALL TESTS PASSED\n${pass} assertions`);
