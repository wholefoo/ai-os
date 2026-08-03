---
name: social-listening
description: Real-time social media intelligence sweep — monitors X, LinkedIn, Bluesky, HN, and Reddit for AI/tech trends and sentiment.
category: intelligence
rubric: research
estimated_time: ~10min
---

# Social Listening Sweep

## Goal
The operator learns what the field is actually saying this week that they would not have found by
reading release notes — with enough sourcing to tell a signal from a loud minority.

## What good looks like
- Every finding carries its permalink, its author, and its real engagement numbers. A trend asserted
  without a post behind it is a guess.
- Sentiment is reported as sentiment and never as fact. "Widely criticised" is a claim about
  discourse, not about the thing being discussed.
- A contested topic is flagged as contested, with both sides represented. Averaging a fight into
  "mixed" loses the only interesting part.
- Findings below the relevance threshold do not appear, and findings already covered by the latest
  Tech Radar report are merged rather than repeated as new.
- Credible low-engagement signals are surfaced separately. The most useful early signal is usually
  the one that has not gone viral yet, and an engagement filter alone will drop it.
- Sentiment shifts are stated relative to the previous sweep. A snapshot with no baseline cannot show
  a shift.

## Guardrails
- Read-only. Never post, reply, follow, or react.
- Never attribute a view to a named individual on the basis of a single post's tone.
- No personal data beyond the public post, its public author handle, and its public metrics.

## Team
- **social-intel** — the platform sweep, relevance scoring, and sentiment classification
- **synthesis** — deduplication against Tech Radar, the trend map, and the brief

## Parameters
- `topics`: Comma-separated focus topics (default: AI agents, LLM, Claude, MCP)
- `platforms`: Which platforms to scan (default: all)
- `min_engagement`: Minimum engagement threshold (default: 100)
- `timeframe`: How far back to look (default: 24h)

## Output
- `.magent/vault/outputs/social-brief-{date}.md` — top trends with sentiment, emerging signals, and
  anything that should become a Tech Radar proposal
