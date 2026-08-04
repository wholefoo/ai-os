---
name: cost-routing
description: Rules for routing tasks to the most cost-effective execution engine based on task complexity, sensitivity, and volume.
---

# Cost Routing Rules

## Model Tier Hierarchy

**Which model and what it costs are defined in `.claude/context/runtime.md`, which is canonical.
Read it there.** In short: five tiers — Strategic / Professional / Scout on Claude Code, Creative on
Gemini Omni, Economy on DeepSeek, plus a Cross-Model verification seat on Codex.

> This section used to restate the model and price table and **drifted into being wrong**: it
> asserted a single model at a flat $5/$25, while `runtime.md` and `engineering-workflow.md` both
> correctly described `balanced` mode routing professional and scout work to **Sonnet 5** at
> different rates. Three copies, one of them stale, and the stale one is the file an agent reads
> when deciding where to send work. Corrected 2026-08-03 by deleting the copy, not by syncing it —
> syncing three copies is how it broke.

What this file owns, and what nothing else should restate, is the **decision matrix below**: given a
task, which tier gets it.

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
