// lib/knowledge-context.js
// ============================================================
//  G5 of .magent/vault/wiki/graph-engineering-eval.md — the source document's "ultimate synergy":
//  an agent that knows how work moves (the agent graph) AND how the business's facts relate (the
//  knowledge graph). AI OS had the second one feeding a radial diagram in the dashboard and nothing
//  else: **no agent dispatch read it.**
//
//  ── RELATIONSHIPS, NOT CONTENT. This is the load-bearing decision. ──
//  This module renders node labels, tags, categories and CONNECTIONS. It does NOT paste node
//  excerpts into a prompt. Two reasons, and the second is a security one:
//
//    1. Faithfulness. The document's own distinction is that a knowledge graph answers "how does
//       this connect", while retrieving the closest matching paragraph is ordinary RAG. Pasting
//       excerpts would build the RAG, not the graph.
//    2. `vault/raw/` is defined in this repo as "unprocessed intake: meeting notes, WEB CLIPPINGS,
//       data dumps". Injecting those excerpts into every agent's system prompt would be a
//       prompt-injection vector wearing a helpful hat — operator-adjacent text that the model has
//       been told is context. A label and a tag list cannot carry an instruction; a clipped web page
//       can. If excerpts are ever wanted here, they must go through executeAgent's `untrusted`
//       fence, not through `context`.
//
//  ── AND IT SAYS WHEN IT IS PARTIAL. ──
//  The graph is built by a MANUAL admin action (POST /api/knowledge-graph/auto-categorize), so it
//  lags the vault by however long since anyone pressed it — on 2026-08-04 it was missing 5 of 9 wiki
//  files including two design docs written that day. A map that silently omits half the territory is
//  worse than no map, so `renderContext` states the coverage it actually has.
//
//  Pure: selection and rendering. The caller supplies the graph and decides whether to use it.
// ============================================================

'use strict';

// Words that carry no topical signal here. The last group is pipeline scaffolding: every stage task
// this platform builds contains "stage", "pipeline" and "produce", so leaving them in would score
// every node against every task.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was',
  'produce', 'stage', 'pipeline', 'task', 'write', 'create', 'make', 'using', 'about', 'deliverable',
  'objective', 'directly', 'concisely', 'inputs', 'earlier', 'stages', 'build', 'these']);

/** Content words from a task, lowercased and de-duplicated. */
function keywords(task) {
  return [...new Set(String(task || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])]
    .filter((w) => !STOP.has(w));
}

/**
 * Score one node against a task's keywords.
 *
 * Tags are worth more than the label, and the label more than the id, because a tag was assigned by
 * the categorising agent as a topical claim about the file while the id is just its path.
 */
function scoreNode(node, words) {
  if (!node) return 0;
  const tags = (node.tags || []).map((t) => String(t).toLowerCase());
  const label = String(node.label || '').toLowerCase();
  const id = String(node.id || '').toLowerCase();
  let score = 0;
  for (const w of words) {
    if (tags.some((t) => t === w)) score += 3;
    else if (tags.some((t) => t.includes(w) || w.includes(t))) score += 2;
    if (label.includes(w)) score += 2;
    if (id.includes(w)) score += 1;
  }
  return score;
}

/**
 * Nodes relevant to a task, plus one hop along their connections.
 *
 * The hop is what makes this a graph lookup rather than a search: a node that does not match the
 * task at all is still worth naming when something that DOES match points at it. Hop results are
 * marked so the prompt can distinguish "this matched" from "this is connected to a match".
 *
 * @returns {{direct: object[], related: object[]}}
 */
function selectRelevant(graph, task, opts = {}) {
  const limit = Math.max(1, opts.limit || 5);
  const nodes = (graph && graph.nodes) || [];
  const words = keywords(task);
  if (!nodes.length || !words.length) return { direct: [], related: [] };

  const scored = nodes.map((n) => ({ node: n, score: scoreNode(n, words) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));

  const direct = scored.slice(0, limit).map((x) => x.node);
  const directIds = new Set(direct.map((n) => n.id));

  const relatedIds = new Set();
  for (const n of direct) for (const c of (n.connections || [])) if (!directIds.has(c)) relatedIds.add(c);
  const related = nodes.filter((n) => relatedIds.has(n.id)).slice(0, Math.max(0, opts.relatedLimit || 5));

  return { direct, related };
}

/** How much of the vault the graph actually covers. */
function coverage(graph, sourceCount) {
  const have = ((graph && graph.nodes) || []).length;
  const total = Number.isFinite(sourceCount) ? sourceCount : null;
  return { nodes: have, sources: total, missing: total === null ? null : Math.max(0, total - have) };
}

const line = (n, mark) => `- ${mark}${n.label || n.id} [${n.id}]${(n.tags || []).length ? ` — tags: ${(n.tags || []).join(', ')}` : ''}`;

/**
 * Render the block that goes into executeAgent's `context`.
 *
 * Returns '' when nothing is relevant — an empty section is worse than none, because it reads as
 * "the graph has nothing on this" when it may simply not have been asked the right way.
 */
function renderContext(selection, opts = {}) {
  const direct = (selection && selection.direct) || [];
  const related = (selection && selection.related) || [];
  if (!direct.length) return '';

  const cov = opts.coverage;
  const parts = ['--- Related knowledge (graph) ---',
    'Entries the knowledge graph holds on this topic, and what they connect to. These are POINTERS,',
    'not content: read the file if you need what it says. Nothing here is a fact about the world —',
    'it is a map of what this business has written down.',
    '',
    ...direct.map((n) => line(n, '')),
  ];
  if (related.length) {
    parts.push('', 'Connected to the above (one hop):', ...related.map((n) => line(n, '→ ')));
  }
  if (cov && cov.missing) {
    parts.push('', `NOTE: this graph covers ${cov.nodes} of ${cov.sources} known sources — ${cov.missing} are not indexed yet, so treat it as partial. It is rebuilt by a manual admin action, not automatically.`);
  }
  return parts.join('\n');
}

/** One call: graph + task -> a context block (or '' if nothing relevant). */
function contextFor(graph, task, opts = {}) {
  return renderContext(selectRelevant(graph, task, opts), opts);
}

module.exports = { keywords, scoreNode, selectRelevant, coverage, renderContext, contextFor };
