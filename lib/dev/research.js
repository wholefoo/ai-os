// lib/dev/research.js
// ============================================================
//  The RESEARCH facet's provider call (dev-platform P1). Fetches any operator-supplied URLs (SSRF-safe,
//  size- and time-capped) and asks a grounded web model for a short brief the planner will read.
//
//  The platform functions are INJECTED by server.js — executeAgent (which enforces the hard budget
//  cap, records the cost and fences untrusted text) and safeFetch — so this is testable without the
//  server and cannot spend outside the budget path. Fetched pages are passed as UNTRUSTED data, never
//  as instructions; the planner then sees the brief fenced as reference material (engine.js).
// ============================================================

const { htmlToText } = require('../web-studio/sanitize-html');

const MAX_URLS = 3;
const PAGE_BYTES = 400000;
const PAGE_CHARS = 8000;

const SYSTEM = 'You are a research assistant preparing a brief for an engineer who will plan a code change in the AI OS repository (Node.js/Express). Research the goal using current, authoritative sources. Reply in concise markdown: the key facts, relevant APIs/versions/pitfalls, and a "Sources" list with URLs. Do not write the plan or any code. Say plainly when something is uncertain or disputed.';

function createResearcher({ executeAgent, safeFetch, agent = 'consultant-perplexity', maxTokens = 3000 }) {
  if (typeof executeAgent !== 'function' || typeof safeFetch !== 'function') throw new Error('createResearcher: executeAgent and safeFetch are required');
  return async function research(m) {
    const pages = [];
    for (const u of (m.research_urls || []).slice(0, MAX_URLS)) {
      try { pages.push(`SOURCE: ${u}\n${htmlToText(await safeFetch(u, { maxBytes: PAGE_BYTES, timeoutMs: 15000 })).slice(0, PAGE_CHARS)}`); }
      catch (e) { pages.push(`SOURCE: ${u}\n(fetch failed: ${e && e.message})`); }
    }
    const task = `GOAL OF THE CHANGE:\n${m.goal}${m.research_query ? `\n\nSPECIFIC RESEARCH QUESTION:\n${m.research_query}` : ''}`;
    const r = await executeAgent(agent, task, {
      systemOverride: SYSTEM, skill: 'dev-research', maxTokens,
      untrusted: pages.length ? { label: 'operator-supplied pages', text: pages.join('\n\n') } : undefined,
    });
    return { ok: Boolean(r && r.ok), content: r && r.content, cost: r && r.cost, budgetExceeded: Boolean(r && r.budgetExceeded), error: r && r.error };
  };
}

module.exports = { createResearcher };
