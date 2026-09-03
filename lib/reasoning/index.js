// lib/reasoning/index.js
// ============================================================
//  THE AGENTIC REASONING ORCHESTRATION FRAMEWORK — one entry point over the five engines.
//
//    steps.js      Chain-of-Thought decomposition + PRM process verification   (spec §§1-2)
//    reflexion.js  Actor / Evaluator / episodic-memory retry loop              (spec §3)
//    tot.js        Tree-of-Thoughts search with real backtracking              (spec §4)
//    star.js       Outcome-filtered rationale bootstrapping + trace corpus     (spec §5)
//    context.js    Four-segment context budget manager                         (spec §6)
//    budget.js     The meter every one of them calls through
//
//  ── WHAT THIS IS AND IS NOT ──
//  It is RUN-TIME reasoning scaffolding: it changes how an agent decomposes, checks, searches and
//  remembers while it works. It is NOT a change to any model's training data, and nothing here
//  fine-tunes anything — see the honest-naming note at the top of star.js. The one artefact that
//  genuinely feeds training is `star_dataset.jsonl`, and it feeds it OFFLINE, later, if someone
//  chooses to.
//
//  ── WHY IT WRAPS `executeAgent` RATHER THAN REPLACING IT ──
//  deps.runAgent is server.js's executeAgent, which owns budget ceilings, model/effort routing, the
//  concurrency slot, untrusted fencing and the cost ledger. Reimplementing any of that here would
//  fork five safety mechanisms. Every engine therefore takes the same injected `{runAgent, broadcast,
//  log}` bag lib/orchestrator.js takes, so the real engine and a mock runner share one code path and
//  the whole framework is testable without spending a token.
//
//  ── COST, STATED PLAINLY ──
//  These patterns trade calls for reliability, and the multiplier is not small:
//    direct     1 call.
//    steps      1 + 2N  (decompose, then act+verify per step)         — ~9 calls at N=4
//    reflexion  up to 3 per attempt (act, evaluate, reflect)          — ~9 calls at 3 attempts
//    tot        1 + b per expansion, × expansions                     — ~16 calls at b=3, depth=3
//    deliberate all of the above in sequence                          — capped by MODE_CALLS.deliberate
//  Nothing here is free, `createBudget` caps every one of them, and every result carries the meter
//  reading so a caller can see what deliberation actually cost.
// ============================================================

'use strict';

const budgetMod = require('./budget');
const models = require('./models');
const steps = require('./steps');
const reflexion = require('./reflexion');
const tot = require('./tot');
const star = require('./star');
const contextMod = require('./context');

const { createBudget, deps: normDeps } = budgetMod;

/** Reasoning modes reachable by name. */
const MODES = Object.freeze(['direct', 'steps', 'reflexion', 'tot', 'deliberate']);

/** Default call ceilings per mode — deliberate is the sum of its parts plus slack, not unbounded. */
const MODE_CALLS = Object.freeze({ direct: 1, steps: 20, reflexion: 18, tot: 30, deliberate: 45 });

/**
 * Run a task under a named reasoning strategy.
 *
 * @param {string} task
 * @param {object} deps    { runAgent, broadcast?, log? } — runAgent is server.js executeAgent
 * @param {object} opts    { mode, agent, maxCalls, budget, context, criteria, ... }
 * @returns {Promise<{ok, mode, output, trace?, budget, meta}>}
 */
async function reason(task, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const mode = MODES.includes(opts.mode) ? opts.mode : 'direct';
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || MODE_CALLS[mode] });
  const sub = { ...opts, budget };

  switch (mode) {
    case 'steps': {
      const r = await steps.runVerifiedSteps(task, d, sub);
      return {
        ok: r.ok, mode, output: steps.traceToAnswer(r.trace), trace: r.trace, budget: r.budget,
        meta: { revisions: r.revisions, haltedAt: r.haltedAt, outcome: r.trace.outcome, verification: r.trace.meta.verification },
      };
    }
    case 'reflexion': {
      const r = await reflexion.reflexionLoop(task, d, sub);
      return {
        ok: r.ok, mode, output: r.output, trace: r.trace, budget: r.budget,
        meta: { attempts: r.attempts, lessons: r.lessons, exhausted: r.exhausted, score: r.evaluation ? r.evaluation.score : 0 },
      };
    }
    case 'tot': {
      const r = await tot.search(task, d, sub);
      return {
        ok: r.ok, mode, output: r.pathText, budget: r.budget,
        meta: { solved: r.solved, backtracks: r.backtracks, expanded: r.expanded, nodes: r.nodes.length, strategy: r.strategy, bestScore: r.best.score },
      };
    }
    case 'deliberate':
      return deliberate(task, d, sub);
    default: {
      const r = await budgetMod.guardedCall(d, budget, opts.agent || 'coder', task, { maxTokens: opts.maxTokens, context: opts.context });
      return { ok: r.ok, mode: 'direct', output: r.content, budget: budget.snapshot(), meta: { error: r.error } };
    }
  }
}

