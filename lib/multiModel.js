// lib/multiModel.js
// ============================================================
//  Multi-Model Consensus Engine. Query N model providers in parallel and reduce their
//  answers to a consensus (average / min / max / variance / agreement). The reusable AEO
//  primitive behind "Share of Model" and the AEO analyzer: ask every engine the same
//  thing, then measure how much they agree.
//
//  Decoupled by design — callers are INJECTED as [{ name, call: async (prompt, system) => text }]
//  so server.js wires its real provider functions (callAnthropic / callChatCompletions for
//  grok/deepseek/openai/perplexity / gemini) and this stays unit-testable with mocks. Ported
//  from aiserp's multi_model_analyzer.py (call_consensus / extract_score_consensus); the
//  `variance <= 15 => high agreement` heuristic is kept.
// ============================================================

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Query all callers in parallel. Never rejects.
 * @returns {Promise<{responses:Object, errors:Object, succeeded:string[], failed:string[]}>}
 */
async function callConsensus(callers, prompt, system = '', { timeoutMs = 30000 } = {}) {
  const settled = await Promise.allSettled((callers || []).map((c) =>
    withTimeout(Promise.resolve().then(() => c.call(prompt, system)), timeoutMs).then((text) => ({ name: c.name, text }))));
  const responses = {}, errors = {};
  settled.forEach((s, i) => {
    const name = (callers[i] && callers[i].name) || `provider${i}`;
    if (s.status === 'fulfilled' && s.value && s.value.text != null && String(s.value.text).trim()) responses[name] = String(s.value.text);
    else errors[name] = (s.status === 'rejected' && s.reason && s.reason.message) || 'no response';
  });
  return { responses, errors, succeeded: Object.keys(responses), failed: Object.keys(errors) };
}

// Pull a numeric score from a model reply: prefer JSON {score:N}, else first number.
function extractScore(text, key = 'score') {
  if (text == null) return null;
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { const j = JSON.parse(s.slice(a, b + 1)); if (j[key] != null && !isNaN(Number(j[key]))) return Number(j[key]); } catch { /* fall through */ }
  }
  const m = s.match(/-?\d{1,3}(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Query all callers for a numeric score and compute consensus.
 * @returns {Promise<{scores, average, min, max, variance, highAgreement, responses, errors, succeeded, failed}>}
 */
async function scoreConsensus(callers, prompt, system = '', { key = 'score', timeoutMs = 30000 } = {}) {
  const base = await callConsensus(callers, prompt, system, { timeoutMs });
  const scores = {};
  for (const [name, text] of Object.entries(base.responses)) {
    const v = extractScore(text, key);
    if (v != null) scores[name] = v;
  }
  const vals = Object.values(scores);
  const stats = vals.length
    ? { average: round1(vals.reduce((a, b) => a + b, 0) / vals.length), min: Math.min(...vals), max: Math.max(...vals), variance: round1(Math.max(...vals) - Math.min(...vals)), highAgreement: (Math.max(...vals) - Math.min(...vals)) <= 15 }
    : { average: 0, min: 0, max: 0, variance: 0, highAgreement: false };
  return { scores, ...stats, ...base };
}

module.exports = { callConsensus, scoreConsensus, extractScore };
