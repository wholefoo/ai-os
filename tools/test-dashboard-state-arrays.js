// tools/test-dashboard-state-arrays.js
// ============================================================
//  dashboard/js/app.js crashed with `TypeError: state.inbox.filter is not a function` in
//  updateStats() whenever GET /api/approvals answered with a non-array — e.g. a 401
//  `{error:'Not authenticated'}` when app.html is opened without a session. fetchJSON returns the
//  server's JSON as-is, and loadInbox assigned it to state.inbox unchecked. The same shape
//  (`state.X = await fetchJSON(...)` then `.map`/`.filter`) was in the agents, skills, workflows,
//  activity, proposals and pipelines loaders.
//
//  The functions are read OUT OF THE SHIPPED FILE and run in a sandbox, so this tests what ships;
//  a retyped copy would keep passing after someone edited app.js.
// ============================================================

const vm = require('vm');
const { assert, done, readRepoFile, requireFinish } = require('./test-util');
requireFinish();

const src = readRepoFile('dashboard/js/app.js');

// Pull a top-level `[async ]function name(...) { ... }` out by brace matching. The bodies used here
// contain only balanced braces (template `${}` included), which is all a counter needs.
function extract(name) {
  const start = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name}() not found in dashboard/js/app.js — renamed or removed?`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

// A minimal DOM: every element accepts textContent/innerHTML and classList calls.
function fakeDocument() {
  const els = {};
  const el = () => ({ textContent: '', innerHTML: '', value: '', dataset: {}, addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false } });
  return {
    els,
    getElementById: (id) => (els[id] = els[id] || el()),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function sandbox(responses) {
  const document = fakeDocument();
  const ctx = {
    document,
    console,
    state: { health: { agents: 3, skills: 5 }, agents: [], skills: [], workflows: [], activity: [], inbox: [], proposals: [], fleetStatus: {} },
    fetchJSON: async (url) => (url in responses ? responses[url] : { error: 'Not authenticated' }),
    // Renderers are not under test here — only that the loaders hand them a list without throwing.
    renderInbox() {},
    renderSkillsStats() {},
    renderSkillsGrid(list) { if (!Array.isArray(list)) throw new TypeError('renderSkillsGrid got a non-array'); },
    renderSkillsExecutions() {},
    setTimeout: () => 0,
    clearTimeout() {},
    escapeHtml: (s) => String(s),
    capitalize: (s) => s,
  };
  vm.createContext(ctx);
  vm.runInContext(['asArray', 'updateStats', 'loadInbox', 'loadAgents', 'loadSkills', 'loadWorkflows'].map(extract).join('\n'), ctx);
  return ctx;
}

(async () => {
  // --- asArray itself -------------------------------------------------------------------------
  const { asArray } = sandbox({});
  const prev = [{ id: 1 }];
  const real = [{ id: 2 }];
  assert(asArray(real, prev) === real, 'asArray passes a real array through (same reference)');
  assert(asArray({ error: 'Not authenticated' }, prev) === prev, 'asArray keeps the previous list on an error object');
  assert(Array.isArray(asArray({ error: 'x' })) && asArray({ error: 'x' }).length === 0, 'asArray falls back to [] with no previous list');
  for (const bad of [null, undefined, 'oops', 0, { length: 2 }]) {
    const got = asArray(bad, undefined);
    assert(Array.isArray(got) && got.length === 0, `asArray(${JSON.stringify(bad)}) -> []`);
  }

  // --- THE REPORTED CRASH: loadInbox -> updateStats with a 401 body -----------------------------
  {
    const ctx = sandbox({}); // every endpoint answers {error:'Not authenticated'}
    let threw = null;
    try { await ctx.loadInbox('all'); } catch (e) { threw = e; }
    assert(!threw, `loadInbox survives a 401 body (${threw ? threw.message : 'no throw'})`);
    assert(Array.isArray(ctx.state.inbox), 'state.inbox is still an array after a 401');
    assert(!ctx.document.els.inboxBadge || ctx.document.els.inboxBadge.textContent === '', 'no badge count invented from an error body');
  }

  // --- A previous good list survives a later 401 ----------------------------------------------
  {
    const ctx = sandbox({ '/api/approvals': [{ id: 'a', status: 'pending' }, { id: 'b', status: 'approved' }] });
    await ctx.loadInbox('all');
    assert(ctx.state.inbox.length === 2, 'a real approvals list is stored');
    assert(ctx.document.els.inboxBadge.textContent === 1, 'badge counts the 1 pending item');
    ctx.fetchJSON = async () => ({ error: 'Not authenticated' });
    await ctx.loadInbox('all');
    assert(ctx.state.inbox.length === 2 && ctx.state.inbox[0].id === 'a', 'a later 401 keeps the previous list instead of replacing it');
  }

  // --- Sibling loaders with the same pattern --------------------------------------------------
  for (const fn of ['loadAgents', 'loadSkills', 'loadWorkflows']) {
    const ctx = sandbox({});
    let threw = null;
    try { await ctx[fn](); } catch (e) { threw = e; }
    assert(!threw, `${fn} survives a 401 body (${threw ? threw.message : 'no throw'})`);
  }

  // --- Static guard: no list-typed state field is assigned a raw fetch result ------------------
  // Catches a new loader re-introducing `state.inbox = await fetchJSON(...)` without asArray.
  const LIST_FIELDS = ['inbox', 'agents', 'skills', 'workflows', 'activity', 'proposals', 'pipelines'];
  const raw = [...src.matchAll(new RegExp(`state\\.(${LIST_FIELDS.join('|')})\\s*=\\s*await\\s+fetchJSON`, 'g'))].map((m) => m[0]);
  assert(raw.length === 0, `no raw \`state.<list> = await fetchJSON(...)\` assignments (found: ${raw.join(' | ') || 'none'})`);
  for (const [field, from] of [['skills', 'skills'], ['activity', 'activity'], ['proposals', 'proposalsRes']]) {
    assert(src.includes(`state.${field} = asArray(${from},`), `loadDashboard/loadRadar route state.${field} through asArray`);
  }

  done();
})();
