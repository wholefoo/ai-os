// lib/reasoning/tot.js
// ============================================================
//  TREE OF THOUGHTS — BRANCHING, STATE SCORING, AND EXPLICIT BACKTRACKING.
//
//  Spec §4. After Yao et al. 2023, "Tree of Thoughts: Deliberate Problem Solving with Large
//  Language Models". Chain-of-Thought commits to one path and cannot un-commit; ToT treats the
//  partial reasoning state as a node in a search space, so a path that turns out badly is a branch
//  to abandon rather than a mistake to rationalise forward from.
//
//  ── WHAT MAKES THIS A SEARCH AND NOT A DRESSED-UP BEST-OF-N ──
//  Backtracking. If a DFS descent hits a node scoring below `backtrackThreshold`, the engine does
//  NOT expand it: it pops back to the highest-scoring UNEXPANDED node it has seen and continues
//  from there. `result.backtracks` counts those events, and the test suite asserts it is greater
//  than zero on a tree rigged to have a dead end — because a "search" that never backtracks is
//  best-first with extra vocabulary, and it would pass any test that only checked the final answer.
//
//  ── SCORING: `value` vs `vote` ──
//    value (default) — one call per candidate, absolute score in [0,1]. Costs b calls per level.
//    vote            — ONE call ranking all siblings. Costs 1 call per level, but yields only a
//                      RELATIVE ordering. Backtracking needs an absolute floor to compare against,
//                      so under `vote` the threshold is applied to a rank-derived score, which is a
//                      weaker signal. Default to `value`; reach for `vote` when breadth is wide and
//                      the budget is tight, and know what you traded.
//
//  Every node's `cumulative` is the MEAN score along its path (see models.js) — a sum would reward
//  depth for its own sake and the frontier would drift toward long mediocre chains.
// ============================================================

'use strict';

const { guardedCall, deps: normDeps, createBudget } = require('./budget');
const M = require('./models');

const DEFAULT_BREADTH = 3;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_BACKTRACK_THRESHOLD = 0.4;
const DEFAULT_SOLVED_SCORE = 0.85;

