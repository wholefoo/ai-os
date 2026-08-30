// lib/pipeline-patterns.js
// ============================================================
//  Lets a pipeline stage say `pattern: fan-out` and reach the orchestration kernel.
//
//  G2 of .magent/vault/wiki/graph-engineering-eval.md. lib/orchestrator.js has implemented the
//  Diamond Pattern's primitives since it was written, and FIVE OF ITS SEVEN EXPORTS HAD NO CONSUMER
//  ANYWHERE — which is why they all sit in .fallowrc.json's ignoreExports allowlist. The kernel was
//  not wrong, it was unreachable: the only way to fan out or run a skeptic panel was a bespoke
//  server route. A pipeline could not ask for either.
//
//  ── FIVE KERNEL PATTERNS MAP TO YAML. TWO DELIBERATELY DO NOT. ──
//  (Three more — verified-steps, reflexion, tree-search — come from lib/reasoning and are declared
//  further down, next to the bounds that make a multi-call stage refusable at load time.)
//    fan-out          -> fanOutAndSynthesize   N agents in parallel, then a synthesizer
//    skeptic          -> adversarialVerify     N refuters vote on a dependency's output
//    generate-filter  -> generateAndFilter     over-generate, then pick the best
//    tournament       -> tournament            pairwise A/B over the dependencies' outputs
//    classify         -> classifyAndAct        route the task to one of several agents
//
//    loop-until-done  NOT EXPOSED. It takes stepFn and isDone as FUNCTIONS. Expressing a predicate
//                     in YAML means inventing a small language, and a half-built one would be worse
//                     than the honest absence. It stays a code-level primitive.
//    runSequential    NOT EXPOSED. It is what the pipeline runner already is; a stage that re-ran a
//                     sequence inside a stage would be a second scheduler competing with the first.
//
//  A pattern stage's SUBJECT is its declared dependencies' output (G1). `skeptic` and `tournament`
//  therefore require at least one `depends_on` — a skeptic with nothing to refute is the decorative
//  guardrail this codebase keeps finding, and it fails at load time rather than passing vacuously.
//
//  Pure w.r.t. injected deps: `runPattern` takes the same { runAgent, broadcast, log } shape the
//  kernel takes, so a test drives it with a mock runner and never spends a token.
// ============================================================

'use strict';

const kernel = require('./orchestrator');
const reasoning = require('./reasoning');

/** Verdict when a skeptic panel refutes the work it was given. */
const ON_REFUTE = Object.freeze(['fail', 'gate', 'warn']);

//  ── THE THREE REASONING PATTERNS (added with lib/reasoning/) ──
//  Same argument as the five above: lib/reasoning implements CoT+PRM, Reflexion and Tree-of-Thoughts
//  as pure engines over an injected runAgent, and without a `pattern:` key the only way to reach any
//  of them would be a bespoke route — which is exactly how the orchestration kernel spent months
//  being right and unreachable. STaR and the context manager are deliberately NOT here: STaR needs a
//  trace store and a ground-truth check that YAML cannot express, and the context manager is a
//  library the engines use rather than a stage anyone would schedule.
const REASONING_PATTERNS = Object.freeze(['verified-steps', 'reflexion', 'tree-search']);
const PATTERNS = Object.freeze(['fan-out', 'skeptic', 'generate-filter', 'tournament', 'classify', ...REASONING_PATTERNS]);
const NEEDS_DEPS = Object.freeze(['skeptic', 'tournament']);
const TREE_STRATEGIES = Object.freeze(['bfs', 'dfs']);

/**
 * Config errors for one pattern stage. Called at LOAD time, alongside the graph validation, so a
 * misconfigured pattern is refused before the run starts instead of failing on the stage.
 */
