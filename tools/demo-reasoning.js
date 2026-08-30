#!/usr/bin/env node
// Runnable demonstration of lib/reasoning — the framework spec's §4 "practical demonstration".
//
//     node tools/demo-reasoning.js
//
// It uses a MOCK model client, so it runs with no API key, spends nothing, and is deterministic.
// The mock is scripted to make the interesting things actually happen rather than narrating them:
//
//   1. A Tree-of-Thoughts search where the most attractive opening move is a dead end, so the
//      engine must abandon it and come back to a branch it had already passed over.
//   2. A process verifier catching a HALLUCINATED step — and the step's ACTION being dropped
//      instead of executed.
//   3. A Reflexion loop turning that rejection into a written lesson and passing on the retry.
//   4. The STaR bootstrapper filtering rationales by outcome and filing only the survivors.
//   5. The context manager under memory pressure, keeping the safety rules and evicting the rest.
//
// The scenario: diagnose why a nightly job silently stopped producing output. The real cause is a
// disk-full condition. The mock model is scripted to first "remember" a plausible but INVENTED
// config flag — the kind of confident fabrication that outcome-only supervision ships and process
// supervision catches.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/reasoning');
const { createBudget } = require('../lib/reasoning/budget');
const { createContextManager } = require('../lib/reasoning/context');

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const RED = '\x1b[31m';
const GREEN = '\x1b[32m'; const YELLOW = '\x1b[33m'; const CYAN = '\x1b[36m'; const OFF = '\x1b[0m';
const h = (n, t) => console.log(`\n${BOLD}${CYAN}${'─'.repeat(74)}\n ${n}. ${t}\n${'─'.repeat(74)}${OFF}`);
const say = (s) => console.log(`   ${s}`);
const note = (s) => console.log(`   ${DIM}${s}${OFF}`);

const TASK = 'The nightly export job stopped producing output three days ago. Nothing errors. Find the cause.';

// ── The mock client ─────────────────────────────────────────────────────────────────────────────
// One scripted "model". Every reply is chosen from the prompt it receives, so the same client
// serves the planner, actor, verifier, scorer and reflector roles — exactly as a real deployment
// routes them all through executeAgent.
let hallucinationCorrected = false;

