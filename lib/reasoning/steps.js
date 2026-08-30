// lib/reasoning/steps.js
// ============================================================
//  CHAIN-OF-THOUGHT DECOMPOSITION + PROCESS-SUPERVISED VERIFICATION (PRM).
//
//  Spec §§1-2. Two papers, one engine, because they only pay off together:
//    - Chain-of-Thought (Wei et al. 2022): make the intermediate reasoning EXPLICIT instead of
//      letting one monolithic answer hide the step that was wrong.
//    - PRM / process supervision (Lightman et al. 2023, "Let's Verify Step by Step"): grade each
//      intermediate step, not just the final answer. Outcome supervision rewards a right answer
//      reached by a broken argument; process supervision catches the break where it happens.
//
//  ── THE ORDER IS THE POINT ──
//  A step carries a RATIONALE (a thought) and optionally an ACTION (a thing the world feels). This
//  engine verifies the rationale BEFORE `executeAction` is ever called, and a step that fails
//  verification has its action DROPPED, not run-then-regretted. That ordering is the whole safety
//  argument for process supervision in an agent that can touch anything real — and it is structural
//  here, not a convention: `executeAction` is unreachable from any path where `verified` is false.
//
//  ── THE VERIFIER IS PLUGGABLE ON PURPOSE ──
//  Spec §2 asks for "a model, a rule-based validator, or an external checker". A model verifier
//  costs a call and can be fooled by fluent nonsense; a rule verifier is free and cannot be fooled
//  but only sees what you thought to encode. `chainVerifiers` runs cheap deterministic checks FIRST
//  and only pays for a model when the rules have nothing to say — which is also the cost-shaped
//  choice, not just the rigorous one.
// ============================================================

'use strict';

const { guardedCall, deps: normDeps, createBudget } = require('./budget');
const M = require('./models');

/** Default confidence below which a CORRECT verdict is downgraded — fluent but shaky is not a pass. */
const DEFAULT_PASS_SCORE = 0.6;
const MAX_STEPS = 12;

// ---------------------------------------------------------------------------------------------
//  Parsing
// ---------------------------------------------------------------------------------------------

/**
 * Split a decomposition reply into discrete step texts.
 *
 * Accepts "1. foo" / "1) foo" / "- foo" / "STEP 1: foo". Continuation lines are joined onto their
 * step (the same wrapped-bullet problem lib/handbooks/schema.js already solved — a model that wraps
 * a long step across two lines must not yield a phantom extra step).
 */
function parseSteps(text, max = MAX_STEPS) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const START = /^\s*(?:step\s*)?(?:\d+[.)]|[-*•])\s+(.*)$/i;
  for (const line of lines) {
    const m = line.match(START);
    if (m) {
      if (m[1].trim()) out.push(m[1].trim());
    } else if (out.length && line.trim() && !/^\s*#/.test(line)) {
      out[out.length - 1] += ' ' + line.trim();     // continuation of the previous step
    }
  }
  // A model that ignored the format entirely still gave us prose worth one step.
  if (!out.length) {
    const t = String(text || '').trim();
    if (t) out.push(t.slice(0, 2000));
  }
  return out.slice(0, max);
}

/**
 * Separate reasoning tokens from execution tokens within one step (spec §1).
 * An `ACTION:` line (anywhere in the step) is the executable part; everything else is the thought.
 */
function parseStepText(text, index = 0) {
  const raw = String(text || '');
  const m = raw.match(/^\s*ACTION\s*:\s*(.+)$/im);
  const action = m ? m[1].trim() : null;
  const rationale = (action ? raw.replace(m[0], '') : raw).trim();
  return M.makeStep({ index, rationale: rationale || raw.trim(), action });
}

/**
 * Read a step-verifier's reply into a StepVerification.
 *
 * Tolerant of ordering and of a model that answers with only one of the two fields. The DEFAULT
 * when nothing parses is AMBIGUOUS, never CORRECT: an unreadable verdict is "nobody knows", and
 * this codebase's standing rule is that a missing verdict is a block, never a silent ship.
 */
