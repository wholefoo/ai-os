// Copy-drift guard: the public surface (README.md + dashboard/index.html) must mention every
// feature in the manifest below. This exists because the copy fell ~10 features behind the code
// in under a week of shipping (July 2026 sprint) — the numbers had drift guards (auto-research
// score.js), the FEATURES didn't. CI-gated.
//
// WHEN YOU SHIP A PUBLIC-SURFACE FEATURE (per .claude/commands/ship.md): add it to README.md,
// to the landing featureList JSON-LD, AND to this manifest in the same commit. When a feature
// is retired, remove it from all three.
const fs = require('fs');
const path = require('path');

const FEATURES = [
  { name: 'AI Web Studio',                 pattern: /AI Web Studio/i },
  { name: 'SEO + AEO agency',              pattern: /\bAEO\b/ },
  { name: 'AI-signal first-party analytics', pattern: /first-party.{0,60}analytics|analytics.{0,60}(AI.?crawler|GPTBot)|AI[- ]signal/is },
  { name: 'lead capture → CRM',            pattern: /lead[- ]capture|lead inbox|lead pipeline/i },
  { name: 'sales funnels',                 pattern: /funnel/i },
  { name: 'dynamic pages',                 pattern: /dynamic pages/i },
  { name: 'per-site Site Manager',         pattern: /site manager/i },
  { name: 'Open Knowledge Format bundles', pattern: /open knowledge format|\bOKF\b/i },
  { name: 'content provenance',            pattern: /provenance/i },
  { name: 'self-improve (Grok Build)',     pattern: /grok build/i },
  { name: 'custom domains + TLS',          pattern: /custom domain/i },
  { name: 'CRM',                           pattern: /\bCRM\b/ },
  { name: 'YouTube intelligence',          pattern: /youtube/i },
  { name: 'human-in-the-loop approval',    pattern: /human[- ]in[- ]the[- ]loop|approval gat/i },
];

const SURFACES = ['README.md', 'dashboard/index.html'];

let failed = 0;
for (const surface of SURFACES) {
  const text = fs.readFileSync(path.join(__dirname, '..', surface), 'utf8');
  const missing = FEATURES.filter((f) => !f.pattern.test(text));
  if (missing.length) {
    failed++;
    console.error(`✗ ${surface} is missing: ${missing.map((m) => m.name).join(', ')}`);
  } else {
    console.log(`✓ ${surface}: all ${FEATURES.length} public features mentioned`);
  }
}
if (failed) {
  console.error('\nCopy drift detected — update the surface(s) above (and this manifest if a feature was retired).');
  process.exit(1);
}
