// tools/verify-reasoning-live.js
// ============================================================
//  THE ONE THING lib/reasoning's UNIT SUITES CANNOT TELL YOU.
//
//  tools/test-reasoning*.js pass 100% against MOCKS. They prove the engines' control flow, their
//  budgets, their backtracking and their safety properties. They cannot prove the single assumption
//  everything else rests on: THAT A REAL MODEL ACTUALLY REPLIES IN THE SHAPES THE PARSERS EXPECT —
//  `STATUS: CORRECT`, `SCORE: 0.9`, `VERDICT: PASS`, `ANSWER:`, numbered steps.
//
//  That assumption has never been tested. It could not be: the Anthropic account was spend-capped
//  until 2026-09-01, so every paid call 400'd.
//
//  ── WHY THE FAILURE MODE IS SNEAKY ──
//  Every parser in lib/reasoning FAILS SAFE. An unreadable verifier verdict becomes AMBIGUOUS, an
//  unreadable evaluation becomes FAIL, an unreadable score becomes 0. So if the model ignores the
//  format entirely, nothing crashes and nothing reports an error — the engines simply refuse
//  everything and grind through their budget achieving nothing. "Safe but useless" looks almost
//  exactly like "working but strict" from the outside. The only way to tell them apart is to read
//  the RAW MODEL REPLY and check its shape.
//
//  So this script does not assert on the engines' verdicts. It captures every raw reply the model
//  sends, works out which format that call ASKED for, and grades the reply against that format.
//
//  ── COSTS REAL MONEY, SO IT DOES NOTHING BY DEFAULT ──
//  Named verify-*, not test-*: tools/test-all.js auto-discovers `test-*.js` and this must never run
//  in CI. It also defaults to a DRY RUN that makes zero calls and just prints the plan.
//
//    node tools/verify-reasoning-live.js              # dry run — 0 calls, 0 cost, shows the plan
//    node tools/verify-reasoning-live.js --run        # ~12 real calls, ~$0.30
//    node tools/verify-reasoning-live.js --run --base http://localhost:3000
//
//  RUN IT ON THE VPS. This developer box has a stale truncated key in ~/.claude/settings.json that
//  shadows the valid one in .env, so a local run fails with `invalid x-api-key` for a reason that
//  has nothing to do with what is being tested — a false negative that would read as "the formats
//  do not work".
//
//  Auth: API_TOKEN from the environment, else from .env in the repo root. Never printed.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const steps = require('../lib/reasoning/steps');
const reflexion = require('../lib/reasoning/reflexion');
const tot = require('../lib/reasoning/tot');
const { createBudget } = require('../lib/reasoning/budget');

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const BASE = flag('base', process.env.AIOS_BASE || 'http://localhost:3000').replace(/\/$/, '');
const RUN = has('run');

function resolveToken() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN.trim();
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^API_TOKEN\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through */ }
  return null;
}

