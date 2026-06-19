// lib/web-studio/aeo-emit.js
// ============================================================
//  Deterministic, ZERO-token answer-engine emitters for generated sites. AI OS sells AEO but
//  its own generated sites previously emitted no structured data — losing ~15 pts on AI OS's
//  OWN readability scorer (lib/aeo/readability.js structured_data dimension). This supplies the
//  JSON-LD entities (Organization + WebSite site-wide, WebPage per page = 3 @types → full 15),
//  canonical URLs, a curated llms.txt, an AI-crawler-allowing robots.txt, and a sitemap — all
//  built deterministically from the existing plan object. Astro copies public/ verbatim → dist/.
//
//  JSON-LD is returned as OBJECTS (not HTML), so the pipeline can embed them as Astro frontmatter
//  consts and render with `set:html` — the only safe way (raw {…} in a .astro template is parsed
//  as a JS expression).
// ============================================================

const { generateRobotsAllowlist } = require('../aeo/crawlers');

function siteUrl(domain) {
  if (!domain) return '';
  return 'https://' + String(domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
function pageUrl(domain, p) {
  const u = siteUrl(domain);
  return u ? u + (p === '/' || !p ? '/' : '/' + String(p).replace(/^\/+/, '')) : '';
}
const xesc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Site-wide Organization + WebSite entities (same on every page). When the plan carries a
// provenance stamp (generated sites only), also emit a schema.org CreativeWork AI-generation
// DISCLOSURE — machine-readable transparency (EU AI Act Art. 50). NOTE this JSON-LD is unsigned
// and freely editable: it is disclosure, NOT tamper-evidence (the signed sidecar supplies integrity).
function siteLdObjects(plan) {
  const url = siteUrl(plan.domain);
  const org = { '@context': 'https://schema.org', '@type': 'Organization', name: plan.siteName || 'Site' };
  const ws = { '@context': 'https://schema.org', '@type': 'WebSite', name: plan.siteName || 'Site' };
  if (url) { org.url = url; ws.url = url; }
  const out = [org, ws];
  if (plan.provenance && plan.provenance.generatedAt) {
    out.push({
      '@context': 'https://schema.org', '@type': 'CreativeWork',
      creator: { '@type': 'SoftwareApplication', name: 'AI OS Web Studio', applicationCategory: 'WebApplication' },
      dateCreated: plan.provenance.generatedAt,
      creditText: 'Content generated with generative AI by AI OS Web Studio',
    });
  }
  return out;
}

// Build the UNSIGNED provenance sidecar payload (C2PA-vocabulary-aligned, deterministic, zero-token).
// The caller (pipeline) fills content_binding.hash with sha256 of the FINAL built index.html, then
// signs the whole object with Ed25519 (lib/provenance.sign). Public form — no model identities.
function provenanceSidecar(plan, provenance) {
  const p = provenance || {};
  const ingredients = [];
  if (p.briefHash) ingredients.push({ title: 'creative brief', relationship: 'inputTo', alg: 'sha256', hash: p.briefHash });
  if (p.designClonedFrom) ingredients.push({ title: 'design reference', relationship: 'inputTo', source: p.designClonedFrom });
  return {
    schema: 'ai-os-provenance-credential/1',
    spec_alignment: 'c2pa-vocabulary',
    disclaimer: 'Domain-bound, Ed25519-signed JSON provenance credential reusing C2PA/IPTC vocabulary. NOT an embedded C2PA manifest; verifiable by the AI OS verifier, not by generic Content Credentials tools. Trust rests on key-to-domain binding, not a CA trust list.',
    claim_generator_info: [{ name: 'AI OS Web Studio', version: '1.0' }],
    assertions: [
      { label: 'c2pa.actions.v2', data: { actions: [{
        action: 'c2pa.created',
        softwareAgent: 'AI OS Web Studio',
        digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
        when: p.generatedAt || null,
      }] } },
      { label: 'cawg.training-mining', data: { entries: {
        'cawg.ai_training': 'notAllowed', 'cawg.ai_generative_training': 'notAllowed', 'cawg.data_mining': 'notAllowed',
      } } },
    ],
    content_binding: { alg: 'sha256', target: 'index.html', hash: p.contentHash || null },
    ingredients,
  };
}

// Per-page WebPage entity.
function pageLdObject(plan, page) {
  const url = pageUrl(plan.domain, page.path);
  const wp = { '@context': 'https://schema.org', '@type': 'WebPage', name: page.title || 'Page' };
  if (url) wp.url = url;
  if (page.description) wp.description = page.description;
  return wp;
}

function canonicalUrl(plan, page) { return pageUrl(plan.domain, page.path); }

// /llms.txt — a curated content map answer engines can read to navigate the site.
function llmsTxt(plan) {
  const lines = [`# ${plan.siteName || 'Site'}`, ''];
  const home = (plan.pages || []).find((p) => p.path === '/') || (plan.pages || [])[0];
  if (home && home.description) lines.push(`> ${home.description}`, '');
  lines.push('## Pages', '');
  for (const p of (plan.pages || [])) {
    const link = pageUrl(plan.domain, p.path) || p.path;
    lines.push(`- [${p.title || p.path}](${link})${p.description ? ': ' + p.description : ''}`);
  }
  return lines.join('\n') + '\n';
}

// /robots.txt — allow everyone + explicitly allow the AI crawlers (so answer engines can cite).
function robotsTxt(plan) {
  const url = siteUrl(plan.domain);
  let out = 'User-agent: *\nAllow: /\n\n' + generateRobotsAllowlist();
  if (url) out += `\nSitemap: ${url}/sitemap.xml\n`;
  return out;
}

// /sitemap.xml — only when a domain is known (loc requires absolute URLs).
function sitemapXml(plan) {
  const url = siteUrl(plan.domain);
  if (!url) return '';
  const urls = (plan.pages || []).map((p) => `  <url><loc>${xesc(pageUrl(plan.domain, p.path))}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

module.exports = { siteLdObjects, pageLdObject, canonicalUrl, llmsTxt, robotsTxt, sitemapXml, xesc, provenanceSidecar };
