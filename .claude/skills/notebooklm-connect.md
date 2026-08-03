---
name: notebooklm-connect
description: Connect to a Google NotebookLM notebook — sync sources, query for insights, and pull synthesized knowledge back into the AI OS.
category: research
rubric: research
estimated_time: 10min
---

# NotebookLM Connect

## Goal
Insights come back from the notebook with their grounding intact — each claim traceable to the
specific uploaded document that supports it, and each of those mapped back to its path in this system.

## What good looks like
- Every returned insight names the source document grounding it. An ungrounded NotebookLM answer is
  the model's general knowledge, and it must be labelled as such rather than filed as synthesis.
- Citations map back to real local artifact paths. A citation to a document that was never uploaded
  is a broken chain and is reported as one.
- The sync manifest lists exactly what was pushed and what came back, so a later reader can tell what
  the notebook actually saw.
- An upload that failed after its retry is recorded as failed and the run continues on the sources
  that did land — with the report saying which ones are missing.
- Rate limiting is handled by backing off, not by dropping the query silently.

## Guardrails
- No document containing PII or operator-sensitive material is uploaded without explicit human
  approval. Uploaded documents fall under Google's data policies and leave this system permanently.
- Google credentials are never stored, logged, or typed by an agent — the run relies on an existing
  browser session, and a missing session is reported, not worked around.

## Team
- **browser-agent** — the session, the uploads, and the query submission
- **researcher** — the questions worth asking and what the answers mean
- **reviewer** — whether each returned claim is actually grounded in an uploaded source

## Parameters
- `notebook_name`: Required. Name of the target NotebookLM notebook.
- `notebook_url`: Optional. Direct URL to the notebook (skips search).

## Output
- `.magent/artifacts/research/notebooklm-<query-slug>.md` — structured insights with grounding
- `.magent/artifacts/research/notebooklm-sources-manifest.md` — what was pushed and pulled
- `.magent/artifacts/docs/notebooklm-audio-<timestamp>.md` — audio overview link (if requested)
