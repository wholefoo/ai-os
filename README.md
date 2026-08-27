# AI OS — The Agentic Operating System

A multi-agentic AI operating system built as a Virtual Corporate Headquarters, orchestrating 70 specialized AI agents across 11 departments, powered by 6 AI models across 4 routing tiers. Research, create, analyze, scrape, build and host websites, run an SEO + AEO agency, manage clients, manage a governed document library, and monetize — all from a single dashboard. Self-hosted, single-customer, open-source core (Community edition) with commercial licenses: Business $1,997 one-time (all 70 agents, all production tools, self-instance theming) and Enterprise $4,997 one-time (everything in Business + SSO/SAML, advanced security, custom agents). All tiers run on your own infrastructure.

## Architecture

```
                    ┌─────────────────────────┐
                    │      Landing Page        │  Public
                    │   (Stripe Paywall)       │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    Virtual Corporate HQ  │  Authenticated
                    │   30+ navigable views    │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐      ┌───────▼───────┐      ┌───────▼───────┐
   │  CEO Atlas   │      │  Agent Fleet  │      │  Memory Vault │
   │(Opus 5 xh)│──────│  70 agents    │──────│  .magent/     │
   └──────────────┘      └───────────────┘      └───────────────┘
          │                      │
   ┌──────▼──────────────────────▼──────┐
   │     Effort-Based Model Routing     │
   ├──────────┬─────────┬──────┬────────┤
   │ Opus 5 │ Opus4.8 │Opus  │Gemini  │
   │  xhigh   │  high   │ low  │ Omni   │
   │Strategic  │  Pro    │Scout │Creative│
   ├──────────┼─────────┼──────┼────────┤
   │DeepSeek  │ Grok-3  │Hermes│        │
   │ Economy  │Realtime │Persist│       │
   └──────────┴─────────┴──────┴────────┘
```

## Virtual Corporate Headquarters

AI OS presents its agent fleet as a virtual company with named employees, departments, and reporting lines:

| Department | Employees | Key Roles |
|---|---|---|
| **Executive Office** | 4 | CEO (Atlas), CTO (Nova), CFO (Ledger), COO (Meridian) |
| **Board of Directors** | 3 | Quality Director, Security Director, Research Director |
| **Engineering** | 5 | Engineering Lead, QA, Data Engineer, Automation, DevOps |
| **Marketing & Communications** | 6 | Marketing Director, Communications Director (Herald), Content Lead, SEO Lead, Social Manager, Sales Director |
| **Creative Studio** | 6 | Creative Director, UI/UX Designer, Video Producer, 3D Artist, Audio Engineer, Brand Designer |
| **Customer Service** | 3 | Support Lead, Tier 1, Tier 2 |
| **Tech Support & IT** | 3 | IT Director, SysAdmin, Help Desk |
| **Product & Innovation** | 3 | Product Manager, Research Analyst, Data Scientist |
| **Operations & Hermes** | 6 | Hermes Director, Scheduler, Compliance Officer, Scout, Batch Processor, Intel Analyst |
| **Knowledge & Records** | 4 | Chief Librarian (Athena), Archivist (Vellum), Knowledge Manager (Archive), Sync Steward (Tether) |
| **Legal Department** | 4 | General Counsel (Justice), Compliance Officer (Shield), Licensing Attorney (Covenant), Contract Specialist (Clause) |

Each virtual employee maps to an AI agent with a specific model tier, can receive dispatched tasks, and reports through a corporate hierarchy. The org chart above names the ~56 department-facing roles (including the seven LLM provider consultants and the Communications Director in Product & Marketing); the remaining ~11 are system and orchestration agents (e.g. orchestrator, safety, synthesis, factory, hosting-ops, web-studio-lead) plus the SEO Agency sub-agents and external-model worker agents (DeepSeek, Grok). The full fleet of 70 agents is broken down by model tier in **Agent Fleet** below.

## Features

