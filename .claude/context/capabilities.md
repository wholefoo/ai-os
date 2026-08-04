# Capabilities — the feature catalogue

Read when: adding to or touching a feature area, and you need its API surface, owning agent, and
skill. **Check `.claude/SKILL-MAP.md` first** — it is auto-generated and authoritative for what
agents, skills and pipelines exist; this file adds the API endpoints and groups them by build phase.

## Phase 1 — Core Intelligence

**Knowledge Graph** — auto-organizing knowledge base that categorizes sources into types (wiki, docs, research, outputs, raw) and discovers semantic connections. Visual radial graph in the dashboard.
- API: `/api/knowledge-graph`, `/api/knowledge-graph/stats`, `POST /api/knowledge-graph/auto-categorize` · Agent: knowledge-graph · Skill: knowledge-categorize

**Design System Protocol** — DESIGN.md-based universal token system with built-in WCAG linter. Color roles, typography scales, spacing grids, border radii. Includes "Skills as Ingredients" for programmatic design feature generation.
- API: `/api/design-system`, `/api/design-system/tokens`, `POST /api/design-system/lint` · Agent: design-system · Skill: design-lint
- ⚠ **`DESIGN.md` does not exist in this repo** (verified 2026-08-03). Dangling reference; the fix is the HTML brand book in `model-fit-2026-design.md` §3.4.

**Media Production Pipeline** — multi-engine: Remotion (programmable video as React code), Google Vids (prompt-to-production with consistent avatars), Blender MCP (text-to-3D). Template-driven with parameterized inputs.
- API: `/api/media/productions`, `/api/media/templates`, `/api/media/stats`, `POST /api/media/produce` · Agent: media-producer · Skill: media-produce

**Continuous Loop Workflows** — CRON-scheduled autonomous routines: ad variation generation, competitor price monitoring, analytics digests, content repurposing. Rate-limited with cooldowns and batch processing.
- API: `/api/routines`, `/api/routines/stats`, `PUT /api/routines/:id/toggle`, `POST /api/routines/:id/run`, `POST /api/routines` · Agent: routine-runner

## Phase 2 — Monetization

**Product Factory** — generates high-ticket digital products (spreadsheets, Notion templates, toolkits) using Claude + openpyxl. Published to Etsy and Gumroad with SEO-optimized listings.
- API: `/api/products`, `/api/products/stats`, `/api/products/templates`, `POST /api/products` · Agent: product-factory

**Lead Generation Pipeline** — scraping, enrichment, achievement discovery, personalized outreach. Scores leads 0-100, generates messages referencing specific accomplishments.
- API: `/api/leads`, `/api/leads/stats`, `/api/leads/campaigns`, `POST /api/leads/scrape`, `POST /api/leads/:id/outreach` · Agent: lead-gen

**Marketing Hub** — transforms source content into multi-platform distribution. Tracks channels, engagement, growth. Content queue with scheduling.
- API: `/api/marketing/pipelines`, `/api/marketing/channels`, `/api/marketing/queue`, `/api/marketing/stats`, `POST /api/marketing/queue` · Agent: marketing-hub

**Golden Loop** — connects Gemini Gems to NotebookLM notebooks for real-time sync, so the AI expert always has the latest research and docs.
- API: `/api/golden-loop`, `/api/golden-loop/stats`, `POST /api/golden-loop/:id/sync`, `POST /api/golden-loop` · Agent: golden-loop

## Phase 3 — Creative Studio

**Vibe Design Studio** — prompt-driven UI generation replacing wireframing. Natural language, voice, sketches, reference URLs. Screens with predictive heat maps and granular style controls.
- API: `/api/vibe-design/projects`, `/api/vibe-design/stats`, `/api/vibe-design/controls`, `POST /api/vibe-design/projects`, `POST /api/vibe-design/:id/heatmap` · Agent: vibe-designer

**3D Production Studio** — Blender MCP text-to-3D: environments, product renders, abstract visualizations. Multiple lighting presets, resolutions up to 4K.
- API: `/api/3d/scenes`, `/api/3d/stats`, `/api/3d/presets`, `POST /api/3d/scenes` · Agent: blender-3d

**Predictive Analytics** — AI-estimated forecasts for revenue, engagement, costs, churn. Trained models with confidence scores and contributing-factor analysis.
- API: `/api/predictions`, `/api/predictions/stats`, `/api/predictions/models`

**Batch Generation Queue** — mass content production using economy-tier agents to build A/B testing libraries. Tracks progress, cost per item, completion status.
- API: `/api/batch`, `/api/batch/stats`, `POST /api/batch` · Agent: batch-runner (economy tier)
