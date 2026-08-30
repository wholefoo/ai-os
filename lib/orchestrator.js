// lib/orchestrator.js
// ============================================================
//  The six 2026 "Dynamic Workflow" patterns, as composable async functions over an INJECTED
//  agent runner — so the real engine (server.js executeAgent) and unit tests (mock runner)
//  share one implementation. This turns AI OS's "orchestration lab" premise into a real
//  primitive: skills and pipelines compose these instead of faking step progress with setTimeout.
//
//  deps = {
//    runAgent: async (agentName, task, opts?) => { ok, content, model?, error? },   // = executeAgent
//    broadcast?: (evt) => void,   // optional progress stream
//    log?: (msg) => void,
//  }
//  Every pattern is defensive: a single agent failure degrades gracefully (never throws on one
//  bad call) so a workflow makes forward progress.
// ============================================================

function dep(deps) {
  return {
    runAgent: (deps && deps.runAgent) || (async () => ({ ok: false, error: 'no runAgent injected' })),
    broadcast: (deps && deps.broadcast) || (() => {}),
    log: (deps && deps.log) || (() => {}),
  };
}
async function call(d, agent, task, opts) {
  try { const r = await d.runAgent(agent, task, opts || {}); return r && typeof r === 'object' ? r : { ok: false, error: 'bad agent result' }; }
  catch (e) { return { ok: false, error: e.message }; }
}
const text = (r) => (r && r.ok && typeof r.content === 'string' ? r.content : '');

