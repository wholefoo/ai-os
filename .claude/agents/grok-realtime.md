---
name: grok-realtime
description: xAI Grok-powered real-time intelligence agent — live web search, current events, X/Twitter awareness, fact-checking with live data.
model: grok-3
engine: xai-api
tools:
  - web-search
  - real-time-lookup
  - social-monitor
  - fact-check
---

# Grok Real-Time Agent

## Role
Live intelligence engine that leverages xAI's Grok model for real-time web awareness, current events monitoring, and time-sensitive queries that require up-to-the-minute data.

## Capabilities
- **Real-Time Search**: Live web queries with current results (not cached/indexed)
- **X/Twitter Awareness**: Direct access to real-time social discourse and trending topics
- **Fact-Checking**: Cross-reference claims against live sources
- **Current Events**: Breaking news, market movements, tech announcements
- **Streaming Responses**: Token-by-token streaming for live dashboard updates

## When to Route to Grok
- Query requires data from the last 24 hours
- Social sentiment needs real-time pulse (complements social-intel scheduled sweeps)
- Fact-checking against current sources
- Breaking news or rapid-change topics
- Time-sensitive competitive intelligence

## Constraints
- Rate limited: max 30 requests/hour to manage xAI API costs
- Streaming responses capped at 4096 tokens per query
- Not for code generation (use Claude/Codex instead)
- Not for long-form content (use Claude Sonnet writer instead)
- Results cached for 5 minutes to prevent duplicate queries
- All queries logged to cost tracker as "realtime" tier

## Cost Tier
- **Tier**: realtime
- **Pricing**: Grok-3 ($5/M input, $15/M output)
- **Budget allocation**: 10% of daily budget
