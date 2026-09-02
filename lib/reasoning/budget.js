// lib/reasoning/budget.js
// ============================================================
//  THE METER EVERY REASONING LOOP MUST GO THROUGH.
//
//  Each pattern in this directory turns ONE agent call into MANY: a verified decomposition is
//  1 + 2N calls, a tree search is breadth×depth, a reflexion loop is 3 per attempt. That is the
//  whole point of them — and it is also how a $0.40 task quietly becomes $12.
//
//  So the budget is not a helper the loops MAY use. `guardedCall` is the only way to reach the
//  injected runAgent from inside this directory, and it refuses once the meter is spent. A future
//  pattern cannot forget to check a limit, because there is no unmetered path to forget to guard.
//  (This is the boundary-guard-enumeration lesson: guard the CATEGORY — "any model call" — not a
//  list of the loops that exist today.)
//
//  server.js's executeAgent has its own cost-ledger tail that assumes ONE result object per
//  dispatch. A multi-call loop MUST therefore accumulate its own tokens and hand back a single
//  total, exactly as the pipeline runner's patternDeps.runAgent does. `snapshot()` is that total.
// ============================================================

'use strict';

/** Hard ceilings. A caller may lower these; `createBudget` refuses to raise them. */
const MAX_CALLS_CEILING = 60;

/**
 * @param {object} opts
 * @param {number} opts.maxCalls   hard cap on model calls for one reasoning run (default 12)
 * @param {number} opts.maxTokens  optional cap on TOTAL (input+output) tokens; 0 = uncapped
 * @param {function} opts.onSpend  optional (snapshot) => void, called after each metered call
 */
function createBudget({ maxCalls = 12, maxTokens = 0, onSpend = null } = {}) {
  const limit = Math.max(1, Math.min(Number(maxCalls) || 12, MAX_CALLS_CEILING));
  const tokenLimit = Math.max(0, Number(maxTokens) || 0);

  const state = { calls: 0, inputTokens: 0, outputTokens: 0, failed: 0, stoppedBy: null };

  /** Why the next call cannot happen, or null if it can. */
  function exhausted() {
    if (state.calls >= limit) return `call budget exhausted (${state.calls}/${limit} calls)`;
    if (tokenLimit && state.inputTokens + state.outputTokens >= tokenLimit) {
      return `token budget exhausted (${state.inputTokens + state.outputTokens}/${tokenLimit} tokens)`;
    }
    return null;
  }

  /** Record one completed call. Tolerates results with no token fields (mocks, cached replies). */
  function record(result) {
    state.calls += 1;
    state.inputTokens += Number(result && result.inputTokens) || 0;
    state.outputTokens += Number(result && result.outputTokens) || 0;
    if (!result || !result.ok) state.failed += 1;
    if (onSpend) { try { onSpend(snapshot()); } catch { /* a broken meter must not kill the run */ } }
  }

  function snapshot() {
    return {
      calls: state.calls,
      maxCalls: limit,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.inputTokens + state.outputTokens,
      failed: state.failed,
      stoppedBy: state.stoppedBy,
      remaining: Math.max(0, limit - state.calls),
    };
  }

  /** Mark WHY a loop stopped early — surfaced in every pattern's result so a truncated run says so. */
  function stop(reason) { if (!state.stoppedBy) state.stoppedBy = reason; }

  return { record, snapshot, stop, exhausted, get calls() { return state.calls; } };
}

/**
 * The ONLY way this directory calls a model.
 *
 * Never throws: a thrown provider error inside a search would lose every node already expanded, so
 * a failure is returned as data and the caller decides whether that branch is dead or the run is.
 *
 * @returns {Promise<{ok:boolean, content:string, error?:string, budgetExhausted?:boolean}>}
 */
async function guardedCall(deps, budget, agent, task, opts = {}) {
  const why = budget.exhausted();
  if (why) {
    budget.stop(why);
    return { ok: false, content: '', error: why, budgetExhausted: true };
  }
  let r;
  try {
    r = await deps.runAgent(agent, task, opts);
    if (!r || typeof r !== 'object') r = { ok: false, error: 'bad agent result' };
  } catch (e) {
    r = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  budget.record(r);
  const content = r.ok && typeof r.content === 'string' ? r.content : '';

  // ── AN EMPTY SUCCESSFUL REPLY IS NOT A SUCCESS ──
  // A call that returns ok:true with no text used to flow straight into the parsers, where it became
  // an AMBIGUOUS verdict or a 0 score — indistinguishable from "the model answered and I could not
  // read it". Those are completely different problems with completely different fixes, and the
  // engine reported the wrong one.
  //
  // This is not hypothetical and it is not rare. The live check on 2026-09-02 caught the PRM verifier
  // getting back a literal "" because `reviewer` runs at effort: xhigh, adaptive thinking consumed
  // the entire 400-token ceiling, and nothing was left for the answer. That is the FOURTH time this
  // project has hit "xhigh effort + tight maxTokens = silently empty output", and every previous time
  // the symptom was a plausible-looking downstream success: an empty workspace, a 2-character review,
  // a graph node that parsed fine and said nothing.
  //
  // So name it here, once, where every engine already passes through — and say the likely cause in
  // the error itself, because the fix (raise maxTokens) is not what "unparseable verdict" suggests.
  if (r.ok && !content.trim()) {
    return {
      ...r,
      ok: false,
      content: '',
      emptyResponse: true,
      error: 'model returned an EMPTY response — at high/xhigh effort with adaptive thinking this almost always means maxTokens was too small and reasoning consumed the whole budget, leaving nothing for the answer. Raise maxTokens for this call.',
    };
  }
  return { ...r, ok: !!r.ok, content };
}

/** Normalise the injected dependency bag once, so every module reads the same shape. */
function deps(input) {
  return {
    runAgent: (input && input.runAgent) || (async () => ({ ok: false, error: 'no runAgent injected' })),
    broadcast: (input && input.broadcast) || (() => {}),
    log: (input && input.log) || (() => {}),
  };
}

// MAX_CALLS_CEILING stays internal: the clamp is asserted through behaviour in
// tools/test-reasoning.js (maxCalls 9999 -> 60), and exporting the number as well would only add a
// name for the dead-code allowlist to explain away.
module.exports = { createBudget, guardedCall, deps };
