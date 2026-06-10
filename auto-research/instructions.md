# Optimization Instructions

<!-- TEMPLATE — edit everything below for your asset before running the loop. -->

## Goal
Improve the asset in `asset/` so that `node auto-research/score.js` returns a higher score.

## The Asset
<!-- What is it? e.g. "asset/landing.html — the landing page hero section" -->
Describe the asset here.

## What "Better" Means
<!-- Tie this to the scorer so the agent understands the metric it is chasing. -->
- The score (0-100) measures: <fill in>
- Current known weaknesses: <fill in>

## Hard Constraints (violations = automatic revert)
- NEVER modify `auto-research/score.js`, `auto-research/run-loop.js`, or anything outside `auto-research/asset/`.
- Preserve the asset's external interface: <e.g. exported function signatures, required HTML ids, CLI flags>.
- <Add domain constraints: brand voice, design tokens, max bundle size, etc.>

## Mutation Guidance
- Make ONE focused change per iteration, not a rewrite — small steps make the score
  history interpretable and keep reverts cheap.
- Read `history/log.jsonl` first: do not retry a mutation class that already lost twice.
- State in a one-line comment at the top of the asset what this iteration changed.
