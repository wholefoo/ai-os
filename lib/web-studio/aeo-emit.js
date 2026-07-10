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

// Real schema.org Action vocabulary only — NOT a claim of WebMCP-spec compliance, which is a
// separate, evolving browser standard this does not implement.
// Conservative by design: only emits an Action when the page's plan.sections prove the site
// genuinely has that capability. Currently that's just a contact form/email → ContactAction.
// No ReserveAction/OrderAction/BookAction — a static generator can't verify those are real.
function actionLdObjects(plan, page) {
  const out = [];
  const sections = (page && page.sections) || [];
  const contact = sections.find((s) => s && s.type === 'contact');
  if (contact && typeof contact.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'ContactAction',
      target: 'mailto:' + contact.email,
      name: 'Contact ' + (plan.siteName || 'us'),
    });
  }
  return out;
}

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
  lines.push('', '## Knowledge', '', `- [Agent-ready knowledge bundle](${(siteUrl(plan.domain) || '') + '/knowledge/index.md'}): Open Knowledge Format (OKF) bundle describing this site — machine-readable concepts for AI agents.`);
  return lines.join('\n') + '\n';
}

// /knowledge/ — an Open Knowledge Format (OKF v0.1) bundle: the agent-ready description of the
// site. Deterministic and zero-token, built from the plan like every other emitter here. Concepts:
// index.md (the Website), one concept per page, and — when the plan carries provenance — a
// provenance concept pointing at the signed sidecar. Returns [{relPath, fm, body}] for lib/okf.
function okfBundle(plan, meta = {}) {
  const now = new Date().toISOString();
  const site = siteUrl(plan.domain);
  const pageRel = (p) => 'pages' + (p === '/' || !p ? '/home' : '/' + String(p).replace(/^\/+/, '').replace(/\//g, '-')) + '.md';
  const files = [];

  const pageLines = (plan.pages || []).map((p) => `- [${p.title || p.path}](/${pageRel(p.path)})${p.description ? ' — ' + p.description : ''}`);
  files.push({
    relPath: 'index.md',
    fm: { type: 'Website', title: plan.siteName || 'Site', description: ((plan.pages || [])[0] || {}).description || '', resource: site || undefined, tags: ['website', 'okf'], timestamp: now },
    body: `# ${plan.siteName || 'Site'}\n\nThis is an Open Knowledge Format (OKF) bundle describing this website for AI agents.\n\n## Pages\n\n${pageLines.join('\n')}\n${plan.provenance ? '\n## Provenance\n\n- [Content provenance](/provenance.md) — how this site was generated and how to verify it.\n' : ''}`,
  });

  for (const p of (plan.pages || [])) {
    const m = (meta && meta[p.path]) || {};
    const sectionLines = [];
    for (const s of (Array.isArray(p.sections) ? p.sections : [])) {
      if (s.heading) sectionLines.push(`## ${s.heading}`, '');
      if (s.subheading) sectionLines.push(s.subheading, '');
      if (s.body) sectionLines.push(String(s.body), '');
      if (Array.isArray(s.items)) { for (const it of s.items) sectionLines.push(`- **${it.title || ''}**${it.body ? ': ' + it.body : ''}`); sectionLines.push(''); }
      if (s.email) sectionLines.push(`Contact: ${s.email}`, '');
    }
    files.push({
      relPath: pageRel(p.path),
      fm: { type: 'Web Page', title: m.title || p.title || p.path, description: m.description || p.description || '', resource: pageUrl(plan.domain, p.path) || undefined, timestamp: now },
      body: sectionLines.join('\n') || `# ${p.title || p.path}`,
    });
  }

  if (plan.provenance && plan.provenance.generatedAt) {
    files.push({
      relPath: 'provenance.md',
      fm: { type: 'Provenance', title: 'Content provenance', description: 'AI-generation disclosure and integrity credential for this site.', resource: site ? site + '/.well-known/aios-provenance.json' : undefined, timestamp: now },
      body: `# Content provenance\n\nThis site was generated by AI OS Web Studio on ${plan.provenance.generatedAt}. An Ed25519-signed provenance sidecar binding the homepage content hash is served at \`/.well-known/aios-provenance.json\`. The JSON-LD disclosure on each page is informational; the signed sidecar is the integrity artifact.`,
    });
  }
  return files;
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

module.exports = { siteLdObjects, pageLdObject, canonicalUrl, llmsTxt, robotsTxt, sitemapXml, xesc, provenanceSidecar, actionLdObjects, okfBundle };
