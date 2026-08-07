// Read-only repo tools: the bounds that keep a failed search from walking the whole box.
//
// THE INCIDENT THIS PINS (2026-08-06). The inline version in server.js counted HITS, not files:
//
//     walkRepoFiles(BASE, (a, r) => { grepOneFile(a, r); return hits.length > 0; }, MAX_HITS)
//
// With zero matches that callback returns false forever, `count` never increments, and the walk
// crossed the entire tree reading every file as utf-8 — no size cap, no binary skip, no byte
// ceiling, no clock. Wired into pipeline stages (254571b) it took production down 27s into every
// dispatch; reverted in c398dab. A grep that finds nothing is the COMMON case, so the old budget
// bounded only the searches that never needed bounding.
//
// Two properties, and the second is what makes the first safe to rely on:
//   1. Every ceiling is on work ACTUALLY DONE — files visited, bytes read, wall clock.
//   2. A bounded result SAYS it was bounded. Otherwise the caller cannot tell "no matches exist"
//      from "I stopped looking" — the same defect as the 4000-char stage-input cut.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRepoTools, LIMITS, BINARY_EXT, SKIP_DIRS } = require('../lib/repo-tools');
const planStore = require('../lib/self-improve/plan-store');
const { assert, done } = require('./test-util');

// --- a synthetic tree big enough to blow an unbounded walk -------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repotools-'));
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
for (let i = 0; i < 60; i++) write(`src/d${i % 6}/file${i}.js`, `// file ${i}\nconst x = ${i};\n`);
write('needle.js', 'const FINDME_UNIQUE = 1;\n');
// Deliberately over the per-file cap AND containing a searchable token: the point is that a grep for
// that token must not answer "No matches." as though the file had been read and found wanting.
write('big.js', 'UNIQUE_TOKEN_ONLY_IN_BIG\n' + 'x'.repeat(3 * 1024 * 1024));
write('image.webp', Buffer.alloc(300 * 1024, 7));       // binary
write('secret.env.js', 'ok');
write('node_modules/pkg/index.js', 'SHOULD_NEVER_BE_SCANNED');
write('.git/config', 'SHOULD_NEVER_BE_SCANNED');

const allowAll = () => true;
const tools = createRepoTools({ base: root, isPathAllowed: allowAll });

