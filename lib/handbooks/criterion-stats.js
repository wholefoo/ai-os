// lib/handbooks/criterion-stats.js — which criteria actually fire, and which say the same thing.
//
// §9 item 14 of .magent/vault/wiki/agent-handbooks-design.md, answerable at last. P2 gave criteria
// ids derived from their TEXT so they survive between runs; this is what those ids were for.
//
// Two questions, and they have opposite remedies:
//
//   NEVER FAILS   a criterion nothing has ever failed is either universally true or ungradeable.
//                 Either way it costs a model call per run and changes no decision. Delete it.
//   REDUNDANT     two criteria that co-occur and always land on the same verdict are one standard
//                 stated twice. Keep the more specific wording, delete the other.
//
// The second is what a live P5 run surfaced. One outcome graded these three, all `partial`:
//   - "Every citation is a real, resolvable URL fetched in THIS session."   (researcher handbook)
//   - "Claims are supported by evidence or labeled as assumptions"          (floor rubric)
//   - "Every claim cites a source retrieved in this run."                   (operator's own)
// Three model calls, three ways of asking one question.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS REFUSES TO CONCLUDE ANYTHING EARLY
//
// With one observation every pair of criteria correlates perfectly, and "never failed" is true of
// everything that has only ever been graded once. A redundancy report built from thin data would
// confidently recommend deleting criteria that had simply not been tested yet — and deleting a
// standard is not reversible by re-running. So every claim here carries a minimum sample and the
// module reports `undecided` below it rather than guessing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Pure: counters and arithmetic. No I/O — the caller owns persistence.

'use strict';

/** Runs a criterion must appear in before "it never fails" means anything. */
const MIN_RUNS_TO_JUDGE = 8;

/** Runs a PAIR must co-occur in before agreement means anything. */
const MIN_COOCCURRENCE = 5;

/** Agreement rate at or above which a pair is called redundant. */
const REDUNDANCY_THRESHOLD = 0.9;

/** Cap on tracked criteria, so a long-lived instance cannot grow this file without bound. */
const MAX_TRACKED = 400;

const STATUSES = Object.freeze(['pass', 'partial', 'fail']);

function emptyStore() {
  return { version: 1, runs: 0, criteria: {}, pairs: {} };
}

/** Stable key for an unordered pair. */
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Fold one completed verification into the store.
 *
 * @param {object} store    previous store (or null)
 * @param {object[]} results  the report's per-check results: {id, description, source, status}
 * @param {object} meta     {agent, skillName}
 * @returns {object} the updated store — a NEW object, so a caller can persist it atomically
 */
function record(store, results, meta = {}) {
  const s = store && store.criteria ? { ...store, criteria: { ...store.criteria }, pairs: { ...store.pairs } } : emptyStore();
  const graded = (results || []).filter((r) => r && r.id && STATUSES.includes(r.status));
  if (!graded.length) return s;

  s.runs += 1;

  for (const r of graded) {
    // Copy the entry, never mutate it in place. Shallow-copying the `criteria` map alone left every
    // entry a shared reference, so the caller's store advanced even when the save that follows this
    // failed — the tally and the file on disk would then disagree, silently and permanently.
    const existing = s.criteria[r.id];
    const prev = existing ? { ...existing, agents: [...existing.agents] } : {
      id: r.id,
      // Kept so a report can show WHAT to delete. Truncated: this file is read by a person, and the
      // full text already lives in the handbook that owns it.
      text: String(r.description || r.name || '').slice(0, 200),
      source: r.source || 'rubric',
      runs: 0, pass: 0, partial: 0, fail: 0,
      agents: [],
      lastSeen: null,
    };
    prev.runs += 1;
    prev[r.status] += 1;
    prev.lastSeen = meta.at || new Date().toISOString();
    if (meta.agent && !prev.agents.includes(meta.agent) && prev.agents.length < 12) prev.agents.push(meta.agent);
    s.criteria[r.id] = prev;
  }

  // Pairwise agreement, for the redundancy signal. Only within THIS run — two criteria that never
  // appear together cannot be compared, and pretending otherwise would compare unrelated verdicts.
  for (let i = 0; i < graded.length; i++) {
    for (let j = i + 1; j < graded.length; j++) {
      const k = pairKey(graded[i].id, graded[j].id);
      const was = s.pairs[k];
      const p = was ? { ...was } : { together: 0, agreed: 0 };   // copied, for the reason above
      p.together += 1;
      if (graded[i].status === graded[j].status) p.agreed += 1;
      s.pairs[k] = p;
    }
  }

  return prune(s);
}