function parseVerdict(text, { passScore = DEFAULT_PASS_SCORE, verifier = 'model' } = {}) {
  const t = String(text || '');
  const sm = t.match(/SCORE\s*:\s*([0-9]*\.?[0-9]+)/i);
  const fm = t.match(/(?:FEEDBACK|NOTE)\s*:\s*(.+)/i);

  let score = null;
  if (sm) {
    let n = parseFloat(sm[1]);
    if (Number.isFinite(n)) score = n > 1 ? n / 100 : n;     // accept 0-100 or 0-1
  }

  let status = null;
  if (/\bINCORRECT\b/i.test(t)) status = M.STATUS.INCORRECT;
  else if (/\bAMBIGUOUS\b|\bUNSURE\b|\bUNCLEAR\b/i.test(t)) status = M.STATUS.AMBIGUOUS;
  else if (/\bCORRECT\b/i.test(t)) status = M.STATUS.CORRECT;

  if (!status && score != null) status = score >= passScore ? M.STATUS.CORRECT : M.STATUS.INCORRECT;
  if (!status) status = M.STATUS.AMBIGUOUS;

  // A confident-sounding CORRECT with a low score is not a pass. Fluency is not evidence.
  if (status === M.STATUS.CORRECT && score != null && score < passScore) status = M.STATUS.AMBIGUOUS;
  if (score == null) score = status === M.STATUS.CORRECT ? passScore : 0;

  return M.makeVerification({
    score, status, verifier,
    feedback: fm ? fm[1].trim() : (t.trim().split('\n')[0] || null),
  });
}

// ---------------------------------------------------------------------------------------------
//  Verifiers (spec §2: model | rule-based | external)
// ---------------------------------------------------------------------------------------------

/** A model-backed step verifier. Costs one metered call per step. */
function modelVerifier({ agent = 'reviewer', passScore = DEFAULT_PASS_SCORE, maxTokens = 400 } = {}) {
  return async function verifyWithModel(step, ctx) {
    const prompt = [
      'You are a PROCESS verifier. Judge ONLY the single reasoning step below — not the whole task,',
      'and not whether you would have approached it differently. A step is CORRECT if it follows from',
      'what precedes it and contains no fabricated fact.',
      '',
      'Reply in exactly this shape:',
      'STATUS: CORRECT | INCORRECT | AMBIGUOUS',
      'SCORE: <0-1 confidence>',
      'FEEDBACK: <one sentence; if INCORRECT, say what to change>',
      '',
      'Answer AMBIGUOUS when the step cannot be judged from what you were given. Do not guess CORRECT.',
      '',
      `TASK: ${ctx.task}`,
      ctx.priorSteps ? `\nSTEPS ALREADY ACCEPTED:\n${ctx.priorSteps}` : '',
      `\nSTEP ${step.index + 1} TO JUDGE:\n${step.rationale}`,
      step.action ? `\nPROPOSED ACTION: ${step.action}` : '',
    ].join('\n');

    const r = await guardedCall(ctx.deps, ctx.budget, agent, prompt, { maxTokens });
    if (!r.ok) {
      // A verifier that could not answer has NOT approved anything.
      return M.makeVerification({ status: M.STATUS.AMBIGUOUS, score: 0, verifier: `model:${agent}`, feedback: `verifier unavailable: ${r.error}` });
    }
    return parseVerdict(r.content, { passScore, verifier: `model:${agent}` });
  };
}

/**
 * Wrap a synchronous rule/external checker.
 * `fn(step, ctx)` may return a boolean, a {score,status,feedback} object, or null to abstain.
 * Abstaining is first-class — a rule that does not apply must not be able to fail a step.
 */
function ruleVerifier(fn, { name = 'rule', passScore = DEFAULT_PASS_SCORE } = {}) {
  return async function verifyWithRule(step, ctx) {
    let out;
    try { out = await fn(step, ctx); }
    catch (e) { return M.makeVerification({ status: M.STATUS.AMBIGUOUS, verifier: name, feedback: `checker threw: ${e.message}` }); }

    if (out === null || out === undefined) return null;                       // abstained
    if (typeof out === 'boolean') {
      return M.makeVerification({
        status: out ? M.STATUS.CORRECT : M.STATUS.INCORRECT,
        score: out ? 1 : 0, verifier: name,
        feedback: out ? null : 'failed a deterministic check',
      });
    }
    return parseVerdict(
      `STATUS: ${out.status || (Number(out.score) >= passScore ? 'CORRECT' : 'INCORRECT')}\nSCORE: ${out.score == null ? '' : out.score}\nFEEDBACK: ${out.feedback || ''}`,
      { passScore, verifier: name });
  };
}

/**
 * Run verifiers in order; the first NON-ABSTAINING verdict wins.
 *
 * Put the free deterministic ones first: they cannot be talked out of their answer, and every step
 * they settle is a model call not spent. The model verifier is the fallback for what rules can't see.
 */
