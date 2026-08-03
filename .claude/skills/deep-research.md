---
name: deep-research
description: Multi-source deep research with synthesis — goes beyond surface-level search to build comprehensive, cross-referenced knowledge maps.
category: research
rubric: research
estimated_time: 30min
source: https://github.com/wholefoo/academic-research-skills
---

# Deep Research

## Goal
Someone about to make a strategic decision can read this and know not just what is true, but how
confident to be and where the field disagrees. Conflicts are surfaced, not averaged away.

## What good looks like
- At least `min_sources` distinct sources, each rated for credibility, recency and relevance, with
  the rating's reason given. An unexplained 9/10 is a number, not an assessment.
- Where sources conflict, the conflict is reported as a conflict — both positions, who holds each,
  and what would settle it. Presenting one side as consensus is the failure this skill exists to avoid.
- Every finding carries a confidence level, and low confidence is stated rather than omitted.
- Known gaps are listed explicitly. "Nothing found on X" is a result worth reporting.
- Findings are cross-referenced: a claim appearing in three sources is distinguishable from one
  appearing in one source that the other two cite.
- The executive summary is decision-shaped — what to do or watch, not a précis of the body.
- The time range asked for is respected, and anything outside it that was included is labelled.

## Guardrails
- Never present a source's claim as an independent confirmation of another source that it cites.
- Never resolve a genuine disagreement by picking the more recent source without saying that is why.

## Team
- **research-architect** — the boundaries, the questions, and what evidence would answer them
- **researcher** — the sweep, source retrieval, and per-source evaluation
- **synthesis** — consensus, conflict and gap map with confidence ratings
- **report-compiler** — the knowledge map and the executive summary

## Parameters
- `topic`: Research topic or question
- `depth`: surface | moderate | exhaustive (default: moderate)
- `focus`: trends | technical | competitive | regulatory | all (default: all)
- `min_sources`: minimum source count (default: 20)
- `time_range`: recent (30d) | quarter (90d) | year | all (default: quarter)

## Output
- `.magent/artifacts/research/deep-research-{topic-slug}.md` — Full research report
- `.magent/artifacts/research/sources-{topic-slug}.md` — Annotated source list with ratings

## Difference from research-brief
`research-brief` is a quick 8-source summary. `deep-research` is an exhaustive multi-source synthesis
with cross-referencing, confidence scoring, and conflict identification. Use `deep-research` for
strategic decisions, `research-brief` for quick context gathering.
