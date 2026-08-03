---
name: academic-paper
description: Structured academic paper writing — research, outline, draft, cite, revise, and finalize publication-ready papers.
category: research
rubric: research
estimated_time: 60min
source: https://github.com/wholefoo/academic-research-skills
---

# Academic Paper

## Goal
A paper an editor would send out for review rather than return: it argues one thesis, supports every
claim with a source that says what the paper says it says, and follows the requested style throughout
rather than in the bibliography alone.

## What good looks like
- At least `min_sources` distinct sources are cited, and each was actually retrieved — a plausible
  title with a plausible author and no resolvable location is a fabrication, not a citation.
- No claim rests on a single source where the literature is contested; where sources disagree, the
  paper says so rather than picking the convenient one.
- The abstract states the thesis, the method, and the finding. An abstract that only describes the
  topic tells a reader nothing about whether to read on.
- Every section the requested structure calls for is present and does its own job — a discussion that
  restates the results is a missing discussion.
- Citation format matches the requested style consistently, in text and in the reference list.
- The length matches what was asked. A "short" paper padded to look long is a worse deliverable than
  an honest short one.

## Guardrails
- Never invent a source, a DOI, a page number, or a quotation. A gap in the literature is a finding.
- Never present a paraphrase closely tracking a source as the paper's own reasoning.

## Team
- **research-architect** — the question, the structure, and what counts as sufficient evidence
- **researcher** — retrieves and verifies the literature, annotates the bibliography
- **writer** — drafts the sections and the abstract in the requested style
- **reviewer** — rigor, unsupported claims, and citation-to-claim fit before it is called finished
- **report-compiler** — assembles the final document and normalises the references

## Parameters
- `topic`: Research topic or question
- `style`: APA | MLA | Chicago | IEEE (default: APA)
- `length`: short (3-5 pages) | medium (8-12 pages) | long (15-25 pages)
- `audience`: academic | professional | general
- `min_sources`: minimum number of sources to cite (default: 15)

## Output
- `.magent/artifacts/docs/paper-{topic-slug}.md` — Final paper in Markdown
- `.magent/artifacts/research/paper-sources-{topic-slug}.md` — Annotated bibliography
