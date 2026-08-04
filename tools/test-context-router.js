// `.claude/claude.md` is a ROUTER into `.claude/context/`, and this suite keeps it one.
//
// Phase 1 of .magent/vault/wiki/model-fit-2026-design.md — progressive disclosure. The file was 250
// lines and 34 `##` sections, every one of them loaded on every session whether the work touched the
// 3D Production Studio or not. It now carries what a cold session actually needs (session-start
// maps, mission, architecture, the non-negotiables, the file layout, and a routing table) and points
// at leaves for the rest.
//
// Three failure modes, all of them things this repo has hit before in other guises:
//
//   1. THE ROUTER REGROWS. A section gets added "just here, it's small" until the file is a manual
//      again. Budgeted, exactly like MAX_BODY_LINES on a handbook body: the router is paid for on
//      every session forever.
//   2. A LEAF IS UNREACHABLE. A file in `.claude/context/` that the routing table never names is
//      strictly worse than an inline section — it rots unread while looking maintained. Same defect
//      class as a `gates:` id that names nothing, and checked the same way, in both directions.
//   3. CONTENT VANISHES IN THE MOVE. A relocation that silently drops a paragraph is the expensive
//      failure, because the loss is invisible in a diff of 250 deletions and 210 insertions across
//      seven files. Asserted on VALUES — specific load-bearing strings that must still be findable.
const fs = require('fs');
const path = require('path');
const { assert, done } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(ROOT, '.claude', 'claude.md');
const CONTEXT_DIR = path.join(ROOT, '.claude', 'context');

// CRLF normalised at the read boundary, once. This repo checks out CRLF on Windows and a `\r` has
// silently zeroed a line-based count here three separate times.
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const lineCount = (s) => s.split('\n').length;

const router = read(ROUTER);

// --- 1. the router stays a router -------------------------------------------------------------------
// 80 rather than the 50 the blueprint first guessed. That estimate was written before the content was
// laid out; the honest floor is session-start maps + mission + architecture + 10 non-negotiables +
// an 18-line file layout + the routing table, which lands near 70. Budgeting below the real floor
// would just mean deleting something load-bearing to satisfy a number, which is the opposite of the
// point. 80 leaves room for a route row or two and still fails loudly on a regrown manual.
const ROUTER_BUDGET = 80;
assert(lineCount(router) <= ROUTER_BUDGET,
  `the router is ${lineCount(router)} lines, within the ${ROUTER_BUDGET}-line budget — it is loaded on EVERY session (was 250 before the split)`);

// A router routes. If the detail came back inline, these strings would be here rather than in a leaf.
for (const detail of ['resolveAnthropicModel', 'TELEGRAM_BOT_TOKEN', 'firecrawl_deep_research', 'PASS >= 80']) {
  assert(!router.includes(detail),
    `"${detail}" is NOT in the router — it belongs to a leaf, and finding it here means the split is reverting`);
}

// --- 2. every leaf is reachable, and every route resolves --------------------------------------------
const leaves = fs.readdirSync(CONTEXT_DIR).filter((f) => f.endsWith('.md'));
assert(leaves.length >= 5, `the context leaves were found (${leaves.length}: ${leaves.join(', ')})`);

const unrouted = leaves.filter((f) => !router.includes(`.claude/context/${f}`));
assert(unrouted.length === 0,
  `every leaf is named by the router${unrouted.length ? ` — unreachable: ${unrouted.join(', ')}` : ''}`);

// The other direction. A route pointing at a file that does not exist reads as coverage and delivers
// a missing read — the same asymmetry as an executor with no risk band.
const routed = [...router.matchAll(/`\.claude\/context\/([a-z-]+\.md)`/g)].map((m) => m[1]);
assert(routed.length === leaves.length,
  `the router names ${routed.length} leaves and ${leaves.length} exist — the two sides agree`);
const dangling = routed.filter((f) => !fs.existsSync(path.join(CONTEXT_DIR, f)));
assert(dangling.length === 0,
  `every routed path resolves${dangling.length ? ` — dangling: ${dangling.join(', ')}` : ''}`);

// Leaves have a budget too, or the split just moves the problem one hop out.
const LEAF_BUDGET = 60;
const fat = leaves.map((f) => ({ f, n: lineCount(read(path.join(CONTEXT_DIR, f))) })).filter((x) => x.n > LEAF_BUDGET);
assert(fat.length === 0,
  `no leaf exceeds ${LEAF_BUDGET} lines${fat.length ? ` — over: ${fat.map((x) => `${x.f} (${x.n})`).join(', ')}` : ''}`);

// Every leaf states when to read it. Without that line the routing table is the only signal, and a
// leaf opened out of context reads as undifferentiated reference.
const noWhen = leaves.filter((f) => !/^Read when:/m.test(read(path.join(CONTEXT_DIR, f))));
assert(noWhen.length === 0,
  `every leaf opens with a "Read when:" line${noWhen.length ? ` — missing: ${noWhen.join(', ')}` : ''}`);

// --- 3. nothing was lost in the move ------------------------------------------------------------------
// Load-bearing strings from the pre-split file. Each is here because losing it costs something real:
// a routing trap, a threshold, a credential name, a security gate, a hard-won ops fact. A line count
// would not have caught any of them going missing — this repo has been bitten by exactly that.
const ALL = [router, ...leaves.map((f) => read(path.join(CONTEXT_DIR, f)))].join('\n');
const MUST_SURVIVE = [
  'resolveAnthropicModel',                       // effective model != frontmatter, the recurring trap
  'declared default, NOT the effective model',
  'costRateFor(model)',                          // unknown models warn instead of billing as Opus
  'PASS >= 80, REVIEW 60-79, FAIL < 60',         // the verdict thresholds
  'gate: blocking',                              // pipeline human-approval syntax
  'firecrawl_deep_research',                     // the real MCP tool names
  'TELEGRAM_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'seclint.js',                                  // the security gate
  'CORS_ORIGIN',
  '127.0.0.1',                                   // production binding
  'soul.md',                                     // the identity stack
  '.magent/vault/outputs/',
  'Never write outside',                         // non-negotiable #1
  'robots.txt',                                  // browser-agent safety
  '30 queries/hour',                             // grok rate limit
];
const lost = MUST_SURVIVE.filter((s) => !ALL.includes(s));
assert(lost.length === 0,
  `every load-bearing detail survived the split${lost.length ? ` — LOST: ${lost.map((s) => JSON.stringify(s)).join(', ')}` : ` (${MUST_SURVIVE.length} checked)`}`);

// The router keeps the things a cold session cannot work without.
for (const essential of ['SKILL-MAP.md', 'vault-map.md', 'engineering-workflow.md', 'Non-Negotiable Rules', 'File Layout']) {
  assert(router.includes(essential), `the router still carries "${essential}" — a cold session needs it before it knows what to route to`);
}

console.log(`  info: router ${lineCount(router)} lines + ${leaves.length} leaves (${leaves.map((f) => lineCount(read(path.join(CONTEXT_DIR, f)))).reduce((a, b) => a + b, 0)} lines), from 250 inline`);

done();
