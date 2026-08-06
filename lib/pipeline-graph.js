// lib/pipeline-graph.js
// ============================================================
//  Turns a pipeline's declared `depends_on` edges into an executable schedule.
//
//  Until 2026-08-03 those edges were DOCUMENTATION. `.claude/pipelines/*.yaml` declared
//  `depends_on: [research]` on almost every stage and **no JavaScript read the field anywhere in the
//  repo**. The runner was `for (let i = startIdx; i < run.stages.length; i++)` — array order — and it
//  threaded EVERY prior stage's output into every later stage regardless of what was declared. So a
//  file that reads as a DAG in review executed as a queue, and `security-sweep`'s two independent
//  audits ran one after the other for no reason.
//
//  Two things follow from making the edges real, and the second matters more than the speedup:
//    1. Independent stages run concurrently (`security-sweep` has two roots).
//    2. A stage receives ONLY its declared dependencies' output. State becomes what this node needs
//       rather than everything that happened earlier — which is the actual point of modelling work
//       as a graph, and is why a five-stage run used to hand stage five four other deliverables it
//       never asked for.
//
//  ── THE OPT-IN RULE, and it is deliberate ──
//  A pipeline where NO stage declares `depends_on` runs sequentially, exactly as before. Declaring
//  an edge anywhere opts the whole pipeline into graph execution. Absence of a declaration is not
//  evidence of independence — it is far more likely nobody wrote it down — and turning an
//  un-annotated pipeline into a fully parallel one would be inventing a claim the author never made.
//
//  Pure: topology and validation only. No I/O, no execution. The runner in server.js drives it.
// ============================================================

'use strict';

/** Stages that declare at least one edge — the opt-in signal. */
function declaresEdges(stages) {
  return (stages || []).some((s) => Array.isArray(s && s.depends_on) && s.depends_on.length > 0);
}

const depsOf = (s) => (Array.isArray(s && s.depends_on) ? s.depends_on.filter(Boolean) : []);

/**
 * Is this graph runnable at all? Called at LOAD time, so a malformed pipeline fails before it
 * spends a token — the same reasoning as validating `gates:` against ACTION_RISK rather than
 * discovering at runtime that a guardrail names nothing.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateGraph(stages) {
  const errors = [];
  const list = stages || [];
  const ids = list.map((s) => s && s.id);

  ids.forEach((id, i) => {
    if (!id) errors.push(`stage ${i} has no id`);
    else if (ids.indexOf(id) !== i) errors.push(`duplicate stage id "${id}" — dependencies could not name one unambiguously`);
  });

  const known = new Set(ids.filter(Boolean));
  for (const s of list) {
    for (const d of depsOf(s)) {
      if (!known.has(d)) errors.push(`stage "${s.id}" depends_on "${d}", which is not a stage in this pipeline`);
      if (d === s.id) errors.push(`stage "${s.id}" depends on itself`);
    }
  }

  // Cycle detection, but only report it when the ids all resolve — otherwise an unknown-id typo
  // also surfaces as a confusing "cycle", and the first message is the useful one.
  if (!errors.length) {
    const remaining = new Map(list.map((s) => [s.id, new Set(depsOf(s))]));
    let progressed = true;
    while (remaining.size && progressed) {
      progressed = false;
      for (const [id, deps] of remaining) {
        if ([...deps].every((d) => !remaining.has(d))) { remaining.delete(id); progressed = true; }
      }
    }
    if (remaining.size) {
      errors.push(`dependency cycle among: ${[...remaining.keys()].sort().join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Execution layers. Every stage in a layer may run concurrently; layer N+1 starts only after N.
 *
 * Kahn's algorithm, grouped. Sequential pipelines (no declared edges) come back as one stage per
 * layer, in file order, which is precisely the old behaviour.
 *
 * @returns {string[][]} stage ids, or [] if the graph is invalid
 */
function layersOf(stages) {
  const list = stages || [];
  if (!validateGraph(list).ok) return [];
  if (!declaresEdges(list)) return list.map((s) => [s.id]);   // legacy: strictly sequential

  const pending = new Map(list.map((s) => [s.id, new Set(depsOf(s))]));
  const done = new Set();
  const layers = [];

  while (pending.size) {
    const ready = [...pending.keys()].filter((id) => [...pending.get(id)].every((d) => done.has(d)));
    if (!ready.length) return [];        // unreachable after validateGraph, but never loop forever
    // Preserve file order inside a layer so runs read predictably and logs are stable.
    ready.sort((a, b) => list.findIndex((s) => s.id === a) - list.findIndex((s) => s.id === b));
    layers.push(ready);
    ready.forEach((id) => { pending.delete(id); done.add(id); });
  }
  return layers;
}

/**
 * The stages whose output this stage actually asked for.
 *
 * For a graph pipeline: its DIRECT dependencies, nothing else. Not transitive — if `outline` needs
 * `research` as well as `synthesize`, that is an edge to declare, not something to infer. Making it
 * transitive would quietly rebuild the everything-forward blob this module exists to remove.
 *
 * For a legacy (edgeless) pipeline: every earlier stage, matching the old runner exactly.
 */
