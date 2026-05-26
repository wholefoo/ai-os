---
name: research-brief
description: Deep research on a topic with structured findings and source citations.
category: research
estimated_time: 10min
---

# Research Brief Skill

## Goal
Produce a comprehensive research brief with verified sources on any given topic.

## Process
1. **Define Scope**
   - Parse topic into 3-5 research questions
   - Identify target domains (academic, industry, news)

2. **Gather**
   - Researcher agent conducts web searches
   - Collect minimum 8 sources
   - Prioritize recent (< 1 year) and authoritative sources

3. **Synthesize**
   - Organize findings by theme
   - Identify consensus vs. conflicting views
   - Note knowledge gaps

4. **Structure Output**
   - Executive summary (3-5 sentences)
   - Key findings (bulleted)
   - Detailed analysis by theme
   - Sources with annotations
   - Recommended next steps

5. **Quality Check**
   - Reviewer validates citation accuracy
   - Flag any single-source claims

## Parameters
- `topic`: Required. Research subject.
- `depth`: quick|standard|deep (default: standard)
- `focus`: Optional lens or angle to prioritize.

## Output
`.magent/artifacts/research/brief-<topic>.md`
