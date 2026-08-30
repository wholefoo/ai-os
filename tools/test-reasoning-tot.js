// Tree of Thoughts — lib/reasoning/tot.js.
//
// THE ONE THING THIS FILE MUST PROVE: that the search actually BACKTRACKS. A tree search that only
// ever descends into its best child is best-first with extra vocabulary, and it would pass any test
// that checked the final answer — the answer would often still be right. So the tree below is rigged
// with a DEAD END behind the most attractive opening move: a search that cannot backtrack finds
// nothing, and one that can finds the solution down a branch it had already passed over.
//
// `backtracks` is asserted to be EXACTLY 1, not merely > 0, and the same tree is re-run with the
// threshold at 0 to show the counter goes to 0 — a number that never varies is not a measurement,
// and this repo has shipped a guard before whose signal was a constant (see the mutation-testing
// note in tools/test-vhost-scheme-guard.js).

const { assert, done } = require('./test-util');
const tot = require('../lib/reasoning/tot');
const { createBudget } = require('../lib/reasoning/budget');

/**
 * A rigged, fully deterministic thought tree:
 *
 *                          root
 *          ┌────────────────┼────────────────┐
 *      approach A(.8)   approach B(.1)   approach C(.6)
 *        ┌────┴────┐                          │
 *   dead end(.05) dead end(.05)        the winning move(.95, SOLVED)
 *
 * A is the most attractive opening and leads nowhere. C is the answer. A depth-first search MUST
 * abandon A and come back to C.
 */
const SCORES = [
  [/the winning move/, 0.95, true],
  [/approach A/, 0.8, false],
  [/approach C/, 0.6, false],
  [/approach B/, 0.1, false],
  [/dead end/, 0.05, false],
];
const riggedTree = (seen = []) => ({
  runAgent: async (agent, task) => {
    seen.push({ agent, task });
    if (agent === 'architect') {
      if (/REASONING SO FAR/.test(task)) {
        if (/approach A/.test(task)) return { ok: true, content: '1. dead end one\n2. dead end two', model: 'mock', inputTokens: 10, outputTokens: 10 };
        if (/approach C/.test(task)) return { ok: true, content: '1. the winning move', model: 'mock', inputTokens: 10, outputTokens: 10 };
        return { ok: true, content: '1. dead end three', model: 'mock', inputTokens: 10, outputTokens: 10 };
      }
      return { ok: true, content: '1. approach A\n2. approach B\n3. approach C', model: 'mock', inputTokens: 10, outputTokens: 10 };
    }
    if (agent === 'reviewer') {
      const cand = (task.split('CANDIDATE NEXT STEP:')[1] || '').trim();
      const hit = SCORES.find(([re]) => re.test(cand));
      const [, score, solved] = hit || [null, 0.5, false];
      return { ok: true, content: `SCORE: ${score}${solved ? ' SOLVED' : ''}\nNOTE: mock`, model: 'mock', inputTokens: 10, outputTokens: 10 };
    }
    return { ok: false, error: `no mock for ${agent}` };
  },
  broadcast: () => {}, log: () => {},
});

