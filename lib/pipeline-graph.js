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

module.exports = { validateGraph, layersOf, inputsFor, declaresEdges, mapLimited, MAX_CONCURRENT_STAGES };
