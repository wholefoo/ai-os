---
name: academic-paper
description: Structured academic paper writing — research, outline, draft, cite, revise, and finalize publication-ready papers.
category: research
estimated_time: 60min
source: https://github.com/wholefoo/academic-research-skills
---

# Academic Paper Skill

## Goal
Generate a structured, citation-backed academic paper on a given topic, following standard academic conventions (abstract, introduction, methodology, results, discussion, conclusion, references).

## Process
1. **Topic Analysis** — Decompose the topic into research questions and sub-topics
2. **Literature Search** — Gather 15+ relevant sources using web search and Firecrawl
3. **Outline** — Create a structured outline with section headings and key arguments
4. **Draft** — Write each section with inline citations and evidence
5. **Review** — Run through the academic-reviewer skill for quality and rigor checks
6. **Revise** — Address reviewer feedback, strengthen weak arguments, fill citation gaps
7. **Finalize** — Format references, add abstract, proofread, compile final document

## Parameters
- `topic`: Research topic or question
- `style`: APA | MLA | Chicago | IEEE (default: APA)
- `length`: short (3-5 pages) | medium (8-12 pages) | long (15-25 pages)
- `audience`: academic | professional | general
- `min_sources`: minimum number of sources to cite (default: 15)

## Output
- `.magent/artifacts/docs/paper-{topic-slug}.md` — Final paper in Markdown
- `.magent/artifacts/research/paper-sources-{topic-slug}.md` — Annotated bibliography
