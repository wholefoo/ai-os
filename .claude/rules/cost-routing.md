---
name: cost-routing
description: Rules for routing tasks to the most cost-effective execution engine based on task complexity, sensitivity, and volume.
---

# Cost Routing Rules

## Model Tier Hierarchy

Claude Code runs a **single model — `claude-opus-4-8`** — at three **effort tiers**. The
tiers do NOT switch models; they vary reasoning effort, which changes how many tokens a
task spends. Opus 4.8 bills the same flat rate ($5/1M input, $25/1M output) at every
effort level — lower effort is cheaper because it spends fewer tokens, not because the
per-token rate drops.

| Tier | Engine | Model | Effort | Per-token rate | Use When |
|------|--------|-------|--------|----------------|----------|
| **Strategic** | Claude Code | claude-opus-4-8 | xhigh | $5/$25 per 1M (flat) | Planning, architecture, review, safety |
| **Professional** | Claude Code | claude-opus-4-8 | high | $5/$25 per 1M (flat) | Core coding, research, writing, QA |
| **Scout** | Claude Code | claude-opus-4-8 | low | $5/$25 per 1M (flat) | Quick lookups, classification, triage |
| **Creative** | Gemini Omni | gemini-omni-flash | — | $1.25/$5 per 1M | Video, image, audio, UI generation (name-routed: media-producer, vibe-designer, video-creator, audio-producer, thumbnail-gen) |
| **Economy** | DeepSeek Tui | deepseek-v4 | — | $0.10-0.50 per 1M | Bulk content, data processing, batch ops |
| **Cross-Model** | Codex CLI | gpt-5.5 | — | ChatGPT plan (flat) | Adversarial review seat, second-opinion code review |

Effort drives cost on the Claude tiers: higher effort lets the model reason longer and
emit more tokens (so a Strategic task costs more than a Scout task on the same flat rate),
while lower effort caps token spend for cheap, fast work. The Economy and Cross-Model
tiers use genuinely different external models with their own pricing.

The Cross-Model tier is not a general work tier — it exists solely for verification diversity (see `adversarial-verification.md`). Never dispatch production tasks to it.

## Routing Decision Matrix

The Orchestrator evaluates each task against these criteria:

### Route to xhigh effort (Strategic)
- [ ] Involves architectural decisions or system design
- [ ] Requires critical review with veto power
- [ ] Safety or compliance evaluation needed
- [ ] Confidence threshold below 0.7 on any sub-decision
- [ ] Task involves irreversible operations
- [ ] Multi-agent coordination and orchestration

### Route to high effort (Professional)
- [ ] Implementation from a spec (coding)
- [ ] Research requiring nuanced analysis and citations
- [ ] Creative or technical writing with quality requirements
- [ ] Test creation and execution
- [ ] Tasks requiring multiple specialized tools (Edit, Bash, MCP)

### Route to low effort (Scout)
- [ ] Quick classification or triage
- [ ] Simple lookups and data retrieval
- [ ] Initial sweep before deeper analysis
- [ ] Scheduled monitoring and alerting
- [ ] Lightweight intelligence gathering

### Route to DeepSeek V4 (Economy)
- [ ] Bulk content generation (>5 pieces)
- [ ] Data transformation and cleaning
- [ ] Boilerplate and template expansion
- [ ] SEO batch operations (meta tags, descriptions)
- [ ] Summarization of large document sets
- [ ] Translation and localization tasks
- [ ] Tasks where cost > quality concern
- [ ] Repetitive operations across many items

## Cost Controls

1. **Budget Caps**: Each mission defines a max API spend. The orchestrator tracks cumulative cost.
2. **Auto-downgrade**: If budget is >75% consumed, non-critical tasks auto-route to DeepSeek V4.
3. **Quality Gate**: DeepSeek outputs on `high` quality tasks get spot-checked by the Reviewer (Opus 4.8, xhigh effort).
4. **Cost Logging**: Every agent execution logs estimated cost to `.magent/decisions.log`.
5. **Monthly Report**: Scout generates a monthly cost efficiency report comparing engines.

## Escalation Path for Cost Routing
1. Task arrives at Orchestrator
2. Orchestrator classifies complexity: `strategic` | `professional` | `scout` | `economy`
3. If classification is ambiguous, default UP one tier (prefer quality over cost)
4. If budget pressure is high, orchestrator may propose downgrade to human for approval
5. Human can override any routing decision via the approval inbox

## Anti-Patterns (Never Do)
- Never route safety/compliance checks to Economy tier
- Never route code that handles secrets/auth to Economy tier
- Never auto-downgrade Strategic (xhigh effort) tasks without human approval
- Never split a coherent task across tiers to save cost (context switching costs more)