function chainVerifiers(verifiers) {
  const list = (verifiers || []).filter((v) => typeof v === 'function');
  return async function verifyChained(step, ctx) {
    for (const v of list) {
      const out = await v(step, ctx);
      if (out) return out;
    }
    return M.makeVerification({ status: M.STATUS.AMBIGUOUS, score: 0, verifier: 'none', feedback: 'no verifier produced a verdict' });
  };
}

// ---------------------------------------------------------------------------------------------
//  The engine
// ---------------------------------------------------------------------------------------------

/** Ask the actor to decompose the task into explicit steps before it does anything (spec §1). */
async function decompose(task, deps, { agent = 'architect', maxSteps = 6, budget, maxTokens = 1200, context = '' } = {}) {
  const prompt = [
    `Decompose the task into at most ${maxSteps} explicit reasoning steps. Do not solve it yet.`,
    'One step per line, numbered. Each step states WHAT it establishes and WHY it follows from the',
    'step before it. If a step must touch something outside this conversation (a file, an API, a',
    'command), put that on its own line inside the step as:  ACTION: <the exact thing to do>',
    context ? `\nCONTEXT:\n${context}` : '',
    `\nTASK:\n${task}`,
  ].join('\n');
  const r = await guardedCall(deps, budget, agent, prompt, { maxTokens });
  if (!r.ok) return { ok: false, steps: [], error: r.error };
  return { ok: true, steps: parseSteps(r.content, maxSteps), raw: r.content };
}

/**
 * Decompose, then execute each step behind a verification gate.
 *
 * @param {object} opts
 *  - actor/planner/verifier agents; `verify` to supply your own verifier fn (model|rule|chain)
 *  - onFail: 'halt' (default) | 'revise' | 'continue' — spec §2's "halt, error-handle, or backtrack"
 *  - maxRevisions: how many times ONE step may be rewritten from its own critique
 *  - executeAction: async (action, step) => ({ok, output}) — called ONLY for verified steps
 *
 * @returns {Promise<{ok, trace, budget, revisions, haltedAt}>}
 */
