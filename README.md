# AI OS — The Agentic Operating System

A multi-agentic AI operating system that orchestrates 39 specialized sub-agents across 7 model tiers to execute complex workflows autonomously. Research, create, analyze, and monetize — all from a single dashboard.

## Architecture

```
                    ┌─────────────────────────┐
                    │      Landing Page        │  Public
                    │   (Stripe Paywall)       │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       Dashboard          │  Authenticated
                    │   30+ navigable views    │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐      ┌───────▼───────┐      ┌───────▼───────┐
   │ Orchestrator │      │  Agent Fleet  │      │  Memory Vault │
   │(Opus 4.8 xh)│──────│  39 agents    │──────│  .magent/     │
   └──────────────┘      └───────────────┘      └───────────────┘
          │                      │
   ┌──────▼──────────────────────▼──────┐
   │     Effort-Based Model Routing     │
   ├──────────┬─────────┬──────┬────────┤
   │ Opus 4.8 │ Opus4.8 │Opus  │Gemini  │
   │  xhigh   │  high   │ low  │ Omni   │
   │Strategic  │  Pro    │Scout │Creative│
   ├──────────┼─────────┼──────┼────────┤
   │DeepSeek  │ Grok-3  │Hermes│        │
   │ Economy  │Realtime │Persist│       │
   └──────────┴─────────┴──────┴────────┘
```

## Features

### Core Intelligence
- **Knowledge Graph** — Auto-categorizing knowledge base with semantic connections and visual radial graph
- **Design System** — DESIGN.md dual-structure protocol (reasoning + tokens), WCAG linter, brand clone from URL
- **Tech Radar** — Automated intelligence sweeps with proposal system and upgrade tracking
- **Continuous Loops** — CRON-scheduled autonomous routines with rate limiting

### SEO Agency
- **Automated SEO Audits** — 5 parallel sub-agents (Keyword, Technical, Competitor, Content, Backlink)
- **Composite Scoring** — Site health score out of 100 with severity-coded findings
- **Content Brief Generation** — Keyword-targeted briefs with outlines and word counts
- **12-Week Content Calendar** — Phased action plan from audit findings
- **Meta Tag Optimizer** — Before/after title and description recommendations
- **DataForSEO Integration** — Real keyword, backlink, and competitor data

### Creative Studio (Gemini Omni)
- **Video Generation** — Text/image/audio to video with physics simulation
- **Image Creation & Editing** — Any-to-image generation and editing
- **Audio & Voiceover** — Natural speech, music, and sound effects
- **Thumbnail Generation** — Platform-optimized thumbnails with variants
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

### Hermes Agent (Persistent MCP)
- **Walkaway Mode** — Delegate tasks that run autonomously in the background
- **Approval Gate** — Risk-scored actions require human approval before execution
- **CRON Jobs** — Persistent scheduled tasks managed through MCP
- **Always-On Worker** — Background processing without active browser session

### Infrastructure
- **Admin Dashboard** — Settings page for all API keys, MCP connections, and account management
- **Stripe Paywall** — Pro ($49/mo) and Enterprise ($199/mo) subscriptions
- **Auth System** — bcrypt password hashing, session cookies, Bearer token fallback, admin roles
- **Security** — Helmet CSP (with `script-src-attr`), CORS, rate limiting, input validation
- **Notifications** — Dashboard (WebSocket), Telegram Bot API, Slack Incoming Webhooks
- **Documentation Hub** — 14 sub-pages covering architecture, agents, skills, deployment, and more
- **Deployment** — PM2, Nginx with TLS, Docker, VPS install script

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + Express |
| Dashboard | Vanilla HTML/CSS/JS with WebSocket live updates |
| AI Models | Claude Opus 4.8 (effort routing), Gemini Omni Flash, DeepSeek V4, Grok-3 |
| Web Scraping | Firecrawl API |
| SEO Data | DataForSEO API |
| Payments | Stripe Checkout + Webhooks |
| Auth | bcryptjs, cookie-parser, session-based + Bearer token |
| Agent definitions | Markdown with YAML frontmatter |
| Memory | File-based (.magent/) with JSON state persistence |
| Security | Helmet, CORS, express-rate-limit, compression |
| Deployment | PM2, Nginx, Docker, Let's Encrypt |

## Quick Start

```bash
# Clone
git clone https://github.com/wholefoo/ai-os.git
cd ai-os

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Run
npm start
# Dashboard at http://localhost:3000
```

### First Login

The admin account is seeded on first run using the credentials in `.env`:

```env
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD_HASH=$2b$12$...   # Generate with: node -e "require('bcryptjs').hash('yourpassword',12).then(console.log)"
```

Navigate to `http://localhost:3000`, click Login, and enter your credentials.

## Production Deployment

### Option 1 — PM2 + Nginx (Recommended)

```bash
# On your VPS
sudo bash deploy/install-vps.sh yourdomain.com

# Then
cd /opt/ai-os
npm install --production
cp .env.example .env && nano .env
pm2 start ecosystem.config.js --env production
pm2 save

# Get TLS
sudo certbot --nginx -d yourdomain.com
```

### Option 2 — Docker

