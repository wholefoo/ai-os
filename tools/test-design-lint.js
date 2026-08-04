// The design linter — the one that actually lints.
//
// `POST /api/design-system/lint` ignored its request body and echoed a hardcoded findings array
// until 2026-08-03. `web-builder`'s handbook called it the quality gate and promised to refuse
// `ready` on error-severity findings; the canned array contained none, so the refusal could never
// fire. This suite exists to keep that from being true again, and the assertions are shaped
// accordingly: **every one feeds the linter something broken and demands it notices.** A linter
// only ever run on clean input is indistinguishable from the canned array it replaced.
const path = require('path');
const fs = require('fs');
const lint = require('../lib/design-lint');
const { assert, done } = require('./test-util');

const ROOT = path.join(__dirname, '..');

// --- the arithmetic, anchored -----------------------------------------------------------------------
assert(Math.abs(lint.contrastRatio('#000000', '#ffffff') - 21) < 0.01, 'contrast is 21:1 at the extreme');
assert(Math.abs(lint.contrastRatio('#ffffff', '#ffffff') - 1) < 0.001, '...and 1:1 for a colour on itself');
assert(lint.normalizeHex('#ABC') === '#aabbcc', 'shorthand hex expands and lowercases');
assert(lint.normalizeHex('rebeccapurple') === null && lint.normalizeHex('var(--x)') === null,
  'a named colour or CSS variable is not a hex value — it is reported as unknown, never guessed at');

// --- lintTokens FINDS things ---------------------------------------------------------------------------
// #6b7280 is the only shade in this palette that clears BOTH bars: 4.83:1 on white and 3.83:1 on
// the app background. The first draft of this fixture used #0b5cad, which passes on white and is
// then unreadable on the product's own dark surface — the linter caught it, which is the check
// doing its job on its own test data before it ever saw production markup.
const goodTokens = {
  colors: { primary: { hex: '#6b7280' }, background: { hex: '#0f1419' }, surface: { hex: '#1a2332' } },
  typography: { fontFamily: { primary: 'Inter, system-ui, sans-serif', mono: 'JetBrains Mono, monospace' } },
  spacing: { xs: '4px', sm: '8px', lg: '16px' },
};
const clean = lint.lintTokens(goodTokens, [{ id: 'btn', background: 'primary', text: 'surface' }]);
assert(!clean.some((f) => f.status === 'fail'), `a sound token set produces no failures (${clean.map((f) => f.rule + ':' + f.status).join(', ')})`);

const offGrid = lint.lintTokens({ ...goodTokens, spacing: { xs: '4px', odd: '13px' } });
assert(offGrid.some((f) => f.rule === 'spacing-consistency' && f.status === 'fail' && /13px/.test(f.message)),
  'a 13px spacing token is caught and NAMED — the 4px grid is checked by arithmetic, not asserted');

const noFallback = lint.lintTokens({ ...goodTokens, typography: { fontFamily: { primary: 'Inter' } } });
assert(noFallback.some((f) => f.rule === 'font-fallback' && f.status === 'fail'),
  'a font stack with no generic fallback is caught');

const hardcoded = lint.lintTokens(goodTokens, [{ id: 'btn-bad', background: '#ff0000' }]);
assert(hardcoded.some((f) => f.rule === 'component-refs' && f.status === 'fail' && /btn-bad/.test(f.message)),
  'a component with a hardcoded hex instead of a role is caught and named');

