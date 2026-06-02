# AI OS — The Agentic Operating System

A multi-agentic AI operating system built as a Virtual Corporate Headquarters, orchestrating 51 specialized sub-agents across 10 departments and 7 model tiers. Research, create, analyze, scrape, and monetize — all from a single dashboard. Available as a white-label SaaS license — Pro $99/mo, Business $497/mo, Enterprise $1,997/mo, or Lifetime $9,997 one-time (limited to 200 spots).

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
   │(Opus 4.8 xh)│──────│  47 agents    │──────│  .magent/     │
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

## Virtual Corporate Headquarters

AI OS presents its agent fleet as a virtual company with named employees, departments, and reporting lines:

| Department | Employees | Key Roles |
|---|---|---|
| **Executive Office** | 4 | CEO (Atlas), CTO (Nova), CFO (Ledger), COO (Meridian) |
| **Board of Directors** | 3 | Quality Director, Security Director, Research Director |
| **Engineering** | 5 | Engineering Lead, QA, Data Engineer, Automation, DevOps |
| **Marketing & Sales** | 5 | Marketing Director, Content Lead, SEO Lead, Social Manager, Sales Director |
| **Creative Studio** | 6 | Creative Director, UI/UX Designer, Video Producer, 3D Artist, Audio Engineer, Brand Designer |
| **Customer Service** | 3 | Support Lead, Tier 1, Tier 2 |
| **Tech Support & IT** | 3 | IT Director, SysAdmin, Help Desk |
| **Product & Innovation** | 4 | Product Manager, Research Analyst, Data Scientist, Knowledge Manager |
| **Operations & Hermes** | 6 | Hermes Director, Scheduler, Compliance Officer, Scout, Batch Processor, Intel Analyst |
| **Legal Department** | 4 | General Counsel (Justice), Compliance Officer (Shield), Licensing Attorney (Covenant), Contract Specialist (Clause) |

Each virtual employee maps to an AI agent with a specific model tier, can receive dispatched tasks, and reports through a corporate hierarchy.

## Features

### Core Intelligence
- **Knowledge Graph** — Auto-categorizing knowledge base with semantic connections and visual radial graph
- **Design System** — DESIGN.md dual-structure protocol, WCAG linter, brand clone from URL
- **Tech Radar** — Automated intelligence sweeps with proposal system and upgrade tracking
- **Continuous Loops** — CRON-scheduled autonomous routines with rate limiting

### SEO Agency
- **Automated SEO Audits** — 5 parallel sub-agents (Keyword, Technical, Competitor, Content, Backlink)
- **Composite Scoring** — Site health score out of 100 with severity-coded findings
- **Post-Audit Actions** — Content brief generation, 12-week content calendar, meta tag optimizer
- **DataForSEO Integration** — Real keyword, backlink, and competitor data

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
- **Licensing Attorney** — Software license agreements, white-label terms, SaaS licensing
- **Contract Specialist** — Contract generation, review, lifecycle management, template library

### White-Label Licensing
- **4 tiers** — Pro ($99/mo), Business ($497/mo), Enterprise ($1,997/mo), Lifetime ($9,997 one-time)
- **Application pipeline** — apply, review, approve, payment, activate
- **Stripe checkout** — subscription and one-time payment integration
- **White-label branding** — custom name, logo, colors, domain per licensee
- **Admin management** — status tracking, tenant provisioning, revenue dashboard
- **No franchise law** — standard software license, no FDD, no state registration required

### Hermes Agent (Persistent MCP)
- **Walkaway Mode** — Delegate tasks that run autonomously in the background
- **Approval Gate** — Risk-scored actions require human approval before execution
- **CRON Jobs** — Persistent scheduled tasks managed through MCP
- **Always-On Worker** — Background processing without active browser session

### Interactive Tour Guide
- **Atlas avatar** — animated floating widget on landing page with pulsing glow
- **Guided tours** — visitors choose topics (Overview, SEO, Creative, Franchise, Pricing, Models)
- **Free-text input** — keyword matching routes typed questions to relevant tour paths
- **Quick reply buttons** — contextual options after each tour segment
- **Typing animation** — bot-style message bubbles with progressive disclosure
- **Auto-attention** — bouncing animation after 5 seconds to invite engagement

