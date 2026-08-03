---
name: lead-enrichment
description: Enrich a list of leads with company data, contacts, and scoring.
category: sales
rubric: sales
estimated_time: 20min
---

# Lead Enrichment

## Goal
A salesperson opens the enriched list and knows who to call first and what to open with. Every score
can be explained by pointing at the ICP criterion that produced it.

## What good looks like
- Every enriched field traces to a source that was actually retrieved. An inferred company size
  presented as a known one turns a call into an embarrassment.
- A field that could not be found is empty and marked not-found, never filled with a plausible guess.
  An invented contact email is worse than a blank one — it gets sent to.
- Every score cites the ICP criteria that produced it. An unexplained 8/10 cannot be tuned, argued
  with, or trusted.
- Invalid or unusable input rows are reported with their row identity and the reason, not silently
  dropped. A count that does not reconcile with the input is a silent data loss.
- High-priority leads (7 and above) are separated out, because a flat list of 200 gets worked from the
  top regardless of score.
- The score distribution is reported. If everything scores 8, the criteria are not discriminating and
  the operator needs to know that.

## Guardrails
- Never guess an email address from a pattern and present it as found. A guessed pattern is labelled
  as a guess or it is not included.
- Never enroll an enriched lead into an outreach sequence. Enrichment and contact are separate acts.
- Personal data gathered here is subject to the operator's retention policy — no scraping of anything
  beyond business contact information.

## Team
- **lead-gen** — enrichment, decision-maker identification, and ICP scoring
- **researcher** — company facts, recent news, and source verification

## Parameters
- `input_file`: Required. Path to lead list (CSV/JSON/MD).
- `icp_criteria`: Optional override for scoring (default: from mission.md).
- `batch_size`: Number to process per run (default: 25).

## Output
- `.magent/artifacts/data/leads-enriched-<timestamp>.md` — per-lead record, score with its reasoning,
  the score distribution, and the prioritized call list