// ── The formats under test ────────────────────────────────────────────────────────────────────────
// Each entry: how to RECOGNISE the call from its prompt, and what a correctly-shaped reply contains.
// `required` are the patterns that must ALL match. This is the actual contract between the prompts
// in lib/reasoning and the parsers that read the replies back.
const FORMATS = [
  {
    id: 'decomposition',
    engine: 'steps',
    detect: /Decompose the task/,
    asked: 'numbered steps, one per line',
    parsedBy: (t) => steps.parseSteps(t, 6),
    required: [{ name: 'more than one numbered step', test: (t) => steps.parseSteps(t, 6).length >= 2 }],
  },
  {
    id: 'step-verdict',
    engine: 'steps (PRM gate)',
    detect: /You are a PROCESS verifier/,
    asked: 'STATUS: CORRECT|INCORRECT|AMBIGUOUS + SCORE: 0-1',
    required: [
      { name: 'STATUS: line', test: (t) => /STATUS\s*:\s*(CORRECT|INCORRECT|AMBIGUOUS)/i.test(t) },
      { name: 'SCORE: line', test: (t) => /SCORE\s*:\s*[0-9]*\.?[0-9]+/i.test(t) },
      // The decisive one. AMBIGUOUS is what the parser returns when it understood NOTHING, so a
      // verdict that parses to AMBIGUOUS *without* the model having written the word is precisely
      // the silent-uselessness case this whole script exists to detect.
      { name: 'parses to a definite verdict (not a fallback)', test: (t) => {
        const v = steps.parseVerdict(t);
        return v.status !== 'AMBIGUOUS' || /AMBIGUOUS|UNSURE|UNCLEAR/i.test(t);
      } },
    ],
  },
  {
    id: 'evaluation',
    engine: 'reflexion (Evaluator)',
    detect: /Evaluate the attempt/,
    asked: 'VERDICT: PASS|FAIL + SCORE + CRITIQUE',
    required: [
      { name: 'VERDICT: line', test: (t) => /VERDICT\s*:\s*(PASS|FAIL)/i.test(t) },
      { name: 'SCORE: line', test: (t) => /SCORE\s*:\s*[0-9]*\.?[0-9]+/i.test(t) },
      { name: 'CRITIQUE: line', test: (t) => /CRITIQUE\s*:/i.test(t) },
      { name: 'parses to a non-empty critique', test: (t) => reflexion.parseEvaluation(t).critique.length > 10 },
    ],
  },
  {
    id: 'reflection',
    engine: 'reflexion (Reflector)',
    detect: /Write ONE sentence/,
    asked: 'one actionable sentence, no preamble',
    required: [{ name: 'short and non-empty', test: (t) => t.trim().length > 10 && t.trim().length < 600 }],
  },
  {
    id: 'thought-proposal',
    engine: 'tot (propose)',
    detect: /Propose exactly/,
    asked: 'N distinct numbered thoughts',
    parsedBy: (t) => tot.parseThoughts(t, 5),
    required: [{ name: 'at least 2 DISTINCT thoughts', test: (t) => tot.parseThoughts(t, 5).length >= 2 }],
  },
  {
    id: 'thought-score',
    engine: 'tot (value scorer)',
    detect: /Score how promising/,
    asked: 'SCORE: 0-1 (+ optional SOLVED / DEAD-END)',
    required: [
      { name: 'SCORE: line', test: (t) => /SCORE\s*:\s*[0-9]*\.?[0-9]+/i.test(t) },
      // A 0 score is what parseScore returns when it finds no number at all — indistinguishable
      // from a genuine "this branch is worthless" unless the model actually wrote a zero.
      { name: 'parses to a usable score (not the 0 fallback)', test: (t) => tot.parseScore(t).score > 0 || /\b0(\.0+)?\b/.test(t) },
    ],
  },
];

// ── Transport ─────────────────────────────────────────────────────────────────────────────────────
const captured = [];   // { agent, prompt, content, ok, error, cost, inputTokens, outputTokens }

