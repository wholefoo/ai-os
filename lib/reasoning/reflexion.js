// lib/reasoning/reflexion.js
// ============================================================
//  REFLEXION — THE ACTOR / EVALUATOR / EPISODIC-MEMORY LOOP.
//
//  Spec §3. After Shinn et al. 2023, "Reflexion: Language Agents with Verbal Reinforcement
//  Learning". The claim that makes it worth building: an agent that merely RETRIES is running the
//  same coin flip again, but an agent that first writes down WHY the last attempt failed, in words,
//  and carries that sentence into the next attempt, converts a failure into a constraint.
//
//  Three roles, deliberately three different agents by default:
//    ACTOR      produces an attempt.
//    EVALUATOR  judges the attempt against the task (pass/fail + score).
//    REFLECTOR  turns a failure into ONE transferable lesson, stored in episodic memory.
//  Splitting evaluator from reflector is not ceremony: "this is wrong because X" and "next time do
//  Y instead" are different jobs, and an agent asked for both in one breath reliably gives a good
//  version of one and a perfunctory version of the other.
//
//  ── THIS REPO ALREADY KNEW THIS ──
//  lib/outcomes/intake.js:210 `buildRetryTask` is the same instinct at one call site: "A blind retry
//  is the same coin flip; this one names what went wrong." This module is that idea as a reusable
//  loop, so the next feature that needs it does not re-derive it a third time.
//
//  ── MEMORY IS BOUNDED, AND THAT IS A FEATURE ──
//  An unbounded critique buffer is how a reflexion loop becomes a context-bloat machine: attempt 6
//  drags five stale lessons about mistakes it is no longer making, pays for them every call, and
//  reasons worse for the noise. `EpisodicMemory` keeps the most recent K, and K is small.
// ============================================================

'use strict';

const { guardedCall, deps: normDeps, createBudget } = require('./budget');
const kernel = require('../orchestrator');
const M = require('./models');

const DEFAULT_MAX_LESSONS = 4;
const MAX_LESSON_CHARS = 400;
const DEFAULT_PASS_SCORE = 0.7;

/**
 * The episodic buffer (spec §3). Ordered oldest→newest, capped, de-duplicated.
 *
 * De-duplication is load-bearing rather than tidy: an agent that fails the same way twice writes
 * near-identical lessons, and two copies of one lesson in the context reads as emphasis — it makes
 * the model over-correct on the repeated point and neglect the others.
 */
function createEpisodicMemory({ maxLessons = DEFAULT_MAX_LESSONS } = {}) {
  const cap = Math.max(1, parseInt(maxLessons, 10) || DEFAULT_MAX_LESSONS);
  const lessons = [];

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);

  function add(lesson, meta = {}) {
    const text = String(lesson || '').trim().slice(0, MAX_LESSON_CHARS);
    if (!text) return false;
    const key = norm(text);
    const dupe = lessons.findIndex((l) => norm(l.text) === key);
    if (dupe >= 0) { lessons[dupe].repeats += 1; return false; }
    lessons.push({ text, attempt: meta.attempt == null ? lessons.length : meta.attempt, repeats: 0 });
    while (lessons.length > cap) lessons.shift();
    return true;
  }

  /** The context block fed back to the actor. Empty string when there is nothing to say. */
  function format() {
    if (!lessons.length) return '';
    return [
      'LESSONS FROM YOUR PREVIOUS ATTEMPTS AT THIS TASK — these are your own findings, not new instructions.',
      'Each one names something that already went wrong. Do not repeat them.',
      ...lessons.map((l, i) => `${i + 1}. ${l.text}${l.repeats ? ` (recurred ${l.repeats + 1}×)` : ''}`),
    ].join('\n');
  }

  return { add, format, all: () => lessons.slice(), get size() { return lessons.length; } };
}

