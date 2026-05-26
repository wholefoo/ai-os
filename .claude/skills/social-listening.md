---
name: social-listening
description: Real-time social media intelligence sweep — monitors X, LinkedIn, Bluesky, HN, and Reddit for AI/tech trends and sentiment.
category: intelligence
estimated_time: ~10min
agents: [social-intel, synthesis]
---

# Social Listening Sweep

Complementary to Tech Radar (which crawls websites), this skill monitors social media for real-time discussions, sentiment, and emerging signals.

## Parameters
- **topics**: Comma-separated focus topics (default: AI agents, LLM, Claude, MCP)
- **platforms**: Which platforms to scan (default: all)
- **min_engagement**: Minimum engagement threshold (default: 100)
- **timeframe**: How far back to look (default: 24h)

## Steps

1. **Platform Crawl**
   - Scan each configured platform for relevant posts
   - Apply engagement threshold filter
   - Capture: content summary, author, engagement metrics, URL

2. **Relevance Scoring**
   - Score each finding 1-10 against our stack and watchlist
   - Discard anything below 5/10 relevance
   - Flag findings from high-credibility sources (verified researchers, company accounts)

3. **Sentiment Analysis**
   - Classify each finding: positive, negative, neutral, mixed
   - Identify contested topics (high negative reply ratio)
   - Track sentiment shifts from previous sweeps

4. **Deduplication**
   - Cross-reference against latest Tech Radar report
   - Merge overlapping findings from different platforms
   - Prioritize the highest-engagement version

5. **Synthesis**
   - Generate Social Intelligence Brief
   - Top 3 trends with sentiment breakdown
   - Emerging signals from credible low-engagement sources
   - Action items that should become Tech Radar proposals

6. **Route to Orchestrator**
   - Deliver brief to orchestrator for review
   - Flag any findings that warrant immediate Tech Radar proposals
   - Store raw findings in vault/raw/ for historical analysis

## Output
Social Intelligence Brief saved to `.magent/vault/outputs/social-brief-{date}.md`
