---
name: web-content
description: Authoring standard for the public web surface (landing, docs, blog) — JSON-LD schema, AEO readiness, external-link safety, and AI-crawler hygiene.
---

# Web Content Rules

Applies to every hand-authored page under `dashboard/` (the landing `index.html`, `docs/*.html`, `blog/*.html`, and standalone pages). Goal: every page is AEO-ready (parseable + citable by AI answer engines), safe, and consistent. **Validate before commit** with the platform's own scorer and aim for **80+ (grade A)**:

```
node -e "const {scoreReadability,extractSignals}=require('./lib/aeo/readability');const fs=require('fs');const r=scoreReadability(extractSignals(fs.readFileSync(process.argv[1],'utf8')));console.log(r.score+'/100 ('+r.grade+')');console.log(r.breakdown)" dashboard/docs/<page>.html
```

## 1. Structured data (JSON-LD) — required per page type
Every page ships at least **two** `<script type="application/ld+json">` blocks; **3+ schema types scores full marks** on the structured-data dimension.
- **Docs page** → `TechArticle` + `BreadcrumbList` (Home → Documentation → Page).
- **Blog post** → `Article` (with `datePublished`) + `BreadcrumbList` (Home → Blog → Title).
- **Landing / index** → `SoftwareApplication` + `Organization`.
- **Any page with Q&A** → add a `FAQPage` block. This is the single highest-leverage AEO signal — it maxes both the FAQ and structured-data dimensions at once. Keep the visible FAQ and the `FAQPage` `mainEntity` in sync.
- `publisher`/`author` = `{ "@type": "Organization", "name": "AI OS Orchestration Lab" }`. Add the page's `featureList` entry to the landing's `SoftwareApplication` JSON-LD when launching a notable feature.

## 2. AEO readiness (the 8-dimension scorer in `lib/aeo/readability.js`)
- **Answer-first**: open with a 2–3 sentence lead that directly answers the page's core question (definitional "X is a/are …" phrasing scores the answer-readiness dimension).
- **Headings**: exactly one `<h1>`; **3+ `<h2 id="…">`**; **2+ `<h3>`**. Keep the `docs-toc` / on-page nav anchors in sync with the `<h2 id>`s by hand (no JS generates them).
- **Length**: 300–2000 words of real content. **Lists**: use `<ul>/<ol>` and `<table class="docs-table">` generously — answer engines extract them.
- **Meta**: `<title>` ideally 30–60 chars; `<meta name="description">` 120–160 chars (reused in `og:description` + the JSON-LD `description`); plus `canonical` + OpenGraph.

## 3. External links ALWAYS open in a new tab
Any off-site `<a>` (a domain other than `aiosorchestrationlab.com`) **must** carry `target="_blank" rel="noopener"`. Internal, same-domain, and `#anchor` links stay in the same tab. `rel="noopener"` is mandatory — it stops the opened page from touching `window.opener` (security + perf). Audit with:
```
grep -rEn '<a [^>]*href="https?://' dashboard --include="*.html" | grep -v 'target="_blank"' | grep -v 'aiosorchestrationlab'
```
(should return nothing).

## 4. AI-crawler hygiene
- Keep `dashboard/robots.txt` explicitly allowing GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot, Google-Extended, Amazonbot.
- When you add a page, also add it to **`dashboard/llms.txt`** (the curated AI-crawler index) and to the **sitemap** (the list in `server.js`, served at `/sitemap.xml`).

## 5. Routing when adding a page
- **New docs page**: create `dashboard/docs/<slug>.html` → add `<slug>` to the `docPages` allowlist in `server.js` → add a card to `dashboard/docs/index.html` → add to the sitemap + `llms.txt`.
- **New blog post**: create `dashboard/blog/<slug>.html` (the `/blog/:slug` route is dynamic — no allowlist) → add a card to `dashboard/blog/index.html` → add to the sitemap + `llms.txt`.

## 6. Honest framing (house rule)
Never overstate. Match the existing voice: AEO "improves readiness, not guaranteed citations"; provenance is "NOT certified C2PA"; the security suite is "AI-assisted, report-only, not a guarantee, opt-in." State prerequisites and defaults plainly.

## 7. Match the template
Clone an existing page of the same type for the exact `<head>`, nav, footer, and shared includes (`/css/landing.css`, `/css/docs.css`, the GA snippet). Don't invent new page structure.
