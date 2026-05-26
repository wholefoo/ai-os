---
name: academic-reviewer
description: Peer review simulation — evaluates academic papers for rigor, methodology, citation quality, logical consistency, and identifies weaknesses.
category: research
estimated_time: 20min
source: https://github.com/wholefoo/academic-research-skills
---

# Academic Reviewer Skill

## Goal
Provide structured peer review feedback on academic papers, simulating a rigorous journal review process.

## Process
1. **Structure Check** — Verify all required sections are present and properly organized
2. **Argument Analysis** — Evaluate logical flow, identify unsupported claims, check for circular reasoning
3. **Citation Audit** — Verify citations support claims, check for missing citations, flag over-reliance on single sources
4. **Methodology Review** — Assess research methodology appropriateness and rigor
5. **Clarity Assessment** — Flag jargon, ambiguity, unclear explanations
6. **Verdict** — Issue ACCEPT / REVISE / REJECT with detailed rationale

## Parameters
- `paper_path`: Path to the paper to review
- `review_depth`: quick | standard | thorough (default: standard)
- `focus_areas`: methodology | citations | arguments | all (default: all)

## Output
- `.magent/artifacts/research/review-{paper-slug}.md` — Structured review with scores and feedback