(async () => {
  // =============================================================================================
  //  PARSING
  // =============================================================================================
  {
    assert(tot.parseThoughts('1. alpha\n2. beta\n3. gamma', 3).length === 3, 'three numbered thoughts parse as three');
    const dup = tot.parseThoughts('1. same idea\n2. Same   Idea\n3. different', 5);
    assert(dup.length === 2, `near-duplicate branches are collapsed (${JSON.stringify(dup)}) — b identical branches is a branching factor of 1 wearing a costume`);
    assert(tot.parseThoughts('1. a\n2. b\n3. c\n4. d', 2).length === 2, 'the breadth cap is honoured');

    assert(tot.parseScore('SCORE: 0.9').score === 0.9, 'a plain score parses');
    assert(tot.parseScore('SCORE: 90').score === 0.9, 'a 0-100 score is normalised');
    assert(tot.parseScore('SCORE: 0.9 SOLVED').solved === true, 'the SOLVED marker is read');
    assert(tot.parseScore('SCORE: 0.9 DEAD-END').score <= 0.15,
      'a DEAD-END marker CLAMPS the score down regardless of what number the model also wrote — otherwise a model could label a branch dead and still have it lead the frontier');
    assert(tot.parseScore('').score === 0, 'an empty scorer reply is 0, not a default pass');
  }

  // =============================================================================================
  //  DFS — the backtracking proof
  // =============================================================================================
  {
    const seen = [];
    const r = await tot.search('solve the puzzle', riggedTree(seen), {
      strategy: 'dfs', breadth: 3, maxDepth: 3, backtrackThreshold: 0.4, budget: createBudget({ maxCalls: 40 }),
    });

    assert(r.solved === true, 'the search found the solution');
    assert(/the winning move/.test(r.best.thought), `and the winning node is the answer (best = "${r.best.thought}")`);
    assert(r.backtracks === 1,
      `IT BACKTRACKED EXACTLY ONCE (got ${r.backtracks}). The most attractive opening move led to a dead end; without backtracking the search would have stalled there. This single assertion is the difference between a tree search and a best-first walk.`);

    const pathThoughts = r.path.map((n) => n.thought);
    assert(pathThoughts.includes('approach C') && !pathThoughts.includes('approach A'),
      `the winning PATH runs through the branch that was passed over first (${JSON.stringify(pathThoughts)}) — not through the attractive dead end`);
    assert(r.nodes.some((n) => /dead end/.test(n.thought)),
      'the abandoned nodes are STILL in `nodes` — a caller inspecting the search wants to see what was considered and dropped, not a tidy lie about a straight-line solve');
  }
  {
    // The counter must respond to conditions. With nothing below the threshold, nothing backtracks.
    const r = await tot.search('solve the puzzle', riggedTree(), {
      strategy: 'dfs', breadth: 3, maxDepth: 3, backtrackThreshold: 0, budget: createBudget({ maxCalls: 40 }),
    });
    assert(r.backtracks === 0,
      `with the threshold at 0 nothing is ever abandoned, so backtracks is 0 (got ${r.backtracks}) — proving the counter tracks a real event rather than being a constant that happens to read 1`);
  }

  // =============================================================================================
  //  BFS — level expansion and beam pruning
  // =============================================================================================
  {
    const r = await tot.search('solve the puzzle', riggedTree(), {
      strategy: 'bfs', breadth: 3, maxDepth: 2, beam: 2, budget: createBudget({ maxCalls: 40 }),
    });
    assert(r.strategy === 'bfs' && r.nodes.length >= 3, 'BFS expands the first level fully');
    assert(r.expanded >= 2, `it then expands the surviving beam (${r.expanded} expansions)`);
    assert(r.solved === true && /the winning move/.test(r.best.thought),
      'BFS also reaches the answer — C survives the beam because 0.6 beats B at 0.1');
    assert(r.backtracks === 0, 'BFS never backtracks by construction — it prunes instead, and reports 0 rather than borrowing a DFS number');
  }

  // =============================================================================================
  //  SCORING STRATEGIES — value vs vote, and what the cheaper one costs you
  // =============================================================================================
  {
    const seenValue = [];
    await tot.search('t', riggedTree(seenValue), { strategy: 'bfs', breadth: 3, maxDepth: 1, budget: createBudget({ maxCalls: 40 }) });
    const valueScorerCalls = seenValue.filter((s) => s.agent === 'reviewer').length;
    assert(valueScorerCalls === 3, `'value' scoring costs one call PER CANDIDATE (${valueScorerCalls} calls for breadth 3)`);

    const seenVote = [];
    await tot.search('t', {
      runAgent: async (agent, task) => {
        seenVote.push({ agent, task });
        if (agent === 'architect') return { ok: true, content: '1. approach A\n2. approach B\n3. approach C', model: 'm', inputTokens: 1, outputTokens: 1 };
        return { ok: true, content: '3,1,2', model: 'm', inputTokens: 1, outputTokens: 1 };
      }, broadcast: () => {}, log: () => {},
    }, { strategy: 'bfs', breadth: 3, maxDepth: 1, scoring: 'vote', budget: createBudget({ maxCalls: 40 }) });
    const voteScorerCalls = seenVote.filter((s) => s.agent === 'reviewer').length;
    assert(voteScorerCalls === 1,
      `'vote' scoring ranks all siblings in ONE call (${voteScorerCalls}) — a third of the cost at breadth 3, in exchange for a relative ordering instead of absolute scores`);
  }
  {
    const votes = await tot.voteThoughts('t', '', ['a', 'b', 'c'], { runAgent: async () => ({ ok: true, content: '2,3,1', inputTokens: 1, outputTokens: 1 }) }, createBudget({ maxCalls: 2 }), {});
    assert(votes[1].score > votes[2].score && votes[2].score > votes[0].score,
      `a "2,3,1" ranking scores b > c > a (${votes.map((v) => v.score).join(', ')})`);

    const partial = await tot.voteThoughts('t', '', ['a', 'b', 'c'], { runAgent: async () => ({ ok: true, content: '2', inputTokens: 1, outputTokens: 1 }) }, createBudget({ maxCalls: 2 }), {});
    assert(partial.every((v) => typeof v.score === 'number'),
      'a ranking that names only some candidates still scores every one of them — the unranked go last rather than becoming undefined');
  }

  // =============================================================================================
  //  DEGRADATION — an exhausted or broken search still returns its best work
  // =============================================================================================
  {
    const r = await tot.search('t', riggedTree(), { strategy: 'dfs', breadth: 3, maxDepth: 3, budget: createBudget({ maxCalls: 5 }) });
    assert(r.solved === false, 'a 5-call budget cannot reach the answer down this tree');
    assert(r.ok === true && r.best && r.best.thought,
      `but the search still returns its BEST-SO-FAR ("${r.best.thought}") rather than nothing — discarding it would waste every call already spent`);
    assert(r.budget.stoppedBy && /budget exhausted/.test(r.budget.stoppedBy), `and the result says why it stopped: "${r.budget.stoppedBy}"`);
  }
  {
    const r = await tot.search('t', { runAgent: async () => ({ ok: false, error: 'provider down' }), broadcast: () => {}, log: () => {} }, { budget: createBudget({ maxCalls: 5 }) });
    assert(r.ok === false && r.nodes.length === 0, 'a search where the proposer never answers reports ok:false with no nodes, rather than inventing a path');
  }
  {
    // An external terminal check beats the model's opinion about what counts as solved.
    let asked = 0;
    const r = await tot.search('t', riggedTree(), {
      strategy: 'bfs', breadth: 3, maxDepth: 2, budget: createBudget({ maxCalls: 40 }),
      isTerminal: async (node) => { asked++; return /approach B/.test(node.thought); },
    });
    assert(asked > 0 && r.solved === true && /approach B/.test(r.best.thought),
      `the injected isTerminal decided the answer (${r.best.thought}) even though the model scored that branch 0.1 — a rule, a compile or a passing test outranks any model's opinion about completion`);
  }
  {
    const r = await tot.search('t', riggedTree(), { strategy: 'dfs', maxDepth: 1, breadth: 3, budget: createBudget({ maxCalls: 40 }) });
    assert(r.nodes.every((n) => n.depth <= 1), `maxDepth is enforced — no node is deeper than 1 (deepest was ${Math.max(...r.nodes.map((n) => n.depth))})`);
  }

  done();
})();
