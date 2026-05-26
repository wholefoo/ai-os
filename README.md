# AI OS — The Agentic Operating System

A multi-agentic AI operating system that orchestrates 25+ specialized sub-agents to execute complex workflows autonomously. Research, create, analyze, and monetize — all from a single dashboard.

## Architecture

```
                    ┌─────────────────────────┐
                    │      Landing Page        │  Public
                    │   (Stripe Paywall)       │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       Dashboard          │  Authenticated
                    │   16+ navigable views    │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐      ┌───────▼───────┐      ┌───────▼───────┐
   │ Orchestrator │      │  Agent Fleet  │      │  Memory Vault │
   │   (Opus)     │──────│  25+ agents   │──────│  .magent/     │
   └──────────────┘      └───────────────┘      └───────────────┘
          │                      │
   ┌──────▼──────────────────────▼──────┐
   │        Multi-Model Routing          │
   ├─────────┬──────────┬───────┬───────┤
   │  Opus   │  Sonnet  │ Haiku │DeepSk │ Grok
   │Strategic│  Pro     │ Scout │Economy│ Realtime
   └─────────┴──────────┴───────┴───────┘
```

## Features

### Phase 1 — Core Intelligence
- **Knowledge Graph** — Auto-categorizing knowledge base with semantic connections and visual radial graph
- **Design System** — DESIGN.md dual-structure protocol (reasoning + tokens), WCAG linter, brand clone from URL, cross-platform export
- **Media Production** — Remotion video, Google Vids, Blender 3D from natural language prompts
- **Continuous Loops** — CRON-scheduled autonomous routines with rate limiting

### Phase 2 — Monetization
- **Product Factory** — AI-generated digital products published to Etsy and Gumroad
- **Lead Generation** — Automated scraping, enrichment, scoring, and personalized outreach
- **Marketing Hub** — End-to-end content pipelines with multi-platform distribution
- **Golden Loop** — Gemini Gems synced to NotebookLM notebooks in real time

### Phase 3 — Creative Studio
- **Vibe Design Studio** — Prompt-driven UI generation with predictive heat maps
- **3D Production** — Blender MCP text-to-3D environments and product renders
- **Predictive Analytics** — AI-estimated forecasts with confidence scores
- **Batch Queue** — Mass content production at economy-tier cost

### Infrastructure
- **Stripe Paywall** — Pro ($49/mo) and Enterprise ($199/mo) subscriptions
- **Auth System** — Session-based login with cookie auth
- **Security** — Helmet CSP, CORS, rate limiting, input validation, Bearer token API auth
- **Notifications** — Dashboard (WebSocket), Telegram Bot API, Slack Incoming Webhooks
- **Deployment** — PM2, Nginx with TLS, Docker, VPS install script

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + Express |
| Dashboard | Vanilla HTML/CSS/JS with WebSocket live updates |
| AI Models | Claude Opus/Sonnet/Haiku, DeepSeek V4, Grok-3 |
| Payments | Stripe Checkout + Webhooks |
| Agent definitions | Markdown with YAML frontmatter |
| Memory | File-based (.magent/) with JSON state persistence |
| Security | Helmet, CORS, express-rate-limit, cookie-parser |
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
# Edit .env with your API keys and Stripe credentials

# Run
npm start
# Dashboard at http://localhost:3000
```

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
| `API_TOKEN` | Prod | Bearer token for API auth |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | Yes | Stripe price ID for Pro plan |
| `STRIPE_ENTERPRISE_PRICE_ID` | Yes | Stripe price ID for Enterprise plan |
| `ANTHROPIC_API_KEY` | For AI | Claude API key |
| `DEEPSEEK_API_KEY` | For AI | DeepSeek API key |
| `XAI_API_KEY` | For AI | Grok/xAI API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `SLACK_WEBHOOK_URL` | No | Slack notifications |

## Project Structure

```
.claude/
  agents/        31 agent role definitions
  skills/        19 procedural skill files
  rules/         Guardrails, cost routing, security
  identity/      Soul, user preferences, personality
  pipelines/     Declarative YAML skill chains
  projects/      Per-project context overrides
.magent/
  vault/         Knowledge base (raw, wiki, outputs)
  state/         Persisted runtime state
  team.yaml      Agent roster and escalation paths
dashboard/
  index.html     Public landing page
  app.html       Authenticated dashboard
  css/           Landing, legal, and dashboard styles
  js/            Landing and dashboard scripts
deploy/
  nginx.conf     Reverse proxy with TLS and WS upgrade
  install-vps.sh One-command VPS provisioning
server.js        Express + WebSocket backend (~3800 lines)
```

## Agent Fleet

| Tier | Agents | Model |
|------|--------|-------|
| Strategic | Orchestrator, Architect, Reviewer, Security Auditor | Claude Opus |
| Professional | Researcher, Coder, Writer, Design System, Media Producer, Lead Gen, Marketing Hub, Product Factory, Vibe Designer, Blender 3D, Knowledge Graph, Golden Loop, Synthesis, Automator, Browser Agent, Report Compiler, Research Architect, Data Wrangler, QA | Claude Sonnet |
| Scout | Scout, Social Intel, Routine Runner | Claude Haiku |
| Economy | DeepSeek Worker, Batch Runner | DeepSeek V4 |
| Realtime | Grok Realtime | Grok-3 |

## API

40+ endpoints across all features. Key routes:

```
GET  /api/health                    Health check
GET  /api/agents                    List all agents
GET  /api/skills                    List all skills
POST /api/auth/login                User login
GET  /api/auth/me                   Current session
GET  /api/stripe/checkout?plan=pro  Start Stripe checkout
POST /api/grok/query                Real-time Grok query
POST /api/design-system/clone-url   Clone brand from URL
GET  /api/design-system/export      Export DESIGN.md
POST /api/media/produce             Start media production
POST /api/batch                     Queue batch generation
POST /api/leads/scrape              Start lead scraping
```

## License

Proprietary. All rights reserved.
