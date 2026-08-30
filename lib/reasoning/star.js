// lib/reasoning/star.js
// ============================================================
//  STaR — SELF-TAUGHT REASONER: BOOTSTRAPPING AND RATIONALE FILTERING.
//
//  Spec §5. After Zelikman et al. 2022, "STaR: Bootstrapping Reasoning With Reasoning". The loop:
//  let the model produce a rationale, keep the rationale ONLY when it reached the verified-correct
//  answer, and use the surviving rationales to make the next attempt better. Filtering by outcome is
//  what makes the kept set higher-quality than the model's average output — no human labels needed.
//
//  ── HONEST NAMING, BECAUSE THE PAPER'S MECHANISM IS NOT THE ONE WE HAVE ──
//  STaR proper FINE-TUNES on the filtered rationales. We call a hosted API; we cannot fine-tune, and
//  this module does not pretend to. What it actually does is two separable things:
//    1. WRITE `star_dataset.jsonl` — a real, correctly-shaped, outcome-filtered corpus that IS
//       suitable for offline fine-tuning later. That file is the paper's artifact.
//    2. RETRIEVE past successful traces as FEW-SHOT EXEMPLARS at run time. That is in-context
//       learning, not weight updating. It helps, and it helps for different reasons, with different
//       guarantees — it does not persist into the model, and it costs context on every call.
//  Conflating the two would be this repo's C2PA mistake again (lib/provenance: real vocabulary,
//  honest boundary about what was not implemented). Same discipline here.
//
//  ── THE SECURITY PROPERTY THE SPEC DOES NOT MENTION ──
//  A saved trace is model-generated text derived from some earlier task's input — and this platform
//  ingests scraped pages, imported sites, uploaded documents and tool output. Replaying a stored
//  trace into a later prompt is therefore a STORED PROMPT-INJECTION path: poison one run's input,
//  get the payload filed as a "gold standard", and it is quietly re-served to every future task that
//  looks similar. So `fewShotBlock()` returns the {label, text} shape executeAgent's `untrusted`
//  option takes — fenced as DATA — and never a string to concatenate into an instruction. The
//  fencing is the API. There is no exported call that hands back raw replayable trace text.
//
//  ── AND ONE HARD BOUNDARY ──
//  The dataset path goes through lib/self-improve/plan-store.js `assertContained`, the same
//  containment used by the self-modification system. Nothing here may write outside the repo, and
//  in particular nothing here may write into `.claude/agents/`: handbooks are edited by people. A
//  filtered-rationale corpus that could rewrite an agent's own instructions is a self-modifying
//  agent with a friendly name on it.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { guardedCall, deps: normDeps, createBudget } = require('./budget');
const { assertContained } = require('../self-improve/plan-store');
const M = require('./models');

//  ── WHY THE CORPUS LIVES IN `.magent/reasoning/` AND NOT `.magent/state/` ──
//  `.magent/state/` is where it naturally belongs — it is run-time state, exactly what saveState()
//  writes. But `assertContained` is shared with lib/self-improve/plan-store.js, and that module
//  DENIES `.magent/state/` on purpose: a self-improvement plan must not be able to rewrite the
//  platform's runtime state. Reusing the guard imported its POLICY along with its containment.
//
//  Keeping one containment implementation is worth more than the tidier path (two copies of a
//  path-escape check is how one of them ends up subtly weaker), so the corpus moved instead. It is
//  gitignored: a trace records the text of real tasks, and that is not repository content.
const DEFAULT_DATASET = '.magent/reasoning/star_dataset.jsonl';
const MAX_TRACES_IN_MEMORY = 500;
const MAX_FEWSHOT = 3;

/** Handbooks are people-edited. Nothing in this module may target them (see the header). */
const FORBIDDEN_DATASET_PREFIXES = ['.claude/', '.git/', 'node_modules/', 'commercial/'];

