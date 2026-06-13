# AI Web Studio — Unified Architecture & Delivery Plan

*Status: design for human approval. No implementation until signed off.*

Locked decisions: same-VPS static hosting · custom-domain primary · AI + Monaco editing · tiers Community 1 / Business 10 / Enterprise unlimited.

---

## 1. Executive Summary

An **AI Web Studio + multi-site hosting control panel** inside AI OS, surfaced in the backend dashboard. From a natural-language brief it generates stunning static sites (Astro + Tailwind compiled to plain HTML/CSS/JS), and it can import existing sites — via GitHub clone or Firecrawl crawl — into the same editable workspace to improve and re-host. Every site is edited two ways: AI natural-language editing (agents regenerate/patch the source) and a built-in Monaco code editor with live preview, both funneling into one build→WCAG-gate→deploy pipeline. Sites are hosted **on the same VPS the AI OS instance runs on** as static nginx vhosts, each pointing its own custom domain at the box with auto-TLS via certbot; drafts live on preview subdomains. The feature ships open-core (Community = 1 site) with a commercial overlay (Business = 10, Enterprise = unlimited) that unlocks import, custom-domain fan-out, blocking quality gates, visual QA, white-label, client handoff, analytics, and Codex review. It reuses existing AI OS machinery throughout: Firecrawl, Gemini Omni, the design-system WCAG linter, the SEO agents, browser-agent, and the Codex cross-model review rig.

---

## 2. Architecture Overview