// --- 1. THE REGRESSION: a zero-match search is bounded, and says so ----------------------------------
const tiny = createRepoTools({ base: root, isPathAllowed: allowAll, limits: { ...LIMITS, maxFilesScanned: 10 } });
(async () => {
  const miss = await tiny.run('Grep', { pattern: 'ZZZ_NOT_PRESENT_ANYWHERE_ZZZ' });
  assert(/No matches/.test(miss), 'a zero-match grep reports no matches');
  assert(/SEARCH INCOMPLETE/.test(miss),
    'AND it announces that it stopped early — under the old code this walked every file in the tree and reported the same "No matches", indistinguishable from a complete search');
  assert(/scanning 10 files/.test(miss), '...naming the ceiling it hit, so the caller can widen or narrow deliberately');
  assert(/NOT "no more matches"/.test(miss),
    '...and stating explicitly that absence here is not evidence of absence — the misreading that produced a false defect report last time');

  // The same search under the real limits completes, because this tree is small.
  const full = await tools.run('Grep', { pattern: 'ZZZ_NOT_PRESENT_ANYWHERE_ZZZ' });
  assert(/No matches/.test(full), 'under production limits the same search completes');
  assert(!/SEARCH INCOMPLETE/.test(full),
    'and carries NO note — a complete search must not look truncated, or the marker becomes noise and gets ignored');

  // --- 2. it still actually works ---------------------------------------------------------------------
  const hit = await tools.run('Grep', { pattern: 'FINDME_UNIQUE' });
  assert(/needle\.js:1:/.test(hit), 'a real match is found, with file and line');
  assert(!/SEARCH INCOMPLETE/.test(hit), '...and a successful search is not marked incomplete');

  const scoped = await tools.run('Grep', { pattern: 'const x', path: 'src/d0' });
  assert(scoped.split('\n').length > 1, 'a directory-scoped grep works');
  const oneFile = await tools.run('Grep', { pattern: 'FINDME', path: 'needle.js' });
  assert(/needle\.js/.test(oneFile), 'a single-FILE path works too — the natural thing to pass right after a Read');

  const g = await tools.run('Glob', { pattern: 'src/**/*.js' });
  assert(g.split('\n').length >= 60, 'glob matches across depth');
  assert(!/node_modules/.test(g) && !/\.git/.test(g), 'and never descends into node_modules or .git');

  // SKIP_DIRS is pruned at the WALK, before the denylist is even consulted — two independent reasons
  // `commercial/` is unreachable. The open-core split is a boundary, not a convention, and a walk
  // that descended into the private repo would be a boundary violation even if nothing was returned.
  for (const d of ['node_modules', '.git', 'commercial']) {
    assert(SKIP_DIRS.has(d), `the walk prunes "${d}" by name at any depth`);
  }

  const r = await tools.run('Read', { path: 'needle.js' });
  assert(/FINDME_UNIQUE/.test(r), 'Read returns file content');

  // --- 3. cost bounds -----------------------------------------------------------------------------------
  const binaryHit = await tools.run('Grep', { pattern: 'const x' });
  assert(!/image\.webp:/.test(binaryHit),
    `a .webp is never read as text (${BINARY_EXT.size} extensions skipped) — megabytes of mojibake for zero useful hits`);

  // THE DEFECT THE FIRST REAL AUDIT FOUND (run-1786080073868, 2026-08-07). A file skipped for size
  // used to return null with NOTHING recorded, so the scan reported a confident "No matches." while
  // never having opened it. server.js is 716KB against a then-512KB cap: grepping for
  // `buildRepoToolset` — defined in server.js — answered "No matches." The security-auditor
  // reproduced this first-hand and filed it as CS-01. A skip that reads like an absence is the same
  // defect as an unannounced truncation, in the one tool an audit depends on most.
  const oversize = await tools.run('Grep', { pattern: 'UNIQUE_TOKEN_ONLY_IN_BIG' });
  assert(/NOT SEARCHED/.test(oversize),
    'a file skipped for SIZE is reported — "No matches" must never mean "I did not open it"');
  assert(/big\.js/.test(oversize), '...naming the file, so the caller can Read it directly');
  assert(/would NOT appear above/.test(oversize),
    '...and saying plainly that a match inside it would not have shown — the caller must not read absence as evidence');
  assert(!/SEARCH INCOMPLETE/.test(oversize),
    'and it is NOT reported as budget exhaustion — different cause, different remedy (Read that file vs narrow the search)');

  assert(LIMITS.maxFileBytes >= 716 * 1024,
    `the per-file cap (${Math.round(LIMITS.maxFileBytes / 1024)}KB) clears server.js at 716KB — a repo tool that cannot read this repo's largest source file is not an audit tool`);

  const byteCapped = createRepoTools({ base: root, isPathAllowed: allowAll, limits: { ...LIMITS, maxBytesRead: 200 } });
  const bytes = await byteCapped.run('Grep', { pattern: 'ZZZ_NOT_PRESENT' });
  assert(/SEARCH INCOMPLETE/.test(bytes) && /MB/.test(bytes), 'the byte ceiling stops the scan and is reported');

  const timeCapped = createRepoTools({ base: root, isPathAllowed: allowAll, limits: { ...LIMITS, timeBudgetMs: -1 } });
  const timed = await timeCapped.run('Grep', { pattern: 'anything' });
  assert(/SEARCH INCOMPLETE/.test(timed) && /0\.001s|after /.test(timed), 'an exhausted clock stops the scan and is reported');

  // --- 4. the denylist is INJECTED, and enforced ---------------------------------------------------------
  const gated = createRepoTools({ base: root, isPathAllowed: (p) => !/secret/.test(p) });
  assert(/not allowed/.test(await gated.run('Read', { path: 'secret.env.js' })), 'a denied Read is refused');
  assert(!/secret\.env\.js/.test(await gated.run('Glob', { pattern: '**/*.js' })), 'and a denied file never appears in Glob output');
  assert(!/secret/.test(await gated.run('Grep', { pattern: 'ok' })), 'nor is it grepped');

  // The real denylist, unchanged and still the boundary for the production wiring.
  for (const denied of ['.env', '.magent/state/settings.json', '.magent/vault/raw/x.md', 'commercial/a.js', '.git/config', '../../etc/passwd']) {
    assert(planStore.isPathAllowed(denied) !== true, `the shipped denylist still refuses "${denied}"`);
  }
  assert(planStore.isPathAllowed('server.js') === true, '...and still allows source an audit must read');

  // --- 5. never throws ------------------------------------------------------------------------------------
  // A tool that rejects instead of returning a string is a crash risk in any caller that forgets to
  // catch. This one is the last line of defence, not the only one.
  for (const [n, a] of [['Grep', { pattern: '[' }], ['Glob', { pattern: '[' }], ['Read', {}], ['Read', { path: 'nope' }], ['Nope', {}], ['Grep', null]]) {
    const out = await tools.run(n, a);
    assert(typeof out === 'string', `run(${n}, ${JSON.stringify(a)}) returns a string rather than throwing`);
  }
  assert(/not a function|is required/.test((() => { try { createRepoTools({ base: root }); return ''; } catch (e) { return e.message; } })()),
    'constructing without an isPathAllowed predicate throws at wiring time — a repo reader with no denylist must never be constructible');

  // --- 6. the wiring in server.js -----------------------------------------------------------------------
  // The module can be perfect while the server keeps its own copy, or never reaches it.
  const src = require('./test-util').serverSource();
  assert(/require\('\.\/lib\/repo-tools'\)/.test(src), 'server.js uses the module');
  assert(!/function walkRepoFiles/.test(src),
    'and the inline implementation is GONE — a second copy would be a second unbounded walk to forget about');
  assert(/createRepoTools\(\{[\s\S]{0,200}isPathAllowed: selfImprovePlanStore\.isPathAllowed/.test(src),
    'the denylist is INJECTED from plan-store, not re-declared');
  assert(/options\.useRepoTools/.test(src),
    'executeAgent exposes useRepoTools as an explicit opt-in — no other caller silently gains repo read');

  // Only the two PIPELINE STAGE dispatches. Matching loosely on `agent, t` also caught
  // `executeAgent(agent, task, ...)` in runScheduledAgent — which must NOT have repo access, so a
  // loose pattern here would have demanded exactly the wrong thing.
  const stageCalls = src.match(/executeAgent\((?:stage\.agent, task|agent, t), \{[\s\S]{0,160}?\)/g) || [];
  assert(stageCalls.length === 2, `both pipeline stage dispatch sites found, and only those (${stageCalls.length})`);
  for (const c of stageCalls) {
    assert(/useRepoTools:\s*true/.test(c),
      'every stage dispatch passes useRepoTools — one stage with evidence access and its sibling without is the half-blocked run this fixes');
  }

  // BLAST RADIUS: the scheduled runner must stay repo-blind. tech-radar / research-brief /
  // intel-brief / uptime-check run unattended on cron; they have no audit purpose and granting them
  // filesystem read would widen the surface for nothing. This is what kept them safe during the
  // 254571b incident.
  const sched = src.match(/executeAgent\(agent, task, \{ useMcpTools: true, skill: `schedule[\s\S]{0,120}?\)/);
  assert(sched, 'the scheduled-agent dispatch is present');
  assert(!/useRepoTools/.test(sched[0]),
    'and does NOT pass useRepoTools — unattended cron jobs stay repo-blind');

  // --- 6b. tool-call budget --------------------------------------------------------------------------
  // run-1786078508128: three stages spent all 6 turns reading /opt/ai-os and returned a 62-char
  // placeholder — $1.29 of real investigation discarded because nothing asked for a write-up.
  assert(/const PIPELINE_STAGE_TOOL_ITERS = 30;/.test(src),
    'pipeline stages get 30 tool-calling turns — 6 cannot explore a repo AND synthesise');
  for (const c of stageCalls) {
    assert(/maxToolIters: PIPELINE_STAGE_TOOL_ITERS/.test(c), 'and every stage dispatch passes it');
  }
  assert(/\{ maxIters = 6, model = OPUS_MODEL \}/.test(src),
    'while the DEFAULT stays 6 — a chat turn reaching for one lookup must not silently gain a 30-turn budget');
  assert(/TOOL BUDGET[\s\S]{0,200}at most \$\{maxIters\} tool-calling turns/.test(src),
    'the model is TOLD its budget, so it can stop and write while it still has room instead of being cut off');

  // The recovery call is the part that matters more than the number: everything read is still in
  // `messages`, so one call with the tool surface REMOVED forces an answer instead of another tool use.
  const exhausted = src.slice(src.indexOf('BUDGET EXHAUSTED'), src.indexOf('BUDGET EXHAUSTED') + 2200);
  assert(exhausted.length > 100, 'the exhaustion branch is present');
  assert(/const body = \{ model, max_tokens: maxTokens, system: guardedSystem, messages \};/.test(exhausted),
    'the final call omits `tools` ENTIRELY — leaving the tool surface in place would let the model spend a turn it does not have');
  assert(/budgetExhausted: true/.test(exhausted), 'and the result is flagged');
  assert(/tool budget was exhausted/.test(exhausted),
    '...and the text SAYS it was budget-limited, so a downstream stage can tell a partial answer from a complete one — same reason a truncated stage input announces itself');
  assert(/catch \(e\) \{[\s\S]{0,120}final-answer call failed/.test(exhausted),
    'and a failure of the recovery call degrades to the old placeholder rather than throwing');

  assert(/repoSet\.names\.has\(/.test(src), 'repo tool names are reserved against an MCP tool of the same name');
  const execBlock = src.slice(src.indexOf('const mcpSet ='), src.indexOf('const mcpSet =') + 4000);
  const iRepo = execBlock.search(/runReadOnlyRepoTool/);
  const iGate = execBlock.search(/gateAction\(\{/);
  assert(iRepo > -1 && iGate > -1 && iRepo < iGate,
    'a repo read is served BEFORE the MCP approval gate — read-only work must not queue a human approval per file');
  assert(/UNTRUSTED TOOL OUTPUT/.test(src), 'and tool output is still fenced as untrusted — a repo file can carry adversarial text');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`  info: bounds — ${LIMITS.maxFilesScanned} files, ${Math.round(LIMITS.maxBytesRead / 1048576)}MB, ${LIMITS.maxFileBytes / 1024}KB/file, ${LIMITS.timeBudgetMs / 1000}s`);
  done();
})();