// The real palette. This is the check that would have caught the shipped defect: six colours fail
// AA on white, and the old canned list claimed three.
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n?/g, '\n');
const realColors = {};
for (const m of server.matchAll(/(\w+): \{ hex: '(#[0-9a-f]{6})'[^\n]*?wcag: \{ onWhite: ([\d.]+)/g)) {
  realColors[m[1]] = { hex: m[2] };
}
assert(Object.keys(realColors).length === 9, `the live palette was parsed (${Object.keys(realColors).length} colours)`);
const realFindings = lint.lintTokens({ ...goodTokens, colors: realColors });
const flagged = realFindings.filter((f) => f.rule === 'color-contrast' && f.status !== 'pass');
assert(flagged.length >= 6,
  `the live palette produces ${flagged.length} contrast findings — the hand-written list it replaced claimed 3`);

// --- lintHtml FINDS things -------------------------------------------------------------------------------
const missingAlt = lint.lintHtml('<html lang="en"><img src="a.png"><img src="b.png" alt="ok"></html>');
assert(missingAlt.some((f) => f.rule === 'img-alt' && f.status === 'fail' && /1 of 2/.test(f.message)),
  'an <img> with no alt is an ERROR — the severity web-builder gates on');

const noLang = lint.lintHtml('<html><body><p>hi</p></body></html>');
assert(noLang.some((f) => f.rule === 'html-lang' && f.status === 'fail'), 'a missing lang attribute is caught');

// Contrast from inline styles, computed. #777 on #fff is 4.48:1 — just under AA, the kind of near
// miss an eyeball waves through and the reason this is arithmetic.
const lowContrast = lint.lintHtml('<html lang="en"><p style="color:#777777;background-color:#ffffff">text</p></html>');
const cf = lowContrast.find((f) => f.rule === 'color-contrast' && f.status !== 'pass');
assert(cf && /4\.4\d/.test(cf.message), `a 4.48:1 inline pair is caught with its computed ratio (got: ${cf ? cf.message : 'nothing'})`);
assert(!lint.lintHtml('<html lang="en"><p style="color:#ffffff;background-color:#0f1419">t</p></html>')
  .some((f) => f.rule === 'color-contrast' && f.status !== 'pass'), '...and a compliant pair is not flagged');

const offPalette = lint.lintHtml('<p style="color:#123456">x</p>', { colors: { primary: { hex: '#3b82f6' } } });
assert(offPalette.some((f) => f.rule === 'token-compliance' && f.status === 'warning' && /#123456/.test(f.message)),
  'a colour literal outside the palette is reported by value');

// --- the property web-builder actually gates on ------------------------------------------------------------
const broken = lint.summarizeFindings(lint.lintHtml('<html><img src="x.png"></html>'));
assert(broken.hasErrors === true, 'summarizeFindings().hasErrors is TRUE for markup with an error-severity finding');
const fine = lint.summarizeFindings(lint.lintHtml('<html lang="en"><img src="x.png" alt="a duck"></html>'));
assert(fine.hasErrors === false, '...and FALSE for clean markup — the gate can now actually fire, in both directions');

assert(lint.lintHtml('').some((f) => f.status === 'fail'), 'empty input is an error, not a silent pass');

// --- honesty about scope ------------------------------------------------------------------------------------
// The failure mode this whole module exists to end is a check that reads as more than it is.
assert(lint.lintHtml('<html lang="en"></html>').some((f) => f.rule === 'scope' && /not a full WCAG audit/.test(f.message)),
  'every HTML result states its own limits — static markup only, no CSS cascade');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'design-lint.js'), 'utf8');
assert(/CANNOT DO/.test(src) && /not a full WCAG audit/i.test(src),
  'and the module header says so too, where someone extending it will read it');

// --- the route is wired to this, not to a canned array ---------------------------------------------------------
const mod = path.join(ROOT, 'commercial', 'modules', 'design-system', 'index.js');
if (fs.existsSync(mod)) {
  const route = fs.readFileSync(mod, 'utf8').replace(/\r\n?/g, '\n');
  assert(/designLint\.lintHtml\(/.test(route), 'the commercial lint route calls lintHtml when given markup');
  assert(!/results: designSystem\.linterResults \}\);/.test(route),
    'the route no longer echoes the cached findings array back as if it had linted something');
} else {
  console.log('  info: commercial/ not present (Community checkout) — route assertions skipped');
}
assert(/designSystem\.linterResults = designLint\.lintTokens\(/.test(server),
  'server.js DERIVES linterResults from the tokens rather than carrying a hand-written list');

done();