### Infrastructure
- **Admin Dashboard** — Settings page for all API keys, MCP connections, and account management
- **Stripe Paywall** — Pro ($49/mo) and Enterprise ($199/mo) subscriptions
- **Auth System** — bcrypt password hashing, session cookies, Bearer token fallback, admin roles
- **Security** — Helmet CSP, CORS, rate limiting, input validation
- **Notifications** — Dashboard (WebSocket), Telegram Bot API, Slack Incoming Webhooks
- **Documentation Hub** — 14 sub-pages covering architecture, agents, skills, deployment, and more
- **VPS Deployment** — One-command install script, PM2, Nginx with TLS

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + Express |
| Dashboard | Vanilla HTML/CSS/JS with WebSocket live updates |
| AI Models | Claude Opus 4.8 (effort routing), Gemini Omni Flash, DeepSeek V4, Grok-3 |
| Web Scraping | Firecrawl, Apify (25K+ actors), Tavily (AI search) |
| Video Analysis | yt-dlp + ffmpeg + Claude Vision API |
| SEO Data | DataForSEO API |
| Payments | Stripe Checkout + Webhooks |
| Auth | bcryptjs, cookie-parser, session-based + Bearer token |
| Agent definitions | Markdown with YAML frontmatter |
| Memory | File-based (.magent/) with JSON state persistence |
| Security | Helmet, CORS, express-rate-limit, compression |
| Deployment | PM2, Nginx, Let's Encrypt |

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

## Production Deployment (PM2 + Nginx)

```bash
# On your VPS (Ubuntu 22.04/24.04)
sudo bash deploy/install-vps.sh yourdomain.com

# Edit .env with your API keys
sudo nano /opt/ai-os/.env

# Get TLS certificate
sudo certbot --nginx -d yourdomain.com

# Restart with production config
sudo -u aios pm2 restart ai-os --update-env

# Verify
curl -s https://yourdomain.com/api/health | jq .
```

### Push Updates

```bash
# From your local machine
bash deploy/push-update.sh root@your-vps-ip
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
| `TAVILY_API_KEY` | For AI | Tavily AI-optimized search |
| `APIFY_API_TOKEN` | For AI | Apify platform scraping (YouTube, Maps, etc.) |
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

## Project Structure

```
.claude/
  agents/        51 agent role definitions (YAML frontmatter + instructions)
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
  install-vps.sh One-command VPS provisioning (Ubuntu)
  push-update.sh Local-to-VPS update script
  nginx.conf     Reverse proxy with TLS, WS, rate limiting
server.js        Express + WebSocket backend (~6000 lines)
ecosystem.config.js  PM2 process manager config
```

## Agent Fleet — 7 Model Tiers

| Tier | Model | Effort | Count | Role |
|------|-------|--------|-------|------|
| Strategic | Opus 4.8 | xhigh | 6 | Deep reasoning, architecture, code review, legal counsel |
| Professional | Opus 4.8 | high | 23 | Research, coding, writing, support, IT, licensing, compliance |
| Scout | Opus 4.8 | low | 4 | Fast lookups, triage, routine running |
| Creative | Gemini Omni | — | 5 | Video, image, audio generation |
| Economy | DeepSeek V4 | — | 2 | Bulk text processing |
| Realtime | Grok-3 | — | 1 | Live web search, trending topics |
| Persistent | Hermes MCP | — | 3 | Background tasks, walkaway mode |

### SEO Agency Sub-Agents (5)

Keyword Analysis, Technical Audit, Competitor Analysis, Content Analysis, Backlink Profile

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
POST /api/seo/calendar/:id          Generate content calendar
POST /api/seo/meta/:id              Optimize meta tags
POST /api/omni/generate             Gemini Omni creative generation
GET  /api/omni/capabilities         List generation types
POST /api/youtube/analyze           Launch YouTube video analysis
GET  /api/youtube/analyses          List all video analyses
GET  /api/youtube/analysis/:id      Full analysis with frames + transcript
GET  /api/license/info               License program info (public)
POST /api/license/apply              Submit license application
GET  /api/license/participants       List all licensees (admin)
PUT  /api/license/participant/:id    Update licensee status
POST /api/license/checkout/:id       Generate Stripe payment link
GET  /api/license/stats              License revenue dashboard
GET  /api/tenants                    List all tenants (admin)
POST /api/tenants                    Provision new tenant
GET  /api/tenant/branding            Current tenant branding (public)
GET  /api/templates                  Industry templates
POST /api/platform/propose           Self-improvement proposal
GET  /api/platform/proposals         List proposals
POST /api/grok/query                Real-time Grok query
POST /api/hermes/delegate           Delegate to Hermes
GET  /api/stripe/checkout?plan=pro  Start Stripe checkout
```

## Documentation

Full documentation at `/docs` when the server is running, covering architecture, agents, skills, deployment, billing, and all subsystems.

## License

Proprietary. All rights reserved.
