# Built-in Analytics Panel — AI-Signal-First Design

Status: DESIGN (not yet implemented) · Owner: platform · Scope: public core (`lib/analytics/` + dashboard panel)

## 1. Why build this (and why not GA)

Google Analytics has a structural blind spot that matters more every month: **AI crawlers and answer-engine fetchers do not execute JavaScript**, so GPTBot, ClaudeBot, PerplexityBot and friends are *invisible* to GA by design. For a platform whose product line is AEO, the most valuable traffic signal — "which AI engines are reading which pages, how often, and what do they do with it" — can only be seen server-side. We own the server. GA also brings cookie-consent baggage, sampled data, and a third-party dependency that conflicts with the self-hosted moat.

Positioning: **first-party, cookieless, AI-signal-first analytics** — traditional web metrics as the baseline, AI visibility as the differentiator. This is a feature GA cannot copy without our vantage point (origin logs + the AEO toolchain we already ship).

## 2. Signal taxonomy

### A. AI crawl signals (from nginx access logs — the GA-invisible layer)
- **Bot hits by engine and purpose.** Classify user-agents against a maintained registry (reuse + extend the AI-crawler list from the AEO robots-allowlist feature, `lib/aeo`):
  - *Training crawlers*: GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended, Meta-ExternalAgent, Bytespider, Amazonbot
  - *Search/index crawlers*: OAI-SearchBot, Claude-SearchBot, PerplexityBot, Bingbot, DuckAssistBot
  - *Live user-triggered fetchers* (a human asked an AI about you **right now**): ChatGPT-User, Claude-User, Perplexity-User, Gemini fetches, copilot
- **Per-page crawl heat**: which URLs each engine fetches most — this is the engines telling us which content they consider answer-worthy.
- **Crawl freshness**: time since each engine last fetched each key page. Stale crawl = stale answers about the client.
- **Bot hygiene**: robots.txt fetches, 404s served to bots, llms.txt fetches (an explicit AEO signal), status-code mix per bot.

### B. AI referral signals (humans arriving FROM answer engines)
- Referrer/UTM classification: `chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, plus `utm_source=chatgpt.com` (ChatGPT now appends this).
- This is the conversion side of AEO: crawl signals show engines *reading*; referrals show engines *sending buyers*.

### C. Existing AEO instruments (integrate, don't rebuild)
- **Share-of-Model citation tracker** (already shipped, admin-only): citation share per engine over time, per tracked domain → becomes a panel card.
- **AEO readiness score** (8-dim scorer, already shipped): score trend per site → panel card. Correlate: "AEO score went up → GPTBot crawl frequency followed."

### D. Traditional baseline (from beacon + logs)
Pageviews, unique visitors (privacy-safe estimate, see §5), top pages, top referrers, country (from Cloudflare `CF-IPCountry` header — free, no geo-IP DB), device class, 404s. Enough to sanity-check against GA's "other perspective" — not trying to out-feature GA on its own turf.

## 3. Collection architecture (two sources, one store)

```
nginx access logs ──► log ingester (Node, offset-tracked tail) ──┐
  (bots + all HTML hits; assets are access_log off = free noise filter)
                                                                 ├─► lib/analytics/db.js (node:sqlite)
dashboard + hosted sites ──► 1KB beacon ──► POST /api/collect ───┘      raw events (30d) + hourly/daily rollups
  (human-only signals: referrer, screen, SPA views)                        │
                                                        SSE broadcast ◄───┘ (live feed to panel)
