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
  // Match the HIT shape (`path:line: text`), not the bare word: the policy note now legitimately
  // contains "secrets", and a loose /secret/ would fail on the very disclosure that fixes the bug.
  assert(!/secret\.env\.js:\d+:/.test(await gated.run('Grep', { pattern: 'ok' })), 'nor is it grepped');

  // --- 4b. READ allowance vs WRITE allowance ------------------------------------------------------------
  // DEP-01 (run-1786080073868) was a FALSE HIGH: the security-auditor reported "no root lockfile;
  // deploys resolve live" for a package-lock.json committed since July. Cause: the read tools reused
  // the WRITE denylist, which denies package-lock.json so a self-improve plan cannot rewrite it — a
  // supply-chain guard that is right for writes and wrong for reads. The dependencies stage was
  // therefore structurally unable to read the one file it exists to analyse, and the denial was
  // invisible, so "not permitted" arrived as "not present".
  assert(planStore.isReadPathAllowed('package-lock.json') === true,
    'a dependency audit CAN read the lockfile — denying it made the dependencies stage unable to do its job');
  assert(planStore.isPathAllowed('package-lock.json') === false,
    'but the WRITE path still refuses it — an agent rewriting a lockfile could pin a malicious version, and that guard must not be widened by this change');
  assert(planStore.isReadPathAllowed('.env') === false,
    '.env is denied for BOTH — the exception list is for write-only denials, never for secrets');
  assert(planStore.isReadPathAllowed('commercial/package-lock.json') === false,
    'and a prefix denial still wins over the exception: the open-core boundary is not exempted by an exact-path allowance');
  for (const p of ['.magent/state/settings.json', '.magent/vault/raw/x.md', '../../etc/passwd']) {
    assert(planStore.isReadPathAllowed(p) === false, `read allowance did not widen "${p}"`);
  }
  assert(planStore.READ_ONLY_EXCEPTIONS.size <= 2,
    'the write-only exception list stays tiny — every entry is a file an agent may read but must never rewrite, and it should be argued for one at a time');

  // A denial must be COUNTED, or absence and prohibition are indistinguishable.
  const denied = await createRepoTools({ base: root, isPathAllowed: (p) => !/secret/.test(p) })
    .run('Grep', { pattern: 'ZZZ_NOT_PRESENT_ANYWHERE_ZZZ' });
  assert(/EXCLUDED BY POLICY/.test(denied), 'policy-excluded paths are reported, not silently dropped');
  assert(/says nothing about/.test(denied),
    '...and the note states that their absence implies nothing — the inference that produced the false HIGH');

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
  assert(/createRepoTools\(\{[\s\S]{0,900}isPathAllowed: selfImprovePlanStore\.isReadPathAllowed/.test(src),
    'the denylist is INJECTED from plan-store — and it is the READ predicate, not the write one (using isPathAllowed here is what hid package-lock.json and produced the false DEP-01)');
  assert(!/isPathAllowed: selfImprovePlanStore\.isPathAllowed\b/.test(src),
    'the write predicate is NOT wired to the read tools');
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
  // Pin the DEFAULT, not the whole parameter list. This originally matched the entire destructuring
  // literal `{ maxIters = 6, model = OPUS_MODEL }` and went red the moment a fourth option
  // (timeoutMs) was added beside it — a false alarm about a default that had not moved. An assertion
  // should fail when its subject changes, not when its neighbours do.
  assert(/async function callAnthropicWithTools\([^)]*\{[^}]*maxIters = 6\b/.test(src),
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

  // --- GLOB PATTERN SEMANTICS -----------------------------------------------------------------------
  // Found by run-1786158988267 (2026-08-08): its `architecture` stage declared every application
  // source file "excluded by policy" and marked the whole stage NOT ASSESSABLE. That was FALSE. It
  // had globbed `*.{js,ts,py}`, braces were unsupported, and the bare "No files matched." landed in
  // the same response as an unrelated EXCLUDED-BY-POLICY note. Two independent facts read as one.
  // Investigating it turned up three more matcher defects, all silent-wrong-answer, all pinned here.
  const globNames = async (pattern) =>
    String(await tools.run('Glob', { pattern })).split('\n').filter((l) => l && !l.startsWith('['));

  // 1. BRACES. Previously escaped into literals, so this could never match anything.
  const braced = await globNames('*.{js,ts}');
  assert(braced.includes('needle.js'), '`*.{js,ts}` expands braces and matches — it used to be a literal, so it matched nothing');
  const multi = await globNames('**/*.{js,webp}');
  assert(multi.includes('image.webp') && multi.some((f) => f.startsWith('src/')),
    'brace alternatives are matched independently, at depth');

  // 2. `**` MUST MATCH ZERO SEGMENTS. This is the severe one: `**/*.js` used to compile to a regex
  //    REQUIRING a slash, so it returned a long, confident list with every root-level file missing.
  //    In the real repo that silently omitted server.js — the 716KB monolith most of the code is in.
  const deep = await globNames('**/*.js');
  assert(deep.includes('needle.js'),
    '`**/*.js` includes ROOT-level files — `**` matches zero or more segments, not "at least one"');
  assert(deep.some((f) => f.startsWith('src/')), 'and still matches nested ones');

  // 3. `*` MUST NOT CROSS `/`. The counterpart to the above: if `*` leaked across separators, the
  //    root-only form would silently become recursive and the two patterns would be indistinguishable.
  const shallow = await globNames('*.js');
  assert(shallow.includes('needle.js') && !shallow.some((f) => f.includes('/')),
    '`*.js` matches ONLY the repo root — `*` does not cross a path separator');

  // 4. `?` IS ONE CHARACTER. It used to fall through to the regex as a quantifier, so `needl?.js`
  //    quietly meant "need, optional l" instead of "one character here".
  assert((await globNames('needl?.js')).includes('needle.js'), '`?` matches exactly one character');

  // 5. A ZERO MATCH MUST EXPLAIN ITSELF — the defect that started this.
  const empty = String(await tools.run('Glob', { pattern: '*.{nope,nada}' }));
  assert(/No files matched/.test(empty), 'a genuinely unmatched pattern still says so');
  assert(/interpreted as 2 alternatives: \*\.nope, \*\.nada/.test(empty),
    'and REPORTS HOW IT WAS INTERPRETED, so a misunderstood pattern is visible instead of looking like a refusal');
  assert(/NOT the same as "they were withheld"/.test(empty),
    'and explicitly separates "matched nothing" from "was withheld" — the exact conflation that blocked the audit stage');

  // Unbalanced braces must not throw or vanish — a caller may legitimately search for a `{`.
  assert(!/Error/.test(String(await tools.run('Glob', { pattern: '*.{js' }))), 'an unbalanced brace is treated literally, not as an error');

  // Expansion is capped: `{a,b}` repeated multiplies, and an unbounded expansion is exponential work
  // from one tool argument.
  const bomb = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'.repeat(2);
  const t0 = Date.now();
  await tools.run('Glob', { pattern: bomb });
  assert(Date.now() - t0 < 5000, `a brace bomb is capped and returns promptly (${Date.now() - t0}ms)`);

  // --- THE RESULT CAP MUST ANNOUNCE ITSELF ------------------------------------------------------------
  // The one bound that did NOT. `walk` returns early on a 'stop' from its callback without setting
  // budget.stopped, so a search finding exactly maxHits looked identical to an exhaustive one. This
  // module's header promises the opposite. A capped list is the most dangerous incomplete result:
  // long enough to look complete.
  const capped = createRepoTools({ base: root, isPathAllowed: allowAll, limits: { ...LIMITS, maxHits: 5 } });
  const cg = String(await capped.run('Glob', { pattern: '**/*.js' }));
  assert(cg.split('\n').filter((l) => l && !l.startsWith('[')).length === 5, 'Glob stops at the result cap');
  assert(/SEARCH INCOMPLETE[\s\S]*result cap/.test(cg), 'and SAYS it hit the result cap');
  const cr = String(await capped.run('Grep', { pattern: 'const' }));
  assert(cr.split('\n').filter((l) => l && !l.startsWith('[')).length === 5, 'Grep stops at the result cap');
  assert(/SEARCH INCOMPLETE[\s\S]*result cap/.test(cr), 'and SAYS it hit the result cap too');
  // The counterpart, or the note is just noise: a search that genuinely finished must NOT be marked.
  const complete = String(await tools.run('Grep', { pattern: 'FINDME_UNIQUE' }));
  assert(!/result cap/.test(complete), 'a search that finished within the cap is NOT marked incomplete');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`  info: bounds — ${LIMITS.maxFilesScanned} files, ${Math.round(LIMITS.maxBytesRead / 1048576)}MB, ${LIMITS.maxFileBytes / 1024}KB/file, ${LIMITS.timeBudgetMs / 1000}s`);
  done();
})();
