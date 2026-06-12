# AI OS Orchestration Lab — Project Brain

## Session Start (read these first)
1. **`.claude/SKILL-MAP.md`** — capability inventory: all agents, skills, and pipelines. Consult before assuming a capability is missing or building one that already exists.
2. **`.magent/vault/wiki/vault-map.md`** — memory table of contents. Consult before searching the vault blind or re-deriving stored knowledge.

Both maps are auto-generated (`npm run maps`) and refreshed by the server's session-context hook. Regenerate after adding/removing agents, skills, pipelines, or vault files.

## Mission
This is a multi-agentic AI Operating System that orchestrates specialized sub-agents to execute complex workflows autonomously. The system bridges the gap between technical AI tools and user accessibility through a visual dashboard.

## Architecture
- **Orchestrator**: Master agent that interviews users, writes specs, spawns sub-agents, routes tasks, and reviews outputs.
- **Agent Factory**: Deterministic generator that converts role specs into concrete agent files.
- **Worker Team**: Ephemeral specialized sub-agents that execute domain work.
- **Shared Memory**: `.magent/` directory acts as the team blackboard.

## Non-Negotiable Rules
1. Never write outside `.magent/artifacts/` until explicitly approved.
2. Every factual claim requires a citation or `[assumption]` label.
3. Planning mode is default — always plan before executing.
4. Irreversible actions require human confirmation.
5. All decisions append to `.magent/decisions.log`.
6. API keys and secrets are referenced by name, never read directly.
7. Think before coding — state assumptions, surface tradeoffs, ask if unclear.
8. Simplicity first — minimum code that solves the problem, nothing speculative.
9. Surgical changes — touch only what you must, match existing style.
10. Goal-driven execution — define success criteria, verify each step.

## Tech Stack
- Runtime: Node.js + Express
- Dashboard: Vanilla HTML/CSS/JS with WebSocket live updates
- Agent definitions: Markdown with YAML frontmatter
- Team config: YAML
- Memory: File-based (`.magent/`)
- Web Intelligence: Firecrawl MCP server (search, scrape, structured extraction)
- Execution Engines: Claude Code (Opus 4.8 across xhigh/high/low effort tiers), DeepSeek Tui (DeepSeek V4 economy tier)

## Execution Engines
The system uses a multi-engine architecture for cost-optimized task routing:
- **Claude Code** — Primary engine running Opus 4.8 across strategic (xhigh effort), professional (high effort), and scout (low effort) tasks
- **DeepSeek Tui** — Economy engine for bulk content, data processing, and batch operations via DeepSeek V4
- **Codex CLI** — Cross-model verification engine (gpt-5.5, read-only `reviewer` profile); used only for adversarial review seats and second-opinion code reviews, never production tasks. Headless calls must close stdin (`< NUL` on Windows, `< /dev/null` on Linux)
- Routing rules defined in `.claude/rules/cost-routing.md`
- Orchestrator auto-classifies tasks and routes to the cheapest capable engine

## MCP Servers
- **firecrawl** — Web crawling and structured data extraction for the Scout agent's Tech Radar sweeps. Provides `firecrawl_scrape`, `firecrawl_search`, `firecrawl_crawl`, `firecrawl_extract`, and `firecrawl_deep_research` tools. Configured in `.claude/settings.json`.

## Identity Layer (The "Soul")
Three-file identity stack that shapes all agent behavior:
- **`soul.md`** — Immutable guardrails: transparency, human sovereignty, evidence-based reasoning, privacy, cost consciousness
- **`user.md`** — Operator preferences: communication style (direct, technical), decision patterns (cost-focused, incremental), workflow preferences
- **`personality.md`** — Agent persona definitions: orchestrator voice, dashboard persona, inter-agent communication style, naming conventions
- Context inheritance: identity files are loaded before any agent interaction

## Verification Protocols (Plan-Execute-Verify)
Automated quality gates that validate agent outputs against configurable rubrics before delivery:
- **Rubric Library**: YAML-defined rubrics for 6 categories (default, research, marketing, security, sales, design)
- **Weighted scoring**: Each check has a weight (1-3), aggregate score determines verdict (PASS >= 80, REVIEW 60-79, FAIL < 60)
- **Inheritance**: Category rubrics inherit default checks plus add category-specific ones
- **Human override**: REVIEW verdicts route to operator for manual approve/reject
- **Execution integration**: Verifications can link to skill executions for end-to-end traceability
- **Dashboard view**: Score gauges, per-check results grid, category pass rates, rubric detail modals

