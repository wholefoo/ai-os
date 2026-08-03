---
name: verify-output
description: Plan-Execute-Verify protocol — scores an agent output against that agent's own handbook criteria, with the named rubric as a floor, and gates delivery on the verdict.
category: intelligence
rubric: default
estimated_time: 2min
---

# Output Verification

## Goal
A verdict a person can trust without re-reading the output: PASS, REVIEW, or FAIL, with the specific
criterion behind every deduction. A score with no cited criterion is a number nobody can act on.

## What good looks like
- Every check reports pass, partial, or fail with the evidence from the output that decided it —
  quoted or located, not asserted.
- A failed check names the criterion it failed, in the criterion's own words. "Scored 62" without the
  failing criterion is unreadable a week later.
- The report states which standard was applied: the agent's own handbook criteria, the floor rubric,
  or both, and how many checks came from each.
- The verdict follows the thresholds without exception — PASS at 80 and above, REVIEW from 60 to 79,
  FAIL below 60 — so two runs over the same output cannot disagree.
- The verifier judges the artifact, never the reasoning that produced it. An author's explanation of
  why something is fine is not evidence that it is.
- A FAIL returns specific, addressable feedback. "Needs improvement" sends the work back with nothing
  to act on and costs a second full run.

## Guardrails
- Never auto-approve a REVIEW or FAIL verdict, whatever `auto_approve` is set to. That flag governs
  passing output only.
- Never let the agent that produced an output grade it. Verification by its author always passes.

## Team
- **reviewer** — scores the output against the resolved criteria and issues the verdict
- **qa** — the second pass for code and anything with an executable claim

## Parameters
- `execution_id`: Required. The workflow execution to verify.
- `rubric`: auto | research | marketing | security | sales | design (default: auto)
- `strictness`: lenient | standard | strict (default: standard)
- `auto_approve`: true | false (default: true)

## Output
- `.magent/artifacts/verification/verify-<execution_id>.md` — per-check results, score, and verdict

## Verdicts
- **PASS** (score >= 80) — Output approved for delivery, auto-released if enabled
- **REVIEW** (score 60-79) — Routed to human inbox for manual review
- **FAIL** (score < 60) — Returned to agent with specific failure notes for revision
