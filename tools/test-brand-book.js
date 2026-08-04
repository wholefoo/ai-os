// The brand book, and the arithmetic the design system claims about itself.
//
// Phase 3 of .magent/vault/wiki/model-fit-2026-design.md — "design interfaces rather than examples".
// The deliverable is `.claude/design/brand-book.html`: roles, reasoning and constraints an agent can
// design inside, instead of examples that constrain the exploration space.
//
// WHAT BUILDING IT FOUND, which is why this suite exists and is not just a file-presence check:
// `designSystem.tokens.colors` in server.js carried a hardcoded `wcag: { onWhite, onDark, passes }`
// per colour, and **8 of the 9 were wrong**. Three were wrong in the direction that matters —
// `primary`, `secondary` and `error` were marked `passes: true` while actually failing WCAG AA on
// white (3.68, 4.23, 3.76 against a 4.5 threshold). Nothing caught it because the design system's
// linter endpoint returns a hardcoded results array rather than linting anything.
//
// So the assertion that matters here is the third one: **recompute every claimed ratio and compare**.
// It is the only check that would have fired, and it is cheap — the WCAG 2.1 relative-luminance
// formula is eight lines. A number a system asserts about itself, that nothing recomputes, is a
// number that drifts.
const fs = require('fs');
const path = require('path');
const { assert, done } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const BOOK = path.join(ROOT, '.claude', 'design', 'brand-book.html');

// WCAG 2.1 relative luminance -> contrast ratio. Deliberately reimplemented here rather than
// imported from the page: a checker that shares an implementation with the thing it checks proves
// only that they agree, not that either is right. Cross-checked against known values below.
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Anchor the formula on values that cannot be argued with, so a broken checker fails here rather
// than silently blessing whatever it is handed.
assert(Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01, 'the contrast formula is right at the extreme: black on white is 21:1');
assert(Math.abs(ratio('#ffffff', '#ffffff') - 1) < 0.001, '...and 1:1 for a colour against itself');

// --- 1. the brand book exists and COMPUTES rather than asserts ----------------------------------------
assert(fs.existsSync(BOOK), 'the brand book exists at .claude/design/brand-book.html');
const html = read(BOOK);

assert(/0\.2126\s*\*/.test(html) && /0\.03928/.test(html),
  'the page carries the WCAG luminance formula — it derives its ratios at render time');
assert(/const ratio\s*=/.test(html) && /function|=>/.test(html),
  '...and a contrast function to apply it');

// The failure this page exists to prevent: a table of ratios typed in by hand. Any `4.5:1`-shaped
// literal in the markup would be a copied number, which is exactly how the token object drifted.
const markup = html.split('<script>')[0];
assert(!/\d\.\d+\s*:\s*1/.test(markup.replace(/4\.5:1|3:1/g, '')),
  'no per-colour ratio is hardcoded in the markup — only the AA/AAA thresholds themselves appear');

// --- 2. the brand book and server.js agree on the tokens ------------------------------------------------
// Two copies of a palette is exactly the drift shape phase 2 found in the rules corpus. Here the
// duplication is deliberate (the page must be self-contained to be openable), so it is PINNED.
const serverSrc = read(path.join(ROOT, 'server.js'));
const serverColors = {};
for (const m of serverSrc.matchAll(/(\w+): \{ hex: '(#[0-9a-f]{6})'[^\n]*?wcag: \{ onWhite: ([\d.]+), onDark: ([\d.]+), passes: (true|false) \} \}/g)) {
  serverColors[m[1]] = { hex: m[2], onWhite: parseFloat(m[3]), onDark: parseFloat(m[4]), passes: m[5] === 'true' };
}
assert(Object.keys(serverColors).length === 9,
  `the designSystem colour tokens were parsed from server.js (${Object.keys(serverColors).length})`);

// Execute the page's OWN token table, so this checks the shipped file rather than a transcription.
const tokensSrc = html.match(/const TOKENS = (\{[\s\S]*?\n\});/);
assert(tokensSrc, 'the brand book exposes a TOKENS table');
// eslint-disable-next-line no-new-func
const TOKENS = new Function(`return ${tokensSrc[1]}`)();