## One-Click Skill Execution (Skill Launchpad)
Dashboard-integrated skill execution system that turns complex workflows into clickable buttons:
- **Parameter auto-parsing**: Extracts parameters, steps, and agent assignments from skill markdown files
- **Smart forms**: Generates input forms with dropdowns, number fields, toggles, and text inputs based on skill definitions
- **Category filtering**: Filter skills by research, marketing, sales, security, design, intelligence
- **Search**: Full-text search across skill names and descriptions
- **Execution tracking**: Real-time progress bars with step-by-step dot indicators and WebSocket updates
- **Parameter display**: Shows configured parameters as tags on completed executions
- **Dashboard integration**: Quick Actions on the main dashboard launch the same parameter-aware modals

## Context Inheritance (Project Contexts)
Parent-child configuration system that shapes agent behavior per project:
- **Global identity**: `.claude/identity/` files define baseline tone, rules, and persona
- **Project overrides**: `.claude/projects/*.yaml` files override tone, audience, domain terms, and rules per project
- **Context resolution**: Merges global identity + active project overrides at runtime — project settings win on conflict
- **Active context**: One project context is active at a time; agents inherit its overrides automatically
- **Domain terms**: Per-project glossary that agents reference for consistent terminology
- **Dashboard view**: Active context bar, project cards with override tags, resolved context preview grid

## Browser Agent (Playwright Automation)
Playwright-powered browser automation for web interaction tasks:
- **Task types**: navigate, extract, screenshot, form-fill, verify
- **Viewport options**: desktop (1920×1080), tablet (768×1024), mobile (375×812)
- **Wait strategies**: network idle, page load, selector visible
- **Safety**: Form submissions require HITL approval, never enters credentials, respects robots.txt
- **Rate limiting**: Max 1 request per 2 seconds, max 10 navigations per task
- **Artifacts**: Screenshots saved to `.magent/artifacts/screenshots/`, extracted data to `.magent/artifacts/extractions/`
- **Integration**: Works alongside Firecrawl (Firecrawl for data, browser-agent for interaction)

## Grok Real-Time Intelligence
Live intelligence engine powered by xAI's Grok model for time-sensitive queries:
- **Query types**: search (live web), trending (X/Twitter discourse), fact-check (cross-reference claims), monitor (ongoing watch)
- **Streaming**: Token-by-token response streaming via WebSocket to dashboard
- **Sources**: Each result includes cited sources with relevance scores and confidence ratings
- **Rate limiting**: 30 queries/hour with 5-minute cache deduplication
- **Cost tier**: "realtime" (Grok-3 at $5/M input, $15/M output), budgeted at 10% daily spend
- **Dashboard**: Live query console with streaming output, query history with expandable details, stats with rate limit tracking
- **Integration**: Complements scheduled social-intel sweeps with on-demand real-time queries

## Skill Chaining (Pipeline Engine)
Declarative YAML pipelines that chain skills and agents into multi-step workflows:
- **Pipeline definitions** in `.claude/pipelines/*.yaml` — stages, dependencies, gates, parameters
- **Available pipelines**: research-to-report (5 stages), content-pipeline (4 stages), security-sweep (4 stages)
- **Gate system**: Stages with `gate: blocking` or `gate: advisory` pause for human approval
- **Cost tracking**: Each pipeline stage logs token usage to the cost ledger automatically

## Notification System (HITL Push)
Multi-channel notification system with escalation timeouts:
- **Dashboard** — Always-on, real-time via WebSocket
- **Telegram** — Bot integration via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
- **Slack** — Webhook integration via `SLACK_WEBHOOK_URL`
- **Escalation** — Unanswered critical notifications auto-escalate after configurable timeout (default: 1 hour)

## Memory Vault (Persistent Knowledge System)
The vault prevents "context rot" by maintaining a structured, searchable knowledge store:
- **`.magent/vault/raw/`** — Unprocessed intake: meeting notes, web clippings, data dumps
- **`.magent/vault/wiki/`** — Synthesized knowledge: processed reports, decision records, agent roster
- **`.magent/vault/outputs/`** — Final deliverables: compiled reports, published documents
- **Session-start hooks**: Auto-load the most recent decisions and relevant wiki entries
- **Semantic search**: Full-text search across all vault files via `/api/vault/search`