### Core Intelligence
- **Knowledge Graph** — Auto-categorizing knowledge base with semantic connections and visual radial graph
- **Design System** — DESIGN.md dual-structure protocol, WCAG linter, brand clone from URL
- **Tech Radar** — Automated intelligence sweeps with proposal system and upgrade tracking
- **Continuous Loops** — CRON-scheduled autonomous routines with rate limiting
- **Adversarial Verification** — Agent deliverables pass a skeptic-panel stage where independent verifiers try to refute each finding before it ships, catching plausible-but-wrong output
- **Cross-Model Review** — A second-model review seat (OpenAI Codex / GPT-5.6) independently checks code and findings for verification diversity — distinct from the Claude work tiers, never used for production work

### SEO + AEO Agency
- **Automated SEO Audits** — 7 parallel sub-agents (Keyword, Technical, Competitor, Content, Backlink, AEO, Local SEO)
- **AEO Readiness (Answer-Engine Optimization)** — Optimizes a site to be ready for AI answer engines (ChatGPT, Perplexity, Google AI Overviews) with a deterministic 8-dimension readiness score and multi-model consensus. AEO is readiness/optimization, not a guarantee of citations or rankings.
- **Local SEO / Google Business Profile Audit** — Scores GBP completeness (hours, photos, description, category, claim status), review signals, and local-pack ranking for the business's niche keyword — the dimension that matters most for local businesses. Runs automatically when auditing a domain sourced from Local Prospecting (using the exact listing already in hand); non-local sites without a GBP are excluded from the composite rather than scored as a misleading zero.
- **Composite Scoring** — Site health score out of 100 with severity-coded findings
- **Post-Audit Actions** — Content brief generation, 12-week content calendar, meta tag optimizer
- **DataForSEO Integration** — Real keyword, backlink, and competitor data