const hexMismatch = Object.entries(serverColors)
  .filter(([k, v]) => !TOKENS.colors[k] || TOKENS.colors[k].hex !== v.hex)
  .map(([k, v]) => `${k}: server ${v.hex} vs book ${TOKENS.colors[k] ? TOKENS.colors[k].hex : '(missing)'}`);
assert(hexMismatch.length === 0,
  `the brand book and server.js agree on every hex${hexMismatch.length ? ` — drift: ${hexMismatch.join(', ')}` : ` (${Object.keys(serverColors).length} tokens)`}`);

// --- 3. every claimed ratio is arithmetically correct ---------------------------------------------------
// THE assertion. 8 of 9 failed this on 2026-08-03 before the values were recomputed.
const WHITE = '#ffffff';
const DARK = serverColors.background.hex;
const wrong = [];
for (const [name, t] of Object.entries(serverColors)) {
  const w = ratio(t.hex, WHITE), d = ratio(t.hex, DARK), passes = w >= 4.5;
  if (Math.abs(w - t.onWhite) > 0.01) wrong.push(`${name}.onWhite claims ${t.onWhite}, computes ${w.toFixed(2)}`);
  if (Math.abs(d - t.onDark) > 0.01) wrong.push(`${name}.onDark claims ${t.onDark}, computes ${d.toFixed(2)}`);
  if (passes !== t.passes) wrong.push(`${name}.passes claims ${t.passes}, computes ${passes} <-- VERDICT`);
}
assert(wrong.length === 0,
  `every claimed contrast figure recomputes correctly${wrong.length ? ` — ${wrong.length} wrong: ${wrong.join(' | ')}` : ` (${Object.keys(serverColors).length} tokens x onWhite/onDark/passes)`}`);

// --- 4. the linter's canned results do not contradict the tokens -----------------------------------------
// POST /api/design-system/lint ignores its request body and returns this static array, so it cannot
// disagree with reality by linting badly — only by being written wrong. It was: it named 3 colours
// as failing AA on white when 6 do. Pinned to the tokens so the two cannot part company again.
const failingOnWhite = Object.entries(serverColors).filter(([, t]) => !t.passes).map(([k]) => k);
// Slice FORWARD from linterResults. The first draft searched for the next `skills: [` with a bare
// indexOf, which matches an earlier occurrence elsewhere in server.js and yields a backwards slice —
// an empty string that made the assertion fail for the wrong reason. A guard that fails for the
// wrong reason is only luckier than one that passes for the wrong reason.
const linterStart = serverSrc.indexOf('linterResults: [');
assert(linterStart > 0, 'the linterResults array was located in server.js');
const linterBlock = serverSrc.slice(linterStart, serverSrc.indexOf('skills: [', linterStart));
assert(linterBlock.includes('color-contrast'), '...and the slice actually contains the contrast findings');

const unreported = failingOnWhite.filter((c) => !new RegExp(serverColors[c].hex, 'i').test(linterBlock));
assert(unreported.length === 0,
  `the linter's contrast findings name every token that fails AA on white${unreported.length
    ? ` — unreported: ${unreported.join(', ')}` : ` (${failingOnWhite.join(', ')})`}`);

// And the ratios quoted in those findings must be the real ones. They were not: the three findings
// quoted 3.1, 2.1 and 3.2, which were the stale hardcoded figures, not the computed 2.54, 2.15, 2.43.
const misquoted = failingOnWhite
  .map((c) => ({ c, quoted: (linterBlock.match(new RegExp(`${serverColors[c].hex}[^\\n]*?\\((\\d+\\.\\d+):1`, 'i')) || [])[1] }))
  .filter((x) => x.quoted && Math.abs(parseFloat(x.quoted) - ratio(serverColors[x.c].hex, WHITE)) > 0.01)
  .map((x) => `${x.c} quotes ${x.quoted}, computes ${ratio(serverColors[x.c].hex, WHITE).toFixed(2)}`);
assert(misquoted.length === 0,
  `each finding quotes the ratio it actually computes${misquoted.length ? ` — ${misquoted.join(' | ')}` : ''}`);

console.log(`  info: ${Object.keys(serverColors).length} tokens verified; ${failingOnWhite.length} fail AA on white (${failingOnWhite.join(', ')})`);

done();