function mockModel(agent, task) {
  // ---- Tree-of-Thoughts: propose ----
  if (/Propose exactly/.test(task)) {
    if (/REASONING SO FAR/.test(task)) {
      if (/rewrite the scheduler/.test(task)) return '1. rewrite the scheduler in a new language\n2. add more scheduler logging';
      if (/check the host/.test(task)) return '1. inspect disk usage on the export volume';
      return '1. re-read the job definition';
    }
    return '1. rewrite the scheduler from scratch\n2. check the host resources the job depends on\n3. blame the upstream API';
  }
  // ---- Tree-of-Thoughts: score ----
  if (/Score how promising/.test(task)) {
    const cand = (task.split('CANDIDATE NEXT STEP:')[1] || '').trim();
    if (/inspect disk usage/.test(cand)) return 'SCORE: 0.95 SOLVED\nNOTE: this is the direct cause.';
    if (/rewrite the scheduler in a new language/.test(cand)) return 'SCORE: 0.05 DEAD-END\nNOTE: rewriting cannot diagnose anything.';
    if (/add more scheduler logging/.test(cand)) return 'SCORE: 0.1\nNOTE: logging a healthy scheduler tells you nothing.';
    if (/rewrite the scheduler from scratch/.test(cand)) return 'SCORE: 0.8\nNOTE: decisive-sounding and concrete.';
    if (/check the host resources/.test(cand)) return 'SCORE: 0.6\nNOTE: unglamorous but plausible.';
    return 'SCORE: 0.15\nNOTE: unlikely.';
  }
  // ---- Decomposition ----
  if (/Decompose the task/.test(task)) {
    return [
      '1. Confirm the job is still being scheduled at all',
      '2. Establish why the job produces no output',
      '3. Confirm the fix restores output',
    ].join('\n');
  }
  // ---- Step execution ----
  if (/Carry out step/.test(task)) {
    if (/Confirm the job is still being scheduled/.test(task)) {
      return 'The scheduler fired the job all three nights; the run log shows three starts and three exits.\nACTION: read /var/log/export/runs.log';
    }
    if (/Establish why the job produces no output/.test(task)) {
      if (/YOUR PREVIOUS ATTEMPT AT THIS STEP WAS REJECTED/.test(task)) {
        hallucinationCorrected = true;
        return 'I asserted a config flag without checking it. Reading the job definition, no such flag exists. The job writes to /export, and df reports that volume at 100% — the writes fail and the job treats a failed write as a no-op.\nACTION: df -h /export';
      }
      // The hallucination: a confident, plausible, entirely invented setting.
      return 'The job has `export.suppress_empty=true` set in its config, which silently discards output when a batch is empty.\nACTION: grep suppress_empty /etc/export/job.conf';
    }
    return 'After freeing 12GB the next run produced the expected file.\nACTION: ls -la /export/latest';
  }
  // ---- Process verification ----
  if (/You are a PROCESS verifier/.test(task)) {
    if (/suppress_empty/.test(task)) {
      return 'STATUS: INCORRECT\nSCORE: 0.1\nFEEDBACK: `export.suppress_empty` does not exist in this job\'s configuration — the step asserts a setting it never read.';
    }
    return 'STATUS: CORRECT\nSCORE: 0.92\nFEEDBACK: follows from the previous step and cites a command that was actually run.';
  }
  // ---- Reflexion: evaluate / reflect ----
  if (/Evaluate the attempt/.test(task)) {
    return /df|100%|disk/i.test(task)
      ? 'VERDICT: PASS\nSCORE: 0.9\nCRITIQUE: identifies a checkable cause and confirms the fix.'
      : 'VERDICT: FAIL\nSCORE: 0.2\nCRITIQUE: names a configuration flag that was never verified to exist.';
  }
  if (/Write ONE sentence/.test(task)) {
    return 'Do not cite a configuration value you have not read — open the file and quote it, or investigate the host instead.';
  }
  // ---- STaR bootstrapping ----
  if (/Solve the task/.test(task)) {
    if (/HINT — the correct answer is/.test(task)) return '1. Checked the volume rather than the config\n2. df reported 100% on /export\nANSWER: disk full';
    if (/nightly export/i.test(task)) return '1. Assumed a config flag\nANSWER: config flag';
    if (/403/.test(task)) return '1. The nightly token rotation had not completed\n2. Requests after midnight used the previous token\nANSWER: expired credentials';
  }
  // ---- Reflexion actor (the bare task, optionally carrying banked lessons) ----
  if (/nightly export job stopped/.test(task)) {
    return /LESSONS FROM YOUR PREVIOUS ATTEMPTS/.test(task)
      ? 'I checked the host rather than guessing at config. df reports /export at 100% — writes fail and the job treats a failed write as a no-op. Freeing space restored output.'
      : 'The job has `export.suppress_empty=true` set, which silently discards output.';
  }
  // ---- Context compression ----
  if (/Compress the notes/.test(task)) {
    return 'Scheduler fires normally; output stopped due to /export at 100%; ruled out the upstream API and a suppress_empty flag that does not exist.';
  }
  return 'acknowledged';
}

const calls = [];
const deps = {
  runAgent: async (agent, task) => {
    calls.push({ agent, task });
    return { ok: true, content: mockModel(agent, task), model: 'mock-model', inputTokens: 120, outputTokens: 60 };
  },
  broadcast: () => {},
  log: () => {},
};