/** Keep the store bounded: drop the least-seen criteria and any pair referencing a dropped one. */
function prune(store) {
  const ids = Object.keys(store.criteria);
  if (ids.length <= MAX_TRACKED) return store;
  const keep = new Set(ids
    .sort((a, b) => store.criteria[b].runs - store.criteria[a].runs || (store.criteria[b].lastSeen || '').localeCompare(store.criteria[a].lastSeen || ''))
    .slice(0, MAX_TRACKED));
  const criteria = {};
  for (const id of keep) criteria[id] = store.criteria[id];
  const pairs = {};
  for (const [k, v] of Object.entries(store.pairs)) {
    const [a, b] = k.split('|');
    if (keep.has(a) && keep.has(b)) pairs[k] = v;
  }
  return { ...store, criteria, pairs };
}

/**
 * What the data supports — and explicitly what it does not yet.
 *
 * @returns {{runs, tracked, neverFails, redundant, undecided}}
 */
function summarizeCriteria(store) {
  const s = store && store.criteria ? store : emptyStore();
  const all = Object.values(s.criteria);

  const neverFails = all
    .filter((c) => c.runs >= MIN_RUNS_TO_JUDGE && c.fail === 0 && c.partial === 0)
    .map((c) => ({ id: c.id, text: c.text, source: c.source, runs: c.runs, agents: c.agents }))
    .sort((a, b) => b.runs - a.runs);

  const redundant = [];
  for (const [k, p] of Object.entries(s.pairs)) {
    if (p.together < MIN_COOCCURRENCE) continue;
    const rate = p.agreed / p.together;
    if (rate < REDUNDANCY_THRESHOLD) continue;
    const [a, b] = k.split('|');
    const ca = s.criteria[a]; const cb = s.criteria[b];
    if (!ca || !cb) continue;
    redundant.push({
      a: { id: ca.id, text: ca.text, source: ca.source },
      b: { id: cb.id, text: cb.text, source: cb.source },
      together: p.together,
      agreementRate: Math.round(rate * 100) / 100,
    });
  }
  redundant.sort((x, y) => y.agreementRate - x.agreementRate || y.together - x.together);

  // Named explicitly rather than left as an absence. "No redundancy found" and "not enough runs to
  // look" are different answers, and only one of them is a reason to stop worrying about it.
  const undecided = all.filter((c) => c.runs < MIN_RUNS_TO_JUDGE).length;

  return {
    runs: s.runs,
    tracked: all.length,
    neverFails,
    redundant,
    undecided,
    thresholds: { minRunsToJudge: MIN_RUNS_TO_JUDGE, minCooccurrence: MIN_COOCCURRENCE, redundancyThreshold: REDUNDANCY_THRESHOLD },
    // A plain sentence, because a report nobody can read gets ignored and the criteria rot anyway.
    readiness: s.runs < MIN_RUNS_TO_JUDGE
      ? `Only ${s.runs} verification run(s) recorded — need ${MIN_RUNS_TO_JUDGE} before any criterion can be called dead or redundant.`
      : `${s.runs} runs recorded; ${undecided} criteria still below the ${MIN_RUNS_TO_JUDGE}-run bar.`,
  };
}

module.exports = {
  MIN_RUNS_TO_JUDGE, MIN_COOCCURRENCE, REDUNDANCY_THRESHOLD, MAX_TRACKED,
  emptyStore, record, summarizeCriteria,
};