// ---------------------------------------------------------------------------------------------
//  Trace store
// ---------------------------------------------------------------------------------------------

/**
 * Cheap lexical similarity — token Jaccard over CONTENT words. No embedding dependency.
 *
 * The stopword list is not tidying. Without it, "Why did the nightly export stop producing files?"
 * and "Why does the API return 403 after midnight?" share `why` and `the`, which is enough Jaccard
 * to clear the retrieval threshold — and tools/demo-reasoning.js duly offered a 403 exemplar to a
 * disk-space question. An irrelevant exemplar is not a harmless near-miss: it costs context on every
 * call and actively points the model at the wrong shape of answer.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'are', 'has', 'have', 'had', 'not', 'but', 'you', 'your', 'why', 'how',
  'what', 'when', 'where', 'which', 'who', 'does', 'did', 'doing', 'this', 'that', 'these', 'those',
  'with', 'from', 'into', 'about', 'after', 'before', 'then', 'than', 'there', 'their', 'its',
  'can', 'could', 'would', 'should', 'will', 'may', 'might', 'must', 'been', 'being', 'get', 'got',
]);
function similarity(a, b) {
  const tok = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((t) => !STOPWORDS.has(t)));
  const A = tok(a); const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * An append-only JSONL corpus of outcome-filtered reasoning traces.
 *
 * @param {object} opts
 *  - root: repo root (containment anchor)
 *  - file: repo-relative dataset path (default `.magent/state/star_dataset.jsonl`)
 *  - readOnly: never write (used by tests and by callers that only want retrieval)
 */
function createTraceStore({ root = process.cwd(), file = DEFAULT_DATASET, readOnly = false } = {}) {
  const rel = String(file || DEFAULT_DATASET).replace(/\\/g, '/').replace(/^\.\//, '');

  const lower = rel.toLowerCase();
  if (FORBIDDEN_DATASET_PREFIXES.some((p) => lower.startsWith(p))) {
    throw new Error(`star: refusing to use "${rel}" as a dataset path — ${FORBIDDEN_DATASET_PREFIXES.join(', ')} are off limits`);
  }
  assertContained(root, rel);      // throws on traversal / symlink escape
  const abs = path.join(root, rel);

  let cache = null;

  function load() {
    if (cache) return cache;
    cache = [];
    try {
      if (!fs.existsSync(abs)) return cache;
      const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // One malformed line must not destroy the corpus — skip it and keep the rest.
        try { const rec = JSON.parse(t); if (rec && rec.task) cache.push(rec); } catch { /* skip */ }
      }
      if (cache.length > MAX_TRACES_IN_MEMORY) cache = cache.slice(-MAX_TRACES_IN_MEMORY);
    } catch (e) {
      cache = [];
    }
    return cache;
  }

  /**
   * Append one verified trace. Returns {saved, reason}.
   * REFUSES anything not outcome-verified — that filter is the entire value of the corpus.
   */
  function save(record) {
    if (!record || !record.task || !Array.isArray(record.steps) || !record.steps.length) {
      return { saved: false, reason: 'empty or malformed trace' };
    }
    if (!record.verified) return { saved: false, reason: 'not outcome-verified — STaR keeps only traces that reached a checked-correct answer' };
    if (readOnly) return { saved: false, reason: 'store is read-only' };

    const rec = {
      task: String(record.task).slice(0, 4000),
      steps: record.steps.slice(0, 20).map((s) => String(s).slice(0, 2000)),
      answer: String(record.answer == null ? '' : record.answer).slice(0, 4000),
      verified: true,
      rationalized: !!record.rationalized,   // kept: a hinted rationale is weaker evidence, see below
      verifier: String(record.verifier || 'unknown').slice(0, 80),
      agent: String(record.agent || '').slice(0, 80),
      savedAt: record.savedAt || null,       // injected by the caller; this module owns no clock
    };
    try {
      // Warm the cache BEFORE appending. Appending first and then calling load() on a cold cache
      // makes load() read the line just written AND the push add a second copy — so the very first
      // save of a session silently produced a duplicate. It fails quietly in the worst way: two
      // identical few-shot exemplars, doubling the context cost and over-weighting one example, with
      // nothing anywhere reporting a problem.
      const list = load();
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(rec) + '\n', 'utf8');
      list.push(rec);
      return { saved: true, reason: 'ok', record: rec };
    } catch (e) {
      return { saved: false, reason: `write failed: ${e.message}` };
    }
  }

  /** The k most similar past traces to `task`. Excludes hinted rationales unless asked. */
  function retrieve(task, { k = MAX_FEWSHOT, minScore = 0.12, includeRationalized = false } = {}) {
    return load()
      .filter((r) => includeRationalized || !r.rationalized)
      .map((r) => ({ ...r, _sim: similarity(task, r.task) }))
      .filter((r) => r._sim >= minScore)
      .sort((a, b) => b._sim - a._sim)
      .slice(0, Math.max(0, k));
  }

  return { save, retrieve, load, all: () => load().slice(), path: abs, relPath: rel, get size() { return load().length; } };
}