/** Split a proposal reply into up to `k` distinct candidate thoughts. */
function parseThoughts(text, k) {
  // models.parseList is shared with steps.parseSteps — one definition of "what counts as a list
  // item", so the tolerance widened by the 2026-09-02 live check applies to both engines at once.
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const out = M.parseList(raw, k);
  if (!out.length && raw.trim()) out.push(raw.trim().slice(0, 2000));
  // Drop near-duplicates: b identical branches is a branching factor of 1 wearing a costume.
  const seen = new Set();
  const uniq = [];
  for (const t of out) {
    const key = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  return uniq.slice(0, k);
}

/** Parse a value-scorer reply: a 0-1 (or 0-100) score, plus an optional solved/dead-end marker. */
function parseScore(text) {
  const t = String(text || '');
  const m = t.match(/SCORE\s*:\s*([0-9]*\.?[0-9]+)/i) || t.match(/([0-9]*\.?[0-9]+)/);
  let score = 0;
  if (m) { const n = parseFloat(m[1]); if (Number.isFinite(n)) score = n > 1 ? n / 100 : n; }
  const solved = /\b(SOLVED|COMPLETE|TERMINAL)\b/i.test(t);
  const dead = /\b(DEAD.?END|IMPOSSIBLE|CONTRADICT)/i.test(t);
  return { score: M.clamp01(dead ? Math.min(score, 0.15) : score), solved, dead, note: (t.split('\n')[0] || '').slice(0, 200) };
}

/** Generate `breadth` candidate next-thoughts from a node's path. */
async function proposeThoughts(task, pathText, d, budget, opts) {
  const k = Math.max(2, opts.breadth || DEFAULT_BREADTH);
  const prompt = [
    `Propose exactly ${k} DIFFERENT next steps in the reasoning. They must be genuinely distinct`,
    'approaches, not rephrasings of one another. One per line, numbered. No commentary.',
    `\nTASK:\n${task}`,
    pathText ? `\nREASONING SO FAR:\n${pathText}` : '\n(Nothing has been reasoned yet — propose opening moves.)',
  ].join('\n');
  // No ceiling here on purpose: lib/reasoning/budget.js enforces MIN_OUTPUT_TOKENS (executeAgent's
  // own default) on every call, and a per-site number below it was a decorative lie about what the
  // call would do. Callers may still pass a LARGER value through opts.
  const r = await guardedCall(d, budget, opts.proposer || 'architect', prompt, { maxTokens: opts.proposeTokens });
  if (!r.ok) return { ok: false, thoughts: [], error: r.error, budgetExhausted: !!r.budgetExhausted };
  return { ok: true, thoughts: parseThoughts(r.content, k) };
}

/** Score one candidate absolutely (`value` strategy). One call. */
async function scoreThought(task, pathText, thought, d, budget, opts) {
  const prompt = [
    'Score how promising this next reasoning step is for solving the task. Judge the STEP, not the',
    'whole solution.',
    '',
    'Reply in exactly this shape:',
    'SCORE: <0-1>',
    'NOTE: <one short sentence>',
    '',
    'Append the word SOLVED on the SCORE line only if this step completes the task.',
    'Append DEAD-END if this path cannot lead anywhere and should be abandoned.',
    `\nTASK:\n${task}`,
    pathText ? `\nREASONING SO FAR:\n${pathText}` : '',
    `\nCANDIDATE NEXT STEP:\n${thought}`,
  ].join('\n');
  // Ceiling comes from the budget.js floor — see proposeThoughts.
  const r = await guardedCall(d, budget, opts.scorer || 'reviewer', prompt, { maxTokens: opts.scoreTokens });
  if (!r.ok) return { score: 0, solved: false, dead: false, note: `scorer unavailable: ${r.error}`, failed: true, budgetExhausted: !!r.budgetExhausted };
  return parseScore(r.content);
}

/** Rank all siblings in ONE call (`vote` strategy), converting rank position into a score. */
async function voteThoughts(task, pathText, thoughts, d, budget, opts) {
  const menu = thoughts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
  const prompt = [
    `Rank these ${thoughts.length} candidate next steps from best to worst for solving the task.`,
    'Reply with ONLY the numbers in order, best first, comma-separated. Example: 3,1,2',
    `\nTASK:\n${task}`,
    pathText ? `\nREASONING SO FAR:\n${pathText}` : '',
    `\nCANDIDATES:\n${menu}`,
  ].join('\n');
  // This site once handed an xhigh reviewer 200 tokens — a ceiling it could never answer within,
  // found by sweeping call sites rather than by failing. The budget.js floor now makes that impossible.
  const r = await guardedCall(d, budget, opts.scorer || 'reviewer', prompt, {});
  if (!r.ok) return thoughts.map(() => ({ score: 0, solved: false, dead: false, note: `vote unavailable: ${r.error}`, failed: true }));

  const order = (String(r.content).match(/\d+/g) || []).map((n) => parseInt(n, 10) - 1).filter((i) => i >= 0 && i < thoughts.length);
  const seen = new Set();
  const ranked = order.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
  for (let i = 0; i < thoughts.length; i++) if (!seen.has(i)) ranked.push(i);   // unranked go last

  const scores = new Array(thoughts.length).fill(0);
  ranked.forEach((idx, pos) => {
    // Linear decay from 0.9 (best) toward 0.2 (worst) — an absolute-ish floor so the backtrack
    // threshold still means something, while being honest that this is derived from a ranking.
    // Rounded for the same reason makeNode rounds its running mean: these scores are compared
    // against the backtrack threshold, and 0.20000000000000007 is noise in a number that decides
    // whether a branch lives.
    scores[idx] = thoughts.length === 1 ? 0.9 : M.clamp01(Math.round((0.9 - (0.7 * pos) / (thoughts.length - 1)) * 1e6) / 1e6);
  });
  return scores.map((s) => ({ score: s, solved: false, dead: false, note: 'ranked' }));
}

/**
 * Search the thought tree.
 *
 * @param {object} opts
 *  - strategy: 'bfs' | 'dfs'         (default 'bfs')
 *  - breadth, maxDepth, beam         (beam applies to BFS: how many nodes survive each level)
 *  - backtrackThreshold              DFS: score below which a node is abandoned unexpanded
 *  - solvedScore                     score at/above which a node is treated as a solution
 *  - scoring: 'value' | 'vote'
 *  - isTerminal(node)                optional external solution check (a rule, a test run)
 *
 * @returns {Promise<{ok, best, path, pathText, nodes, expanded, backtracks, solved, budget}>}
 */
async function search(task, depsIn, opts = {}) {
  const d = normDeps(depsIn);
  const budget = opts.budget || createBudget({ maxCalls: opts.maxCalls || 30 });
  const strategy = opts.strategy === 'dfs' ? 'dfs' : 'bfs';
  const breadth = Math.max(2, Math.min(opts.breadth || DEFAULT_BREADTH, 5));
  const maxDepth = Math.max(1, Math.min(opts.maxDepth || DEFAULT_MAX_DEPTH, 5));
  const beam = Math.max(1, opts.beam || 2);
  const threshold = opts.backtrackThreshold == null ? DEFAULT_BACKTRACK_THRESHOLD : M.clamp01(opts.backtrackThreshold);
  const solvedScore = opts.solvedScore == null ? DEFAULT_SOLVED_SCORE : M.clamp01(opts.solvedScore);

  const byId = new Map();
  const root = M.makeNode({ id: 'root', thought: '', depth: 0, score: 0.5 });
  byId.set(root.id, root);

  const all = [];
  let expanded = 0;
  let backtracks = 0;
  let solvedNode = null;
  let seq = 0;

  const pathTextOf = (node) => M.pathTo(node, byId).filter((n) => n.thought)
    .map((n, i) => `${i + 1}. ${n.thought}`).join('\n');

  /** Expand one node into scored children. Returns [] when it cannot (budget, proposer failure). */
  async function expand(node) {
    const pathText = pathTextOf(node);
    const prop = await proposeThoughts(task, pathText, d, budget, opts);
    if (!prop.ok || !prop.thoughts.length) return [];
    expanded += 1;

    const evals = opts.scoring === 'vote'
      ? await voteThoughts(task, pathText, prop.thoughts, d, budget, opts)
      : await Promise.all(prop.thoughts.map((t) => scoreThought(task, pathText, t, d, budget, opts)));

    const kids = prop.thoughts.map((thought, i) => {
      const e = evals[i] || { score: 0 };
      const child = M.makeNode({
        id: `n${++seq}`, parentId: node.id, thought, depth: node.depth + 1,
        score: e.score, parentCumulative: node.cumulative,
        terminal: !!e.solved || e.score >= solvedScore,
        state: { note: e.note || '', dead: !!e.dead },
      });
      byId.set(child.id, child);
      node.children.push(child.id);
      all.push(child);
      d.broadcast({ type: 'reasoning.thought', id: child.id, depth: child.depth, score: child.score });
      return child;
    });
    return kids;
  }

  /** External terminal check (a rule, a compile, a test) — beats any model's opinion when supplied. */
  async function checkTerminal(node) {
    if (typeof opts.isTerminal !== 'function') return node.terminal;
    try { return !!(await opts.isTerminal(node, { task, pathText: pathTextOf(node) })); }
    catch { return false; }
  }

  if (strategy === 'bfs') {
    let frontier = [root];
    for (let depth = 0; depth < maxDepth && !solvedNode; depth++) {
      const level = [];
      for (const node of frontier) {
        if (budget.exhausted()) break;
        const kids = await expand(node);
        level.push(...kids);
      }
      if (!level.length) break;

      for (const k of level) {
        if (await checkTerminal(k)) { solvedNode = k; break; }
      }
      if (solvedNode) break;

      // Keep only the `beam` best by path-mean. Pruned branches are NOT deleted from `all` — a
      // caller inspecting the search wants to see what was considered and dropped, not a tidy lie.
      frontier = level.slice().sort((a, b) => b.cumulative - a.cumulative).slice(0, beam);
    }
  } else {
    // --- DFS with explicit backtracking ---
    const stack = [root];
    const visited = new Set();
    while (stack.length && !solvedNode) {
      if (budget.exhausted()) break;
      const node = stack.pop();
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      if (node.depth > 0 && node.score < threshold) {
        // Dead end. Do not expand. Backtrack to the best node we have seen and not yet opened.
        backtracks += 1;
        d.broadcast({ type: 'reasoning.backtrack', from: node.id, score: node.score });
        const candidates = all.filter((n) => !visited.has(n.id) && n.score >= threshold && n.depth < maxDepth);
        if (!candidates.length) continue;
        candidates.sort((a, b) => b.cumulative - a.cumulative);
        stack.push(candidates[0]);
        continue;
      }
      if (node.depth >= maxDepth) continue;

      const kids = await expand(node);
      if (!kids.length) continue;

      for (const k of kids) {
        if (await checkTerminal(k)) { solvedNode = k; break; }
      }
      if (solvedNode) break;

      // Push worst-first so the BEST child is popped next — depth-first through the good branch.
      kids.slice().sort((a, b) => a.score - b.score).forEach((k) => stack.push(k));
    }
  }

  // No terminal node? Return the best leaf we actually reached. An exhausted search still has a
  // best-so-far, and discarding it because nothing crossed the line would waste every call spent.
  const best = solvedNode || all.slice().sort((a, b) =>
    (b.cumulative - a.cumulative) || (b.depth - a.depth))[0] || root;

  const path = M.pathTo(best, byId).filter((n) => n.thought);

  return {
    ok: all.length > 0,
    solved: !!solvedNode,
    best,
    path,
    pathText: path.map((n, i) => `${i + 1}. ${n.thought}`).join('\n'),
    nodes: all,
    expanded,
    backtracks,
    strategy,
    budget: budget.snapshot(),
  };
}

// The DEFAULT_* bounds and the two single-node helpers (proposeThoughts, scoreThought) are
// implementation detail of search(); every one of them is exercised through it. Exporting them
// would widen the public surface to nothing that calls it.
module.exports = { parseThoughts, parseScore, voteThoughts, search };
