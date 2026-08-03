---
name: knowledge-categorize
description: Auto-categorize and tag sources for the Knowledge Graph
category: intelligence
rubric: default
estimated_time: ~15s
---

# Knowledge Categorize

## Goal
A source becomes findable by someone who does not know it exists — correctly typed, tagged with the
words a person would actually search, and connected to what it relates to.

## What good looks like
- The type is exactly one of wiki, docs, research, outputs, raw. An invented type breaks every
  consumer that filters on it.
- Tags come from the source's own content, not from its filename or its folder. A document filed in
  the wrong place is the case this skill exists to correct.
- Every asserted connection is justifiable from the content of both nodes. A link nobody can explain
  is noise that makes the graph less navigable, not more.
- A source too ambiguous to type confidently is reported as needing review rather than assigned a
  plausible guess. A wrong confident tag is worse than an absent one.
- When `source_id` is 'all', every uncategorized source is processed, and the count handled is
  reported so a partial run is visible as partial.

## Guardrails
- Never re-categorize an already-tagged source unless `force` is set — a human may have corrected it.
- Never remove an existing human-authored tag.

## Team
- **knowledge-graph** — categorization, tagging, and connection discovery

## Parameters
- `source_id`: ID of source to categorize, or 'all' for every uncategorized source
- `force`: true|false — re-categorize even if already tagged (default: false)

## Output
- The updated node in `.magent/knowledge-graph.json`, with type, tags and connections