function validatePatternStage(stage) {
  const errors = [];
  const p = stage && stage.pattern;
  if (!p) return errors;

  if (!PATTERNS.includes(p)) {
    errors.push(`stage "${stage.id}" uses unknown pattern "${p}" — expected one of ${PATTERNS.join(', ')}`);
    return errors;   // nothing else is meaningful once the pattern is unknown
  }
  const deps = Array.isArray(stage.depends_on) ? stage.depends_on.filter(Boolean) : [];
  if (NEEDS_DEPS.includes(p) && !deps.length) {
    errors.push(`stage "${stage.id}" uses pattern "${p}" but declares no depends_on — it would have nothing to work on`);
  }
  if (p === 'fan-out') {
    const w = stage.workers;
    if (!Array.isArray(w) || w.length < 2) errors.push(`stage "${stage.id}" (fan-out) needs a \`workers:\` list of at least 2 agents`);
  }
  if (p === 'classify') {
    const r = stage.routes;
    const n = r && typeof r === 'object' ? Object.keys(r).length : 0;
    if (n < 2) errors.push(`stage "${stage.id}" (classify) needs a \`routes:\` map with at least 2 entries`);
  }
  if (stage.on_refute && !ON_REFUTE.includes(stage.on_refute)) {
    errors.push(`stage "${stage.id}" has on_refute "${stage.on_refute}" — expected one of ${ON_REFUTE.join(', ')}`);
  }

  // A reasoning stage costs many calls, not one (see lib/reasoning/index.js's cost table). A
  // mistyped bound is therefore a budget event, not a cosmetic error, and it is refused at LOAD
  // time — before the run starts — rather than discovered on the stage that spends the money.
  if (p === 'tree-search' && stage.strategy && !TREE_STRATEGIES.includes(stage.strategy)) {
    errors.push(`stage "${stage.id}" (tree-search) has strategy "${stage.strategy}" — expected one of ${TREE_STRATEGIES.join(', ')}`);
  }
  if (REASONING_PATTERNS.includes(p) && stage.max_calls != null) {
    const n = Number(stage.max_calls);
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      errors.push(`stage "${stage.id}" has max_calls "${stage.max_calls}" — expected a number from 1 to 60`);
    }
  }
  if (p === 'reflexion' && stage.max_attempts != null) {
    const n = Number(stage.max_attempts);
    if (!Number.isFinite(n) || n < 1 || n > 6) {
      errors.push(`stage "${stage.id}" has max_attempts "${stage.max_attempts}" — expected a number from 1 to 6`);
    }
  }
  return errors;
}

/** Normalise `workers: [a, b]` or `workers: [{agent: a, task: t}]` into the kernel's shape. */
function normalizeWorkers(workers) {
  return (workers || []).map((w) => (typeof w === 'string' ? { agent: w } : w)).filter((w) => w && w.agent);
}

/**
 * Run one pattern stage.
 *
 * @param {object} stage    the pipeline stage (pattern, workers/routes/n/..., depends_on)
 * @param {object} ctx      { task, subject } — subject is the declared dependencies' joined output
 * @param {object} deps     { runAgent, broadcast, log } — same shape lib/orchestrator.js takes
 * @returns {Promise<{ok:boolean, output:string, meta:object, verdict?:string}>}
 *          verdict is 'gated' or 'refuted' where the caller must act on it.
 */
