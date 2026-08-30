// lib/reasoning/models.js
// ============================================================
//  THE TYPED STATE THE FIVE REASONING ENGINES SHARE.
//
//  From the framework spec's §1 Data Models. JS has no Pydantic, so the guarantee Pydantic would
//  give is bought differently: every shape below has ONE factory, the factory clamps and normalises
//  its inputs, and nothing in this directory builds one of these objects with a bare literal. A
//  score is therefore in [0,1] because it cannot be constructed otherwise — not because every call
//  site remembered to check.
//
//  ── WHY `status` IS THREE-VALUED AND NOT A BOOLEAN ──
//  PRM (Lightman et al. 2023, "Let's Verify Step by Step") supervises the PROCESS, and the useful
//  finding is that a step-verifier which can only say pass/fail has to guess on the steps it cannot
//  judge — and guessing "pass" is how an unverified step gets laundered into a verified trace.
//  AMBIGUOUS is a real answer here: it does not halt the run, it marks the step as UNVERIFIED and
//  that flag survives into the trace, so a caller can tell "checked and fine" from "nobody knows".
//  This codebase has been bitten repeatedly by checks that answer a narrower question than the one
//  asked; a two-valued verifier is exactly that failure with a confident face.
// ============================================================

'use strict';

/** PRM step-verification outcomes. */
const STATUS = Object.freeze({ CORRECT: 'CORRECT', INCORRECT: 'INCORRECT', AMBIGUOUS: 'AMBIGUOUS' });
const STATUSES = Object.freeze(Object.values(STATUS));

/** How a trace ended. `exhausted` = ran out of budget/attempts, which is NOT the same as failing. */
const OUTCOME = Object.freeze({ SOLVED: 'solved', FAILED: 'failed', EXHAUSTED: 'exhausted', HALTED: 'halted' });

const clamp01 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};
const str = (s, max = 4000) => String(s == null ? '' : s).slice(0, max);

/**
 * One intermediate step: a natural-language rationale, and OPTIONALLY an action to execute.
 *
 * Spec §1 `ReasoningStep`, and the Chain-of-Thought requirement (Wei et al. 2022) that reasoning
 * tokens stay separate from execution tokens. `rationale` is the thought; `action` is the thing the
 * world will feel. Keeping them in different fields is what lets the verifier grade the reasoning
 * before the action is allowed to run — which is the entire safety value of the pattern.
 */
function makeStep({ index = 0, rationale = '', action = null, metadata = {} } = {}) {
  return {
    index: Math.max(0, parseInt(index, 10) || 0),
    rationale: str(rationale),
    action: action == null ? null : str(action, 1000),
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
  };
}

/**
 * A step-verifier's judgement. Spec §1 `StepVerification`.
 *
 * `score` is confidence in [0,1]. `status` is the classification. `verified` is a DERIVED
 * convenience — true only for CORRECT — so that a caller writing `if (v.verified)` cannot
 * accidentally treat AMBIGUOUS as a pass.
 */
function makeVerification({ score = 0, status = STATUS.AMBIGUOUS, feedback = null, verifier = 'model' } = {}) {
  const st = STATUSES.includes(status) ? status : STATUS.AMBIGUOUS;
  return {
    score: clamp01(score),
    status: st,
    verified: st === STATUS.CORRECT,
    unverified: st === STATUS.AMBIGUOUS,
    feedback: feedback == null ? null : str(feedback, 1000),
    verifier: str(verifier, 80),
  };
}

/**
 * The full sequential trajectory. Spec §1 `ExecutionTrace`.
 *
 * Steps and their verifications are held in PARALLEL arrays indexed together rather than nested,
 * because a step can be re-verified (by a rule checker, then by a model) without rewriting it, and
 * because STaR serialises the steps alone as the training-shaped record.
 */