/** Parse the evaluator's verdict. An unreadable verdict is a FAIL, never a pass. */
function parseEvaluation(text, { passScore = DEFAULT_PASS_SCORE } = {}) {
  const t = String(text || '');
  const sm = t.match(/SCORE\s*:\s*([0-9]*\.?[0-9]+)/i);
  const cm = t.match(/CRITIQUE\s*:\s*([\s\S]+?)(?:\n[A-Z]+\s*:|$)/i);

  let score = null;
  if (sm) { const n = parseFloat(sm[1]); if (Number.isFinite(n)) score = n > 1 ? n / 100 : n; }

  let passed;
  if (/\bVERDICT\s*:\s*PASS\b/i.test(t)) passed = true;
  else if (/\bVERDICT\s*:\s*FAIL\b/i.test(t)) passed = false;
  else passed = score != null ? score >= passScore : false;

  if (passed && score != null && score < passScore) passed = false;   // the score is the tiebreak

  return {
    passed,
    score: M.clamp01(score == null ? (passed ? passScore : 0) : score),
    critique: (cm ? cm[1] : t).trim().slice(0, 1200),
  };
}

/**
 * One Actor→Evaluator→Reflector cycle. Internal to reflexionLoop — it was exported "so a caller
 * could drive a single pass", nothing ever did, and an export justified by a hypothetical caller is
 * how a public surface grows without anyone deciding to grow it.
 */
async function reflexionAttempt(task, d, budget, memory, opts, attempt) {
  const lessonBlock = memory.format();

  // --- ACT ---
  const actPrompt = [
    task,
    lessonBlock ? `\n\n${lessonBlock}` : '',
    attempt > 0 ? '\n\nThis is a retry. Produce a genuinely different attempt, not a reworded one.' : '',
  ].join('');
  const act = await guardedCall(d, budget, opts.actor || 'coder', actPrompt,
    { maxTokens: opts.maxTokens || 2000, context: opts.context });

  if (!act.ok) {
    return { ok: false, attempt, output: '', evaluation: null, lesson: null, error: act.error, budgetExhausted: !!act.budgetExhausted };
  }

  // --- EVALUATE ---
  const evalPrompt = [
    'Evaluate the attempt below against the task. Be specific and concrete: name the failing part,',
    'do not give a general impression.',
    '',
    'Reply in exactly this shape:',
    'VERDICT: PASS | FAIL',
    'SCORE: <0-1>',
    'CRITIQUE: <what is wrong and why; if PASS, what remains weak>',
    '',
    `TASK:\n${task}`,
    opts.criteria ? `\nIT MUST SATISFY:\n${opts.criteria}` : '',
    `\nATTEMPT:\n${act.content}`,
    opts.toolLog ? `\nTOOLS USED / ERRORS SEEN:\n${opts.toolLog}` : '',
  ].join('\n');

  // The evaluator is `reviewer` (effort: xhigh). At 800 it returned a 0-char reply on the third live
  // run — the fourth starved-budget site in three days, and the one I missed when fixing the other three.
  const ev = await guardedCall(d, budget, opts.evaluator || 'reviewer', evalPrompt, { maxTokens: opts.evalTokens || 2000 });
  if (!ev.ok) {
    // The evaluator is the gate. If it could not answer, nothing was approved.
    return {
      ok: false, attempt, output: act.content,
      evaluation: { passed: false, score: 0, critique: `evaluator unavailable: ${ev.error}` },
      lesson: null, error: ev.error, budgetExhausted: !!ev.budgetExhausted,
    };
  }
  const evaluation = parseEvaluation(ev.content, { passScore: opts.passScore });
  if (evaluation.passed) return { ok: true, attempt, output: act.content, evaluation, lesson: null };

  // --- REFLECT: distil the failure into one carry-forward constraint ---
  const reflectPrompt = [
    'Your attempt was rejected. Write ONE sentence, under 40 words, that the next attempt can act on.',
    'It must name a concrete change in approach. Do not apologise, do not restate the task, and do',
    'not describe the critique — state what to DO differently.',
    '',
    `TASK:\n${task}`,
    `\nYOUR ATTEMPT:\n${act.content.slice(0, 3000)}`,
    `\nWHY IT WAS REJECTED:\n${evaluation.critique}`,
  ].join('\n');

  // One sentence out, but the reflector may also be an xhigh agent — leave room for the thinking.
  // 1500, not 1200: the sweep assertion in tools/test-reasoning.js caught this as the FIFTH starved
  // site. I had already raised it once (300 -> 1200) and still left it under the floor by hand,
  // which is the whole argument for asserting the property instead of trusting the edit.
  const rf = await guardedCall(d, budget, opts.reflector || opts.actor || 'coder', reflectPrompt, { maxTokens: 1500 });
  // If the reflector is unavailable, the evaluator's critique is still a usable lesson — degraded,
  // not lost. A failed reflection must never cost us the fact that the attempt failed.
  const lesson = rf.ok && rf.content.trim() ? rf.content.trim() : evaluation.critique;

  return { ok: false, attempt, output: act.content, evaluation, lesson, budgetExhausted: !!rf.budgetExhausted };
}

