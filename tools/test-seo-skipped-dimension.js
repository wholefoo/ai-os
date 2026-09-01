// An SEO dimension that was never measured must never be PRESENTED as a failing grade.
//
// One invariant, three surfaces, and it was broken on all three at once. A new audit record starts
// all seven dimensions at 'running'; the free-audit demo fallback runs six, because Local SEO needs
// a real business identity (placeId, Maps data) that a public form asking only for a domain cannot
// supply. Nothing closed the seventh slot, so it sat at 'running' forever — and both result views
// build one card per slot from whatever the record holds:
//
//   - the PUBLIC free-audit page rendered `data.score || '?'` in the critical-red class, so a lead
//     saw a red "?" dimension next to six real scores
//   - the ADMIN detail view rendered `escapeHtml(data.score)`, and escapeHtml(null) is the empty
//     string, so the badge came out as a bare red "/100" with no number. That one did not need demo
//     mode at all: runRealSeoAudit marks a dimension 'skipped' whenever it does not apply to a site.
//
// WHY THIS SUITE RUNS THE REAL FUNCTIONS. The fix is a rendering decision, and the previous instances
// of this failure class in this repo were all "the code says the right thing" claims established by
// reading. So each section extracts the actual function from the actual file and executes it, using
// that file's OWN escapeHtml rather than a reimplementation — a harness that escapes differently
// from the page is a harness that tests itself.
//
// WHAT IS DELIBERATELY NOT PINNED: the two surfaces are allowed to disagree, and do. The public page
// OMITS a skipped dimension (a lead should not be shown a dimension nobody ran); the admin view KEEPS
// the card and labels it (an operator needs to see that Local SEO was skipped). Asserting they behave
// identically would be asserting the wrong thing.
'use strict';

const vm = require('vm');
const { assert, done, readRepoFile } = require('./test-util');

const server = readRepoFile('server.js');
const freeAuditPage = readRepoFile('dashboard/js/free-audit-page.js');
const app = readRepoFile('dashboard/js/app.js');

/** Lift a function declaration out of a source file by its opening line and the matching
 *  same-indent closing brace. Used instead of brace-counting because these functions are nests of
 *  template literals containing further template literals, which a naive backtick scanner mistracks.
 *  Returns null when not found, so every caller can assert the extraction before relying on it. */