Five layers, separated by privilege and responsibility. The **only** code that ever crosses into root is three vetted wrapper scripts; everything else runs as the unprivileged `aios` user.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  DASHBOARD (dashboard/js/app.js + app.html)                                │
│  7 views: Sites · Create · Import · Editor(AI chat|Monaco|preview) ·       │
│           Publish · Domains/TLS · Analytics      live via /ws web_studio_* │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ REST  /api/web-studio/*
┌───────────────▼──────────────────────────────────────────────────────────┐
│  CORE (server.js)               │  COMMERCIAL OVERLAY                       │
│  Community-safe base:           │  (commercial/modules/web-studio/index.js)│
│   workspace CRUD, 1-site        │   import, custom-domain fan-out,          │
│   build/publish, Monaco I/O,    │   blocking quality-gate, visual-QA,       │
│   AI NL edit, sites-limit check │   batch, analytics, white-label,          │
│                                 │   client-handoff, codex-review            │
│         tier-resolver.js: features.webStudio* + limits.sites (1/10/∞)       │
└───────────────┬─────────────────────────────────┬──────────────────────────┘
                │ executeAgent()                   │ creation / import pipelines
┌───────────────▼─────────────────┐   ┌────────────▼─────────────────────────┐
│  AGENT TEAM (.claude/agents)     │   │  CREATION & IMPORT PIPELINES          │
│  web-studio-lead (orchestrator)  │   │  brief → scaffold → tokens → layout → │
│  importer · builder · content    │   │  assets → compose → BUILD(astro) →    │
│  a11y-qa · hosting-ops           │   │  WCAG GATE → preview → publish        │
│  +reuse vibe-designer,           │   │  import normalizes → same Astro WS    │
│   media-producer, design-system  │   │  workspace: .magent/artifacts/        │
└───────────────┬──────────────────┘   └───────────┬───────────────────────────┘
                │ build output (dist/) copied to ↓  │
┌───────────────▼───────────────────────────────────▼──────────────────────────┐
│  HOSTING LAYER (on-box, same VPS)                                             │
│  registry .magent/state/hosted_sites.json   site tree /opt/ai-os/sites/<dom>/ │
│   releases/<id>/  + current→symlink (atomic swap, zero-downtime, rollback)    │
│  nginx static vhost per site · preview subdomains · per-site rate-limit zone  │
│  ── ROOT BOUNDARY: 3 sudoers-allowlisted scripts only ──                      │
│     site-vhost.sh   site-cert.sh   site-remove.sh   (domain-regex validated)  │
│  certbot webroot auto-TLS · existing certbot-renewal.timer reused             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**How they fit:**
- **Single source of truth for source** = `.magent/artifacts/web-studio/{siteId}/src/`. Both AI edits and Monaco edits mutate these files; a build is *always* triggered from disk, never from in-memory diffs.
- **Single source of truth for site count** = `web_studio_workspaces.json` length (excluding `status:'failed'`). Never counted from nginx vhosts (those drift).
- **The build→gate→deploy pipeline is unified**: creation, import, AI-edit, and Monaco-edit all converge on `enqueueBuild(siteId)` → Astro build → `/api/design-system/lint` gate → atomic symlink swap. No second code path.
- **The hosting layer is the substrate below Web Studio.** Web Studio writes built output and calls the hosting API/scripts; it never touches `/etc/nginx` or runs certbot directly. The privilege boundary is the load-bearing security invariant.
- **Registry split, reconciled (D1):** app-level record `web_studio_workspaces.json` is authoritative for the UI and limit; infra-level `hosted_sites.json` is authoritative for what nginx serves. The hosting layer owns `hosted_sites.json`; the app reads it for live/TLS status — one writer each, no dual-write.

---

## 3. The Web Studio Agent Team

New department `web-studio` (`commercial/org-chart/departments.js`), auto-merged via the existing `server.js` org-chart spread. Five net-new agents + three reused (referenced, not duplicated, to avoid duplicate employee ids breaking `/api/hq/employee/:id`). EFFORT_ROUTING gets the five new names.

| Agent | New? | Tier / Effort | One-line role |
|---|---|---|---|
| **web-studio-lead** | NEW | strategic / xhigh | Department head: interprets brief, plans pages/IA, sequences the team, gates publish (prod custom-domain publish = human-approved). |
| **web-importer** | NEW | professional / high | Imports an existing site via GitHub clone or Firecrawl crawl into the editable Astro workspace; never invents content the source lacked. |
| **web-builder** | NEW | professional / high | Compiles design + tokens + copy + assets into a static Astro+Tailwind build; inlines tokens as CSS vars; runs design-lint, refuses `ready` on error-severity findings. |
| **content-writer** | NEW | professional / high | Production page copy, metadata, OpenGraph/Twitter tags, alt text — no lorem ipsum in final output. |
| **web-a11y-qa** | NEW | scout / low | Quality gate on *built* output: WCAG AA contrast, touch targets, broken links, responsive checks; blocks on error-severity. |
| vibe-designer | REUSE | creative (gemini-omni-flash) | Brief/URL → screens, tokens, heatmaps. |
| media-producer | REUSE | creative (gemini-omni-flash) | Hero images, social cards, 3D shots via Omni. |
| design-system | REUSE | professional / high | Token source + WCAG lint quality-gate route. |

Deploy agent named **`hosting-ops`** (tier professional): nginx vhost + certbot TLS + tier site-count enforcement + rollback, calling only the constrained root wrappers (never root directly).

SEO agents (`seo-keyword/technical/content`) are **not** roster members — `web-studio-lead` invokes them opportunistically on the pre-publish pass.

---

## 4. Per-Tier Feature Matrix

`tier-resolver.js` gains `limits.sites` (Community `1` / Business `10` / Enterprise `Infinity`) and a `webStudio*` flag family. **Load-bearing:** `sites:1` must be added to the **community fallback block** so core can read it even when no commercial module loads — otherwise the count read returns `undefined` and the limit silently bypasses.

| Capability | Community (1 site) | Business (10) | Enterprise (∞) | Enforced where |
|---|---|---|---|---|
| **Site count** | **1** | **10** | **∞** | `limits.sites`, checked in **core** on `POST /workspaces` |
| Create from brief (AI gen) | ✓ | ✓ | ✓ | core |
| Monaco editor + live preview | ✓ | ✓ | ✓ | core |
| AI natural-language editing | ✓ | ✓ | ✓ | core |
| Astro build → nginx static host | ✓ (1) | ✓ | ✓ | core build + hosting `site-vhost.sh` |
| Custom domain + auto-TLS | 1 domain *(D2)* | ✓ per site | ✓ per site | `webStudioCustomDomains` |
| Import (Firecrawl crawl) | ✗ | ✓ | ✓ | `webStudioImport` |
| Import (GitHub + providers) | ✗ | ✓ | ✓ | `webStudioImport` |
| WCAG quality gate | warn-only | **blocking** | **blocking** | `webStudioQualityGate` |
| Browser-agent visual QA | ✗ | ✓ | ✓ | `webStudioVisualQA` |
| SEO agent integration | manual | ✓ auto | ✓ auto | `unlimitedSeo` (existing) |
| Batch multi-site generation | ✗ | ✓ | ✓ | `batchQueue` (existing) |
| White-label / theming | ✗ | partial | full | `webStudioWhiteLabel` (+`isEnterprise` branch) |
| Client handoff (scoped sub-admin) | ✗ | ✓ | ✓ | `webStudioClientHandoff` |
| Per-site analytics | ✗ | basic | advanced | `webStudioAnalytics` |
| Codex cross-model code review | ✗ | ✗ | ✓ | `webStudioCodexReview` (`isEnterprise`) |

**Split decision (D0 — the central one):** **Option A — core base + commercial overlay.** The 1-site base (workspace CRUD, single build/publish, Monaco, NL-edit) lives in `server.js` core so Community gets its 1 site without loading any commercial module (preserving the existing "community loads zero commercial code" invariant at `commercial/index.js:57`). The `web-studio` commercial module adds everything multi-site and import-related, loaded only for Business+. Recommended over Option B (special-casing the community early-return to load the module everywhere), which ships commercial files to Community installs and breaks the open-core boundary.

---

## 5. Tool Integrations

| Existing tool | Wires in at | Reuse anchor |
|---|---|---|
| **Firecrawl** (`firecrawl_scrape/crawl/extract`) | Import (URL/crawl path) → `web-importer` | proven in `scout.md`, design-system `clone-url`; key at `settings.ai.firecrawl_api_key` |
| **Gemini Omni** (`callGemini`, `generateOmniResult`) | Brief→layout/copy; hero/OG/gallery assets via `/api/omni/generate type=image` | creative-studio pattern; `GEMINI_OMNI_MODEL` in ctx |
| **design-system WCAG linter** | The **mandatory deploy gate** — `/api/design-system/lint` on built HTML; error-severity blocks publish, warnings log | `commercial/modules/design-system`, `design-lint` skill |
| **design tokens** | Seed each build; inline as CSS custom props | `/api/design-system/tokens`, `clone-url` for brand-seed from a reference URL |
| **browser-agent** | Post-deploy visual/responsive QA + before/after thumbnails | `commercial/modules/browser-agent`, `features.browserAgent` |
| **SEO agents** (parallel pipeline) | Pre-publish opportunistic pass; inject og/meta into `<head>` | `seo-unlimited` `runRealSeoAudit` |
| **Codex cross-model review** | Enterprise `/codex-review` of generated HTML/JS | `/review` skill, `add-codex.sh` rig |
| **batchQueue** | Multi-site generation; doubles as the **build concurrency cap** | `ctx.batchQueue`, `features.batchQueue` |
| **Module/tier pattern** | Module skeleton + limit enforcement | `seo-unlimited/index.js` template; advanced-reporting `if(count>=limit) return 403` |
| **Hosting reuse** | ssl/gzip/dotfile-deny blocks, certbot timer, backup/healthcheck loops | `deploy/nginx.conf`, `install-vps.sh`, `backup.sh`, `healthcheck.sh` |

---

## 6. Phased Build Plan

### Phase 0 — MVP: the smallest end-to-end vertical slice

**Goal:** *brief → stunning static site → editable (AI + Monaco) → deploy → live on a custom domain with TLS,* for a single site, proving every layer of the stack once.

**In scope:**
1. **tier-resolver foundation** — add `limits.sites` (1/10/∞ incl. community-fallback `sites:1`) and `webStudio` flag. *(Load-bearing; everything gates on it.)*
2. **Hosting substrate** — `/opt/ai-os/sites/<domain>/` layout with `releases/` + atomic `current→` symlink; `hosted_sites.json` registry; the **three root scripts** `site-vhost.sh` / `site-cert.sh` / `site-remove.sh` with strict domain-regex validation; `/etc/sudoers.d/aios-hosting` (3-line allowlist, 440); the static vhost template; nginx read-perms model; serialized (mutex'd) root-script calls.
3. **Astro toolchain on the box** — `install-vps.sh` step: per-workspace Astro+Tailwind scaffold, build via `execFile` as `aios` with timeout + memory cap; single-flight build queue.
4. **Creation pipeline** — `POST /api/web-studio/workspaces {origin:'brief'}` → scaffold → tokens → `web-studio-lead`+`web-builder`+`content-writer` compose → `astro build` → **WCAG lint gate** → preview → publish.
5. **Editor (core of the MVP)** — Editor view: AI chat (`/ai-edit`), Monaco tree + read/write (`/files`, path-guarded), live-preview iframe; unified debounced `enqueueBuild` → lint → atomic deploy; edit history + revert snapshots.
6. **Publish + custom domain + TLS** — `/publish` (build-if-stale → deploy), `/domain` (DNS pre-check vs box IP — **mandatory** to avoid LE rate-limit burn), `site-cert.sh` webroot issuance, re-render `--tls` vhost.
7. **Sites list** with status + tier-limit badge; core `if (count >= limits.sites) return 403`.
8. **Agents** — `web-studio-lead`, `web-builder`, `content-writer`, `hosting-ops` + reused `vibe-designer`/`design-system`; team.yaml + `.md` files + EFFORT_ROUTING.

**Deliberately deferred out of MVP:** import (GitHub *and* Firecrawl), multi-site beyond the tier cap, wildcard preview-subdomain TLS (MVP uses per-domain HTTP-01; previews can be HTTP-only or share one pre-issued wildcard if DNS creds available), visual QA, SEO auto-pass, analytics, batch, white-label, client handoff, Codex review, rollback-to-arbitrary-build UI (keep last-N releases on disk for instant symlink rollback, expose UI later).

**MVP definition of done:** an operator types a brief, watches the site generate, edits it by chat and in Monaco with live preview, attaches `acme.com`, and the site is live over HTTPS on the same VPS — with the WCAG gate having blocked at least one bad build in testing.

### Phase 1 — Import + the rest of the editor surface
- **Import pipelines** (`web-importer`): GitHub clone + Firecrawl crawl, both normalizing to the **same Astro workspace**. Framework detection; reject/flag dynamic SSR frameworks (Next/Remix/SvelteKit) per static-only topology; dynamic-feature flagging for WP/Shopify snapshots.
- **Untrusted-build hardening** (gates GitHub import): default to **re-generate from extracted structure, never run the imported repo's npm scripts**; sandbox (firejail/bubblewrap) as the alternative.
- Publish/Deploy view: build-log streaming, rollback-to-prior-build UI, `hosted_deployments.json` audit trail.
- Domains/TLS view: DNS-verify endpoint, cert status, renewal hook writing `expiresAt` back.
- `backup.sh` + `healthcheck.sh` extended to cover `sites/` and loop `hosted_sites.json`.

### Phase 2 — Quality, QA, SEO
- Blocking quality gate as a **Business+ flag** (`webStudioQualityGate`); Community stays warn-only.
- `web-a11y-qa` agent + `/visual-qa` (browser-agent) with before/after thumbnails.
- SEO opportunistic pre-publish pass injecting og/meta.
- Per-site analytics — **beacon approach (D3)** injected into built `<head>`, aggregated server-side (no nginx-log parsing in v1).

### Phase 3 — Scale, multi-tenant, Enterprise
- Batch multi-site generation via `batchQueue`.
- White-label theming (Business partial / Enterprise full).
- **Client handoff** scoped sub-admin sessions — *largest net-new surface; the auth layer is single-admin today, so this is real auth work, not a flag.*
- Codex cross-model review (Enterprise) of generated code.
- Wildcard `*.<BASE_DOMAIN>` preview TLS via DNS-01 once provider creds are wired.

---

## 7. Key Risks & Open Decisions

**Decisions before Phase 0:**
- **D0 — Open-core split:** Option A (core base + commercial overlay, recommended) vs Option B (module loaded for all tiers).
- **D1 — Registry source of truth:** single-writer reconciliation (app owns `web_studio_workspaces.json`, hosting owns `hosted_sites.json`).
- **D2 — Community custom domain:** does the 1 Community site get a custom domain (matrix assumes yes), or subdomain-only?
- **D4 — Privilege bridge:** sudoers 3-script allowlist (recommended, matches `add-n8n.sh`/`add-codex.sh`) vs a root helper daemon over a Unix socket.
- **D5 — nginx read perms:** world-traverse (`o+x` on `/opt/ai-os/sites`) vs adding `www-data` to the `aios` group.
- **D6 — Preview-subdomain TLS:** per-domain HTTP-01 (MVP-simple) vs one pre-issued `*.<BASE_DOMAIN>` wildcard (needs DNS-provider creds).
- Phase-3: white-label Business-partial vs Enterprise-only; Codex review Enterprise-only vs Business add-on; client-handoff timing.

**Risks:**
- **[Highest — security] Untrusted build execution.** Imported GitHub repos can run malicious `postinstall`/build scripts as `aios` on the shared VPS. Mitigation: Phase-1 default = regenerate from extracted structure, never run imported scripts; sandbox if raw builds are required. This is why import is Phase 1, not MVP.
- **Privilege boundary integrity.** The only root surface is the 3 domain-validated scripts; they must be root-owned, mode 755, non-group-writable, with the regex enforced *inside the scripts* (not just Node) so a compromised app can't pass `; rm -rf` or `../../etc` through sudo.
- **Let's Encrypt rate limits** (50 certs/week/domain, 5 duplicate/week). The DNS pre-check before any cert attempt is **mandatory**.
- **nginx reload storms / symlink atomicity.** Serialize root-script calls behind a mutex; fully populate `releases/<id>` *before* the `ln -sfn` swap; never build into `current`.
- **Cert/vhost desync on partial failure.** If cert issues but `--tls` vhost fails `nginx -t`, leave the site HTTP-only, mark deploy `error`, retain cert for idempotent retry — never blind-rollback.
- **Build resource contention.** Astro builds compete with the live AI OS process; cap at 1–2 concurrent (reuse `batchQueue`); delete `node_modules`/`_import/` after build; per-site size cap (~200 MB) + total-`sites/` quota.
- **Monaco integration** is lazy-loaded CDN/vendored; server side only needs path-guarded read/write (`resolveSiteFile` rejecting `..`/absolute/dotfile escapes, reusing existing `BLOCKED_PATHS`).
- **"Live" preview is build-to-static, not HMR** — ~1–3 s incremental-rebuild→iframe-reload as the "live" experience.
- **Failed-site slot leak.** A mid-import failure must be reaped or excluded from the count, or it permanently consumes a tier slot.

**Verified codebase gaps (confirmed, not assumed):** `tier-resolver.js` has the `isBusiness` feature pattern but **no `sites` limit and no `webStudio` flag**; `commercial/index.js:57` **early-returns for community** (so the 1-site path must live in core per D0/Option A). Both addressed in Phase 0.