## Cost Tracking
Real-time token usage and API spend monitoring across all execution engines:
- 4-tier tracking: Strategic (Opus 4.8 xhigh), Professional (Opus 4.8 high), Scout (Opus 4.8 low), Economy (DeepSeek)
- Budget alerts at 75% threshold with auto-downgrade recommendations
- Per-agent and per-skill cost attribution
- Daily/weekly/monthly budget caps configurable via API

## Knowledge Graph (Phase 1 — Core Intelligence)
Auto-organizing knowledge base that categorizes sources into types (wiki, docs, research, outputs, raw) and discovers semantic connections between them. Provides a visual radial graph in the dashboard.
- API: `/api/knowledge-graph`, `/api/knowledge-graph/stats`, `POST /api/knowledge-graph/auto-categorize`
- Agent: knowledge-graph (claude-opus-4-8)
- Skill: knowledge-categorize

## Design System Protocol (Phase 1 — Core Intelligence)
DESIGN.md-based universal token system with built-in WCAG linter. Defines color roles, typography scales, spacing grids, and border radii. Includes "Skills as Ingredients" for programmatic design feature generation.
- API: `/api/design-system`, `/api/design-system/tokens`, `POST /api/design-system/lint`
- Agent: design-system (claude-opus-4-8)
- Skill: design-lint

## Media Production Pipeline (Phase 1 — Core Intelligence)
Multi-engine media production: Remotion (programmable video as React code), Google Vids (prompt-to-production with consistent avatars), Blender MCP (text-to-3D environments). Template-driven with parameterized inputs.
- API: `/api/media/productions`, `/api/media/templates`, `/api/media/stats`, `POST /api/media/produce`
- Agent: media-producer (gemini-omni-flash)
- Skill: media-produce

## Continuous Loop Workflows (Phase 1 — Core Intelligence)
CRON-scheduled autonomous routines that run at defined intervals — ad variation generation, competitor price monitoring, analytics digests, content repurposing. Rate-limited with cooldowns and batch processing.
- API: `/api/routines`, `/api/routines/stats`, `PUT /api/routines/:id/toggle`, `POST /api/routines/:id/run`, `POST /api/routines`
- Agent: routine-runner (claude-opus-4-8, batch tier)

## Product Factory (Phase 2 — Monetization)
AI-generates high-ticket digital products (spreadsheets, Notion templates, toolkits) using Claude + openpyxl. Published to Etsy and Gumroad with SEO-optimized listings.
- API: `/api/products`, `/api/products/stats`, `/api/products/templates`, `POST /api/products`
- Agent: product-factory (claude-opus-4-8)

## Lead Generation Pipeline (Phase 2 — Monetization)
Automated scraping, enrichment, achievement discovery, and personalized outreach. Scores leads 0-100, generates custom messages referencing specific accomplishments.
- API: `/api/leads`, `/api/leads/stats`, `/api/leads/campaigns`, `POST /api/leads/scrape`, `POST /api/leads/:id/outreach`
- Agent: lead-gen (claude-opus-4-8)

## Marketing Hub (Phase 2 — Monetization)
End-to-end content pipelines — transforms source content into multi-platform distribution. Tracks channels, engagement, and growth. Content queue with scheduling.
- API: `/api/marketing/pipelines`, `/api/marketing/channels`, `/api/marketing/queue`, `/api/marketing/stats`, `POST /api/marketing/queue`
- Agent: marketing-hub (claude-opus-4-8)

## Golden Loop (Phase 2 — Monetization)
Connects Gemini Gems (custom AI personas) to NotebookLM notebooks for real-time sync. The AI expert always has access to the latest research and docs.
- API: `/api/golden-loop`, `/api/golden-loop/stats`, `POST /api/golden-loop/:id/sync`, `POST /api/golden-loop`
- Agent: golden-loop (claude-opus-4-8)

## Vibe Design Studio (Phase 3 — Creative Studio)
Prompt-driven UI generation replacing traditional wireframing. Accepts natural language, voice, sketches, and reference URLs. Generates screens with predictive heat maps and granular style controls.
- API: `/api/vibe-design/projects`, `/api/vibe-design/stats`, `/api/vibe-design/controls`, `POST /api/vibe-design/projects`, `POST /api/vibe-design/:id/heatmap`
- Agent: vibe-designer (gemini-omni-flash)