### AI Web Studio
- **Design + Build** — Prompt-driven static-site generation with an 11-type section library (hero, features, prose, CTA, contact, testimonials, pricing, FAQ, stats, team, steps), design clone from a URL, a no-code content editor, and a guided 6-question brief mode
- **Starter Templates** — Curated built-in templates plus save-your-own; the AI anchors to the template's structure and tailors all copy to your brief
- **Premium Model Option** — Any build can run on Claude Fable 5 (Anthropic's most capable model) as an opt-in upgrade
- **Sales Funnels** — A Funnel site type generates landing → offer → thank-you with purchase CTAs deterministically wired to your Stripe Payment Link (the platform never touches the money)
- **Dynamic Pages** — One template page + a pasted dataset → N static pages at build time ({{placeholders}} substituted; e.g. a service page per city), all included in the sitemap, llms.txt, and structured data
- **Lead Capture → CRM** — Contact sections on hosted sites render a real form (no JS required, honeypot-protected); submissions land in the CRM and in the site's own lead inbox
- **Site Manager** — every site gets a Manage tab: status/domain/traffic/lead overview, the lead inbox, and one-click actions into analytics, audits, editing, and export
- **Agent-Ready Output** — Every site ships JSON-LD (incl. FAQPage built from its visible FAQ content), a curated llms.txt, AI-crawler-allowing robots.txt, a sitemap, and an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle at /knowledge/ describing the site for AI agents
- **Host on the VPS** — Generated sites are hosted directly on the platform's own infrastructure
- **Custom Domains + TLS** — Bring your own domain with automatic Let's Encrypt certificates
- **Import / Export** — Import existing sites (ZIP/tar upload or GitHub clone, host-as-is) and export any site (ZIP download or GitHub push)
- **Tap into AI OS** — Sites auto-route across the agent fleet so models and agents continuously optimize them against AI OS's own AEO scorer

### AI Business Clones
A clone is a replica of one specific person — their voice, expertise, decision style and hard limits — built by interviewing them, not by filling in a form. It is **not an agent**: an agent is function-first (it exists to do a job), a clone is person-first (what it knows and refuses to say *is* the product). Agents are the tools a clone uses.

**The company profile comes first.** It is a separate record from any clone and gates every clone including the founder's — the facts and limits every clone on the instance inherits. Build it by typing, or upload what the business already has written down (`.txt`, `.md`, `.csv`, `.docx`, `.xlsx`) and accept what AI OS reads out of it field by field. Extraction can only ever *add* a limit, never remove or loosen one, and every accepted value records which document it came from.

- **Draft-only.** The clone produces text, a person reviews it, the person sends it. Nothing here sends.
- **Boundaries enforced twice** — compiled into the prompt and checked against the generated output in code. A topic the owner reserves is screened *before* any model call, so it costs nothing to refuse.
- **Company limits merge at the point of use**, never copied into a persona. An employee can add stricter limits for themselves; they cannot remove the company's, because those were never in the record they edit.
- **Teams** (Business/Enterprise) — invite colleagues and each builds their own clone, one per person. The employer sees the work their clones produced, never their persona.
- **Responsibility map** — who handles what, defined once for the company, so overlaps, unowned escalation topics and areas pointing at someone who has left are all detectable. Escalations route to whoever owns the topic rather than always to the owner.
- **Directing agents** — a clone can commission work from a restricted allowlist of agents whose output comes back as text, and can pick the specialist itself from a stated goal. It cannot direct anything that deploys, publishes or sends; a reserved topic blocks the request itself; and every run passes the same approval gate as an operator-initiated action.
- **Limits per instance**, not per person: 1 on Community, 10 on Business, 25 on Enterprise.

### CRM + Client Management
- **CRM** — node:sqlite-backed contact/account store with live ingest seams, notes, edits, and linking
- **AI Helpdesk (Contact Page)** — the public contact page is a documentation-grounded support agent: visitors submit email + subject + problem and get an instant answer from the docs in a multi-turn thread; anything it can't resolve is logged to the CRM for human follow-up. Visitor input is prompt-injection-fenced, and the support email is not exposed (Enterprise priority channel only)
- **Client-Account Management** — Operators manage client accounts from the dashboard
- **Scoped Client Workspace** — Each client gets a scoped workspace dashboard: their sites, their SEO/AEO audits, their site analytics, and their lead inbox — isolated server-side from every other tenant
- **Lead Pipeline** — Hosted-site contact forms feed the CRM live (contact + activity per submission, with site/page attribution)
- **Pipeline Kanban** — Drag-and-drop pipeline board across the funnel stages (lead → audited → onboarding → customer); every move is validated server-side and logged as a stage-change activity on the contact's timeline
- **Email Nurture Sequences** — New leads auto-enroll in operator-authored (or AI-drafted, human-reviewed) email sequences with per-step delays. Sends go through the Auto-Mode approval gate, retry safely, and every email carries a one-click unsubscribe + List-Unsubscribe header by construction. Bring a Resend API key or any SMTP server
- **Google Maps Local Prospecting** — Find local businesses in any niche + area via API (DataForSEO or Google Places — never scraped) and score each for managed-website fit: no website or a Facebook-page-as-website marks the hottest prospects. Best-effort public-email discovery from the business's own site; email-bearing prospects flow into the CRM, the rest are call-first leads. Cold prospects are never auto-emailed
- **Appointment Booking** — Generated sites can include a real booking section (no JavaScript required): the platform is the availability source of truth (business hours, horizon, conflicts), confirmed bookings land in the CRM, enroll in matching sequences, and the visitor gets a confirmation email with a calendar (.ics) invite. Cancelling from the dashboard notifies the visitor automatically

### First-Party Analytics (AI-Signal-First)
- **The traffic Google Analytics can't see** — AI crawlers don't execute JavaScript; AI OS reads the origin server's own logs, so GPTBot, ClaudeBot, PerplexityBot, Bytespider & co. are first-class citizens: live activity feed, engine leaderboard (training vs search-index vs live user-triggered fetches), and per-page crawl heat
- **Per-Site Attribution** — a vhost-aware log format buckets every request under the hosted site that served it; owners see their own site's analytics in their workspace
- **Answer-Engine Referrals** — human visitors arriving FROM ChatGPT, Perplexity, Gemini, and Copilot are classified separately from classic search/social
- **Cookieless + First-Party** — no tags, no consent banners, no third-party phone-home; visitor estimates use a daily-rotating hash that is unlinkable across days by construction

### Content Provenance
- **Ed25519-Signed Provenance** — Generated sites carry cryptographically signed provenance metadata
- **C2PA-Vocabulary-Aligned** — Uses C2PA vocabulary for interoperability; this is NOT certified C2PA
- **Re-Sign on Rebuild** — Provenance is regenerated and re-signed whenever a site is rebuilt

### Auto-Mode Approval Gating
- **Human-in-the-Loop** — Irreversible or outward-facing actions are server-enforced behind an approval gate; agents propose, a human approves before execution
- **Risk-Scored Actions** — Each action is risk-scored, with secrets stripped from the audit trail
- **Agent-Buyable Offers** — High-impact purchases (e.g. the Managed Website add-on) route through the gate rather than running unattended

### Self-Improve (Grok Build)
- **Grok Build (the dev-architect-grok agent)** — Plans upgrades to this platform and can propose a distribution blueprint as a draft PR against this repo. Every apply and every PR always requires explicit human approval, regardless of Auto-Mode setting.

### Security Suite (Opt-In)
- **AI Security Self-Assessment** — STRIDE threat-model + [semgrep](https://semgrep.dev) static analysis + an AI blue-team review loop, run on demand or on a schedule from an operator **Security dashboard** (driven by the [mythos-defense](https://github.com/wholefoo/mythos-defense) engine). **Report-only** — it surfaces findings and patch *recommendations*, and never auto-patches the live system
- **Web Studio Publish Gate** — every generated or imported site is security-scanned (read-only) before it goes live; configurable `off` / `warn` / `block`
- **Managed-Client Security Service** — per-client security assessments recorded as a CRM deliverable and shown in the client's own "Site Security" workspace view
- *AI-assisted, report-only — not a security guarantee. OFF by default; requires Python 3.11+, the mythos-defense CLI, and semgrep installed and enabled.*

### YouTube Video Intelligence
- **Visual Frame Analysis** — Extracts frames at configurable intervals and sends to Claude Vision API
- **Transcript Extraction** — Pulls spoken-word transcripts with timestamps
- **Cross-Modal Insights** — Identifies what Claude Vision sees that the transcript misses (on-screen code, diagrams, UI demos)
- **Frame-by-Frame Timeline** — Scene descriptions, detected elements, and OCR text per frame
- **Full Report** — Summary, key topics, content type classification, technical level, and actionability scoring

### Web Intelligence
- **Tavily** — AI-optimized search with structured results and citations (1,000 free credits/month)
- **Apify** — Platform-specific scraping with 25,000+ pre-built actors (YouTube, Google Maps, Amazon, LinkedIn, etc.)
- **Firecrawl** — Clean single-page markdown extraction, site crawling, and page interaction

### Creative Studio (Gemini Omni)
- **Video Generation** — Text/image/audio to video with physics simulation
- **Image Creation & Editing** — Any-to-image generation and editing
- **Audio & Voiceover** — Natural speech, music, and sound effects
- **Thumbnail Generation** — Platform-optimized thumbnails with A/B variants
- **Social Clips** — Long content to short-form vertical video

### Media & Marketing
- **Media Production** — Gemini Omni creative pipeline with progress streaming
- **Vibe Design Studio** — Prompt-driven UI generation with predictive heat maps
- **3D Production** — Blender MCP text-to-3D environments and product renders
- **Marketing Hub** — End-to-end content pipelines with multi-platform distribution

### Monetization
- **Product Factory** — AI-generated digital products published to Etsy and Gumroad
- **Lead Generation** — Automated scraping, enrichment, scoring, and personalized outreach
- **Golden Loop** — Gemini Gems synced to NotebookLM notebooks in real time
- **Predictive Analytics** — AI-estimated forecasts with confidence scores
- **Batch Queue** — Mass content production at economy-tier cost

### Legal Department
- **General Counsel** — License agreements, IP protection, regulatory compliance, dispute resolution
- **Compliance Officer** — GDPR/CCPA enforcement, audit trails, policy monitoring
- **Licensing Attorney** — Software license agreements, software-licensing terms, SaaS licensing
- **Contract Specialist** — Contract generation, review, lifecycle management, template library

### Knowledge & Records
A governed company document library — not a fourth physical store, but a catalog over the ones that already exist (the Memory Vault, extracted uploads, and agent-output artifacts). Every agent on every tier reads it, so it has no trusted tier: content only ever reaches an agent inside the same fenced, untrusted-by-default envelope the rest of the platform uses for outside data.
- **Chief Librarian (Athena)** — Taxonomy authority, cross-department lookup, routing, retention decisions
- **Archivist (Vellum)** — Intake, format handling, dedupe, metadata, and versioning over the existing document-extraction pipeline
- **Knowledge Manager (Archive)** — Knowledge ingestion, semantic linking, and graph visualization
- **Sync Steward (Tether)** — Source-change detection and knowledge-base re-sync
- **Reader-Scoped Access** — Every record carries an allowlist of who — and which agents — may read it, plus retention and legal-hold flags before disposal
- **Canonical-Facts Shelf** — Product facts (agent count, department count, pricing) become one governed record every caller reads, so the number lives in one place instead of drifting across copies

### Licensing (Open-Core Model)

**Community Edition (Free)** — Open-source core, self-hosted with custom domain support. Perpetual, royalty-free license for personal and commercial use. Includes 19 agents, 6 departments, Scout + Professional effort tiers, **1 hosted site**, **1 SEO audit/month**, Knowledge & Records library, Knowledge Graph, Tech Radar, and community support via GitHub Issues. Must retain "Powered by AI OS" attribution. You provide your own API keys and are responsible for hosting, security, and backups. [Full license](/docs/license-community)

**Business License ($1,997 one-time)** — Everything in Community plus all 70 agents, all 11 departments, all 6 AI models (4 routing tiers), **up to 100 hosted sites**, unlimited SEO + AEO audits, AI Web Studio, Gemini Omni Creative Studio, YouTube Intelligence, Agent Builder, CRM + client-account management, self-instance theming (brand your own private instance with custom name, logo, colors, and domain — no attribution required), lead generation, product factory, marketing hub, advanced reporting, browser agent, Grok Intel, design system, video meetings, and batch queue. Priority email support included. Self-hosted, single-customer license (one production deployment per key). Lifetime software updates. 14-day refund policy. [Full license](/docs/license-business)

**Enterprise License ($4,997 one-time)** — Everything in Business plus **unlimited hosted sites**, SSO/SAML integration, advanced security configurations, custom agent development assistance (up to 5 custom agents in Year 1), early access to new features, and a deployment architecture review. Upgrade from Business: $3,000 difference. [Full license](/docs/license-enterprise)

**Managed Website (done-for-you, agent-buyable)** — Hands-off option for clients who don't want to self-host: $997 one-time setup + $250/month hosting & maintenance. AI OS designs, builds, and hosts your site on the VPS (custom domain + TLS included) and keeps it maintained. Purchasable directly by an agent through Auto-Mode (gated by human approval).


All tiers are self-hosted — you run on your own infrastructure with your own domain and API keys. Custom domain support is included in every self-hosted tier (the free hosted demo is the only exception).

### Hermes Agent (Persistent MCP)
- **Walkaway Mode** — Delegate tasks that run autonomously in the background
- **Approval Gate** — Risk-scored actions require human approval before execution
- **CRON Jobs** — Persistent scheduled tasks managed through MCP
- **Always-On Worker** — Background processing without active browser session

### Interactive Tour Guide
- **Atlas avatar** — animated floating widget on landing page with pulsing glow
- **Guided tours** — visitors choose topics (Overview, SEO, Creative, Pricing, Models)
- **Free-text input** — keyword matching routes typed questions to relevant tour paths
- **Quick reply buttons** — contextual options after each tour segment
- **Typing animation** — bot-style message bubbles with progressive disclosure
- **Auto-attention** — bouncing animation after 5 seconds to invite engagement

### Infrastructure
- **Admin Dashboard** — Settings page for all API keys, MCP connections, and account management
- **Stripe Checkout** — Business ($1,997) and Enterprise ($4,997) one-time license payments, plus the Managed Website offer ($997 setup + $250/mo)
- **Auth System** — bcrypt password hashing, session cookies, Bearer token fallback, admin roles
- **Security** — Helmet CSP, CORS, rate limiting, input validation
- **Notifications** — Dashboard (WebSocket), Telegram Bot API, Slack Incoming Webhooks
- **Documentation Hub** — 14 sub-pages covering architecture, agents, skills, deployment, and more
- **VPS Deployment** — One-command install script, PM2, Nginx with TLS

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 + Express |
| Dashboard | Vanilla HTML/CSS/JS with WebSocket live updates |
| AI Models | 6 providers: Claude Opus 5 (default, effort routing), OpenAI GPT, Gemini Omni Flash, DeepSeek V4, Grok-3 (xAI), Perplexity — across 4 routing tiers; plus opt-in Z.ai GLM (GLM-5.2) in the multi-model consensus |
| Web Scraping | Firecrawl, Apify (25K+ actors), Tavily (AI search) |
| Video Analysis | yt-dlp + ffmpeg + Claude Vision API |
| SEO Data | DataForSEO API |
| Payments | Stripe Checkout + Webhooks |
| Auth | bcryptjs, cookie-parser, session-based + Bearer token |
| Agent definitions | Markdown with YAML frontmatter |
| Memory | File-based (.magent/) with JSON state persistence |
| Security | Helmet, CORS, express-rate-limit, compression |
| Security scanning (opt-in) | semgrep (SAST) + mythos-defense CLI bridge — STRIDE threat-model + AI blue-team loop; report-only; requires Python 3.11+ |
| Deployment | PM2, Nginx, Let's Encrypt |

## For Users

AI OS follows an open-core model. The Community edition is free and open-source — self-host on your own server. Commercial licenses unlock advanced features.

| Plan | Price | Hosting | Access |
|---|---|---|---|
| Free Demo | $0 | Hosted at aiosorchestrationlab.com | Limited preview, 3 agents, 1 SEO audit/mo |
| Community | Free | Self-hosted | 19 agents, 6 departments, 1 hosted site, 1 SEO audit/mo, full source code |
| Business | $1,997 one-time | Self-hosted | All 70 agents, up to 100 hosted sites, unlimited SEO + AEO audits, all production tools, self-instance theming |
| Enterprise | $4,997 one-time | Self-hosted | Everything in Business + unlimited hosted sites, SSO/SAML, advanced security, custom agents |
| Managed Website | $997 setup + $250/mo | Done-for-you on the VPS | We design, build, host & maintain your site (custom domain + TLS); agent-buyable via Auto-Mode |

---

## Admin Documentation (Private)

> **Everything below is for platform administration.** This is the open-source Community core. The commercial/enterprise modules live in a **separate private repo** (`ai-os-commercial`) that mounts at `./commercial/`; without them the app runs at the Community tier (`lib/commercial-stub.js`).

### Local Development

```bash
# Public open-source core (Community tier)
git clone https://github.com/wholefoo/ai-os.git
cd ai-os && npm install
cp .env.example .env   # Edit with your API keys

# OPTIONAL — licensed/operator builds only: mount the private commercial modules at ./commercial/
# (requires access to the private repo). Without it the app runs at the Community tier.
git clone https://github.com/wholefoo/ai-os-commercial.git commercial

npm start              # http://localhost:3000
```

### Admin Login

The admin account is seeded on first run from `.env`:

```env
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD_HASH=$2b$12$...   # Generate: node -e "require('bcryptjs').hash('password',12).then(console.log)"
```

### Production Deployment (PM2 + Nginx)

```bash
# On your VPS (Ubuntu 22.04/24.04)
sudo bash deploy/install-vps.sh yourdomain.com
# Licensed deployments: mount the private commercial modules (needs a deploy key / token on the VPS)
sudo -u aios git -C /opt/ai-os clone https://github.com/wholefoo/ai-os-commercial.git commercial
sudo nano /opt/ai-os/.env          # Add API keys (+ AIOS_LICENSE_KEY / AIOS_SIGNING_SECRET)
sudo certbot --nginx -d yourdomain.com
sudo -iu aios pm2 restart ai-os --update-env   # -iu, not -u — see "Push Updates" below
curl -s https://yourdomain.com/api/health | jq .
```

### Push Updates

```bash
# Pull BOTH repos (public core + private commercial) as the owning user, then restart.
# `git` takes -u; pm2 takes -iu. pm2 finds its daemon via $HOME, and plain `sudo -u` leaves HOME as
# root's — so it reads /root/.pm2, finds an empty registry, and reports "Process or Namespace not
# found" as though the app name were wrong, while the OLD code keeps serving.
ssh root@your-vps-ip 'sudo -u aios git -C /opt/ai-os pull origin master && sudo -u aios git -C /opt/ai-os/commercial pull origin master && sudo -iu aios pm2 restart ai-os --update-env'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | `development` or `production` |
| `DEMO_MODE` | No | `true` for simulated data (default: true) |
| `API_TOKEN` | Prod | Bearer token for API auth — grants **admin** (service principal) on protected routes; keep it secret and rotate on exposure |
| `ADMIN_EMAIL` | Yes | Admin login email |
| `ADMIN_PASSWORD_HASH` | Yes | bcrypt hash of admin password |
| `ANTHROPIC_API_KEY` | For AI | Claude Opus 5 API key (all effort tiers) |
| `GEMINI_API_KEY` | For AI | Google Gemini API key (Omni creative tier) |
| `DEEPSEEK_API_KEY` | For AI | DeepSeek V4 economy tier |
| `ZAI_API_KEY` | For AI | Z.ai GLM (default GLM-5.2) — opt-in provider in the multi-model consensus |
| `XAI_API_KEY` | For AI | Grok-3 realtime tier |
| `FIRECRAWL_API_KEY` | For AI | Firecrawl web scraping |
| `TAVILY_API_KEY` | For AI | Tavily AI-optimized search |
| `APIFY_API_TOKEN` | For AI | Apify platform scraping (YouTube, Maps, etc.) |
| `DATAFORSEO_LOGIN` | For SEO | DataForSEO account email |
| `DATAFORSEO_PASSWORD` | For SEO | DataForSEO API password |
| `STRIPE_SECRET_KEY` | Payments | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Payments | Stripe webhook signing secret |
| `STRIPE_BUSINESS_PRICE_ID` | Payments | Stripe price ID for Business license ($1,997) |
| `STRIPE_ENTERPRISE_PRICE_ID` | Payments | Stripe price ID for Enterprise license ($4,997) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `SLACK_WEBHOOK_URL` | No | Slack notifications |
| `HERMES_MCP_URL` | No | Hermes MCP server URL (default: http://127.0.0.1:8420) |

## Project Structure

```
.claude/
  agents/        70 agent role definitions (YAML frontmatter + instructions)
  skills/        22 procedural skill files
  rules/         Guardrails, cost routing, security
  identity/      Soul, user preferences, personality
  pipelines/     Declarative YAML skill chains
  projects/      Per-project context overrides
.magent/
  vault/         Knowledge base (raw, wiki, outputs)
  state/         Persisted runtime state (settings, audits, users)
  team.yaml      Agent roster and escalation paths
dashboard/
  index.html     Public landing page
  app.html       Authenticated dashboard (30+ views)
  css/           Landing, docs, and dashboard styles
  js/            Landing and dashboard scripts
  docs/          14 documentation sub-pages
deploy/
  install-vps.sh One-command VPS provisioning (Ubuntu)
  push-update.sh Local-to-VPS update script
  nginx.conf     Reverse proxy with TLS, WS, rate limiting
server.js        Express + WebSocket backend (~9000 lines)
ecosystem.config.js  PM2 process manager config
```

## Agent Fleet — 6 AI Models across 4 Routing Tiers

All 70 agents run on **6 AI models** routed through **4 effort/routing tiers**. Claude Opus
4.8 is the default and runs the three Claude tiers (one model at three effort levels —
Strategic/xhigh, Professional/high, Scout/low); the remaining models are routed in for
specialized work. Five additional providers are wired in: OpenAI GPT, Gemini Omni,
DeepSeek V4, Grok (xAI), and Perplexity.

| Routing Tier | Model(s) | Effort | Count | Role |
|------|-------|--------|-------|------|
| Strategic | Claude Opus 5 | xhigh | 6 | Orchestration, architecture, critical review, security audit, Web Studio lead, knowledge taxonomy |
| Professional | Claude Opus 5 | high | 45 | Research, coding, writing, SEO/AEO, marketing, support, IT, legal, compliance, hosting ops, creative direction, communications, document archiving |
| Scout | Claude Opus 5 | low | 3 | Fast lookups, triage, scheduled monitoring, social intel |
| Specialized | Gemini Omni / DeepSeek V4 / Grok 4.5 / Grok Build | — | 9 | Creative media (5, Gemini Omni), bulk economy processing (2, DeepSeek V4), realtime web search (1, Grok 4.5), platform-upgrade planning (1, Grok Build) |
| LLM Consultants | Each provider's own model | high | 7 | On-site provider consultants (Anthropic, OpenAI, Gemini, DeepSeek, Grok, Perplexity, Manus) — release intelligence + AI OS adoption guidance, each answering on its own provider's model |
| **Total** | | | **70** | |

OpenAI GPT and Perplexity are additionally available across these tiers — GPT as an
alternate work/routing model and Perplexity for cited live-web answers. Hermes MCP is the
persistence layer (background / walkaway execution) that any tier routes into — it's
infrastructure, not a separate model or agent count.

**Z.ai (GLM)** is wired as an opt-in, bring-your-own-key provider (OpenAI-compatible; default
model GLM-5.2). Add a `ZAI_API_KEY` in Settings and it joins the **multi-model consensus /
Share-of-Model** AEO checks — it is not part of the default agent routing, so Claude Opus 5
remains the default for all agent work.

### SEO Agency Sub-Agents

The 7 SEO sub-agents (Keyword, Technical, Competitor, Content, Backlink, AEO, Local SEO) are part
of the Professional tier above — grouped here for the SEO audit pipeline.

## API

80+ endpoints. Key routes:

```
GET  /api/health                    Health check
POST /api/auth/login                Login
GET  /api/hq/org                    Full org chart
GET  /api/hq/stats                  HQ summary stats
POST /api/hq/dispatch/:employeeId   Dispatch task to virtual employee
GET  /api/settings                  Settings (masked keys)
PUT  /api/settings/:section         Update settings
POST /api/settings/test/:service    Test API connection
POST /api/seo/audit                 Launch SEO audit
POST /api/seo/briefs/:id            Generate content briefs
POST /api/seo/calendar/:id            Generate content calendar
POST /api/seo/meta/:id              Optimize meta tags
POST /api/omni/generate             Gemini Omni creative generation
GET  /api/omni/capabilities         List generation types
POST /api/youtube/analyze           Launch YouTube video analysis
GET  /api/youtube/analyses          List all video analyses
GET  /api/youtube/analysis/:id      Full analysis with frames + transcript
GET  /api/tenant/branding            Current instance branding (public)
POST /api/branding                   Update instance branding (admin)
POST /api/platform/propose           Self-improvement proposal
GET  /api/platform/proposals         List proposals
POST /api/grok/query                Real-time Grok query
POST /api/hermes/delegate           Delegate to Hermes
GET  /api/stripe/checkout?plan=pro  Start Stripe checkout
```

## Roadmap (Phase 5 — Platform Expansion)

| Feature | Description | Status |
|---------|-------------|--------|
| Mobile App / PWA | Progressive Web App with offline support, push notifications, native-feel on iOS and Android | Planned |
| Webhook Integrations Marketplace | Browse and install pre-built webhook integrations (Zapier, Make, Slack, HubSpot, Salesforce, etc.) | Planned |
| Plugin / Extension System | Typed SDK for building custom agent tools — extend any agent with new capabilities and data sources | Built |
| Advanced Reporting | Scheduled PDF/CSV reports, custom dashboards, date-range comparisons, executive summaries | Built |
| Video Avatar Meetings | Face-to-face video calls with AI employees via Gemini Omni real-time video — screen sharing, whiteboarding, multi-agent roundtables | Built |

## Documentation

Full documentation at `/docs` when the server is running, covering architecture, agents, skills, deployment, billing, and all subsystems.

## License

Proprietary. All rights reserved.