function grabFn(src, name, indent = '') {
  const lines = src.split('\n');
  const open = [`${indent}async function ${name}(`, `${indent}function ${name}(`];
  const start = lines.findIndex((l) => open.some((o) => l.startsWith(o)));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}}`) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

// ================================================================================================
// 1. server.js — every slot the demo fallback does not run is closed out
// ================================================================================================

const slotsSrc = (server.match(/const NEW_AUDIT_AGENT_SLOTS = [^\n]+/) || [])[0];
const factorySrc = grabFn(server, 'newSeoAudit');
const loopSrc = (server.match(/for \(const slot of Object\.keys\(audit\.agents\)\) \{[\s\S]*?\n {4}\}/) || [])[0];
const demoListSrc = (server.match(/const agentNames = (\[[^\]]*\]);\n\s*const delays =/) || [])[1];

// Assert the extractions FOUND something and contain what is about to be constrained. An extraction
// that silently returns nothing turns every assertion below into a vacuous pass — this repo has shipped
// exactly that shape before.
assert(!!slotsSrc && /'local'/.test(slotsSrc), 'located NEW_AUDIT_AGENT_SLOTS, and it really does include a local slot');
assert(!!factorySrc && /agents:/.test(factorySrc), 'located newSeoAudit and it really does build an agents map');
assert(!!loopSrc && /'skipped'/.test(loopSrc), "located the demo close-out loop and it really does assign 'skipped'");
assert(!!demoListSrc, 'located the demo fallback agentNames list');

const factoryCtx = {};
vm.createContext(factoryCtx);
vm.runInContext(`${slotsSrc}\n${factorySrc}`, factoryCtx);
const demoNames = JSON.parse(demoListSrc.replace(/'/g, '"'));

/** Build a fresh free-audit record and run the real close-out loop over it. */
function afterCloseOut(extraSlots = {}) {
  const audit = factoryCtx.newSeoAudit({ id: 'a1', domain: 'demo.test', email: 'x@y.z', source: 'free' });
  Object.assign(audit.agents, extraSlots);
  const ctx = { audit, agentNames: demoNames };
  vm.createContext(ctx);
  vm.runInContext(loopSrc, ctx);
  return audit;
}

const closed = afterCloseOut();

// THE invariant, stated over the record rather than over 'local': nothing may still be 'running'
// once the fallback has been set up, because nothing will ever come back to finish it.
const stuck = Object.entries(closed.agents).filter(([n, g]) => !demoNames.includes(n) && g.status === 'running');
assert(stuck.length === 0,
  `no slot outside the demo list is left 'running' forever (stuck: ${stuck.map(([n]) => n).join(',') || 'none'})`);

assert(closed.agents.local.status === 'skipped', "today that means Local SEO ends 'skipped'");
assert(closed.agents.local.score === null, 'and its score stays null — a dimension nobody ran gets no fabricated number');
assert(typeof closed.agents.local.completedAt === 'string', 'and it is genuinely terminal, carrying a completedAt');

for (const n of demoNames) {
  assert(closed.agents[n].status === 'running', `${n} is untouched by the close-out and still awaits its own setTimeout`);
}

// The category property, and the reason the loop is derived from the lists instead of naming 'local':
// an eighth dimension added to the record but not to the fallback must close ITSELF out.
const future = afterCloseOut({ somethingNobodyHasWrittenYet: { status: 'running', score: null, findings: [], startedAt: 'x' } });
assert(future.agents.somethingNobodyHasWrittenYet.status === 'skipped',
  'a future dimension absent from the demo list closes itself out — the guard is on the category, not on a name');

// Guards the honesty rule from the other direction. The demo path FABRICATES scores (it is flagged
// `estimated` for exactly that reason), so a dimension joining that list starts being made up. Local
// SEO must not: there is no business identity to measure and inventing one would mislead a lead.
assert(!demoNames.includes('local'),
  'the demo fallback does not fabricate a Local SEO score — it has no business identity to measure');

// ================================================================================================
// 2. dashboard/js/free-audit-page.js — the public results page omits what never ran
// ================================================================================================

const pageEscape = grabFn(freeAuditPage, 'escapeHtml');
const renderFree = grabFn(freeAuditPage, 'renderFreeResult', '    ');
assert(!!pageEscape, 'located the free-audit page escapeHtml, so the harness escapes the way the page does');
assert(!!renderFree && /audit-agent-result-name/.test(renderFree), 'located renderFreeResult and it really does build dimension cards');

function renderPublic(audit) {
  let html = '';
  const ctx = {
    document: { getElementById: () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; }, style: {} }) },
  };
  vm.createContext(ctx);
  vm.runInContext(`${pageEscape}\n${renderFree}`, ctx);
  ctx.renderFreeResult(audit);
  return html;
}

const cardNames = (html) => [...html.matchAll(/audit-agent-result-name">([^<]+)</g)].map((m) => m[1]);

const finished = { compositeScore: 72, executiveSummary: 'Demo summary.', quickWins: [], estimated: true, agents: {} };
for (const n of demoNames) finished.agents[n] = { status: 'complete', score: 72, findings: [] };
finished.agents.local = { status: 'skipped', score: null, findings: [] };

const publicHtml = renderPublic(finished);
const publicCards = cardNames(publicHtml);
assert(publicCards.length === demoNames.length,
  `the public page renders one card per dimension that RAN (${demoNames.length}), not one per slot (got ${publicCards.length}: ${publicCards.join(',')})`);
assert(!publicCards.includes('local'), 'no card for the skipped dimension');
assert(demoNames.every((n) => publicCards.includes(n)), 'and every dimension that did run still gets its card');
assert(!/audit-agent-result-score score-bad">\?/.test(publicHtml),
  'the red "?" card a lead used to be shown is gone');
assert(/audit-estimate-notice/.test(publicHtml),
  'the "preliminary estimate" honesty notice is untouched — it is the thing that keeps a fabricated score from reading as authoritative');

// The guard the other way. The filter must drop SKIPPED dimensions, not the local one: a paid audit
// where Local SEO genuinely ran has to keep showing it.
const real = { ...finished, agents: { ...finished.agents, local: { status: 'complete', score: 88, findings: [] } } };
const realCards = cardNames(renderPublic(real));
assert(realCards.length === demoNames.length + 1 && realCards.includes('local'),
  'when Local SEO genuinely runs, its card IS shown — the filter is on status, not on the name');

// ================================================================================================
// 3. dashboard/js/app.js — the admin detail view labels instead of grading
// ================================================================================================

const appEscape = grabFn(app, 'escapeHtml');
const viewAudit = grabFn(app, 'viewSeoAudit');
assert(!!appEscape, 'located the dashboard escapeHtml');
assert(!!viewAudit && /seo-agent-card/.test(viewAudit), 'located viewSeoAudit and it really does build agent cards');

function renderAdmin(audit) {
  let html = '';
  const ctx = {
    fetchJSON: async () => audit,
    capitalize: (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1),
    document: { getElementById: () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; }, style: {} }) },
  };
  vm.createContext(ctx);
  vm.runInContext(`${appEscape}\n${viewAudit}`, ctx);
  return ctx.viewSeoAudit('id').then(() => html);
}

/** The class and inner text of one dimension's score badge. */
const badge = (html, label) => {
  const m = html.match(new RegExp(`${label} Analysis</span>\\s*<span class="seo-score seo-score-(\\w+)">([^<]*)(<small>([^<]*)</small>)?`));
  return m ? { cls: m[1], text: m[2], small: m[4] } : null;
};

async function adminSuite() {
  const adminAudit = { domain: 'x.test', compositeScore: 72, quickWins: [], actionPlan: [], agents: { ...finished.agents } };
  const html = await renderAdmin(adminAudit);

  const local = badge(html, 'Local');
  assert(local && local.cls === 'pending',
    `a skipped dimension gets the muted seo-score-pending class, never a grade (got ${local && local.cls})`);
  assert(local && local.small === 'skipped', 'and says what happened to it instead of showing a blank score');
  assert(/Local Analysis/.test(html),
    'the admin card is still SHOWN — unlike the public page, an operator needs to see that the dimension was skipped');

  const measured = badge(html, 'Keyword');
  assert(measured && measured.cls === 'warning' && measured.text === '72',
    'a measured dimension is completely unaffected — still graded, still numeric');
  assert(/seo-score seo-score-warning seo-score-lg">72<small>\/100<\/small>/.test(html),
    'and the composite badge is untouched');

  // The grading thresholds sit BEHIND a newly inserted null branch, so they are re-pinned here. A
  // refactor that reorders that ternary would otherwise change grades with nothing to catch it.
  for (const [score, want] of [[100, 'good'], [75, 'good'], [74, 'warning'], [50, 'warning'], [49, 'critical'], [1, 'critical']]) {
    const one = await renderAdmin({ ...adminAudit, agents: { keyword: { status: 'complete', score, findings: [] } } });
    const b = badge(one, 'Keyword');
    assert(b && b.cls === want, `score ${score} still grades ${want} (got ${b && b.cls})`);
  }

  // THE boundary case. Written `!data.score` instead of `data.score != null`, this fix would treat a
  // real zero as "never measured" and hide a genuinely catastrophic score behind a neutral label.
  const zero = await renderAdmin({ ...adminAudit, agents: { keyword: { status: 'complete', score: 0, findings: [] } } });
  const zb = badge(zero, 'Keyword');
  assert(zb && zb.cls === 'critical' && zb.text === '0' && zb.small === '/100',
    'a REAL score of 0 still renders as a red 0/100 — a measurement of zero is not a missing measurement');
}

adminSuite().then(done, (e) => { console.error('FAIL: admin suite threw:', e); process.exitCode = 1; done(); });
