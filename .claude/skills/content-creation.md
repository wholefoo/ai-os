---
name: content-creation
description: Content production from a topic brief — researched, drafted, and checked before it is called finished.
category: marketing
rubric: marketing
estimated_time: 15min
---

# Content Creation

## Goal
A piece the operator could publish as-is: it says something specific, supports the claims that need
support, and reads in the requested voice from the first line rather than settling into it halfway
down.

## What good looks like
- Every factual claim is either sourced or written as opinion. An unsourced statistic is the single
  most damaging thing this skill can emit.
- At least 3 real sources informed the piece, and if fewer were found, that is reported rather than
  papered over with general knowledge.
- The opening earns the second paragraph. A piece that starts by restating its own title has wasted
  the only attention it gets.
- Length lands within about 10% of the requested word count — padding to hit a number is as much a
  miss as falling short.
- Requested keywords appear where they read naturally. A sentence bent around a keyword costs more
  than the keyword is worth.
- The requested tone holds throughout, including in headings and the call to action.
- The piece ends by asking for something specific, when a call to action was asked for.

## Guardrails
- Never invent a statistic, a quotation, a case study, or a customer.
- Never publish or post. This produces a draft; distribution is a separate, gated act.

## Team
- **researcher** — sources, angles, and what is already saturated
- **writer** — the outline and the draft, in the requested voice
- **reviewer** — unsupported claims, tone drift, and whether the opening earns its place

## Parameters
- `topic`: Required. The subject to write about.
- `format`: blog|article|social|email (default: blog)
- `word_count`: Target length (default: 800)
- `tone`: professional|casual|technical (default: professional)
- `keywords`: Optional SEO keywords array.

## Output
- `.magent/artifacts/docs/content-<title>.md` — the draft, with its sources listed
