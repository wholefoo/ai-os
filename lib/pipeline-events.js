// lib/pipeline-events.js
// ============================================================
//  EVENT TRIGGERS — the docx's "when a YouTube video ends, a playbook fires". The last contract
//  component, and the only one that is real machinery rather than composition: the broadcast bus
//  already carries 41 event names, but nothing consumed one to START work.
//
//  ⚠️ THIS IS THE ONLY FEATURE IN THE PLAYBOOK SET THAT SPENDS MONEY WITH NO HUMAN PRESENT.
//  A misfiring trigger does not do one wrong thing — it does one wrong thing per event, forever,
//  until someone reads the bill. Every guard below exists because of that, and none of them are
//  defensive noise:
//
//   1. POLICY. Dispatch goes through `lib/safety/approval.js` as `pipeline.event-dispatch`,
//      classified 'critical' — it runs only in `auto` mode. In manual/supervised it is REFUSED and
//      logged. The operator can always run the pipeline by hand.
//   2. LOOP PREVENTION, the one that actually bites. A pipeline run BROADCASTS events itself
//      (`pipeline_update`). A pipeline subscribing to an event its own run emits is an unbounded
//      spend loop: run -> event -> run -> event. Those names are refused at LOAD time, so the
//      mistake cannot be made in YAML rather than being caught at runtime after it has cost money.
//   3. COOLDOWN. The same (pipeline, event) pair cannot re-fire within COOLDOWN_MS. Events arrive
//      in bursts; without this, one noisy source multiplies every run.
//   4. SINGLE-FLIGHT. A pipeline already running for an event does not start a second run.
//
//  A pipeline opts in with `on: <event-name>` in its YAML. Absent that key, nothing changes — this
//  module is inert for every pipeline that does not ask for it.
// ============================================================

const approval = require('./safety/approval.js');

/**
 * Events a PIPELINE RUN emits. Subscribing to one of these makes a run trigger another run.
 * Refused at load time. `fleet_update` is included because the runner emits it per stage.
 */
const SELF_EMITTED = Object.freeze(['pipeline_update', 'fleet_update', 'skill_progress', 'workflow_update']);

/** Minimum gap between two dispatches of the same (pipeline, event) pair. */
const COOLDOWN_MS = 60_000;

/**
 * Validate one pipeline's `on:` declaration. Called at LOAD time alongside graph validation, so a
 * dangerous subscription is refused before a run exists rather than after it has spent.
 * @returns {string[]} errors
 */
function validateSubscription(def) {
  const errors = [];
  const on = def && def.on;
  if (on === undefined || on === null) return errors;

  const names = Array.isArray(on) ? on : [on];
  if (!names.length || names.some((n) => typeof n !== 'string' || !n.trim())) {
    errors.push(`pipeline "${def.name}" has an \`on:\` that is not an event name (or list of them)`);
    return errors;
  }
  for (const n of names) {
    if (SELF_EMITTED.includes(n)) {
      errors.push(
        `pipeline "${def.name}" subscribes to "${n}", which a pipeline RUN emits — that is a spend `
        + `loop (run -> event -> run). Subscribe to a source event instead.`);
    }
  }
  return errors;
}

/** Build { eventName: [pipelineName] } from loaded definitions, skipping invalid subscriptions. */
function buildRegistry(defs) {
  const reg = new Map();
  for (const def of defs || []) {
    if (!def || !def.on) continue;
    if (validateSubscription(def).length) continue;   // refused; already surfaced by the loader
    for (const name of (Array.isArray(def.on) ? def.on : [def.on])) {
      if (!reg.has(name)) reg.set(name, []);
      if (!reg.get(name).includes(def.name)) reg.get(name).push(def.name);
    }
  }
  return reg;
}

/**
 * Decide what should happen when `eventName` fires. PURE — it starts nothing. The caller performs
 * the dispatch, which keeps this testable without a server and without spending anything.
 *
 * @returns {Array<{pipeline:string, dispatch:boolean, reason:string}>}
 */
function planDispatch(eventName, { registry, mode, now = Date.now(), lastFired = new Map(), running = new Set() } = {}) {
  const subs = (registry && registry.get(eventName)) || [];
  return subs.map((pipeline) => {
    const verdict = approval.decide('pipeline.event-dispatch', mode);
    if (!verdict.allow) {
      return { pipeline, dispatch: false, reason: `refused by policy: risk=${verdict.risk} mode=${verdict.mode}` };
    }
    if (running.has(pipeline)) {
      return { pipeline, dispatch: false, reason: 'already running for this trigger' };
    }
    const key = `${pipeline}::${eventName}`;
    const last = lastFired.get(key) || 0;
    if (now - last < COOLDOWN_MS) {
      return { pipeline, dispatch: false, reason: `cooldown (${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)}s remaining)` };
    }
    return { pipeline, dispatch: true, reason: 'allowed' };
  });
}

module.exports = { SELF_EMITTED, COOLDOWN_MS, validateSubscription, buildRegistry, planDispatch };