function inputsFor(stage, stages) {
  const list = stages || [];
  if (!declaresEdges(list)) {
    const i = list.findIndex((s) => s.id === (stage && stage.id));
    return i <= 0 ? [] : list.slice(0, i);
  }
  const want = new Set(depsOf(stage));
  return list.filter((s) => want.has(s.id));
}

/**
 * Required parameters a dispatch failed to supply.
 *
 * Every pipeline in `.claude/pipelines/` already declares its inputs:
 *
 *     parameters:
 *       target:
 *         required: true
 *         description: Repository path or URL to audit
 *
 * That block was authored with the file and, until this function existed, was read by nothing — so
 * `execute` with `{}` dispatched the entire graph anyway. On production it did exactly that twice:
 * three security-auditor stages each independently rediscovered that no target existed, a fourth
 * compiled their identical blockers, a fifth escalated it. Five Opus calls and ~$0.31 to establish
 * one fact that costs nothing to check. The run's own gate wrote the remedy: "Input presence should
 * be validated once at dispatch, before any stage is commissioned."
 *
 * Same shape as `depends_on` before G1 — the vocabulary existed, the enforcement did not.
 *
 * On value semantics: a supplied `0` or `false` is a SUPPLIED value. The obvious `if (!v)` would
 * refuse a correctly-formed dispatch, and a guard that blocks valid work is worse than no guard. Only
 * `null`/`undefined`/blank-string counts as absent.
 *
 * @returns {{name: string, type: string|null, description: string|null}[]} empty when nothing is missing
 */
function missingRequiredParams(pipeline, params) {
  const declared = (pipeline && pipeline.parameters) || {};
  const supplied = params || {};
  const out = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!spec || spec.required !== true) continue;
    const v = supplied[name];
    const absent = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    // Carry the author's own description through: a refusal naming WHAT to supply is actionable,
    // where one naming only the key sends the operator back to the YAML to find out.
    if (absent) out.push({ name, type: spec.type || null, description: spec.description || null });
  }
  return out;
}

/**
 * How much of ONE upstream stage's output a downstream stage may be shown.
 *
 * This was `slice(0, 4000)`, inline and silent, and it cost a real run. On production
 * `run-1785910485579` the `compile-report` stage emitted 7302 characters; `human-review` — the gate
 * that decides whether the work may be filed — received the first 4000 and lost sections 4 to 8.
 * It then reported the compiled report as "truncated, §4 absent" and blamed the compile stage. The
 * artifact was complete. The harness had cut it, and said nothing, so the reviewer could not tell
 * "the report ends here" from "my input ends here".
 *
 * 24000 chars is roughly 6k tokens. It is deliberately far above every output that run produced
 * (largest: 7302) so that real work arrives WHOLE and this path stops being a silent editor.
 *
 * On why this is affordable: input tokens are NOT drawn from `max_tokens`, which caps generation
 * (thinking + answer) only. A wider input window therefore cannot reproduce the thinking-starvation
 * failure that forced the stage budget up to 12000 — it costs input billing and context, and the
 * context window is 1M. Do not "optimise" this back down without a measured reason.
 */
const STAGE_INPUT_MAX_CHARS = 24000;

/** Characters preserved from the END when a cut is unavoidable. See clipStageOutput. */
const STAGE_INPUT_TAIL_CHARS = 6000;

/**
 * One upstream stage's output, fitted to the input budget.
 *
 * Two rules, both learned from the failure above:
 *
 *   1. **Keep the end.** A head-only slice discards precisely where a report puts its verdict,
 *      recommendation or reference list — the part a downstream stage most needs. When a cut is
 *      required the MIDDLE goes, not the tail.
 *   2. **Say so.** An unannounced cut is indistinguishable from a short document, which is how a
 *      reviewer came to file a defect against work that had none. The marker names the size of the
 *      gap and states that the following text is the END, so the tail is not misread as a
 *      continuation of the head.
 */
function clipStageOutput(text, max = STAGE_INPUT_MAX_CHARS, tail = STAGE_INPUT_TAIL_CHARS) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const keepTail = Math.min(tail, Math.floor(max / 2));
  const dropped = s.length - max;
  return s.slice(0, max - keepTail)
    + `\n\n[... ${dropped} characters omitted from the MIDDLE of this stage's output to fit the`
    + ` per-stage input budget. What follows is the END of that output, not a continuation of the`
    + ` text above. Treat any gap in the argument as missing input, not as a defect in the upstream`
    + ` stage. ...]\n\n`
    + s.slice(-keepTail);
}

/** Cap on stages running at once. A 3-way split at Strategic tier is 3 simultaneous Opus calls. */
const MAX_CONCURRENT_STAGES = 3;

/** Run `fn` over `items` with at most `limit` in flight. Preserves input order in the result. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  validateGraph, layersOf, inputsFor, declaresEdges, mapLimited, MAX_CONCURRENT_STAGES,
  clipStageOutput, STAGE_INPUT_MAX_CHARS, STAGE_INPUT_TAIL_CHARS,
  missingRequiredParams,
};
