// lib/reasoning/context.js
// ============================================================
//  CONTEXT ENGINEERING — THE WINDOW AS A MANAGED CACHE, NOT AN ACCUMULATOR.
//
//  Spec §6, after Karpathy's "LLM as CPU / context as RAM" framing. The failure it exists to stop is
//  unstructured prompt accumulation: every loop above this one (steps, reflexion, ToT, STaR) wants
//  to append something to the prompt, and left alone they produce a context that grows monotonically
//  until it is mostly stale, expensive, and actively harmful to the model's attention.
//
//  ── FOUR SEGMENTS, WITH A STRICT EVICTION ORDER ──
//    INSTRUCTIONS  (static)    system rules, the agent handbook, guardrails.      NEVER EVICTED.
//    LONGTERM      (persistent) rolling compressed summary of what happened.      Compressed, kept.
//    EPISODIC      (injected)  Reflexion lessons, critiques, retrieved exemplars. Evicted oldest.
//    SCRATCHPAD    (volatile)  working notes for the CURRENT step only.           Dropped first.
//
//  The CPU analogy is load-bearing rather than decorative: scratchpad is registers (discarded at
//  step end), episodic is L1 (recent, cheap to lose), longterm is spilled-and-compressed main
//  memory, instructions are ROM. Eviction runs in that order and STOPS at instructions.
//
//  TOOL STATE — tool calls and their results — belongs in SCRATCHPAD, and there is no fifth segment
//  for it. A tool result is working state for the step that asked for it: keeping it past the step
//  boundary is how a context fills with stale directory listings and HTTP bodies nobody will read
//  again. Anything from a tool worth remembering longer is a CONCLUSION, and a conclusion goes to
//  `remember()` in the operator's own words — not the raw output. (Tool output is also untrusted
//  content; it reaches a model through executeAgent's `untrusted` fencing, never by being pasted
//  into an instruction block here.)
//
//  ── THE INVARIANT WORTH THE WHOLE FILE ──
//  INSTRUCTIONS ARE NEVER EVICTED, EVEN WHEN THE BUDGET CANNOT BE MET. The segment holding "never
//  do X without asking" must not be the segment that silently disappears under memory pressure —
//  that turns a context-budget optimisation into a safety regression that no test would catch,
//  because the run still succeeds. When the budget cannot be met with instructions intact,
//  `assemble()` returns `overBudget: true` and lets the caller decide. It never quietly complies.
//
//  ── AND THE INTEGRATION THAT MAKES IT WORTH USING HERE ──
//  server.js:4048 splits every agent prompt into a CACHEABLE PREFIX (`fullSystem`, stable for one
//  agent) and a VOLATILE TAIL (`volatileSystem`, different per call), and its own comment warns that
//  getting the split backwards is "a guaranteed cache miss on every request, reported by nothing".
//  The four segments map onto that split exactly: INSTRUCTIONS is the only stable one, so it is the
//  only thing `assemble()` will put in `system`. Everything that changes between calls goes to
//  `volatile`. `assemble()` refuses to place a segment marked volatile into the stable block, so the
//  cache-correct arrangement is the only one this module can produce.
// ============================================================

'use strict';

const { guardedCall } = require('./budget');

const SEGMENTS = Object.freeze(['instructions', 'longterm', 'episodic', 'scratchpad']);
/** Eviction order: first listed is dropped first. `instructions` is absent BY DESIGN. */
const EVICTION_ORDER = Object.freeze(['scratchpad', 'episodic', 'longterm']);
/** Which segments may sit in the cacheable prefix. Exactly one — see the header. */
const STABLE_SEGMENTS = Object.freeze(['instructions']);

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_SHARES = Object.freeze({ instructions: 0.4, longterm: 0.2, episodic: 0.25, scratchpad: 0.15 });