function makeRunAgent(token) {
  return async function runAgent(agent, task, opts = {}) {
    const res = await fetch(`${BASE}/api/agent/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent, task, maxTokens: opts.maxTokens || 2500, skill: 'reasoning-verify' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const rec = { agent, prompt: task, ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` };
      captured.push(rec);
      return { ok: false, error: rec.error };
    }
    const j = await res.json();

    // A DEMO_MODE instance returns a canned "[DEMO] ..." string. Grading that would be worse than
    // useless: it is a synthetic reply that happens to arrive over the real transport, so a pass
    // would mean nothing at all. Refuse the whole run rather than report a result about a fixture.
    if (j.demo === true || /^\[DEMO\]/.test(String(j.content || ''))) {
      throw new Error('the instance is in DEMO_MODE — replies are canned, so nothing here would be evidence. Set DEMO_MODE=false and re-run.');
    }

    captured.push({
      agent, prompt: task, ok: !!j.ok, content: j.content || '', error: j.error,
      cost: j.cost || 0, inputTokens: j.inputTokens || 0, outputTokens: j.outputTokens || 0, model: j.model,
    });
    return j;
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nlib/reasoning — LIVE WIRE-FORMAT CHECK');
  console.log(`base: ${BASE}\n`);

  if (!RUN) {
    console.log('DRY RUN — no calls made, nothing spent. Pass --run to execute.\n');
    console.log('It would drive the three engines at their smallest useful settings and grade the');
    console.log('RAW model replies against the formats their prompts ask for:\n');
    for (const f of FORMATS) console.log(`  ${f.id.padEnd(18)} ${f.engine.padEnd(22)} expects: ${f.asked}`);
    console.log(`\n  ~8 model calls total (a few cents). RUN THIS ON THE VPS — this box's`);
    console.log('  ~/.claude/settings.json holds a stale truncated key that shadows .env, so a local');
    console.log('  run fails with `invalid x-api-key` and reads as a format failure that it is not.\n');
    return;
  }

  const token = resolveToken();
  if (!token) {
    console.error('No API_TOKEN found (environment or .env). Cannot authenticate — aborting.');
    process.exitCode = 1;
    return;
  }

  const runAgent = makeRunAgent(token);
  const deps = { runAgent, broadcast: () => {}, log: () => {} };
  const budget = createBudget({ maxCalls: 16 });   // hard ceiling: ~10 for the three engines + 2 for the forced reflect path in [2b]

  const TASK = 'Explain why a nightly export job might produce no output while reporting no errors.';

  try {
    console.log('[1/3] steps engine (decomposition + PRM gate)...');
    await steps.runVerifiedSteps(TASK, deps, { maxSteps: 2, maxRevisions: 0, onFail: 'continue', budget });

    console.log('[2/3] reflexion engine (actor + evaluator + reflector)...');
    await reflexion.reflexionLoop(TASK, deps, { maxAttempts: 1, budget });

    // ── [2b] THE REFLECTOR IS ONLY REACHABLE THROUGH A FAILURE ──
    // reflexionLoop calls the reflector only when the evaluator says FAIL. A competent model on a
    // plain task passes first time, so the reflector is never exercised and the run stays PARTIAL
    // forever — "never reached" three runs running, for the OPPOSITE reason each time (run 4: the
    // evaluator died; runs 5-6: the actor simply passed). Neither is evidence about the reflector.
    //
    // So force the path ONCE: intercept the first evaluator call with a synthetic FAIL that never
    // touches a model and is never graded, so the REAL reflector is called and its reply can be.
    // The real evaluator's format was already graded in [2/3]; this does not replace that.
    const reflectionReached = () => captured.some((c) => /Write ONE sentence/.test(c.prompt));
    if (!reflectionReached()) {
      console.log('[2b/3] reflector not reached (actor passed first time) — forcing the reflect path once...');
      let intercepted = false;
      const forcing = {
        ...deps,
        runAgent: async (agent, task, opts) => {
          if (!intercepted && /Evaluate the attempt/.test(task)) {
            intercepted = true;
            // Synthetic and LOCAL: costs nothing, hits no model, and is never pushed to `captured`
            // (only makeRunAgent pushes there), so it cannot be mistaken for a model reply.
            return { ok: true, content: 'VERDICT: FAIL\nSCORE: 0.2\nCRITIQUE: [synthetic — injected by verify-reasoning-live.js to force the reflect path]', inputTokens: 0, outputTokens: 0 };
          }
          return runAgent(agent, task, opts);
        },
      };
      await reflexion.reflexionLoop(TASK, forcing, { maxAttempts: 1, budget });
    }

    console.log('[3/3] tree-of-thoughts engine (propose + value scorer)...');
    // NO token overrides. An earlier version passed proposeTokens: 500 / scoreTokens: 300 — the
    // harness starved the calls it was grading and then reported a FORMAT failure, which is a false
    // negative of its own making. Use the engines' real defaults: this check is meaningless unless
    // the calls it grades are provisioned exactly as production provisions them.
    await tot.search(TASK, deps, { strategy: 'bfs', breadth: 2, maxDepth: 1, budget });
  } catch (e) {
    console.error(`\nABORTED: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  // ── Grade the raw replies ───────────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────────────────────────────────');
  let graded = 0;
  let failed = 0;
  const unseen = [];

  for (const f of FORMATS) {
    const hits = captured.filter((c) => f.detect.test(c.prompt));
    if (!hits.length) { unseen.push(f.id); continue; }

    for (const h of hits) {
      graded++;
      if (!h.ok) {
        failed++;
        console.log(`FAIL ${f.id.padEnd(18)} the call itself failed: ${h.error}`);
        continue;
      }
      const bad = f.required.filter((r) => !r.test(h.content));
      if (bad.length) {
        failed++;
        // AN EMPTY REPLY IS NOT A FORMAT VIOLATION, AND MUST NOT BE REPORTED AS ONE.
        // The third live run printed "missing: VERDICT: line, SCORE: line, CRITIQUE: line" for a
        // reply of ZERO characters — four format complaints about text that did not exist. That is
        // the misdiagnosis lib/reasoning/budget.js already knows how to prevent; the engines had the
        // guard and this diagnostic was bypassing it by grading the raw transport record.
        if (!h.content.trim()) {
          console.log(`FAIL ${f.id.padEnd(18)} (${f.engine}) — EMPTY REPLY (0 chars). NOT a format problem.`);
          console.log(`     ${h.agent} produced ${h.outputTokens} output tokens. At high/xhigh effort adaptive thinking spends`);
          console.log('     from the same ceiling as the answer, so a tight maxTokens returns nothing at all.');
          console.log('     Fix: raise maxTokens for this call. Do NOT touch the prompt or the parser.');
          continue;
        }
        console.log(`FAIL ${f.id.padEnd(18)} (${f.engine}) — missing: ${bad.map((b) => b.name).join(', ')}`);
        console.log(`     asked for : ${f.asked}`);
        // FIRST question to ask of any format failure: was the reply finished? A cut-off reply looks
        // like a format violation and is not one, and blaming the format sends you to rewrite a
        // prompt that was fine. This line goes above the evidence because it changes how to read it.
        if (h.truncated) {
          console.log(`     ⚠ TRUNCATED — ${h.truncationNote}`);
          console.log('     This is very likely NOT a format problem. Raise maxTokens and re-run before changing any parser.');
        }

        // THE FULL REPLY, NOT A PREFIX. The first run truncated at 220 chars, and on the second run
        // that truncation was the only thing standing between a failure and its diagnosis — the
        // interesting part of a list-parsing failure is almost never in the first item. A diagnostic
        // that clips the evidence you need is the same defect class as everything else this suite
        // exists to catch.
        const dump = path.join(os.tmpdir(), `reasoning-verify-${f.id}-${Date.now()}.txt`);
        try { fs.writeFileSync(dump, h.content, 'utf8'); } catch { /* best effort */ }
        console.log(`     full reply (${h.content.length} chars) saved to: ${dump}`);

        // What the PARSER actually extracted. This is what distinguishes "no line matched" from
        // "lines matched and were then joined/deduped/truncated away" — three different bugs that
        // look identical from the item count alone.
        if (f.parsedBy) {
          const items = f.parsedBy(h.content);
          console.log(`     parser extracted ${items.length} item(s):`);
          items.forEach((it, i) => console.log(`       [${i + 1}] ${JSON.stringify(String(it).slice(0, 90))}`));
        }
        console.log('     ── raw reply ──');
        for (const line of h.content.split('\n')) console.log(`     | ${line}`);
        console.log('     ───────────────');
      } else {
        console.log(`ok   ${f.id.padEnd(18)} (${f.engine}) — ${f.asked}`);
      }
    }
  }

  for (const id of unseen) {
    // "Never reached" has two OPPOSITE causes that printed identically for three runs: the step
    // upstream FAILED (run 4 — the evaluator returned nothing), or the step upstream SUCCEEDED so
    // there was nothing to do (runs 5-6 — the actor passed first time, so no reflection was
    // needed). One is a defect, the other is the engine working. A diagnostic that gives them the
    // same line has told you nothing. Read the upstream evaluator's reply and say which it was.
    let why = 'the engine short-circuited before reaching it';
    if (id === 'reflection') {
      const evals = captured.filter((c) => /Evaluate the attempt/.test(c.prompt));
      const last = evals[evals.length - 1];
      if (!last) why = 'no evaluator call happened at all — the actor call before it must have failed';
      else if (!last.ok || !last.content.trim()) why = `UPSTREAM FAILURE — the evaluator returned ${last.ok ? 'an empty reply' : `an error (${last.error})`}, so the loop never got a verdict to reflect on`;
      else if (reflexion.parseEvaluation(last.content).passed) why = 'the actor PASSED on its first attempt, so there was nothing to reflect on — this is the engine working, not failing (and [2b] should have forced the path; if you see this line, [2b] did not run)';
    }
    console.log(`SKIP ${id.padEnd(18)} never exercised — ${why}`);
  }

  const cost = captured.reduce((s, c) => s + (c.cost || 0), 0);
  const inTok = captured.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const outTok = captured.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const models = [...new Set(captured.map((c) => c.model).filter(Boolean))];

  console.log('─────────────────────────────────────────────────────────────────────────');
  console.log(`calls: ${captured.length}   tokens: ${inTok} in / ${outTok} out   cost: $${cost.toFixed(4)}`);
  console.log(`models: ${models.join(', ') || '(none reported)'}`);
  console.log(`formats graded: ${graded}   failed: ${failed}   never reached: ${unseen.length}`);

  if (failed) {
    console.log('\nFORMATS ARE NOT HONOURED. The engines will run, cost money and refuse everything —');
    console.log('safe, but useless. Fix the prompt wording in lib/reasoning, or loosen the parser to');
    console.log('accept what the model actually sends. Do NOT loosen it to accept anything: the');
    console.log('fail-safe default is the only reason a format mismatch is not a safety problem.\n');
    process.exitCode = 1;
  } else if (unseen.length) {
    console.log('\nEverything reached was correctly shaped, but some formats were never exercised.');
    console.log('That is a PARTIAL result — do not record it as a clean pass.\n');
  } else {
    console.log('\nALL FORMATS HONOURED — the assumption every lib/reasoning unit test rests on is');
    console.log('now verified against a real model, not a mock.\n');
  }
})();