/**
 * Build the FENCED exemplar block for executeAgent's `untrusted` option.
 *
 * Returns `{label, text}` — NOT a prompt string. See the security note in the header: retrieved
 * traces are data of uncertain provenance, and the only safe way to show them to a model is inside
 * the untrusted envelope that already guards scraped pages and tool output on this platform.
 * Returns null when there is nothing to show, so the caller passes no `untrusted` at all.
 */
function fewShotBlock(traces, { label = 'PAST SOLVED EXAMPLES (reference only)' } = {}) {
  const list = (traces || []).filter((t) => t && t.task && Array.isArray(t.steps) && t.steps.length);
  if (!list.length) return null;
  const text = list.map((t, i) => [
    `--- EXAMPLE ${i + 1} ---`,
    `TASK: ${t.task}`,
    'REASONING:',
    ...t.steps.map((s, k) => `  ${k + 1}. ${s}`),
    `ANSWER: ${t.answer}`,
  ].join('\n')).join('\n\n');
  return { label, text };
}

// ---------------------------------------------------------------------------------------------
//  Bootstrapping
// ---------------------------------------------------------------------------------------------

/**
 * Attempt ONE example, with the paper's two-phase structure.
 *
 * Phase 1 — direct: produce reasoning + answer, then CHECK it against ground truth.
 * Phase 2 — rationalization (spec §5's "retry by providing a hint or the correct answer"): on
 *   failure, tell the model the correct answer and ask for the reasoning that reaches it.
 *
 * ── WHY PHASE 2 IS STILL VERIFIED, AND STILL FLAGGED ──
 * Handing over the answer invites a post-hoc justification: prose that concludes with the right
 * answer without the reasoning actually supporting it. The paper's own guard is that the
 * rationalized attempt must still produce the correct answer under the same check — so this runs
 * the SAME `check` function, never a softer one. And because a rationale written by someone who was
 * shown the answer is weaker evidence than one written blind, every such record carries
 * `rationalized: true` into the dataset, where a downstream training run can down-weight or exclude
 * it. Dropping that flag would silently mix two different qualities of example.
 */
