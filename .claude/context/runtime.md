# Runtime — engines, model routing, cost

Read when: choosing or debugging a model, touching the cost ledger, or wondering why an agent ran on
something other than its frontmatter says.

## Tech Stack
- Runtime: Node.js + Express
- Dashboard: Vanilla HTML/CSS/JS with WebSocket live updates
- Agent definitions: Markdown with YAML frontmatter
- Team config: YAML
- Memory: File-based (`.magent/`)
- Web Intelligence: Firecrawl MCP server (search, scrape, structured extraction)
- Execution Engines: Claude Code (Opus 5 across xhigh/high/low effort tiers), DeepSeek Tui (DeepSeek V4 economy tier)

## Execution Engines
The system uses a multi-engine architecture for cost-optimized task routing:
- **Claude Code** — Primary engine. Effective model is chosen at run time by `resolveAnthropicModel()` from `settings.ai.reasoning_mode`: **`balanced` (default)** = Opus 5 for the strategic tier (xhigh) + **Sonnet 5** for professional (high) and scout (low); `opus` = all Opus; `sonnet` = all Sonnet (xhigh clamps to high). Agent `.md` frontmatter (`claude-opus-5`) is the declared default, NOT the effective model — derive "the model" from the routing on any UI/ledger surface.
- **DeepSeek Tui** — Economy engine for bulk content, data processing, and batch operations via DeepSeek V4
- **Codex CLI** — Cross-model verification engine (gpt-5.5, read-only `reviewer` profile); used only for adversarial review seats and second-opinion code reviews, never production tasks. Headless calls must close stdin (`< NUL` on Windows, `< /dev/null` on Linux)
- Routing rules defined in `.claude/rules/cost-routing.md`
- Orchestrator auto-classifies tasks and routes to the cheapest capable engine

## MCP Servers
- **firecrawl** — Web crawling and structured data extraction for the Scout agent's Tech Radar sweeps. Provides `firecrawl_scrape`, `firecrawl_search`, `firecrawl_crawl`, `firecrawl_extract`, and `firecrawl_deep_research` tools. Configured in `.claude/settings.json`.

> These are MCP tool names, which is a different vocabulary from an agent's `tools:` frontmatter —
> that field takes Claude Code tool names only (`lib/handbooks/schema.js` `RUNTIME_TOOLS`, enforced).
> See `agent-handbooks-design.md` §9 item 13.

## Cost Tracking
Real-time token usage and API spend monitoring across all execution engines:
- Tier tracking keyed by effective model+effort: Strategic (Opus 5 xhigh), Professional/Scout (Sonnet 5 high/low in `balanced` mode, else Opus), Economy (DeepSeek). Rates via `costRateFor(model)` — unknown models warn once instead of silently billing at the Opus rate. Sonnet 5 = $2/$10 introductory through 2026-08-31, then $3/$15.
- Budget alerts at 75% threshold with auto-downgrade recommendations
- Per-agent and per-skill cost attribution
- Daily/weekly/monthly budget caps configurable via API