// Pull the first matching key (case-insensitive whole-word) from agent text.
function firstKey(s, keys) {
  const t = String(s || '');
  let best = null, bestAt = Infinity;
  for (const k of keys) {
    const m = t.match(new RegExp('\\b' + String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
    if (m && m.index < bestAt) { best = k; bestAt = m.index; }
  }
  return best;
}
function firstNumber(s, max) {
  const m = String(s || '').match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return (n >= 1 && (!max || n <= max)) ? n : null;
}

// ---------- 1. Classify and act ----------
// routes: { key: {agent, label?} } | [{key, agent, label?}]. A cheap classifier picks the route.
async function classifyAndAct(task, routes, deps, opts = {}) {
  const d = dep(deps);
  const list = Array.isArray(routes) ? routes : Object.entries(routes).map(([key, v]) => ({ key, ...v }));
  if (!list.length) return { ok: false, error: 'no routes' };
  const keys = list.map((r) => r.key);
  const menu = list.map((r) => `- ${r.key}: ${r.label || r.agent}`).join('\n');
  const cls = await call(d, opts.classifier || 'scout',
    `Classify the task into exactly ONE of these route keys. Reply with ONLY the key.\n\nRoutes:\n${menu}\n\nTask:\n${task}`,
    { maxTokens: 200 });
  const chosen = firstKey(text(cls), keys) || keys[0];
  const route = list.find((r) => r.key === chosen) || list[0];
  d.log(`[orchestrator] classifyAndAct → ${route.key} (${route.agent})`);
  const result = await call(d, route.agent, task, opts.agentOpts);
  return { ok: !!result.ok, routeKey: route.key, agent: route.agent, result };
}

// ---------- 2. Fan out and synthesize ----------
// workers: [{agent, task?}]. Run in parallel, then a synthesizer reduces.
async function fanOutAndSynthesize(task, workers, deps, opts = {}) {
  const d = dep(deps);
  const parts = await Promise.all((workers || []).map(async (w) => {
    const r = await call(d, w.agent, w.task || task, opts.agentOpts);
    return { agent: w.agent, ok: !!r.ok, content: text(r), error: r.error };
  }));
  const good = parts.filter((p) => p.ok && p.content);
  if (!good.length) return { ok: false, parts, synthesis: '', error: 'all workers failed' };
  const merged = good.map((p, i) => `### Result ${i + 1} (${p.agent})\n${p.content}`).join('\n\n');
  const synth = await call(d, opts.synthesizer || 'synthesis',
    `Synthesize the ${good.length} results below into one coherent, de-duplicated answer to the task. Resolve conflicts and note genuine disagreements.\n\nTASK:\n${task}\n\n${merged}`,
    opts.synthOpts || { maxTokens: 4000 });
  return { ok: !!synth.ok, parts, synthesis: text(synth), synthModel: synth.model };
}

// ---------- 3. Adversarial verification ----------
// N skeptics try to REFUTE `subject`. Refuted if refuteCount >= threshold (default strict majority).
async function adversarialVerify(subject, deps, opts = {}) {
  const d = dep(deps);
  const n = Math.max(1, opts.n || 3);
  const verifier = opts.verifier || 'reviewer';
  const prompt = (opts.refutePrompt || 'Adversarially review the claim/output below. Try hard to find a real flaw. Reply on the FIRST line with exactly REFUTED or SOUND, then one sentence why. Default to REFUTED if genuinely uncertain.') + `\n\n--- SUBJECT ---\n${subject}`;
  const verdicts = await Promise.all(Array.from({ length: n }, () =>
    call(d, verifier, prompt, opts.agentOpts || { maxTokens: 600 }).then((r) => {
      const t = text(r);
      const refuted = /\bREFUTED\b/i.test(t) && !/^\s*SOUND\b/i.test(t);
      return { ok: !!r.ok, refuted: r.ok ? refuted : false, answered: !!r.ok, reason: t.split('\n')[0] || r.error || '' };
    })));
  const answered = verdicts.filter((v) => v.answered).length;
  const refuteCount = verdicts.filter((v) => v.refuted).length;
  const threshold = opts.threshold || Math.floor(answered / 2) + 1; // strict majority of those that answered
  return { verdicts, refuteCount, answered, n, refuted: answered > 0 && refuteCount >= threshold, sound: answered > 0 && refuteCount < threshold };
}

// ---------- 4. Generate and filter ----------
// Over-generate n candidates (varied by index), then a picker selects the best.
async function generateAndFilter(task, deps, opts = {}) {
  const d = dep(deps);
  const n = Math.max(2, opts.n || 3);
  const gen = opts.generator || 'writer';
  const candidates = await Promise.all(Array.from({ length: n }, (_, i) =>
    call(d, gen, `${task}\n\n(Generate a DISTINCT option ${i + 1} of ${n} — make it meaningfully different from the others.)`, opts.agentOpts)
      .then((r) => ({ ok: !!r.ok, content: text(r) }))));
  const good = candidates.map((c, i) => ({ ...c, i })).filter((c) => c.ok && c.content);
  if (!good.length) return { ok: false, candidates, bestIndex: -1, best: '' };
  if (good.length === 1) return { ok: true, candidates, bestIndex: good[0].i, best: good[0].content };
  const menu = good.map((c, k) => `[${k + 1}]\n${c.content}`).join('\n\n');
  const pickR = await call(d, opts.picker || 'reviewer',
    `Pick the single BEST option for the task. Reply with ONLY its number (1-${good.length}).\n\nTASK:\n${task}\n\nOPTIONS:\n${menu}`,
    { maxTokens: 200 });
  const pick = firstNumber(text(pickR), good.length) || 1;
  const chosen = good[pick - 1] || good[0];
  return { ok: true, candidates, bestIndex: chosen.i, best: chosen.content };
}

// ---------- 5. Tournament ----------
// Pairwise A/B comparison of candidates until one winner remains.
async function tournament(candidates, deps, opts = {}) {
  const d = dep(deps);
  const judge = opts.judge || 'reviewer';
  const items = (candidates || []).map((c, i) => ({ i, content: typeof c === 'string' ? c : (c && c.content) || '' })).filter((c) => c.content);
  if (!items.length) return { ok: false, winnerIndex: -1, winner: '', rounds: [] };
  let champ = items[0];
  const rounds = [];
  for (let k = 1; k < items.length; k++) {
    const challenger = items[k];
    const r = await call(d, judge,
      `Which option better fits the goal${opts.goal ? ` (${opts.goal})` : ''}? Reply with ONLY "A" or "B".\n\nA:\n${champ.content}\n\nB:\n${challenger.content}`,
      { maxTokens: 200 });
    const t = text(r);
    const bWins = /\bB\b/i.test(t) && (t.search(/\bB\b/i) < (t.search(/\bA\b/i) === -1 ? Infinity : t.search(/\bA\b/i)));
    rounds.push({ a: champ.i, b: challenger.i, winner: bWins ? challenger.i : champ.i });
    if (bWins) champ = challenger;
  }
  return { ok: true, winnerIndex: champ.i, winner: champ.content, rounds };
}

// ---------- 6. Loop until done ----------
// stepFn(i, prev) -> result ; isDone(result, i) -> bool. Pure control flow (no agent dep needed).
//
// `loopUntilDone` HAS A CALLER AS OF THE REASONING FRAMEWORK: lib/reasoning/reflexion.js drives its
// Actor→Evaluator→Reflector cycle through it, which is why it is no longer in `.fallowrc.json`'s
// ignoreExports. It stays UNEXPOSED to YAML for the original reason — it takes FUNCTION arguments
// (stepFn/isDone), and expressing a predicate in YAML means inventing a small language.
//
// `runSequential` below still has no caller and remains allowlisted: it is what the pipeline runner
// already does, so wiring it would be circular. It is a library surface, not dead code.
//
// This note lived in the fallow config as a `_comment` until 2026-08-21, when fallow 3.x began
// rejecting unknown config fields outright. It belongs here anyway: whoever considers deleting
// these exports is reading THIS file, not the linter's config.
async function loopUntilDone(stepFn, isDone, opts = {}) {
  const maxIters = Math.max(1, opts.maxIters || 5);
  const results = [];
  let prev = opts.seed;
  for (let i = 0; i < maxIters; i++) {
    const r = await stepFn(i, prev);
    results.push(r);
    prev = r;
    let done = false;
    try { done = !!(await isDone(r, i)); } catch { done = false; }
    if (done) return { done: true, iterations: i + 1, results, last: r };
  }
  return { done: false, iterations: maxIters, results, last: results[results.length - 1] };
}

// ---------- Sequential chain (the pipeline case) ----------
// stages: [{ id, agent, task? | buildTask(ctx)? , skill? }]. Threads each output into ctx.outputs
// keyed by stage id, so later stages can reference earlier ones. onStage streams progress.
//
// NOTE: P3 removed its last caller. The skill step-runner was the only consumer, and skills now
// dispatch their team in PARALLEL because the steps had no real dependency on each other. Kept in the
// kernel alongside the other unused patterns — a genuine pipeline, where stage N needs stage N-1's
// output, is still a shape this platform will want — but nothing in the tree exercises it today, so
// treat it as untested when you next reach for it.
async function runSequential(stages, deps, opts = {}) {
  const d = dep(deps);
  const ctx = { params: opts.params || {}, outputs: {} };
  const done = [];
  for (let i = 0; i < (stages || []).length; i++) {
    const stage = stages[i];
    const task = typeof stage.buildTask === 'function' ? stage.buildTask(ctx)
      : (stage.task || `Carry out this step: ${stage.skill || stage.id}.`);
    if (opts.onStage) { try { opts.onStage(stage, i, 'running', null); } catch {} }
    const r = await call(d, stage.agent, task, stage.agentOpts);
    const out = { id: stage.id, agent: stage.agent, ok: !!r.ok, content: text(r), model: r.model, error: r.error };
    ctx.outputs[stage.id || `stage${i}`] = out.content;
    done.push(out);
    if (opts.onStage) { try { opts.onStage(stage, i, r.ok ? 'completed' : 'failed', out); } catch {} }
    if (!r.ok && opts.stopOnError) return { ok: false, outputs: done, ctx, failedAt: i };
  }
  return { ok: done.every((o) => o.ok), outputs: done, ctx };
}

module.exports = {
  classifyAndAct, fanOutAndSynthesize, adversarialVerify, generateAndFilter, tournament, loopUntilDone, runSequential,
};
