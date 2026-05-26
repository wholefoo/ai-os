---
name: grok-search
description: Real-time web intelligence query via xAI Grok — live search, trending topics, fact-checking, and current events.
category: intelligence
estimated_time: ~30s
---

# Grok Real-Time Search

## Goal
Execute a real-time intelligence query using xAI's Grok model, returning current web data, social discourse, and live search results.

## Process
1. **Parse Query** — Extract search intent, determine query type (search, trending, fact-check, monitor)
2. **Check Cache** — Deduplicate queries within 5-minute window
3. **Route to Grok** — Send query to xAI API with streaming enabled
4. **Stream Response** — Broadcast token-by-token to dashboard via WebSocket
5. **Extract Sources** — Parse citations, URLs, and confidence scores
6. **Cache Result** — Store response for deduplication window

## Parameters
- `query`: Required. The real-time search query or question.
- `type`: search | trending | fact-check | monitor (default: search)
- `scope`: web | social | news | all (default: all)
- `max_tokens`: 512 | 1024 | 2048 | 4096 (default: 1024)
- `include_sources`: true | false (default: true)

## Agents Used
- **Grok Real-Time** (Grok-3) — Primary query execution with streaming

## Output
Results: `.magent/artifacts/intelligence/<timestamp>-grok.json`

## Safety
- No PII in queries
- Rate limited: max 30 requests/hour
- Results are informational — not authoritative for decisions
- Fact-check results include confidence scores