function makeTrace({ task = '', steps = [], verifications = [], outcome = OUTCOME.HALTED, ok = false, meta = {} } = {}) {
  return {
    task: str(task),
    steps: Array.isArray(steps) ? steps.slice() : [],
    verifications: Array.isArray(verifications) ? verifications.slice() : [],
    outcome: Object.values(OUTCOME).includes(outcome) ? outcome : OUTCOME.HALTED,
    ok: !!ok,
    meta: meta && typeof meta === 'object' ? { ...meta } : {},
  };
}

/** Append a step + its verification to a trace, keeping the two arrays index-aligned. */
function addStep(trace, step, verification = null) {
  trace.steps.push(step);
  trace.verifications.push(verification || makeVerification({ status: STATUS.AMBIGUOUS, feedback: 'not verified' }));
  return trace;
}

/**
 * Did every step in this trace actually pass verification?
 *
 * Deliberately strict: an AMBIGUOUS step makes this FALSE. STaR uses it to decide whether a trace is
 * gold-standard, and a trace containing a step nobody could judge is not gold — it is a trace with a
 * hole in it. `unverifiedCount` is returned so the caller can tell the two failure shapes apart.
 */
function traceIsClean(trace) {
  const vs = (trace && trace.verifications) || [];
  if (!vs.length) return { clean: false, incorrectCount: 0, unverifiedCount: 0, reason: 'no verified steps' };
  const incorrect = vs.filter((v) => v.status === STATUS.INCORRECT).length;
  const unverified = vs.filter((v) => v.status === STATUS.AMBIGUOUS).length;
  return {
    clean: incorrect === 0 && unverified === 0,
    incorrectCount: incorrect,
    unverifiedCount: unverified,
    reason: incorrect ? `${incorrect} step(s) verified INCORRECT` : unverified ? `${unverified} step(s) UNVERIFIED` : 'all steps CORRECT',
  };
}

/**
 * A node in the Tree of Thoughts state tree. Spec §1 `SearchNode`.
 *
 * `score` is this thought's own value; `cumulative` is the path's mean value, which is what the
 * frontier is ordered by. Using the MEAN and not the sum matters: a sum rewards depth for its own
 * sake, so a long mediocre path would outrank a short excellent one and BFS would wander.
 */
function makeNode({ id, parentId = null, thought = '', depth = 0, score = 0, parentCumulative = null, terminal = false, state = {} } = {}) {
  const s = clamp01(score);
  // Running mean over the path: cumulative_d = (cumulative_{d-1} * d + score) / (d + 1)
  //
  // ROUNDED to 6dp because this value is both compared against a threshold and fed back in as the
  // next depth's `parentCumulative`, so binary-float error compounds along the path rather than
  // staying put: (0.8*1 + 0.4)/2 is 0.6000000000000001, and by depth 5 the drift is large enough to
  // flip a node either side of a backtrack threshold. Six decimals is far finer than any score here
  // means anything at, and it makes the ordering stable and the values readable in a trace.
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const cumulative = parentCumulative == null ? s : clamp01(round6((clamp01(parentCumulative) * depth + s) / (depth + 1)));
  return {
    id: str(id, 64) || `n${depth}-${Math.abs(hashString(thought)) % 100000}`,
    parentId: parentId == null ? null : str(parentId, 64),
    thought: str(thought, 2000),
    depth: Math.max(0, parseInt(depth, 10) || 0),
    score: s,
    cumulative,
    terminal: !!terminal,
    children: [],
    state: state && typeof state === 'object' ? { ...state } : {},
  };
}

/** Walk parent links back to the root. Returns root-first, so it reads as the reasoning path. */
function pathTo(node, byId) {
  const out = [];
  let cur = node;
  const guard = new Set();               // a corrupted parent link must not hang the search
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return out.reverse();
}

/** Small stable non-crypto hash — node ids only, never security. */
function hashString(s) {
  let h = 0;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
  return h;
}

module.exports = {
  STATUS, STATUSES, OUTCOME,
  makeStep, makeVerification, makeTrace, addStep, traceIsClean,
  makeNode, pathTo, hashString, clamp01,
};
