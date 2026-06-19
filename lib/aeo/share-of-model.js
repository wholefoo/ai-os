// lib/aeo/share-of-model.js
// ============================================================
//  "Share of Model" — the flagship AEO metric for 2026: instead of search rankings, measure
//  whether the AI ANSWER ENGINES (Claude, Perplexity, Gemini, GPT, Grok) actually mention/cite
//  a brand when asked buyer-intent questions, and who gets named instead. Built on the
//  multi-model consensus engine (lib/multiModel.js): ask every engine the same prompt in
//  parallel, then deterministically scan each answer for the brand vs. its competitors.
//
//  Deterministic scan = no second LLM pass over the (untrusted) answers, so there is no
//  prompt-injection surface here. Caller functions are INJECTED so this stays unit-testable.
// ============================================================

const { callConsensus } = require('../multiModel');

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-word, case-insensitive presence of `term` in `text` (falls back to substring).
function mentions(text, term) {
  const t = String(term || '').trim();
  if (!t) return false;
  try { return new RegExp('\\b' + escapeRe(t) + '\\b', 'i').test(String(text || '')); }
  catch { return String(text || '').toLowerCase().includes(t.toLowerCase()); }
}

/**
 * Run Share-of-Model across N buyer-intent prompts.
 * @param {object} o
 * @param {Array<{name:string, call:Function}>} o.callers  injected provider callers
 * @param {string[]} o.prompts        buyer-intent questions
 * @param {string[]} o.brandTerms     brand name (+ domain root) to count as a "mention"
 * @param {string[]} [o.competitors]  competitor names to tally
 * @param {string}  [o.system]
 * @returns {Promise<{citationShare, byEngine, byPrompt, competitors, cells, brandCells, errors}>}
 */
async function runShareOfModel({ callers, prompts, brandTerms, competitors = [], system = '', timeoutMs = 30000 }) {
  const engineNames = callers.map((c) => c.name);
  const engineHits = Object.fromEntries(engineNames.map((n) => [n, { mentioned: 0, of: 0 }]));
  const compHits = Object.fromEntries(competitors.map((c) => [c, 0]));
  const byPrompt = [];
  const errors = {};
  let cells = 0, brandCells = 0;

  for (const prompt of prompts) {
    const { responses, errors: errs } = await callConsensus(callers, prompt, system, { timeoutMs });
    Object.assign(errors, errs);
    const engines = {};
    for (const name of engineNames) {
      const answer = responses[name];
      if (answer == null) { engines[name] = null; continue; } // engine errored / no response
      const hit = brandTerms.some((bt) => mentions(answer, bt));
      engines[name] = hit;
      engineHits[name].of += 1; cells += 1;
      if (hit) { engineHits[name].mentioned += 1; brandCells += 1; }
      for (const comp of competitors) if (mentions(answer, comp)) compHits[comp] += 1;
    }
    byPrompt.push({ prompt, engines, brandMentions: Object.values(engines).filter((v) => v === true).length });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const byEngine = Object.fromEntries(engineNames.map((n) => [n, {
    ...engineHits[n], rate: engineHits[n].of ? round2(engineHits[n].mentioned / engineHits[n].of) : 0,
  }]));
  const competitorsRanked = Object.entries(compHits)
    .map(([name, m]) => ({ name, mentions: m })).sort((a, b) => b.mentions - a.mentions);

  return {
    citationShare: cells ? round2(brandCells / cells) : 0,
    byEngine, byPrompt, competitors: competitorsRanked, cells, brandCells, errors,
  };
}

module.exports = { runShareOfModel, mentions };
