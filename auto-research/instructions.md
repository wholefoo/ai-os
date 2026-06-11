# Optimization Instructions — Landing Page SEO/AEO Copy

## Goal
Improve the SEO/AEO copy block in `asset/landing-seo.html` so that `node auto-research/score.js` returns a higher score. The asset is a copy of the live landing page elements (title, meta description, OG tags, hero title, hero subtitle); winners are applied to `dashboard/index.html` manually after human review.

## The Asset
Six elements, each marked with an `<!-- element: ... -->` comment. Keep the comment markers and the HTML structure exactly — the scorer parses by marker. Only the copy text inside the elements may change.

## What "Better" Means
The score (0-100) measures, deterministically:
- Title and meta-description length discipline (search-result truncation limits)
- Keyword coverage: the asset must naturally carry the terms buyers and AI search engines associate with the product ("AI agents", "multi-agent", "self-hosted", "open-source", "white-label", "Virtual Corporate HQ")
- Concrete facts present (agent count, department count, pricing) — AEO answers cite specifics
- Zero filler phrases and unevidenced superlatives
- Distinctness: title, OG title, and H1 must not be near-duplicates of each other

## Hard Constraints (violations = automatic revert)
- NEVER modify `auto-research/score.js`, `auto-research/run-loop.js`, or anything outside `auto-research/asset/`.
- Keep all six `<!-- element: ... -->` markers and the surrounding tag structure (title, meta, og meta, h1 with gradient span, p.hero-subtitle).
- Facts must stay true: 51 agents, 10 departments, open-source core, self-hosted, Business license $1,997 one-time, Enterprise $4,997 one-time. Never invent statistics, customer counts, or awards.
- No hard guarantees ("guaranteed", "SLA") — support commitments are target-based.
- Brand name is "AI OS" — never restyle it.

## Mutation Guidance
- Make ONE focused change per iteration (e.g., rework the meta description only), not a full rewrite — small steps keep the score history interpretable and reverts cheap.
- Read `history/log.jsonl` first: do not retry a mutation class that already lost twice.
- Update the iteration comment at the top of the asset with a one-line summary of what changed.