async function bootstrapExample(example, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || 6 });
  const agent = opts.agent || 'coder';
  const task = String(example.task || '');
  const check = typeof opts.check === 'function'
    ? opts.check
    : (answer) => ({ ok: normAnswer(answer) === normAnswer(example.answer), reason: 'exact match after normalisation' });

  const ask = (extra) => [
    'Solve the task. Show your reasoning as numbered steps, then give the final answer on its own',
    'last line in exactly this form:  ANSWER: <the answer>',
    extra || '',
    `\nTASK:\n${task}`,
  ].join('\n');

  // --- Phase 1: solve blind ---
  const first = await guardedCall(d, budget, agent, ask(''), { maxTokens: opts.maxTokens || 1500 });
  if (first.ok) {
    const parsed = parseSolution(first.content);
    const v = await Promise.resolve(check(parsed.answer, parsed));
    if (v && v.ok) {
      return { ok: true, rationalized: false, task, steps: parsed.steps, answer: parsed.answer, verifier: (v && v.verifier) || 'ground-truth', budget: budget.snapshot() };
    }
  }

  // --- Phase 2: rationalize from the given answer ---
  if (!opts.allowRationalization || example.answer == null) {
    return { ok: false, rationalized: false, task, steps: [], answer: first.ok ? parseSolution(first.content).answer : '', reason: 'failed and rationalization disabled', budget: budget.snapshot() };
  }

  const hinted = await guardedCall(d, budget, agent,
    ask(`\nHINT — the correct answer is: ${example.answer}\nWork out the reasoning that legitimately reaches it. If the reasoning does not actually support that answer, say so plainly instead of inventing a justification.`),
    { maxTokens: opts.maxTokens || 1500 });
  if (!hinted.ok) {
    return { ok: false, rationalized: true, task, steps: [], answer: '', reason: `rationalization call failed: ${hinted.error}`, budget: budget.snapshot() };
  }
  const parsed2 = parseSolution(hinted.content);
  const v2 = await Promise.resolve(check(parsed2.answer, parsed2));
  if (!(v2 && v2.ok)) {
    return { ok: false, rationalized: true, task, steps: parsed2.steps, answer: parsed2.answer, reason: 'rationalized attempt still failed the check', budget: budget.snapshot() };
  }
  return { ok: true, rationalized: true, task, steps: parsed2.steps, answer: parsed2.answer, verifier: (v2 && v2.verifier) || 'ground-truth', budget: budget.snapshot() };
}

/** Pull numbered reasoning steps and the trailing `ANSWER:` out of a solution reply. */
function parseSolution(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const am = raw.match(/ANSWER\s*:\s*(.+?)\s*$/im);
  const answer = am ? am[1].trim() : '';
  const body = am ? raw.slice(0, am.index) : raw;
  const steps = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*)$/);
    if (m) { if (m[1].trim()) steps.push(m[1].trim()); }
    else if (steps.length && line.trim()) steps[steps.length - 1] += ' ' + line.trim();
  }
  if (!steps.length && body.trim()) steps.push(body.trim().slice(0, 2000));
  return { steps, answer };
}

const normAnswer = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');

/**
 * Run the bootstrapping pass over a set of examples and file the survivors.
 *
 * @returns {Promise<{solved, rationalized, failed, saved, results, budget}>}
 */
async function bootstrap(examples, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || 40 });
  const store = opts.store || null;
  const results = [];
  let solved = 0; let rationalized = 0; let failed = 0; let saved = 0;

  for (const ex of examples || []) {
    if (budget.exhausted()) break;
    const r = await bootstrapExample(ex, d, { ...opts, budget });
    results.push(r);
    if (!r.ok) { failed += 1; continue; }
    if (r.rationalized) rationalized += 1; else solved += 1;

    if (store) {
      const w = store.save({
        task: r.task, steps: r.steps, answer: r.answer,
        verified: true, rationalized: r.rationalized,
        verifier: r.verifier, agent: opts.agent || 'coder', savedAt: opts.now || null,
      });
      if (w.saved) saved += 1;
      r.saved = w.saved;
      r.saveReason = w.reason;
    }
    d.broadcast({ type: 'reasoning.star', task: r.task.slice(0, 80), rationalized: r.rationalized });
  }

  return { solved, rationalized, failed, saved, results, budget: budget.snapshot() };
}

module.exports = {
  DEFAULT_DATASET, MAX_FEWSHOT, FORBIDDEN_DATASET_PREFIXES,
  createTraceStore, fewShotBlock, similarity,
  bootstrapExample, bootstrap, parseSolution,
};
