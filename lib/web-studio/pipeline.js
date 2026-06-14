// lib/web-studio/pipeline.js
// ============================================================
//  Creation pipeline: brief -> plan (web-studio-lead) -> copy/meta (content-writer)
//  -> DETERMINISTIC render to Astro -> build -> WCAG gate.
//
//  Why deterministic render (not agent-emitted markup) for the MVP: it guarantees a
//  buildable, accessible site every time (the build + WCAG gate are reliably passable).
//  The agents own the *content + design direction*; the renderer owns *valid structure*.
//  Agent-authored markup is a Phase-1 "more creative output" upgrade.
//
//  Pure-ish module: all side effects (agent calls, lint, broadcast) are INJECTED via
//  `deps`, so server.js owns the engine and this stays testable.
//    deps = { executeAgent(agentName, task) -> {content}, lint(html) -> {findings},
//             broadcast(evt), log(msg) }
// ============================================================

const path = require('path');
const fs = require('fs');
const { scaffoldWorkspace } = require('./scaffold');
const { runBuild } = require('./build');

// ---------- small utils ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Attribute values that must be URL-ish (href). Allow only safe schemes/relative.
function safeHref(h) {
  const v = String(h || '#').trim();
  if (/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v) && !/[\s"'<>]/.test(v)) return v;
  return '#';
}

// Robustly pull the first balanced JSON object/array out of an agent's text reply
// (which may wrap it in prose or a ```json fence).
function extractJson(text) {
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const sources = fence ? [fence[1], text] : [text];
  for (const src of sources) {
    const s = String(src);
    const start = s.search(/[{[]/);
    if (start < 0) continue;
    const open = s[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, escNext = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (escNext) { escNext = false; continue; }
      if (ch === '\\') { escNext = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { const got = tryParse(s.slice(start, i + 1)); if (got !== undefined) return got; break; } }
    }
  }
  return null;
}

// ---------- deterministic section renderers (accessible, token-themed) ----------
// Each takes a merged section spec and returns an HTML string. Copy is escaped.
const SECTIONS = {
  hero(s) {
    const cta = s.cta || {};
    return `<section class="px-6 py-24 text-center bg-paper">
  <div class="mx-auto max-w-3xl">
    <h1 class="text-4xl sm:text-5xl font-display font-bold text-ink">${esc(s.heading)}</h1>
    ${s.subheading ? `<p class="mt-5 text-lg text-ink/70">${esc(s.subheading)}</p>` : ''}
    ${cta.label ? `<a href="${safeHref(cta.href)}" class="mt-8 inline-block rounded-lg bg-brand px-6 py-3 font-medium text-paper hover:opacity-90">${esc(cta.label)}</a>` : ''}
  </div>
</section>`;
  },
  features(s) {
    const items = Array.isArray(s.items) ? s.items : [];
    const cards = items.map((it) => `      <div class="rounded-xl border border-ink/10 p-6">
        <h3 class="text-lg font-semibold text-ink">${esc(it.title)}</h3>
        <p class="mt-2 text-ink/70">${esc(it.body)}</p>
      </div>`).join('\n');
    return `<section class="px-6 py-20">
  <div class="mx-auto max-w-5xl">
    ${s.heading ? `<h2 class="text-3xl font-display font-bold text-ink text-center">${esc(s.heading)}</h2>` : ''}
    <div class="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
${cards}
    </div>
  </div>
</section>`;
  },
  prose(s) {
    const paras = Array.isArray(s.paragraphs) ? s.paragraphs : (s.body ? [s.body] : []);
    const body = paras.map((p) => `      <p class="mt-4 text-ink/80 leading-relaxed">${esc(p)}</p>`).join('\n');
    return `<section class="px-6 py-16">
  <div class="mx-auto max-w-2xl">
    ${s.heading ? `<h2 class="text-2xl font-display font-bold text-ink">${esc(s.heading)}</h2>` : ''}
${body}
  </div>
</section>`;
  },
  cta(s) {
    const cta = s.cta || {};
    return `<section class="px-6 py-16 bg-brand text-paper text-center">
  <div class="mx-auto max-w-2xl">
    <h2 class="text-3xl font-display font-bold">${esc(s.heading)}</h2>
    ${s.subheading ? `<p class="mt-3 opacity-90">${esc(s.subheading)}</p>` : ''}
    ${cta.label ? `<a href="${safeHref(cta.href)}" class="mt-6 inline-block rounded-lg bg-paper px-6 py-3 font-medium text-brand hover:opacity-90">${esc(cta.label)}</a>` : ''}
  </div>
</section>`;
  },
  contact(s) {
    const email = s.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email) ? s.email : '';
    return `<section class="px-6 py-20 text-center">
  <div class="mx-auto max-w-xl">
    <h2 class="text-3xl font-display font-bold text-ink">${esc(s.heading || 'Get in touch')}</h2>
    ${s.body ? `<p class="mt-3 text-ink/70">${esc(s.body)}</p>` : ''}
    ${email ? `<a href="mailto:${esc(email)}" class="mt-6 inline-block rounded-lg bg-brand px-6 py-3 font-medium text-paper hover:opacity-90">${esc(email)}</a>` : ''}
  </div>
</section>`;
  },
};

function renderSection(section) {
  const type = SECTIONS[section && section.type] ? section.type : 'prose';
  try { return SECTIONS[type](section || {}); } catch { return SECTIONS.prose({ body: '' }); }
}

function renderBase(plan) {
  const nav = (Array.isArray(plan.nav) ? plan.nav : []).map((n) =>
    `        <a href="${safeHref(n.href)}" class="text-ink/70 hover:text-ink">${esc(n.label)}</a>`).join('\n');
  const year = '2026'; // stamped at render time by server.js if needed; static for the template
  return `---
import '../styles/tokens.css';
const { title = 'Untitled', description = '', og = {} } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    {description && <meta name="description" content={description} />}
    <meta property="og:title" content={og.title ?? title} />
    {(og.description ?? description) && <meta property="og:description" content={og.description ?? description} />}
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body class="min-h-screen flex flex-col bg-paper">
    <header class="border-b border-ink/10">
      <nav class="mx-auto max-w-5xl flex items-center justify-between px-6 py-4">
        <a href="/" class="font-display font-bold text-brand">${esc(plan.siteName || 'Site')}</a>
        <div class="hidden sm:flex gap-6">
${nav}
        </div>
      </nav>
    </header>
    <main class="flex-1"><slot /></main>
    <footer class="border-t border-ink/10 px-6 py-8 text-center text-sm text-ink/60">
      ${esc(plan.footer || `© ${year} ${plan.siteName || ''}`)}
    </footer>
  </body>
</html>
`;
}

function renderPage(page, meta) {
  const sections = (Array.isArray(page.sections) ? page.sections : []).map(renderSection).join('\n');
  const title = (meta && meta.title) || page.title || 'Untitled';
  const description = (meta && meta.description) || page.description || '';
  const og = (meta && meta.og) || {};
  const ogLit = `{ title: ${JSON.stringify(og.title || title)}, description: ${JSON.stringify(og.description || description)} }`;
  return `---
import Base from '../layouts/Base.astro';
---
<Base title=${JSON.stringify(title)} description=${JSON.stringify(description)} og={${ogLit}}>
${sections}
</Base>
`;
}

// Map a plan page path ('/', '/about') to a src/pages file path.
function pageFile(p) {
  let rel = String(p || '/').replace(/^\/+/, '').replace(/\.+/g, '.').replace(/[^a-z0-9/_-]/gi, '');
  if (rel === '' ) rel = 'index';
  return path.join('src', 'pages', rel.endsWith('/') || rel === 'index' ? (rel === 'index' ? 'index.astro' : rel + 'index.astro') : rel + '.astro');
}

// ---------- prompts ----------
function planPrompt(brief) {
  return `You are planning a marketing website. From this brief, return ONLY a JSON object (no prose) of this exact shape:
{
  "siteName": "string",
  "tokens": { "brand": "#hex", "accent": "#hex", "ink": "#hex", "paper": "#hex", "fontDisplay": "css font-family", "fontBody": "css font-family" },
  "nav": [{ "label": "Home", "href": "/" }],
  "footer": "© 2026 ...",
  "pages": [
    { "path": "/", "title": "Home", "description": "<=160 chars",
      "sections": [
        { "type": "hero", "heading": "...", "subheading": "...", "cta": { "label": "...", "href": "/#contact" } },
        { "type": "features", "heading": "...", "items": [ { "title": "...", "body": "..." } ] },
        { "type": "cta", "heading": "...", "subheading": "...", "cta": { "label": "...", "href": "..." } }
      ] }
  ]
}
Allowed section types: hero, features, prose, cta, contact. Use real, on-brand copy (NO lorem). Pick a tasteful palette with strong contrast (WCAG AA). Keep it to 1-3 pages for the first build.

Output ONLY the JSON object — no tool calls, no delegation, no explanation, no markdown fences. Begin your reply with { and end with }.

BRIEF:
${brief}`;
}

function contentPrompt(brief, plan) {
  return `Refine the COPY and metadata for this site plan. Return ONLY JSON of shape:
{ "pages": { "<path>": { "title": "...", "description": "<=160 chars", "og": { "title": "...", "description": "..." } } } }
Keep titles unique per page. No lorem. Base it on the brief and the existing plan.

BRIEF:
${brief}

PLAN:
${JSON.stringify({ siteName: plan.siteName, pages: (plan.pages || []).map(p => ({ path: p.path, title: p.title })) })}`;
}

// ---------- orchestration ----------
/**
 * Build a site from a natural-language brief.
 * @param {{siteId:string, workspaceDir:string, brief:string}} opts
 * @param {{executeAgent:Function, lint?:Function, broadcast?:Function, log?:Function}} deps
 * @returns {Promise<{ok, status, distDir, plan, buildLog, lint, error?}>}
 *   status: 'ready' | 'gated' | 'build_failed' | 'plan_failed'
 */
async function createSiteFromBrief(opts, deps) {
  const { workspaceDir, brief, siteId } = opts;
  const { executeAgent, lint, broadcast = () => {}, log = () => {} } = deps || {};
  const emit = (phase, extra = {}) => broadcast({ event: 'web_studio_build', data: { siteId, phase, ...extra } });

  // 1. Plan (web-studio-lead). Give it a wide token budget: Opus 4.8 runs this agent at
  // xhigh effort with adaptive thinking, and thinking shares max_tokens — too small a cap
  // and the JSON plan comes back truncated/empty (the default 4096 was the failure mode).
  emit('planning'); log(`[web-studio] planning ${siteId}`);
  const planResp = await executeAgent('web-studio-lead', planPrompt(brief), { maxTokens: 16000 });
  const planText = (planResp && planResp.content) || '';
  const plan = extractJson(planText);
  if (!plan || !Array.isArray(plan.pages) || plan.pages.length === 0) {
    log(`[web-studio] plan parse FAILED for ${siteId}: ${planText.length} chars; head="${planText.slice(0, 280).replace(/\s+/g, ' ')}"`);
    emit('failed', { error: 'plan' });
    return { ok: false, status: 'plan_failed', error: `web-studio-lead did not return a usable plan (${planText.length} chars returned)` };
  }
  log(`[web-studio] plan OK for ${siteId}: ${plan.pages.length} page(s)`);

  // 2. Copy / metadata (content-writer) — best-effort; tolerated if it fails.
  emit('writing');
  let meta = {};
  try {
    const cResp = await executeAgent('content-writer', contentPrompt(brief, plan), { maxTokens: 8000 });
    const c = extractJson(cResp && cResp.content);
    if (c && c.pages) meta = c.pages;
  } catch (e) { log(`[web-studio] content-writer skipped: ${e.message}`); }

  // 3. Scaffold + deterministic render (web-builder's compile step)
  emit('building');
  scaffoldWorkspace(workspaceDir, { siteName: plan.siteName, tokens: plan.tokens });
  fs.writeFileSync(path.join(workspaceDir, 'src', 'layouts', 'Base.astro'), renderBase(plan));
  const writtenPages = [];
  for (const page of plan.pages) {
    const rel = pageFile(page.path);
    const file = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPage(page, meta[page.path]));
    writtenPages.push(rel);
  }

  // 4. Build
  const build = await runBuild(workspaceDir);
  if (!build.ok) {
    emit('failed', { error: 'build' });
    return { ok: false, status: 'build_failed', distDir: build.distDir, buildLog: build.log, error: build.error };
  }

  // 5. WCAG quality gate (warn-only here; the API decides blocking vs warn by tier)
  emit('gating');
  let lintResult = null;
  if (typeof lint === 'function') {
    try {
      const indexHtml = fs.readFileSync(path.join(build.distDir, 'index.html'), 'utf-8');
      lintResult = await lint(indexHtml);
    } catch (e) { log(`[web-studio] lint skipped: ${e.message}`); }
  }
  const errorFindings = lintResult && Array.isArray(lintResult.findings)
    ? lintResult.findings.filter(f => (f.severity || '').toLowerCase() === 'error') : [];

  emit('done', { pages: writtenPages.length, gated: errorFindings.length > 0 });
  return {
    ok: true,
    status: errorFindings.length > 0 ? 'gated' : 'ready',
    distDir: build.distDir,
    plan,
    pages: writtenPages,
    buildLog: build.log,
    lint: lintResult,
  };
}

module.exports = { createSiteFromBrief, extractJson, renderPage, renderBase, renderSection };