/**
 * Token estimate.
 *
 * ~4 chars/token is a HEURISTIC, not a measurement — it runs ~10-20% off on code and on non-Latin
 * scripts. It is the default because it is free and needs no network. Inject `estimator` (the
 * Anthropic count_tokens endpoint, say) when a real number matters; every budget decision here
 * reads whatever estimator it was given, so the accuracy is the caller's to choose.
 */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/**
 * @param {object} opts
 *  - maxTokens: total context budget for the assembled prompt
 *  - shares: per-segment fractions of maxTokens (normalised if they do not sum to 1)
 *  - estimator: (text) => number
 */
function createContextManager({ maxTokens = DEFAULT_MAX_TOKENS, shares = null, estimator = estimateTokens } = {}) {
  const cap = Math.max(500, parseInt(maxTokens, 10) || DEFAULT_MAX_TOKENS);
  const est = typeof estimator === 'function' ? estimator : estimateTokens;

  const raw = { ...DEFAULT_SHARES, ...(shares || {}) };
  const total = SEGMENTS.reduce((s, k) => s + (Number(raw[k]) || 0), 0) || 1;
  const budgets = {};
  for (const k of SEGMENTS) budgets[k] = Math.floor((cap * (Number(raw[k]) || 0)) / total);

  /** Each segment is an ordered list of {text, tokens, pinned}. */
  const store = { instructions: [], longterm: [], episodic: [], scratchpad: [] };
  const evicted = { scratchpad: 0, episodic: 0, longterm: 0 };

  function put(segment, text, { pinned = false } = {}) {
    if (!SEGMENTS.includes(segment)) throw new Error(`unknown context segment "${segment}"`);
    const t = String(text || '').trim();
    if (!t) return false;
    store[segment].push({ text: t, tokens: est(t), pinned: !!pinned });
    return true;
  }

  const setInstructions = (text) => { store.instructions = []; put('instructions', text, { pinned: true }); return api; };
  const remember = (text) => { put('longterm', text); return api; };
  const recall = (textOrList) => {
    (Array.isArray(textOrList) ? textOrList : [textOrList]).forEach((t) => put('episodic', t));
    return api;
  };
  const note = (text) => { put('scratchpad', text); return api; };

  /** Discard the volatile working set. Called at STEP boundaries — that is what makes it volatile. */
  const clearScratchpad = () => { store.scratchpad = []; return api; };

  const tokensIn = (segment) => store[segment].reduce((s, e) => s + e.tokens, 0);
  const usage = () => {
    const per = {};
    for (const k of SEGMENTS) per[k] = { tokens: tokensIn(k), budget: budgets[k], entries: store[k].length, over: tokensIn(k) > budgets[k] };
    return { per, total: SEGMENTS.reduce((s, k) => s + per[k].tokens, 0), cap };
  };

  /**
   * Drop entries until the total fits, in EVICTION_ORDER, oldest-first within a segment.
   * Pinned entries and the whole `instructions` segment are untouchable.
   * @returns {{fits: boolean, dropped: number}}
   */
  function evict() {
    let dropped = 0;
    const instructionTokens = tokensIn('instructions');

    for (const seg of EVICTION_ORDER) {
      while (usage().total > cap && store[seg].length) {
        const idx = store[seg].findIndex((e) => !e.pinned);
        if (idx < 0) break;                     // everything left here is pinned
        store[seg].splice(idx, 1);
        evicted[seg] += 1;
        dropped += 1;
      }
      if (usage().total <= cap) break;
    }
    // If instructions alone blow the budget we report it — we do NOT trim the rules to fit.
    return { fits: usage().total <= cap, dropped, instructionTokens };
  }

  /**
   * Compress `longterm` into one rolling summary via a model call (spec §6's "rolling summaries").
   * Degrades safely: if the summariser fails, the originals are LEFT IN PLACE rather than dropped —
   * losing history to a failed compression would be worse than staying over budget.
   */
  async function compress(depsIn, budget, { agent = 'synthesis', maxTokens = null } = {}) {
    const entries = store.longterm.filter((e) => !e.pinned);
    if (entries.length < 2) return { compressed: false, reason: 'nothing to compress' };

    const joined = entries.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
    const r = await guardedCall(depsIn, budget, agent, [
      'Compress the notes below into a single dense paragraph that preserves every DECISION, every',
      'constraint discovered, and every failure already ruled out. Drop narration and pleasantries.',
      'Do not add anything that is not in the notes.',
      `\nNOTES:\n${joined}`,
    ].join('\n'), { maxTokens });

    if (!r.ok || !r.content.trim()) return { compressed: false, reason: r.error || 'summariser returned nothing' };

    const before = tokensIn('longterm');
    const summary = r.content.trim();

    // A "compression" that produces MORE tokens than it replaced is a pessimization, and a chatty
    // summariser over a few short notes does exactly that. Refuse it: we would otherwise pay for a
    // model call, lose the original detail, AND end up with a bigger context — the worst of three
    // outcomes, reported as a success. Caught by tools/test-reasoning.js on real (small) input.
    const summaryTokens = est(summary);
    if (summaryTokens >= before) {
      return { compressed: false, reason: `summary was not smaller (${summaryTokens} ≥ ${before} tokens) — originals kept`, before, after: before, saved: 0 };
    }

    store.longterm = store.longterm.filter((e) => e.pinned);
    put('longterm', summary);
    return { compressed: true, before, after: tokensIn('longterm'), saved: before - tokensIn('longterm') };
  }

  /**
   * Produce the final prompt pieces.
   *
   * @returns {{system: string, volatile: string, stats: object, overBudget: boolean, fits: boolean}}
   *   `system`   → executeAgent's cacheable prefix (INSTRUCTIONS only, by construction)
   *   `volatile` → everything that changes per call, for the post-cache-breakpoint block
   */
  function assemble() {
    const ev = evict();

    const header = { longterm: 'WHAT HAS HAPPENED SO FAR', episodic: 'RELEVANT PRIOR FINDINGS', scratchpad: 'WORKING NOTES (this step only)' };
    const system = store.instructions.map((e) => e.text).join('\n\n');

    const parts = [];
    for (const seg of ['longterm', 'episodic', 'scratchpad']) {
      if (!store[seg].length) continue;
      parts.push(`## ${header[seg]}\n${store[seg].map((e) => e.text).join('\n')}`);
    }
    const volatile = parts.join('\n\n');

    // The guard that makes the cache-correct split the only reachable one. Unreachable today —
    // and that is the point: if a future edit puts a volatile segment in the prefix, this throws
    // at the boundary instead of silently costing a cache miss on every request forever.
    for (const seg of SEGMENTS) {
      if (STABLE_SEGMENTS.includes(seg)) continue;
      if (store[seg].length && system.includes(store[seg][0].text) && store[seg][0].text.length > 40) {
        throw new Error(`context: volatile segment "${seg}" leaked into the cacheable prefix — see lib/reasoning/context.js header`);
      }
    }

    return {
      system,
      volatile,
      fits: ev.fits,
      overBudget: !ev.fits,
      stats: { ...usage(), evicted: { ...evicted }, dropped: ev.dropped, instructionTokens: ev.instructionTokens },
    };
  }

  const api = {
    setInstructions, remember, recall, note, clearScratchpad,
    compress, assemble, usage, evict,
    budgets: { ...budgets },
    get segments() { return { ...store }; },
  };
  return api;
}

// SEGMENTS and EVICTION_ORDER are exported because tools/test-reasoning.js asserts the eviction
// ORDER directly — that instructions is absent from it is the file's load-bearing invariant, and a
// behavioural test alone could not distinguish "never evicted" from "happened not to be evicted".
module.exports = { SEGMENTS, EVICTION_ORDER, createContextManager };