// ── The demonstration ───────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${BOLD}AI OS — Agentic Reasoning Framework${OFF}  ${DIM}(mock client; no API key, no spend)${OFF}`);
  console.log(`${DIM}Task: ${TASK}${OFF}`);

  // =============================================================================================
  h(1, 'TREE OF THOUGHTS — branch, score, and back out of a dead end');
  const search = await R.tot.search(TASK, deps, {
    strategy: 'dfs', breadth: 3, maxDepth: 2, backtrackThreshold: 0.4, budget: createBudget({ maxCalls: 25 }),
  });
  for (const n of search.nodes) {
    const bar = n.score >= 0.5 ? GREEN : n.score >= 0.2 ? YELLOW : RED;
    say(`${DIM}d${n.depth}${OFF} ${bar}${n.score.toFixed(2)}${OFF}  ${n.thought}${n.state.dead ? ` ${RED}(dead end)${OFF}` : ''}`);
  }
  console.log();
  say(`${BOLD}backtracks:${OFF} ${search.backtracks}   ${BOLD}nodes:${OFF} ${search.nodes.length}   ${BOLD}solved:${OFF} ${search.solved}`);
  say(`${BOLD}chosen path:${OFF} ${GREEN}${search.path.map((n) => n.thought).join(' → ')}${OFF}`);
  note('"rewrite the scheduler" scored HIGHEST at depth 1 and led nowhere. The search abandoned it');
  note('and returned to "check the host resources", which it had already passed over. A best-first');
  note('walk would still be inside the rewrite branch.');

  // =============================================================================================
  h(2, 'PROCESS VERIFICATION — catching a hallucination before its action runs');
  const executed = [];
  const run = await R.steps.runVerifiedSteps(TASK, deps, {
    onFail: 'revise', maxRevisions: 1, budget: createBudget({ maxCalls: 25 }),
    executeAction: async (action) => { executed.push(action); return { ok: true, output: 'done' }; },
  });
  run.trace.steps.forEach((s, i) => {
    const v = run.trace.verifications[i];
    const mark = v.status === 'CORRECT' ? `${GREEN}✓ CORRECT${OFF}` : v.status === 'INCORRECT' ? `${RED}✗ INCORRECT${OFF}` : `${YELLOW}? AMBIGUOUS${OFF}`;
    say(`${BOLD}step ${i + 1}${OFF} ${mark} ${DIM}(${v.score.toFixed(2)})${OFF}`);
    // Show what the gate REJECTED before showing what it accepted — otherwise this prints a clean
    // row of CORRECT steps and the claim "a hallucination was caught" has no evidence behind it.
    for (const rej of s.metadata.rejectedAttempts || []) {
      say(`  ${RED}✗ rejected attempt${OFF} ${DIM}(${rej.score.toFixed(2)})${OFF}`);
      say(`    ${RED}${rej.rationale.slice(0, 130)}${OFF}`);
      if (rej.action) say(`    ${RED}action it wanted to run:${OFF} ${rej.action} ${RED}← DROPPED${OFF}`);
      say(`    ${DIM}verifier:${OFF} ${rej.feedback}`);
    }
    say(`  ${s.rationale.slice(0, 150)}${s.rationale.length > 150 ? '…' : ''}`);
    if (s.action) say(`  ${DIM}action:${OFF} ${s.action} ${DIM}[${s.metadata.actionResult}]${OFF}`);
    if (v.status !== 'CORRECT') say(`  ${RED}why:${OFF} ${v.feedback}`);
  });
  console.log();
  say(`${BOLD}outcome:${OFF} ${run.trace.outcome}   ${BOLD}revisions:${OFF} ${run.revisions}   ${BOLD}actions executed:${OFF} ${executed.length}`);
  note(`The hallucinated step proposed "grep suppress_empty …". That command NEVER RAN —`);
  note(`executed actions are: ${executed.map((a) => `"${a}"`).join(', ')}.`);
  note('Outcome-only supervision would have graded the final answer and shipped the invented flag.');
  if (hallucinationCorrected) note(`${GREEN}The revision carried the verifier's objection and corrected itself.${OFF}`);

  // =============================================================================================
  h(3, 'REFLEXION — a failure becomes a written constraint');
  const reflex = await R.reflexion.reflexionLoop(TASK, deps, { maxAttempts: 3, budget: createBudget({ maxCalls: 15 }) });
  reflex.history.forEach((a) => {
    say(`${BOLD}attempt ${a.attempt + 1}${OFF} ${a.passed ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`} ${DIM}(${a.score.toFixed(2)})${OFF} — ${a.critique.slice(0, 90)}`);
    if (a.lesson) say(`  ${YELLOW}lesson banked:${OFF} ${a.lesson}`);
  });
  console.log();
  say(`${BOLD}passed:${OFF} ${reflex.ok}   ${BOLD}attempts:${OFF} ${reflex.attempts}   ${BOLD}lessons:${OFF} ${reflex.lessons.length}`);
  note('The lesson was injected into attempt 2\'s prompt. Without that, this is a retry —');
  note('the same coin flip, thrown again.');

  // =============================================================================================
  h(4, 'STaR — filter rationales by outcome, keep only what worked');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-demo-'));
  const store = R.star.createTraceStore({ root: tmp, file: 'demo_dataset.jsonl' });
  const boot = await R.star.bootstrap([
    { task: 'Why did the nightly export stop?', answer: 'disk full' },
    { task: 'Why does the API return 403 after midnight?', answer: 'expired credentials' },
  ], deps, { store, allowRationalization: true, now: '2026-08-30T00:00:00Z', budget: createBudget({ maxCalls: 20 }) });

  say(`${BOLD}solved blind:${OFF} ${boot.solved}   ${BOLD}solved after hint:${OFF} ${boot.rationalized}   ${BOLD}failed:${OFF} ${boot.failed}   ${BOLD}filed:${OFF} ${boot.saved}`);
  for (const t of store.all()) {
    say(`${GREEN}kept${OFF} ${t.rationalized ? `${YELLOW}(rationalized)${OFF}` : `${DIM}(solved blind)${OFF}`}  ${t.task}`);
    t.steps.forEach((s, i) => say(`     ${i + 1}. ${s}`));
  }
  note(`Corpus written to ${store.relPath} — the JSONL an offline fine-tune would consume.`);
  note('The first example failed blind, was retried WITH the answer, and only survived because the');
  note('rationalized attempt passed the SAME check. It is flagged, because a rationale written by a');
  note('model that was shown the answer is weaker evidence than one written blind.');

  const q = 'Why did the nightly export stop producing files?';
  const fenced = R.fewShotOptions(store, q);
  const withHinted = store.retrieve(q, { includeRationalized: true });
  say(`${BOLD}retrieval for a similar task${OFF}`);
  say(`  default            → ${fenced.untrusted ? `${GREEN}1 exemplar${OFF}` : `${YELLOW}nothing — the only match is a rationalized trace, excluded by default${OFF}`}`);
  say(`  includeRationalized → ${withHinted.length ? `${GREEN}${withHinted.length} exemplar${OFF}` : 'nothing'}`);
  note('That difference is the `rationalized` flag doing its job: a rationale written by a model that');
  note('was handed the answer is weaker evidence, so it is not silently promoted into a worked');
  note('example for future runs unless a caller asks for it.');
  const shown = R.star.fewShotBlock(withHinted);
  say(`${BOLD}how it reaches a prompt:${OFF} as ${GREEN}{label: "${shown.label}"}${OFF} — the untrusted envelope`);
  note('Never as a concatenable string: a stored trace is a stored-prompt-injection path the moment');
  note('it is treated as instructions rather than data.');

  // =============================================================================================
  h(5, 'CONTEXT ENGINEERING — what survives when the window is full');
  const WINDOW = 700;
  const cm = createContextManager({ maxTokens: WINDOW });
  cm.setInstructions('SAFETY RULES: never delete a volume without asking. Never restart production unprompted.');
  cm.remember('Scheduler confirmed healthy — three starts, three exits.');
  cm.remember('Ruled out the upstream API.');
  reflex.lessons.forEach((l) => cm.recall(l));
  // Enough working notes to genuinely OVERFLOW the window. An earlier draft used 30, which came to
  // ~612 tokens against a 700-token cap — so nothing was ever evicted, and this section's claim
  // that "the safety rules survived" was vacuously true. A demonstration that cannot fail
  // demonstrates nothing; the pressure has to be real for the invariant to mean anything.
  for (let i = 0; i < 90; i++) cm.note(`working note ${i}: intermediate observation while tracing the export path`);

  const before = cm.usage();
  const rulesBefore = cm.segments.instructions.length;
  const assembled = cm.assemble();
  const after = assembled.stats;

  say(`${BOLD}before:${OFF} ~${before.total} tokens against a ${WINDOW}-token window ${before.total > WINDOW ? `${RED}(over by ${before.total - WINDOW})${OFF}` : `${YELLOW}(not actually over — nothing to evict)${OFF}`}`);
  say(`${BOLD}evicted:${OFF} scratchpad ${after.evicted.scratchpad}, episodic ${after.evicted.episodic}, longterm ${after.evicted.longterm}, ${BOLD}instructions ${GREEN}n/a — not evictable${OFF}`);
  say(`${BOLD}after:${OFF} ~${after.total} tokens ${after.total <= WINDOW ? `${GREEN}(fits)${OFF}` : `${RED}(still over)${OFF}`}`);
  console.log();
  say(`${BOLD}cacheable prefix (stable across calls):${OFF}`);
  say(`  ${GREEN}${assembled.system}${OFF}`);
  say(`${BOLD}volatile block — sections present after eviction:${OFF}`);
  for (const seg of ['longterm', 'episodic', 'scratchpad']) {
    const n = cm.segments[seg].length;
    say(`  ${DIM}${seg.padEnd(11)}${OFF} ${n ? `${n} entr${n === 1 ? 'y' : 'ies'}` : `${RED}emptied${OFF}`}`);
  }
  console.log();
  say(`${BOLD}instructions kept:${OFF} ${cm.segments.instructions.length === rulesBefore && /never delete a volume/.test(assembled.system) ? `${GREEN}YES — verbatim, under real pressure${OFF}` : `${RED}NO — INVARIANT VIOLATED${OFF}`}`);
  note('THE SAFETY RULES SURVIVED. They are the one segment with no entry in the eviction order —');
  note('a context-budget optimisation that can silently drop "never delete without asking" is a');
  note('safety regression that no test would catch, because the run still succeeds.');
  note('Only the stable segment goes in the cacheable prefix; server.js warns that getting that');
  note('split backwards is a guaranteed cache miss on every request, reported by nothing.');

  // =============================================================================================
  h(6, 'WHAT IT COST');
  const perAgent = calls.reduce((m, c) => ({ ...m, [c.agent]: (m[c.agent] || 0) + 1 }), {});
  say(`${BOLD}total model calls across all five demonstrations:${OFF} ${calls.length}`);
  Object.entries(perAgent).sort((a, b) => b[1] - a[1]).forEach(([a, n]) => say(`  ${DIM}${a.padEnd(12)}${OFF} ${n}`));
  console.log();
  note('A single direct call would have been 1. That is the trade these patterns make, and it is why');
  note('every engine routes through lib/reasoning/budget.js — there is no unmetered path to a model');
  note('inside this framework, so a new pattern cannot forget to have a ceiling.');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${GREEN}${BOLD}Demo complete.${OFF} ${DIM}Nothing was spent; every reply came from the scripted mock in this file.${OFF}\n`);
})();
