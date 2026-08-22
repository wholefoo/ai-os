// tools/test-pipeline-events.js
// ============================================================
//  Event triggers — the only playbook feature that spends money with NO HUMAN PRESENT.
//
//  Every assertion here is about REFUSING to spend, because that is the failure mode that matters.
//  A trigger that fails to fire costs nothing and the operator runs the pipeline by hand. A trigger
//  that fires wrongly does so once per event, forever, until someone reads the bill.
//
//  The four guards, and why each exists:
//    1. POLICY — `pipeline.event-dispatch` is 'critical', so it runs ONLY in `auto` mode.
//    2. LOOP PREVENTION — a pipeline run emits `pipeline_update`; subscribing to it is
//       run -> event -> run, unbounded. Refused at LOAD time, so the mistake cannot reach runtime.
//    3. COOLDOWN — events arrive in bursts.
//    4. SINGLE-FLIGHT — one run per pipeline per trigger.
// ============================================================

const assert = require('assert');
const ev = require('../lib/pipeline-events.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const reg = (defs) => ev.buildRegistry(defs);

// --- 1. POLICY: the money guard. ---------------------------------------------------------------
ok('supervised mode REFUSES an event-triggered run (it is critical-risk)', () => {
  const r = ev.planDispatch('yt_analysis_complete', {
    registry: reg([{ name: 'repurpose-video', on: 'yt_analysis_complete' }]), mode: 'supervised',
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].dispatch, false, 'supervised must not auto-spend');
  assert.ok(/refused by policy/.test(r[0].reason), r[0].reason);
});

ok('manual mode refuses too', () => {
  const r = ev.planDispatch('yt_analysis_complete', {
    registry: reg([{ name: 'p', on: 'yt_analysis_complete' }]), mode: 'manual',
  });
  assert.strictEqual(r[0].dispatch, false);
});

ok('ONLY `auto` mode dispatches — and that is a deliberate operator choice', () => {
  const r = ev.planDispatch('yt_analysis_complete', {
    registry: reg([{ name: 'p', on: 'yt_analysis_complete' }]), mode: 'auto',
  });
  assert.strictEqual(r[0].dispatch, true, r[0].reason);
});

// --- 2. LOOP PREVENTION: the guard that actually bites. ----------------------------------------
ok('subscribing to a PIPELINE-EMITTED event is refused at LOAD time (spend loop)', () => {
  for (const name of ev.SELF_EMITTED) {
    const errs = ev.validateSubscription({ name: 'loopy', on: name });
    assert.ok(errs.length, `"${name}" is emitted by a run and must be refused`);
    assert.ok(/spend loop/.test(errs[0]), errs[0]);
  }
});

ok('a loop subscription never reaches the registry, so it cannot fire even in auto mode', () => {
  const r = ev.planDispatch('pipeline_update', {
    registry: reg([{ name: 'loopy', on: 'pipeline_update' }]), mode: 'auto',
  });
  assert.deepStrictEqual(r, [], 'a refused subscription must not be dispatchable at all');
});

ok('a legitimate source event still registers', () => {
  assert.deepStrictEqual(ev.validateSubscription({ name: 'p', on: 'yt_analysis_complete' }), []);
});

ok('a malformed `on:` is refused rather than ignored', () => {
  assert.ok(ev.validateSubscription({ name: 'p', on: 42 }).length);
  assert.ok(ev.validateSubscription({ name: 'p', on: [''] }).length);
  // ...but ABSENT `on:` is not an error — most pipelines have none and must be unaffected.
  assert.deepStrictEqual(ev.validateSubscription({ name: 'p' }), []);
});

// --- 3. COOLDOWN and 4. SINGLE-FLIGHT. ---------------------------------------------------------
ok('the same pipeline+event cannot re-fire inside the cooldown', () => {
  const registry = reg([{ name: 'p', on: 'yt_analysis_complete' }]);
  const lastFired = new Map([['p::yt_analysis_complete', 1000]]);
  const blocked = ev.planDispatch('yt_analysis_complete', { registry, mode: 'auto', now: 1000 + ev.COOLDOWN_MS - 1, lastFired });
  assert.strictEqual(blocked[0].dispatch, false);
  assert.ok(/cooldown/.test(blocked[0].reason), blocked[0].reason);
  const allowed = ev.planDispatch('yt_analysis_complete', { registry, mode: 'auto', now: 1000 + ev.COOLDOWN_MS + 1, lastFired });
  assert.strictEqual(allowed[0].dispatch, true, 'past the cooldown it must fire again');
});

ok('a pipeline already running for this trigger does not start a second run', () => {
  const r = ev.planDispatch('yt_analysis_complete', {
    registry: reg([{ name: 'p', on: 'yt_analysis_complete' }]), mode: 'auto', running: new Set(['p']),
  });
  assert.strictEqual(r[0].dispatch, false);
  assert.ok(/already running/.test(r[0].reason));
});

// --- Inertness: pipelines that never asked for this must be untouched. -------------------------
ok('a pipeline with no `on:` is never dispatched by any event', () => {
  const registry = reg([{ name: 'manual-only' }, { name: 'p', on: 'yt_analysis_complete' }]);
  assert.deepStrictEqual(ev.planDispatch('anything_at_all', { registry, mode: 'auto' }), []);
  assert.strictEqual(ev.planDispatch('yt_analysis_complete', { registry, mode: 'auto' }).length, 1);
});

// --- THE WIRING. This module was shipped with NOBODY CALLING IT. -------------------------------
// The first commit added the planner, the policy band, the executor and load-time validation — and
// no consumer. Every unit test above passed, because they exercise `planDispatch` directly. A
// planner nobody calls is the exact "capability exists and nothing dispatches it" shape that
// `pattern: skeptic` and `listRuns` had already shipped with in this same repo.
//
// Asserted at SOURCE level on purpose. The behavioural alternative — boot the server and broadcast
// an event — proves nothing while no pipeline declares `on:`: it would pass just as happily with
// the consumer deleted. This checks the one thing that was actually missing.
ok('server.js CONSUMES the planner — broadcast() is wired to dispatch', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/pipelineEvents\.planDispatch\(/.test(src),
    'nothing calls planDispatch() — event triggers cannot fire, whatever the mode says');
  assert.ok(/pipelineEvents\.buildRegistry\(/.test(src),
    'nothing builds the subscription registry, so planDispatch can never see a subscriber');
  // And the call must be INSIDE broadcast(), not merely nearby.
  //
  // The first version of this assertion sliced a fixed 2500 chars from `function broadcast(` and
  // searched for `maybeDispatchOnEvent(`. That matched the FUNCTION DEFINITION, which sits directly
  // below broadcast — so deleting the actual call still passed. Mutation-testing caught it. Slice
  // to the real end of the function: the first `}` at column 0.
  const start = src.indexOf('function broadcast(');
  assert.notStrictEqual(start, -1, 'broadcast() not found — did it get renamed?');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  assert.ok(/maybeDispatchOnEvent\s*\(/.test(body),
    'broadcast() does not invoke the dispatcher — the bus carries the event but nothing consumes it');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