/**
 * The full composition — explore, then verify, then repair, then file what worked.
 *
 *   1. ToT SEARCH picks a promising approach, backtracking out of dead ends.
 *   2. VERIFIED STEPS executes that approach behind the PRM gate.
 *   3. REFLEXION repairs it if the gate rejected it, carrying the critique forward.
 *   4. STaR files the trace — ONLY if it is clean and only when a store was supplied.
 *
 * Stage 4 is deliberately conservative: `traceIsClean` treats an UNVERIFIED step as disqualifying,
 * so a trace with a hole in it never becomes a "gold standard" exemplar for future runs.
 */
async function deliberate(task, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || MODE_CALLS.deliberate });
  const meta = {};

  // --- 1. Explore ---
  const search = await tot.search(task, d, { ...opts, budget, maxDepth: opts.maxDepth || 2, breadth: opts.breadth || 3 });
  meta.search = { solved: search.solved, backtracks: search.backtracks, expanded: search.expanded, bestScore: search.best.score };
  const approach = search.pathText || '';

  // --- 2. Verify the chosen approach step by step ---
  const guided = approach ? `${task}\n\nUSE THIS APPROACH (chosen by a prior search over alternatives):\n${approach}` : task;
  const run = await steps.runVerifiedSteps(guided, d, { ...opts, budget });
  meta.steps = { outcome: run.trace.outcome, revisions: run.revisions, haltedAt: run.haltedAt, verification: run.trace.meta.verification };

  let output = steps.traceToAnswer(run.trace);
  let ok = run.ok;
  let trace = run.trace;

  // --- 3. Repair, if the gate rejected it and there is budget left to try ---
  if (!ok && !budget.exhausted() && opts.repair !== false) {
    const why = run.trace.meta.haltReason || (run.trace.meta.verification && run.trace.meta.verification.reason) || 'a step failed verification';
    const rf = await reflexion.reflexionLoop(
      `${task}\n\nA previous attempt failed process verification: ${why}\nProduce a corrected solution that survives that objection.`,
      d, { ...opts, budget, maxAttempts: Math.min(opts.maxAttempts || 2, 2) });
    meta.repair = { attempts: rf.attempts, lessons: rf.lessons, recovered: rf.ok };
    if (rf.ok) { ok = true; output = rf.output; trace = rf.trace; }
  }

  // --- 4. File the trace, if it is genuinely clean ---
  //
  // When a store WAS supplied, always say what happened to it — including "nothing, because the run
  // failed". Leaving `meta.star` undefined would make "no store configured" and "store configured,
  // trace rejected" look identical to a caller, and this repo has already paid for one denial that
  // read as an absence (plan-store.js's note on the lockfile that a security audit concluded did
  // not exist).
  if (opts.store && !ok) {
    meta.star = { saved: false, reason: 'run did not succeed — STaR files only traces that reached a verified-correct outcome' };
  } else if (opts.store && ok) {
    const clean = models.traceIsClean(trace);
    if (clean.clean) {
      const w = opts.store.save({
        task, steps: trace.steps.map((s) => s.rationale), answer: output,
        verified: true, rationalized: false, verifier: 'process-verified', agent: opts.actor || 'coder', savedAt: opts.now || null,
      });
      meta.star = { saved: w.saved, reason: w.reason };
    } else {
      meta.star = { saved: false, reason: clean.reason };
    }
  }

  return { ok, mode: 'deliberate', output, trace, budget: budget.snapshot(), meta };
}

/**
 * Build the executeAgent options that carry retrieved STaR exemplars SAFELY.
 *
 * Returns `{ untrusted }` or `{}` — never a prompt string. Retrieved traces are data of uncertain
 * provenance (see star.js's security note), and this is the only exported way to get them near a
 * model: inside the same fencing that guards scraped pages and tool output.
 */
function fewShotOptions(store, task, opts = {}) {
  if (!store) return {};
  const block = star.fewShotBlock(store.retrieve(task, opts));
  return block ? { untrusted: block } : {};
}

// NO CONVENIENCE RE-EXPORTS. An earlier draft re-exported createTraceStore, createBudget and
// friends here as well as from their own modules, which fallow flagged as duplicate exports: the
// same name resolvable through two paths is how half a codebase ends up importing one of them and
// half the other. Reach an engine through its namespace — R.star.createTraceStore — so there is
// exactly one place each thing lives.
module.exports = {
  MODES,
  reason, deliberate, fewShotOptions,
  // The engines, for callers that want one pattern rather than the composition. `context`, `budget`
  // and `models` are NOT re-exported here: nothing reaches them through the barrel, and a namespace
  // with no consumer is the same unused export as any other name — require the module directly.
  steps, reflexion, tot, star,
};