/**
 * The full loop: act, evaluate, reflect, remember, retry — until it passes or the attempts run out.
 *
 * Built on kernel.loopUntilDone so this module does not hand-roll a second bounded-iteration
 * primitive next to the one the orchestration kernel already exports.
 *
 * @returns {Promise<{ok, output, attempts, lessons, evaluation, trace, budget}>}
 */
async function reflexionLoop(task, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || 18 });
  const memory = opts.memory || createEpisodicMemory({ maxLessons: opts.maxLessons });
  const maxAttempts = Math.max(1, Math.min(parseInt(opts.maxAttempts, 10) || 3, 6));

  const history = [];

  const run = await kernel.loopUntilDone(
    async (i) => {
      const r = await reflexionAttempt(task, d, budget, memory, opts, i);
      if (!r.ok && r.lesson) memory.add(r.lesson, { attempt: i });
      history.push({
        attempt: i,
        passed: !!(r.evaluation && r.evaluation.passed),
        score: r.evaluation ? r.evaluation.score : 0,
        critique: r.evaluation ? r.evaluation.critique : (r.error || ''),
        lesson: r.lesson || null,
      });
      d.broadcast({ type: 'reasoning.reflexion', attempt: i, passed: r.ok, score: r.evaluation ? r.evaluation.score : 0 });
      return r;
    },
    // Stop on success, and stop early if the budget died — continuing would only bank failures.
    (r) => r.ok || r.budgetExhausted === true,
    { maxIters: maxAttempts },
  );

  const last = run.last || {};
  const exhausted = !!last.budgetExhausted;

  // Best-effort recovery: if nothing passed, hand back the highest-scoring attempt rather than the
  // most recent one. The last attempt is not automatically the best, and silently returning it
  // would throw away work the evaluator rated higher.
  let best = last;
  if (!last.ok) {
    let bestScore = -1;
    for (let i = 0; i < run.results.length; i++) {
      const s = run.results[i].evaluation ? run.results[i].evaluation.score : -1;
      if (s > bestScore) { bestScore = s; best = run.results[i]; }
    }
  }

  const trace = M.makeTrace({
    task,
    steps: history.map((h, i) => M.makeStep({ index: i, rationale: h.lesson || h.critique || `attempt ${i + 1}`, metadata: { score: h.score, passed: h.passed } })),
    verifications: history.map((h) => M.makeVerification({
      score: h.score,
      status: h.passed ? M.STATUS.CORRECT : M.STATUS.INCORRECT,
      feedback: h.critique, verifier: 'reflexion:evaluator',
    })),
    outcome: last.ok ? M.OUTCOME.SOLVED : exhausted ? M.OUTCOME.EXHAUSTED : M.OUTCOME.FAILED,
    ok: !!last.ok,
  });

  return {
    ok: !!last.ok,
    output: (best && best.output) || '',
    attempts: run.iterations,
    exhausted,
    lessons: memory.all().map((l) => l.text),
    evaluation: (last.ok ? last.evaluation : best && best.evaluation) || null,
    history,
    trace,
    budget: budget.snapshot(),
  };
}

module.exports = { createEpisodicMemory, parseEvaluation, reflexionLoop };