## 3D Production Studio (Phase 3 — Creative Studio)
Blender MCP text-to-3D — generates environments, product renders, and abstract visualizations from natural language. Multiple lighting presets, resolutions up to 4K.
- API: `/api/3d/scenes`, `/api/3d/stats`, `/api/3d/presets`, `POST /api/3d/scenes`
- Agent: blender-3d (claude-opus-4-8)

## Predictive Analytics (Phase 3 — Creative Studio)
AI-estimated forecasts for revenue, engagement, costs, and churn. Trained models with confidence scores and contributing factor analysis.
- API: `/api/predictions`, `/api/predictions/stats`, `/api/predictions/models`

## Batch Generation Queue (Phase 3 — Creative Studio)
Mass content production using economy-tier agents. Rate-limit tripping to build massive A/B testing libraries. Tracks progress, cost per item, and completion status.
- API: `/api/batch`, `/api/batch/stats`, `POST /api/batch`
- Agent: batch-runner (deepseek-v4, economy tier)

## Production Hardening
- **Auth**: Bearer token via `API_TOKEN` env var; middleware gates all `/api/` routes (except `/api/health`)
- **Security headers**: Helmet with CSP (self + fonts.googleapis + ws/wss), X-Frame-Options, HSTS
- **CORS**: Configurable via `CORS_ORIGIN` env var
- **Rate limiting**: 120 req/min global API; 10 req/min on heavy POST operations (batch, grok, media, browser, clone-url, 3d, vibe-design)
- **Input validation**: `validateBody()` with type/required/maxLength/oneOf/min/max rules on critical POST endpoints
- **Compression**: gzip via `compression` middleware
- **Request logging**: `morgan` (dev mode to console, production to `access.log`)
- **WebSocket auth**: Token verification on upgrade; heartbeat every 30s drops stale connections
- **Graceful shutdown**: SIGTERM/SIGINT handlers save state to `.magent/state/`, close WS connections, timeout after 5s
- **State persistence**: Auto-save (debounced 2s) of activity log, cost ledger, grok queries, notifications to JSON files in `.magent/state/`
- **Error handling**: Global Express error handler + uncaughtException/unhandledRejection process handlers
- **DEMO_MODE**: Env flag (default true) distinguishing simulated data from real API integrations
- **Health endpoint**: `GET /api/health` returns uptime, memory, version, demo mode, node env
- **Telegram/Slack**: Real HTTP calls to Telegram Bot API and Slack Incoming Webhooks for notifications
- **Client resilience**: WebSocket auto-reconnect with exponential backoff + visible reconnection banner

## Deployment
- **PM2**: `ecosystem.config.js` with auto-restart, log rotation, production env vars
- **Nginx**: `deploy/nginx.conf` with TLS (Let's Encrypt), WS upgrade, static caching, rate limiting, sensitive path blocking
- **Docker**: `Dockerfile` (node:20-alpine) + `docker-compose.yml` with health checks and volume mounts
- **VPS install**: `deploy/install-vps.sh` — one-script provisioning (UFW, Node 20, PM2, Nginx, Certbot)
- **Production binding**: Server binds `127.0.0.1` in production (behind Nginx), `0.0.0.0` in dev

## File Layout
```
.claude/agents/     → Agent role definitions
.claude/skills/     → Procedural skill files
.claude/rules/      → Guardrails and constraints
.claude/identity/   → Soul, User, Personality files
.claude/pipelines/  → Declarative skill chain definitions
.claude/projects/   → Per-project context overrides (YAML)
.claude/config/     → Automation registry, platform configs
.magent/            → Shared memory / team blackboard
.magent/vault/raw/  → Unprocessed intake data
.magent/vault/wiki/ → Synthesized knowledge base
.magent/vault/outputs/ → Final deliverables
.magent/artifacts/  → All agent outputs land here
.magent/state/      → Persisted runtime state (JSON)
.magent/plans/      → Execution plans awaiting approval
.magent/handoffs/   → Inter-agent task handoffs
dashboard/          → Web UI source
deploy/             → Nginx config, VPS install script
```

## How We Work
1. **Intake**: Structured interview to capture requirements.
2. **Decomposition**: Break requirements into capabilities and roles.
3. **Team Design**: Select agents from the role library.
4. **Materialization**: Factory generates sub-agent files.
5. **Orchestration**: Dispatch, collect, review, report.
