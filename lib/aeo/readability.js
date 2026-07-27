// lib/aeo/readability.js
// ============================================================
//  AEO Readiness Score — a DETERMINISTIC 0-100 measure of how well an AI answer engine
//  (ChatGPT / Perplexity / Google AI Overviews / Claude) can parse, understand, and CITE
//  a page. No LLM calls, so it's free + instant + safe on the public free-audit path.
//  Ported from aiserp's analyzer.py:58 (calculate_llm_readability), re-implemented over a
//  regex HTML extract so it needs no DOM library.
//
//  8 weighted dimensions (100 pts): heading structure (15), content clarity (15),
//  FAQ format (15), structured data (15), entity signals (10), meta quality (10),
//  list formatting (10), answer readiness (10).
// ============================================================

const { safeFetch } = require('../net/safe-fetch');

const UA = 'Mozilla/5.0 (compatible; AI-OS-AEO/1.0; +https://github.com)';

// Pull the AEO-relevant signals out of raw HTML without a DOM parser.
function extractSignals(html) {
  const h = String(html || '');
  const countTags = (tag) => (h.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
  const h1 = countTags('h1'), h2 = countTags('h2'), h3 = countTags('h3');

  const title = ((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  // Match the OPENING quote and stop at the same one, rather than at either kind. The earlier
  // [^"']* stopped dead at the first apostrophe, so a description containing "one person's voice"
  // measured 47 characters instead of 152 and lost marks for being too short — silently, on any
  // page or client site whose description contains a perfectly ordinary possessive.
  const metaDesc = (
    (h.match(/<meta[^>]+name=["']description["'][^>]+content=(["'])([\s\S]*?)\1/i) || [])[2]
    || (h.match(/<meta[^>]+content=(["'])([\s\S]*?)\1[^>]+name=["']description["']/i) || [])[2]
    || ''
  ).trim();

  // JSON-LD structured data
  const ldBlocks = [...h.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const schemaTypes = [];
  let hasFaqSchema = false;
  for (const block of ldBlocks) {
    try {
      const parsed = JSON.parse(block);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of arr) {
        if (it && it['@type']) schemaTypes.push(Array.isArray(it['@type']) ? it['@type'].join(',') : String(it['@type']));
        if (it && JSON.stringify(it).includes('FAQPage')) hasFaqSchema = true;
      }
    } catch { /* malformed JSON-LD — ignore */ }
  }

  // visible-text approximation: drop scripts/styles + tags
  const text = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text ? text.split(' ').length : 0;
  const sentences = Math.max(text.split('.').filter((s) => s.trim()).length, 1);
  const lists = countTags('li') + countTags('ul') + countTags('ol');

  return { h1, h2, h3, title, metaDesc, schemaTypes, hasFaqSchema, hasSchema: ldBlocks.length > 0, text, lc: text.toLowerCase(), words, sentences, lists };
}

function scoreReadability(sig) {
  const d = {
    heading_structure: { score: 0, max: 15, details: '' },
    content_clarity: { score: 0, max: 15, details: '' },
    faq_format: { score: 0, max: 15, details: '' },
    structured_data: { score: 0, max: 15, details: '' },
    entity_signals: { score: 0, max: 10, details: '' },
    meta_quality: { score: 0, max: 10, details: '' },
    list_formatting: { score: 0, max: 10, details: '' },
    answer_readiness: { score: 0, max: 10, details: '' },
  };

  // 1. Heading structure
  if (sig.h1 === 1) { d.heading_structure.score += 5; d.heading_structure.details = 'Single H1 (good)'; }
  else if (sig.h1 > 1) { d.heading_structure.score += 2; d.heading_structure.details = `${sig.h1} H1 tags (should be 1)`; }
  else d.heading_structure.details = 'Missing H1';
  if (sig.h2 >= 3) d.heading_structure.score += 5; else if (sig.h2 > 0) d.heading_structure.score += 3;
  if (sig.h3 >= 2) d.heading_structure.score += 5; else if (sig.h3 > 0) d.heading_structure.score += 2;

  // 2. Content clarity
  const wc = sig.words, asl = wc / Math.max(sig.sentences, 1);
  if (wc >= 300 && wc <= 2000) { d.content_clarity.score += 8; d.content_clarity.details = `${wc} words (optimal)`; }
  else if (wc > 2000) { d.content_clarity.score += 5; d.content_clarity.details = `${wc} words (consider summarizing)`; }
  else if (wc > 100) { d.content_clarity.score += 3; d.content_clarity.details = `${wc} words (thin)`; }
  else d.content_clarity.details = `${wc} words (very thin)`;
  if (asl < 25) d.content_clarity.score += 7; else if (asl < 35) d.content_clarity.score += 4;

  // 3. FAQ format
  const faqKw = ['?', 'what is', 'how to', 'why', 'when', 'where', 'who', 'faq', 'questions'];
  const faqSignals = faqKw.filter((k) => sig.lc.includes(k)).length;
  if (sig.hasFaqSchema) { d.faq_format.score = 15; d.faq_format.details = 'FAQPage schema detected'; }
  else if (faqSignals >= 5) { d.faq_format.score = 10; d.faq_format.details = `${faqSignals} question signals`; }
  else if (faqSignals >= 2) { d.faq_format.score = 5; d.faq_format.details = `${faqSignals} question signals (add an FAQ section)`; }
  else d.faq_format.details = 'No FAQ content detected';

  // 4. Structured data
  if (sig.schemaTypes.length >= 3) { d.structured_data.score = 15; d.structured_data.details = `Rich schema: ${sig.schemaTypes.slice(0, 3).join(', ')}`; }
  else if (sig.schemaTypes.length >= 1) { d.structured_data.score = 10; d.structured_data.details = `Schema: ${sig.schemaTypes.slice(0, 2).join(', ')}`; }
  else if (sig.hasSchema) { d.structured_data.score = 5; d.structured_data.details = 'Basic structured data present'; }
  else d.structured_data.details = 'No Schema.org / JSON-LD markup';

  // 5. Entity signals
  const ep = ['is a', 'we are', 'founded', 'headquartered', 'specializes in', 'provides', 'offers'];
  const ec = ep.filter((p) => sig.lc.includes(p)).length;
  if (ec >= 3) { d.entity_signals.score = 10; d.entity_signals.details = 'Strong entity definition'; }
  else if (ec >= 1) { d.entity_signals.score = 5; d.entity_signals.details = 'Some entity signals'; }
  else d.entity_signals.details = 'Weak entity definition';

  // 6. Meta quality
  if (sig.title.length >= 30 && sig.title.length <= 60) { d.meta_quality.score += 5; d.meta_quality.details = 'Good title length'; }
  else if (sig.title) { d.meta_quality.score += 2; d.meta_quality.details = 'Title needs optimization'; }
  else d.meta_quality.details = 'Missing title';
  if (sig.metaDesc.length >= 120 && sig.metaDesc.length <= 160) d.meta_quality.score += 5; else if (sig.metaDesc) d.meta_quality.score += 2;

  // 7. List formatting
  if (sig.lists >= 10) { d.list_formatting.score = 10; d.list_formatting.details = 'Excellent list formatting'; }
  else if (sig.lists >= 5) { d.list_formatting.score = 7; d.list_formatting.details = 'Good list usage'; }
  else if (sig.lists >= 2) { d.list_formatting.score = 4; d.list_formatting.details = 'Some lists present'; }
  else d.list_formatting.details = 'Add bullet/numbered lists for AI extraction';

  // 8. Answer readiness
  const ap = ['the answer is', 'in summary', 'to summarize', 'the solution', 'you can', 'here is how'];
  const ac = ap.filter((p) => sig.lc.includes(p)).length;
  const dp = [' is ', ' are ', ' means ', ' refers to '];
  const dc = dp.reduce((n, p) => n + (sig.lc.split(p).length - 1), 0);
  if (ac >= 3 || dc >= 5) { d.answer_readiness.score = 10; d.answer_readiness.details = 'Content is answer-ready'; }
  else if (ac >= 1 || dc >= 2) { d.answer_readiness.score = 5; d.answer_readiness.details = 'Partial answer readiness'; }
  else d.answer_readiness.details = 'Add direct answer statements';

  const total = Object.values(d).reduce((a, x) => a + x.score, 0);
  const max = Object.values(d).reduce((a, x) => a + x.max, 0);
  const score = Math.round((total / max) * 100);
  const recommendations = Object.entries(d)
    .filter(([, x]) => x.score < x.max * 0.7)
    .map(([k, x]) => ({ area: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), current: x.score, max: x.max, tip: x.details }))
    .sort((a, b) => (a.current / a.max) - (b.current / b.max))
    .slice(0, 5);
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  return { score, grade, breakdown: d, recommendations };
}

// Fetch a URL and score it. Returns { ok, score?, grade?, ... , error? } — never throws.
async function scoreUrl(url) {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const html = await safeFetch(u, { userAgent: UA, maxBytes: 3_000_000, timeoutMs: 15000 });
    return { ok: true, ...scoreReadability(extractSignals(html)) };
  } catch (e) {
    return { ok: false, error: e.message, score: 0, grade: 'D', breakdown: {}, recommendations: [] };
  }
}

module.exports = { extractSignals, scoreReadability, scoreUrl };