async function runVerifiedSteps(task, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || 20 });
  const onFail = ['halt', 'revise', 'continue'].includes(opts.onFail) ? opts.onFail : 'halt';
  const maxRevisions = Math.max(0, opts.maxRevisions == null ? 1 : opts.maxRevisions);
  const actor = opts.actor || 'coder';
  const verify = opts.verify || modelVerifier({ agent: opts.verifierAgent || 'reviewer', passScore: opts.passScore });

  const trace = M.makeTrace({ task });
  const plan = await decompose(task, d, { agent: opts.planner || 'architect', maxSteps: opts.maxSteps || 6, budget, context: opts.context });
  if (!plan.ok || !plan.steps.length) {
    trace.outcome = M.OUTCOME.HALTED;
    // Always name the PHASE, not just the provider's message. "simulated provider failure" could
    // have come from any of the three roles; "decomposition failed: ..." says which one to look at.
    trace.meta.error = plan.error ? `decomposition failed: ${plan.error}` : 'decomposition produced no steps';
    return { ok: false, trace, budget: budget.snapshot(), revisions: 0, haltedAt: -1 };
  }
  trace.meta.plan = plan.steps.slice();

  let revisions = 0;
  let haltedAt = -1;
  const accepted = [];
  // Track the two terminal conditions in LOCAL flags rather than reading them back off
  // `trace.outcome`. makeTrace's default outcome is `halted` (the safe default for a trace that
  // never finished), so a "did I halt?" test against that field reads its own initial value and is
  // true before anything has happened — which made every successful run report itself as halted
  // while its steps and actions had in fact all run correctly. A verdict that is wrong while the
  // work is right is the worst shape of bug this repo keeps meeting: nothing fails, it just lies.
  let halted = false;
  let exhausted = false;

  for (let i = 0; i < plan.steps.length; i++) {
    let stepText = plan.steps[i];
    let step = null;
    let verification = null;
    // Rejected attempts are KEPT. A trace that silently discards them shows a clean row of CORRECT
    // steps and loses the only evidence that the gate ever did anything — which makes "the verifier
    // caught a hallucination" an unfalsifiable claim about a run rather than a visible fact in it.
    const rejected = [];

    for (let attempt = 0; attempt <= maxRevisions; attempt++) {
      // --- ACT: work the step (the actor may refine the planned text into a real rationale) ---
      const actPrompt = [
        `Carry out step ${i + 1} of ${plan.steps.length} and nothing beyond it.`,
        'State your reasoning for THIS step only. If the step needs to touch something outside this',
        'conversation, end with:  ACTION: <the exact thing to do>',
        accepted.length ? `\nSTEPS ALREADY ACCEPTED:\n${accepted.map((s, k) => `${k + 1}. ${s.rationale}`).join('\n')}` : '',
        verification && verification.feedback ? `\nYOUR PREVIOUS ATTEMPT AT THIS STEP WAS REJECTED: ${verification.feedback}\nAddress that specific objection.` : '',
        `\nTASK: ${task}`,
        `\nSTEP TO CARRY OUT: ${stepText}`,
      ].join('\n');

      const act = await guardedCall(d, budget, actor, actPrompt, { maxTokens: opts.maxTokens || 1500, context: opts.context });
      if (!act.ok) {
        step = M.makeStep({ index: i, rationale: stepText, metadata: { actorError: act.error } });
        verification = M.makeVerification({ status: M.STATUS.AMBIGUOUS, feedback: `actor unavailable: ${act.error}`, verifier: 'none' });
        if (act.budgetExhausted) { exhausted = true; haltedAt = i; }
        break;
      }
      step = parseStepText(act.content, i);

      // --- VERIFY: the gate. Nothing this step proposes runs until this passes. ---
      verification = await verify(step, {
        task, deps: d, budget, index: i,
        priorSteps: accepted.map((s, k) => `${k + 1}. ${s.rationale}`).join('\n'),
      });
      d.broadcast({ type: 'reasoning.step', index: i, status: verification.status, score: verification.score });

      if (verification.status === M.STATUS.CORRECT) break;
      if (onFail !== 'revise' || attempt >= maxRevisions) break;
      rejected.push({ rationale: step.rationale, action: step.action, status: verification.status, score: verification.score, feedback: verification.feedback });
      revisions += 1;
      stepText = plan.steps[i];   // revise the SAME step, now carrying the critique forward
    }
    if (step && rejected.length) step.metadata.rejectedAttempts = rejected;

    // --- EXECUTE: only a verified step may touch the world (see the header). ---
    if (step && step.action && verification.status === M.STATUS.CORRECT && typeof opts.executeAction === 'function') {
      try {
        const ex = await opts.executeAction(step.action, step);
        step.metadata.actionResult = ex && ex.ok ? 'ok' : `failed: ${(ex && ex.error) || 'unknown'}`;
        if (ex && ex.output != null) step.metadata.actionOutput = String(ex.output).slice(0, 2000);
      } catch (e) {
        step.metadata.actionResult = `threw: ${e.message}`;
      }
    } else if (step && step.action && verification.status !== M.STATUS.CORRECT) {
      step.metadata.actionResult = 'dropped — step did not verify';
    }

    M.addStep(trace, step, verification);
    if (verification.status === M.STATUS.CORRECT) accepted.push(step);

    if (exhausted) break;
    if (verification.status !== M.STATUS.CORRECT && onFail !== 'continue') {
      haltedAt = i;
      halted = true;
      trace.meta.haltReason = `step ${i + 1} ${verification.status}: ${verification.feedback || ''}`.trim();
      break;
    }
  }

  const clean = M.traceIsClean(trace);
  trace.outcome = exhausted ? M.OUTCOME.EXHAUSTED
    : halted ? M.OUTCOME.HALTED
      : clean.clean ? M.OUTCOME.SOLVED : M.OUTCOME.FAILED;
  trace.ok = clean.clean && trace.outcome === M.OUTCOME.SOLVED;
  trace.meta.verification = clean;

  return { ok: trace.ok, trace, budget: budget.snapshot(), revisions, haltedAt };
}

/** Render a finished trace as the answer text a caller can hand onward. */
function traceToAnswer(trace) {
  return (trace.steps || [])
    .map((s, i) => `${i + 1}. ${s.rationale}${s.action ? `\n   ACTION: ${s.action}${s.metadata.actionResult ? ` [${s.metadata.actionResult}]` : ''}` : ''}`)
    .join('\n');
}

// decompose() and the two score constants are internal: runVerifiedSteps is the only caller, and
// the pass floor is asserted through parseVerdict's behaviour rather than by reading the number back.
module.exports = {
  parseSteps, parseStepText, parseVerdict,
  modelVerifier, ruleVerifier, chainVerifiers,
  runVerifiedSteps, traceToAnswer,
};
