---
name: tech-radar
description: Autonomous intelligence sweep — crawls AI/tech sources, summarizes advancements, and generates orchestrator-approved update plans for the stack.
category: intelligence
estimated_time: 15min
schedule: daily
---

# Tech Radar Skill

## Goal
Keep the AI OS stack continuously evolving by autonomously monitoring AI advancements, summarizing findings, and routing update proposals through the orchestrator for human approval before any changes are applied.

## Process

### Step 1 — Source Crawl
Scout agent crawls configured sources using web search and fetch:
- **AI News**: OpenAI blog, Anthropic blog, Google AI blog, Hugging Face, arXiv (cs.AI, cs.CL)
- **Dev Tools**: GitHub trending, npm/PyPI releases, MCP server registry
- **Frameworks**: LangChain changelog, CrewAI releases, n8n updates
- **Community**: Hacker News (AI), Reddit r/MachineLearning, r/LocalLLaMA, AI Twitter/X aggregators
- **Security**: CVE feeds for Node.js, Python, Docker; AI safety bulletins

### Step 2 — Filter & Score
Each finding is scored on a 1-10 relevance scale against the current stack:
- **Stack alignment**: Does it relate to tools we use? (Claude, Codex, n8n, Obsidian, Hermes, Higgsfield)
- **Workflow impact**: Would it improve an existing skill or agent capability?
- **Cost impact**: Does it reduce API costs or improve efficiency?
- **Security**: Does it patch a vulnerability or improve safety?
- Threshold: Only findings scored 6+ proceed to the report

### Step 3 — Summarize & Classify
Each qualifying finding gets:
- 2-3 sentence plain-language summary
- Impact classification: `critical` | `high` | `medium` | `low`
- Category tag: `models` | `frameworks` | `tools` | `apis` | `security` | `infrastructure` | `paradigms`
- Source URL for human verification

### Step 4 — Generate Update Proposals
For each `critical` or `high` finding, the scout generates a concrete update proposal.
**Before writing any version/security proposal, it MUST pass the Security & Version-Claim
Verification gate in `.claude/agents/scout.md`** (CVE + fetched advisory URL, version
confirmed on the official release page, forward-only, correct `apply_via`). If it cannot
pass, it is downgraded to a Horizon watch note, not a proposal.

```yaml
proposal:
  title: "Upgrade Claude model to claude-4.7-opus"
  finding: "Anthropic released Claude 4.7 with 2x context window"
  impact: high
  category: models
  source_url: "https://www.anthropic.com/news/..."   # REQUIRED — fetched this sweep
  cve: null                                            # REQUIRED for security items (e.g. CVE-2025-59465), else null
  apply_via: auto                                      # auto = repo-file change | manual-vps = runtime/OS op, never one-click
  action:
    type: config_change | skill_update | agent_update | new_tool | dependency_upgrade
    target: .claude/agents/orchestrator.md  # specific file to modify
    description: "Update model references from claude-4.6-opus to claude-4.7-opus"
    effort: low
    risk: "Model behavior may differ slightly — run test suite after upgrade"
  rollback: "Revert model references to claude-4.6-opus"
```

The dashboard apply flow must honor `apply_via`: `manual-vps` proposals are shown for
awareness with the documented manual steps, never offered as a one-click apply.

### Step 5 — Route to Orchestrator
The orchestrator receives the update proposals and:
1. Reviews each proposal against current mission priorities
2. Bundles related proposals into an Update Plan
3. Assigns an overall risk rating to the plan
4. Routes the Update Plan to the human via the approval inbox as a `blocking` gate

### Step 6 — Human Approval
The Update Plan appears in the dashboard Inbox with:
- Summary of all proposed changes
- Risk assessment per change
- Estimated effort total
- One-click approve/reject per proposal or batch approve/reject all
- "View Full Report" link to the tech radar report

### Step 7 — Apply Approved Updates (Post-Approval)
Only after human approval:
1. Orchestrator dispatches approved changes to the appropriate agents (coder, architect)
2. Each change is applied incrementally with testing
3. Results logged to decisions.log
4. Rollback plan kept ready for 48 hours
5. Follow-up radar scan confirms the update is working

## Parameters
- `sweep_type`: daily | weekly | monthly | full (default: daily)
- `categories`: all | models | frameworks | tools | apis | security | infrastructure (default: all)
- `min_relevance`: 1-10 threshold for inclusion (default: 6)
- `max_proposals`: maximum update proposals to generate (default: 10)
- `sources`: custom source URLs to include in the crawl

## Output
- `.magent/artifacts/research/tech-radar-{date}.md` — Full intelligence report
- `.magent/artifacts/docs/update-proposal-{date}.md` — Structured update proposals
- Inbox item created for orchestrator approval

## Integration Points
- **n8n**: Scheduled trigger fires the sweep at configured intervals
- **Obsidian**: Reports sync to the knowledge vault for historical reference
- **Dashboard**: Tech Radar view shows latest findings and pending proposals
- **Hermes**: Can trigger ad-hoc sweeps when it detects relevant signals during autonomous operation
