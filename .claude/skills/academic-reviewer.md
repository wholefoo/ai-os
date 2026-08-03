---
name: academic-reviewer
description: Peer review simulation — evaluates academic papers for rigor, methodology, citation quality, logical consistency, and identifies weaknesses.
category: research
rubric: research
estimated_time: 20min
source: https://github.com/wholefoo/academic-research-skills
---

# Academic Reviewer

## Goal
A review the author can act on: it reaches a verdict, and every criticism points at a specific
passage and says what would fix it. The author never has to guess which paragraph a comment is about.

## What good looks like
- The verdict is exactly one of ACCEPT, REVISE, or REJECT, stated plainly, with the reasoning that
  produced it. A review that ends in a summary of the paper is not a review.
- Every criticism cites the section or line it applies to. "The methodology is weak" without a
  location is an opinion the author cannot use.
- Citation problems distinguish the three kinds that matter: a citation that does not support the
  claim, a claim that needs one and has none, and a section leaning on a single source.
- Unsupported claims and circular reasoning are named as such, not softened into "could be
  strengthened".
- Strengths are stated too, and specifically — a review that only lists faults gives the author no
  signal about what to preserve while revising.
- The severity of each issue is distinguishable, so the author can tell a fatal flaw from a wording
  preference.

## Guardrails
- Never judge a paper against a methodology it did not claim to use.
- Never soften a verdict to be agreeable. A REJECT stated as REVISE wastes the author's next month.

## Team
- **reviewer** — the verdict, the argument analysis, and the severity ranking
- **researcher** — independently checks that cited sources exist and say what the paper claims

## Parameters
- `paper_path`: Path to the paper to review
- `review_depth`: quick | standard | thorough (default: standard)
- `focus_areas`: methodology | citations | arguments | all (default: all)

## Output
- `.magent/artifacts/research/review-{paper-slug}.md` — Structured review with scores and feedback
