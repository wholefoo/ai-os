// auto-research/score.js — THE UNTOUCHABLE SCORER
// The optimizing agent must NEVER edit this file. run-loop.js checksums it
// before every iteration and aborts the loop if it changed.
//
// Target: asset/landing-seo.html — landing page SEO/AEO copy block.
// Contract: print one JSON line to stdout and exit 0:
//   { "score": <0-100>, "details": { ... } }
// A thrown error or non-zero exit means "candidate is broken" → automatic revert.

const fs = require('fs');
const path = require('path');

const ASSET = path.join(__dirname, 'asset', 'landing-seo.html');

function extract(html, marker, regex) {
  const section = html.split(`<!-- element: ${marker} -->`)[1];
  if (!section) throw new Error(`missing element marker: ${marker}`);
  const m = section.match(regex);
  if (!m) throw new Error(`element not parseable: ${marker}`);
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function score() {
  const html = fs.readFileSync(ASSET, 'utf-8');

  const title = extract(html, 'title', /<title>([\s\S]*?)<\/title>/);
  const meta = extract(html, 'meta-description', /content="([^"]*)"/);
  const ogTitle = extract(html, 'og-title', /content="([^"]*)"/);
  const ogDesc = extract(html, 'og-description', /content="([^"]*)"/);
  const h1 = extract(html, 'hero-title', /<h1[^>]*>([\s\S]*?)<\/h1>/);
  const sub = extract(html, 'hero-subtitle', /<p[^>]*>([\s\S]*?)<\/p>/);

  const all = [title, meta, ogTitle, ogDesc, h1, sub].join(' ');
  const details = {};
  let pts = 0;

  // 1. Length discipline (30 pts) — search/social truncation limits
  const inRange = (len, lo, hi, max) => (len >= lo && len <= hi) ? max : Math.max(0, max - Math.ceil(Math.abs(len - (len < lo ? lo : hi)) / 5));
  details.titleLen = title.length;        pts += inRange(title.length, 45, 60, 10);
  details.metaLen = meta.length;          pts += inRange(meta.length, 140, 160, 10);
  details.ogDescLen = ogDesc.length;      pts += inRange(ogDesc.length, 90, 200, 5);
  details.subWordCount = sub.split(/\s+/).length; pts += inRange(sub.split(/\s+/).length, 15, 35, 5);

  // 2. Keyword coverage (25 pts) — terms buyers and answer engines associate with the product
  const KEYWORDS = ['ai agents', 'multi-agent', 'self-hosted', 'open-source', 'white-label', 'virtual corporate hq'];
  const lower = all.toLowerCase();
  const hits = KEYWORDS.filter(k => lower.includes(k));
  details.keywordsHit = hits;
  pts += Math.round((hits.length / KEYWORDS.length) * 25);

  // 3. Concrete facts (20 pts) — AEO answers cite specifics
  const FACTS = [/\b51\b/, /\b10 departments\b/i, /\$1,?997/];
  const factHits = FACTS.filter(r => r.test(all)).length;
  details.factsPresent = factHits;
  pts += Math.round((factHits / FACTS.length) * 20);

  // 4. Anti-slop (15 pts) — filler phrases and unevidenced superlatives cost points
  const FILLER = /in today's fast-paced world|game-changer|unlock the power|delve|revolutionize|cutting[- ]edge|world-class|best-in-class|seamless(ly)?|supercharge/gi;
  const fillerHits = (all.match(FILLER) || []).length;
  details.fillerHits = fillerHits;
  pts += Math.max(0, 15 - fillerHits * 5);

  // 5. Distinctness (10 pts) — title, OG title, and H1 must not be near-duplicates
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const overlap = (a, b) => {
    const wa = new Set(norm(a).split(' ')), wb = new Set(norm(b).split(' '));
    const inter = [...wa].filter(w => wb.has(w)).length;
    return inter / Math.min(wa.size, wb.size);
  };
  const maxOverlap = Math.max(overlap(title, ogTitle), overlap(title, h1), overlap(ogTitle, h1));
  details.maxTitleOverlap = Number(maxOverlap.toFixed(2));
  pts += maxOverlap < 0.6 ? 10 : (maxOverlap < 0.8 ? 5 : 0);

  // Fact-integrity guard: wrong numbers are a broken candidate, not a low score
  if (/\b5[02-9]\s+(ai\s+)?agents\b/i.test(all)) throw new Error('agent count drifted from 51');
  if (/guarantee/i.test(all)) throw new Error('hard guarantee language is banned');

  return { score: Math.min(100, pts), details };
}

console.log(JSON.stringify(score()));