async function runPattern(stage, ctx, deps) {
  const task = ctx.task || '';
  const subject = ctx.subject || '';

  switch (stage.pattern) {
    case 'fan-out': {
      const r = await kernel.fanOutAndSynthesize(task, normalizeWorkers(stage.workers), deps,
        { synthesizer: stage.synthesizer || 'synthesis' });
      // A partial fan-out is still a result: the kernel only fails when EVERY worker failed.
      return {
        ok: !!r.ok,
        output: r.synthesis || '',
        meta: { workers: (r.parts || []).map((p) => ({ agent: p.agent, ok: p.ok })), failed: (r.parts || []).filter((p) => !p.ok).length },
      };
    }

    case 'skeptic': {
      const r = await kernel.adversarialVerify(subject, deps, {
        n: Number(stage.n) || 3,
        verifier: stage.verifier || 'reviewer',
      });
      const lines = (r.verdicts || []).map((v, i) => `${i + 1}. ${v.refuted ? 'REFUTED' : 'SOUND'} — ${v.reason}`).join('\n');
      const output = `Adversarial panel: ${r.refuteCount}/${r.answered} refuted (n=${r.n}).\n${lines}`;
      // A panel that nobody answered is NOT a pass. Same rule as the repo's own
      // adversarial-verification.md: a missing verdict is a block, never a silent ship.
      if (!r.answered) return { ok: false, output: output + '\nNo skeptic answered — treated as a block.', meta: r };
      if (r.refuted) {
        const mode = stage.on_refute || 'fail';
        return { ok: mode !== 'fail', output, meta: r, verdict: mode === 'gate' ? 'gated' : (mode === 'fail' ? 'refuted' : undefined) };
      }
      return { ok: true, output, meta: r };
    }

    case 'generate-filter': {
      const r = await kernel.generateAndFilter(task, deps, {
        n: Number(stage.n) || 3,
        generator: stage.generator || stage.agent || 'writer',
        picker: stage.picker || 'reviewer',
      });
      return { ok: !!r.ok, output: r.best || '', meta: { candidates: (r.candidates || []).length, bestIndex: r.bestIndex } };
    }

    case 'tournament': {
      // Each declared dependency's output is a candidate — the pipeline-shaped reading of "compare
      // these". ctx.candidates is supplied by the runner from the same inputsFor() G1 uses.
      const r = await kernel.tournament(ctx.candidates || [], deps, { judge: stage.judge || 'reviewer', goal: stage.goal });
      return { ok: !!r.ok, output: r.winner || '', meta: { winnerIndex: r.winnerIndex, rounds: (r.rounds || []).length } };
    }

    case 'classify': {
      const r = await kernel.classifyAndAct(task, stage.routes, deps, { classifier: stage.classifier || 'scout' });
      return { ok: !!r.ok, output: (r.result && r.result.content) || '', meta: { routeKey: r.routeKey, agent: r.agent } };
    }

    // ---- reasoning engines (lib/reasoning) ----------------------------------------------------
    // Each returns a single accumulated budget snapshot, which the runner adds to the stage's cost
    // exactly as it does for the patterns above. A multi-call stage that reported one call's tokens
    // would under-report spend on precisely the stages that spend the most.
    case 'verified-steps': {
      const r = await reasoning.reason(task, deps, {
        mode: 'steps',
        planner: stage.planner || 'architect',
        actor: stage.actor || stage.agent || 'coder',
        verifierAgent: stage.verifier || 'reviewer',
        maxSteps: Number(stage.max_steps) || 6,
        onFail: stage.on_fail === 'continue' || stage.on_fail === 'revise' ? stage.on_fail : 'halt',
        maxCalls: Number(stage.max_calls) || undefined,
        context: subject || undefined,
      });
      return { ok: !!r.ok, output: r.output || '', meta: { ...r.meta, budget: r.budget } };
    }

    case 'reflexion': {
      const r = await reasoning.reason(task, deps, {
        mode: 'reflexion',
        actor: stage.actor || stage.agent || 'coder',
        evaluator: stage.evaluator || 'reviewer',
        reflector: stage.reflector || undefined,
        maxAttempts: Number(stage.max_attempts) || 3,
        criteria: stage.criteria || undefined,
        maxCalls: Number(stage.max_calls) || undefined,
        context: subject || undefined,
      });
      // An exhausted loop that never passed is NOT a success, but its best attempt is still the
      // most useful thing we can hand the next stage — so the output survives and `ok` tells the
      // truth about it.
      return { ok: !!r.ok, output: r.output || '', meta: { ...r.meta, budget: r.budget } };
    }

    case 'tree-search': {
      const r = await reasoning.reason(task, deps, {
        mode: 'tot',
        strategy: stage.strategy || 'bfs',
        proposer: stage.proposer || stage.agent || 'architect',
        scorer: stage.scorer || 'reviewer',
        breadth: Number(stage.breadth) || undefined,
        maxDepth: Number(stage.max_depth) || undefined,
        scoring: stage.scoring === 'vote' ? 'vote' : 'value',
        maxCalls: Number(stage.max_calls) || undefined,
      });
      return { ok: !!r.ok, output: r.output || '', meta: { ...r.meta, budget: r.budget } };
    }

    default:
      return { ok: false, output: '', meta: { error: `unknown pattern "${stage.pattern}"` } };
  }
}

// NEEDS_DEPS, ON_REFUTE and normalizeWorkers stay internal: they are implementation detail of
// validatePatternStage and runPattern, and exporting them would put three more names in the
// dead-code allowlist to say "nothing uses these" — which is just a slower way of not exporting them.
module.exports = { PATTERNS, validatePatternStage, runPattern };