```bash
docker compose up -d
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | `development` or `production` |
| `DEMO_MODE` | No | `true` for simulated data (default: true) |
| `API_TOKEN` | Prod | Bearer token for API auth |
| `ADMIN_EMAIL` | Yes | Admin login email |
| `ADMIN_PASSWORD_HASH` | Yes | bcrypt hash of admin password |
| `ANTHROPIC_API_KEY` | For AI | Claude Opus 4.8 API key (all effort tiers) |
| `GEMINI_API_KEY` | For AI | Google Gemini API key (Omni creative tier) |
| `DEEPSEEK_API_KEY` | For AI | DeepSeek V4 economy tier |
| `XAI_API_KEY` | For AI | Grok-3 realtime tier |
| `FIRECRAWL_API_KEY` | For AI | Firecrawl web scraping |
| `DATAFORSEO_LOGIN` | For SEO | DataForSEO account email |
| `DATAFORSEO_PASSWORD` | For SEO | DataForSEO API password |
| `STRIPE_SECRET_KEY` | Payments | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Payments | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | Payments | Stripe price ID for Pro plan |
| `STRIPE_ENTERPRISE_PRICE_ID` | Payments | Stripe price ID for Enterprise |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `SLACK_WEBHOOK_URL` | No | Slack notifications |
| `HERMES_MCP_URL` | No | Hermes MCP server URL (default: http://127.0.0.1:8420) |
| `N8N_WEBHOOK_BASE` | No | n8n automation webhook base URL |
| `N8N_API_KEY` | No | n8n API key |

## Project Structure

```
.claude/
  agents/        39 agent role definitions (YAML frontmatter + instructions)
  skills/        21 procedural skill files
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
  nginx.conf     Reverse proxy with TLS and WS upgrade
  install-vps.sh One-command VPS provisioning
server.js        Express + WebSocket backend (~5500 lines)
```

## Agent Fleet — 7 Model Tiers

| Tier | Model | Effort | Agents | Role |
|------|-------|--------|--------|------|
| Strategic | Opus 4.8 | xhigh | Orchestrator, Architect, Reviewer, Security Auditor | Deep reasoning, architecture, code review |
| Professional | Opus 4.8 | high | Researcher, Coder, Writer, Design System, Lead Gen, Marketing Hub, Product Factory, Knowledge Graph, Golden Loop, Synthesis, Automator, Browser Agent, Report Compiler, Research Architect, Data Wrangler, QA | Balanced quality/speed for most work |
| Scout | Opus 4.8 | low | Scout, Social Intel, Routine Runner | Fast lookups, lightweight tasks |
| Creative | Gemini Omni | — | Media Producer, Vibe Designer, Video Creator, Audio Producer, Thumbnail Gen | Video, image, audio generation |
| Economy | DeepSeek V4 | — | DeepSeek Worker, Batch Runner | Bulk text processing |
| Realtime | Grok-3 | — | Grok Realtime | Live web search, trending topics |
| Persistent | Hermes MCP | — | Hermes Delegate, Hermes Cron, Hermes Approval Gate | Background tasks, walkaway mode |

### SEO Agency Sub-Agents

| Agent | Role |
|-------|------|
| SEO Keyword | Keyword research, gap analysis, cannibalization detection |
| SEO Technical | Crawl analysis, Core Web Vitals, HTTP status, security |
| SEO Competitor | Top 10 competitor profiling, content velocity, schema adoption |
| SEO Content | Content inventory, thin content detection, topic clusters |
| SEO Backlink | Referring domains, toxicity detection, broken link recovery |

## API

60+ endpoints across all features. Key routes:

```
GET  /api/health                    Health check (agents, skills, uptime)
GET  /api/agents                    List all agents
GET  /api/skills                    List all skills
POST /api/auth/login                User login (bcrypt + session cookie)
GET  /api/auth/me                   Current session info

# Settings (admin)
GET  /api/settings                  Get settings (masked keys)
PUT  /api/settings/:section         Update settings section
POST /api/settings/test/:service    Test API connection

# SEO Agency
POST /api/seo/audit                 Launch full SEO audit (5 parallel agents)
GET  /api/seo/audits                List all audits
GET  /api/seo/audit/:id             Full audit detail with findings
POST /api/seo/briefs/:id            Generate content briefs from audit
POST /api/seo/calendar/:id          Generate 12-week content calendar
POST /api/seo/meta/:id              Generate optimized meta tags
POST /api/seo/report/:id            Generate PDF report

# Gemini Omni Creative
POST /api/omni/generate             Multimodal content generation
GET  /api/omni/capabilities         List generation types and formats

# Hermes Agent
GET  /api/hermes/status             Hermes connection status
POST /api/hermes/delegate           Delegate task to Hermes
GET  /api/hermes/approvals          Pending approval requests
POST /api/hermes/walkaway           Start walkaway mode session

# Core Features
POST /api/grok/query                Real-time Grok query
POST /api/design-system/clone-url   Clone brand from URL
POST /api/media/produce             Start media production
POST /api/batch                     Queue batch generation
POST /api/leads/scrape              Start lead scraping
GET  /api/stripe/checkout?plan=pro  Start Stripe checkout
```

## Documentation

Full documentation is available at `/docs` when the server is running:

- Getting Started
- Architecture & Model Routing
- Agent Fleet & Definitions
- Skills Library
- Knowledge Graph
- Design System
- Media Production
- Monetization
- Batch Queue
- API Reference
- Deployment Guide
- Billing & Subscriptions
- Notifications
- Hermes Agent

## License

Proprietary. All rights reserved.
