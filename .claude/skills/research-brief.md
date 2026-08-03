---
name: research-brief
description: Deep research on a topic with structured findings and source citations.
category: research
rubric: research
estimated_time: 10min
---

# Research Brief

## Goal
Enough verified context to hold an informed conversation about the topic within ten minutes of
reading, with every claim traceable to a source the reader can open.

## What good looks like
- At least 8 distinct sources, weighted toward the authoritative and the recent (under a year), with
  anything older included on purpose and labelled as background.
- Every single-source claim is flagged as such. The reader needs to know which parts rest on one
  voice.
- Findings are organised by theme, not by the order they were found — a brief that reads like a
  search history makes the reader do the synthesis.
- Consensus and disagreement are separated. Where the sources conflict, both positions appear.
- Knowledge gaps are stated. "No current data on X" is a finding, and omitting it implies coverage
  that does not exist.
- The executive summary is three to five sentences and survives on its own if nothing else is read.
- Every citation resolves to a real, reachable location — not a remembered title, not a search snippet.

## Guardrails
- Never fill a gap with plausible general knowledge presented as a finding.
- Never cite a source that was not actually retrieved in this run.

## Team
- **researcher** — the searches, the sources, and the per-claim citations
- **synthesis** — themes, consensus versus conflict, and the gap list
- **reviewer** — citation accuracy and single-source claims before delivery

## Parameters
- `topic`: Required. Research subject.
- `depth`: quick|standard|deep (default: standard)
- `focus`: Optional lens or angle to prioritize.

## Output
- `.magent/artifacts/research/brief-<topic>.md` — the brief with annotated sources
