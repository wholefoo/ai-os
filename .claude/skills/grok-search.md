---
name: grok-search
description: Real-time web intelligence query via xAI Grok — live search, trending topics, fact-checking, and current events.
category: intelligence
rubric: research
estimated_time: ~30s
---

# Grok Real-Time Search

## Goal
A current answer with its sources attached, fresh enough that the question was worth asking a realtime
model rather than a static one. If the answer did not need live data, saying so is a useful result —
the realtime budget is rate-limited and small.

## What good looks like
- Every claim about the present carries a source URL and, where timing matters, when it was published.
  "As of today" with no date is not a realtime answer.
- The answer distinguishes what was found from what was inferred. A summary of discourse is not a
  reported fact.
- Fact-check results carry a confidence level and say what evidence would change it.
- Social sentiment is labelled as sentiment, never reported as fact. Volume of posts is not truth.
- A query the live sources could not answer returns "no current data found" rather than a confident
  answer assembled from background knowledge.

## Guardrails
- No personal information in a query. It leaves this system and reaches a third-party provider.
- No more than 30 requests per hour, and an identical query within five minutes reuses the cached result.
- Results are informational. Nothing irreversible is decided on this output alone.

## Team
- **grok-realtime** — the live query and source extraction

## Parameters
- `query`: Required. The real-time search query or question.
- `type`: search | trending | fact-check | monitor (default: search)
- `scope`: web | social | news | all (default: all)
- `max_tokens`: 512 | 1024 | 2048 | 4096 (default: 1024)
- `include_sources`: true | false (default: true)

## Output
- `.magent/artifacts/intelligence/<timestamp>-grok.json` — the answer with its extracted sources