```

**Source A — log ingester** (`lib/analytics/ingest-logs.js`). Periodically (30s) reads new bytes from `/var/log/nginx/access.log` (+ per-site vhost logs if we later split them), tracking a byte offset in state so restarts don't double-count. Parses the combined format (has referrer + UA), classifies UA against the bot registry, maps vhost/Host → Web Studio site for multi-tenant attribution. Bots don't run JS — **this is the only source that sees them**, and it's also the fallback for humans who block scripts. Runs on the VPS only (dev mode: no-op with a fixture file for tests).

**Source B — beacon** (`dashboard/js/collect.js`, ~1KB inline). Cookieless `navigator.sendBeacon('/api/collect', {path, ref, w})`. Injected into Web Studio builds behind a per-site toggle (default ON for managed clients, disclosed in the site's privacy note) and into the platform's own pages. Respects DNT/GPC. Rate-limited, origin-checked, drops bodies over 1KB.

**Cloudflare notes** (prod is behind CF): real IP from `CF-Connecting-IP`, country from `CF-IPCountry`. HTML is not cached by CF by default, so origin logs see page hits — asset hits are cached away, but assets are `access_log off` anyway, so nothing is lost. One action item: verify CF's bot-fight settings aren't blocking the AI crawlers we *want* (would show up as their absence in our own panel — the panel itself becomes the diagnostic).

## 4. Storage

`lib/analytics/db.js` following the `lib/crm/db.js` node:sqlite pattern. Tables:
- `events_raw(ts, site_id, kind, bot, bot_purpose, path, status, ref_class, ref, country, visitor_hash)` — 30-day retention, nightly prune.
- `rollup_hourly` / `rollup_daily(site_id, bucket, metric, key, count)` — kept indefinitely (tiny), all charts read rollups.
- Rollup job runs on the existing scheduler cadence; raw events only feed the live view and the rollup.

## 5. Privacy posture (the anti-GA angle, and the SOC 2 story)

No cookies, no localStorage, no fingerprinting, no PII rows. Uniques via `sha256(daily_salt + CF-Connecting-IP + UA)` where the salt rotates every 24h and is never persisted — visitor identity is unlinkable across days by construction. DNT/GPC honored. This makes the beacon deployable on client sites without consent banners in most jurisdictions (state honestly: "designed for consent-free deployment; not legal advice" — route wording past the legal agents like the provenance feature did).

## 6. API + panel

Routes (`/api/analytics/*`, session-gated): `GET /summary?site&range`, `GET /ai-crawlers?site&range`, `GET /referrals`, `GET /pages`, `GET /live` (SSE via existing `broadcast`). Multi-tenant scoping mirrors Web Studio: admin sees all sites; clients see their own (`wsOwns` pattern — 404 not 403 cross-tenant).

Panel (new "Analytics" dashboard view), cards in priority order:
1. **AI Activity Live Feed** — "PerplexityBot fetched /pricing · 12s ago" (SSE; this is the demo moment)
2. **AI Engine Leaderboard** — hits by engine, split training / search / live-fetch, with WoW deltas
3. **Crawl Heat** — pages ranked by AI fetch count, per engine filter
4. **Answer-Engine Referrals** — human arrivals from ChatGPT/Perplexity/etc. vs. classic search/social/direct
5. **Crawl Freshness** — days since last fetch of key pages per engine, stale flagged
6. **Share-of-Model** — citation share trend (existing tracker's data)
7. **Traditional row** — pageviews, uniques, top pages/referrers, countries
8. **AEO Score ↔ Crawl correlation** — score trend overlaid with crawl frequency (P2)

## 7. Tiering (follows product canon; final call with pricing truth)

- **Free/Starter**: traditional row + 7-day retention.
- **Pro**: + AI crawl & referral signals, 90-day rollups.
- **Business/Enterprise**: + Share-of-Model card, crawl-freshness alerts (Hermes daily digest via scout/sysadmin skill), white-label client reports, full retention.

## 8. Phasing

- **P0 — see the invisible** (core value, ~1 session): bot registry + log ingester + sqlite store + Analytics panel with cards 1–3 for the platform's own site. No beacon yet.
- **P1 — multi-tenant + humans**: vhost→site attribution for Web Studio sites, beacon + `/api/collect`, cards 4 & 7, client-scoped access, per-site toggle.
- **P2 — AEO flywheel**: cards 5, 6, 8; Hermes daily "AI visibility digest"; freshness alerts; tier gating.
- **P3 — reports**: white-label monthly PDF/HTML for managed clients (agentic-commerce upsell material).

## 9. Risks & open questions

- **Log access**: the Node process needs read access to nginx logs (group `adm` membership or a logrotate-aware copy step) — same constrained-privilege philosophy as the hosting bridge; no new sudo surface.
- **Bot spoofing**: anyone can fake a GPTBot UA. P0 ships UA-only (honest labeling: "reported identity"); P2 can add reverse-DNS/IP-range verification for the big engines (OpenAI/Anthropic/Perplexity publish ranges).
- **Logrotate**: offset tracking must detect rotation (inode change → reset offset). Handled in ingester from day one.
- **CF cache drift**: if CF is later configured to cache HTML, origin logs go blind for humans (bots too). Beacon covers humans; document the constraint.
- **Not a GA replacement** for e-commerce funnels/attribution modeling — deliberately out of scope; say so in the marketing copy to keep the product-canon honest.
