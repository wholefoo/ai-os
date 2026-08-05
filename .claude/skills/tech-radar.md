---
name: tech-radar
description: Autonomous intelligence sweep — crawls AI/tech sources, summarizes advancements, and generates orchestrator-approved update plans for the stack.
category: intelligence
rubric: research
estimated_time: 15min
schedule: daily
---

# Tech Radar

## Goal
The operator learns what changed in the AI stack this period and what, if anything, they should do
about it — as a short list of concrete proposals they can approve or reject, not a news digest. A
sweep that finds nothing worth acting on says so in one line.

## What good looks like
- Every finding carries a source URL that was FETCHED during this sweep. A remembered release or a
  version number recalled from training is the exact failure this skill's proposals must never carry.
- Findings scoring below `min_relevance` against the current stack do not appear. Relevance is to
  what this platform actually runs, not to AI in general.
- Each qualifying finding has a two-to-three sentence plain-language summary, an impact class
  (critical | high | medium | low) and a category tag — enough for the operator to triage without
  opening the source.
- Every proposal conforms to the proposal contract below, including the fields that gate it: a
  security proposal without a CVE and a fetched advisory URL is downgraded to a watch note, never
  emitted as a proposal.
- `apply_via` is set honestly. A runtime or OS operation is `manual-vps` and is presented for
  awareness with its manual steps — never as a one-click apply, because the dashboard will offer
  exactly what this field says it can.
- Version upgrades are forward-only and confirmed on the official release page. A proposal to "up
  grade" to a version older than what is installed is worse than no proposal.
- Each proposal states its rollback. A change with no stated way back should not be proposed.
- No more than `max_proposals` proposals. A list nobody can review in a sitting gets approved in bulk
  or ignored entirely, and both outcomes defeat the gate.

## Guardrails
- Never apply anything. This skill produces proposals; the human approval gate and the dispatcher own
  application, and that separation is the whole safety model.
- Never state a version, CVE, or release date that was not read from a source fetched this sweep.

## Proposal contract
The dashboard's apply flow reads these fields, so this shape is an interface, not a suggestion.

```yaml
proposal:
  title: "Upgrade Claude model to claude-opus-5"
  finding: "Anthropic released Claude Opus 5 with a 1M context window"
  impact: high
  category: models
  source_url: "https://www.anthropic.com/news/..."   # REQUIRED — fetched this sweep
  cve: null                                          # REQUIRED for security items, else null
  apply_via: auto                                    # auto = repo-file change | manual-vps = runtime/OS op, never one-click
  action:
    type: config_change | skill_update | agent_update | new_tool | dependency_upgrade
    target: .claude/agents/orchestrator.md
    description: "Update model references from claude-4.6-opus to claude-opus-5"
    effort: low
    risk: "Model behavior may differ slightly — run test suite after upgrade"
  rollback: "Revert model references to claude-4.6-opus"
```

## Team
- **scout** — the sweep, the relevance scoring, and the proposals
- **security-auditor** — CVE and advisory verification for anything claiming a security impact
- **architect** — whether a proposal fits the stack as it actually is, and what it would cost

## Parameters
- `sweep_type`: daily | weekly | monthly | full (default: daily)
- `categories`: all | models | frameworks | tools | apis | security | infrastructure (default: all)
- `min_relevance`: 1-10 threshold for inclusion (default: 6)
- `max_proposals`: maximum update proposals to generate (default: 10)
- `sources`: custom source URLs to include in the crawl

## Output
- `.magent/artifacts/research/tech-radar-{date}.md` — Full intelligence report
- `.magent/artifacts/docs/update-proposal-{date}.md` — Structured update proposals
- An inbox item for human approval — the proposals are never self-applied

## Integration Points
- **n8n**: Scheduled trigger fires the sweep at configured intervals
- **Obsidian**: Reports sync to the knowledge vault for historical reference
- **Dashboard**: Tech Radar view shows latest findings and pending proposals
- **Hermes**: Can trigger ad-hoc sweeps when it detects relevant signals during autonomous operation
