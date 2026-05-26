---
name: deep-research
description: Multi-source deep research with synthesis — goes beyond surface-level search to build comprehensive, cross-referenced knowledge maps.
category: research
estimated_time: 30min
source: https://github.com/wholefoo/academic-research-skills
---

# Deep Research Skill

## Goal
Conduct exhaustive multi-source research on a topic, synthesizing findings into a comprehensive knowledge map with cross-references, conflicting viewpoints, and confidence levels.

## Process
1. **Scope Definition** — Define research boundaries, key questions, and success criteria
2. **Broad Sweep** — Cast wide net across web, academic, and technical sources using Firecrawl deep research
3. **Source Evaluation** — Rate each source for credibility, recency, and relevance (1-10)
4. **Deep Dive** — Follow high-value threads, extract structured data from key sources
5. **Synthesis** — Cross-reference findings, identify consensus vs. conflict, surface gaps
6. **Knowledge Map** — Build structured output linking findings to sources with confidence levels
7. **Executive Summary** — Distill into actionable insights with recommendations

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
`research-brief` is a quick 8-source summary. `deep-research` is an exhaustive multi-source synthesis with cross-referencing, confidence scoring, and conflict identification. Use `deep-research` for strategic decisions, `research-brief` for quick context gathering.
