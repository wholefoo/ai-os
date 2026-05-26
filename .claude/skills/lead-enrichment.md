---
name: lead-enrichment
description: Enrich a list of leads with company data, contacts, and scoring.
category: sales
estimated_time: 20min
---

# Lead Enrichment Skill

## Goal
Take a raw lead list and enrich each entry with company information, key contacts, and a qualification score.

## Process
1. **Ingest**
   - Read lead list from provided file/path
   - Validate required fields (company name OR domain)
   - Report count and any invalid entries

2. **Research**
   - For each lead, gather: industry, size, location, recent news
   - Identify key decision-makers and their roles
   - Find contact channels (LinkedIn, email patterns)

3. **Score**
   - Apply ICP (Ideal Customer Profile) criteria from mission.md
   - Score 1-10 based on fit indicators
   - Flag high-priority leads (score >= 7)

4. **Output**
   - Structured report per lead
   - Summary dashboard with score distribution
   - Prioritized action list

## Parameters
- `input_file`: Required. Path to lead list (CSV/JSON/MD).
- `icp_criteria`: Optional override for scoring (default: from mission.md).
- `batch_size`: Number to process per run (default: 25).

## Output
`.magent/artifacts/data/leads-enriched-<timestamp>.md`
