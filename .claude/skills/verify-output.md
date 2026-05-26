---
name: verify-output
description: Plan-Execute-Verify protocol — validates agent outputs against category-specific rubrics before delivery.
category: intelligence
estimated_time: 2min
---

# Output Verification Skill

## Goal
Run the Verify phase of the Plan-Execute-Verify protocol. Score agent outputs against the appropriate rubric, flag failures, and gate delivery on passing verification.

## Process
1. **Load Rubric** — Determine output category, load matching rubric from verification-rubrics.yaml, merge with inherited default checks
2. **Run Checks** — Evaluate each rubric criterion against the output, scoring pass/partial/fail with evidence
3. **Score** — Calculate weighted aggregate score (0-100), determine verdict (PASS >= 80, REVIEW 60-79, FAIL < 60)
4. **Generate Report** — Produce structured verification report with per-check results, overall score, and remediation notes
5. **Gate Decision** — If PASS, auto-approve delivery. If REVIEW, flag for human review. If FAIL, return to executing agent with specific feedback.

## Parameters
- `execution_id`: Required. The workflow execution to verify.
- `rubric`: auto | research | marketing | security | sales | design (default: auto)
- `strictness`: lenient | standard | strict (default: standard)
- `auto_approve`: true | false (default: true)

## Agents Used
- **Reviewer** (Opus) — Primary verification agent, scores against rubric
- **QA** (Sonnet) — Secondary check for code outputs

## Output
`.magent/artifacts/verification/verify-<execution_id>.md`

## Verdicts
- **PASS** (score >= 80) — Output approved for delivery, auto-released if enabled
- **REVIEW** (score 60-79) — Routed to human inbox for manual review
- **FAIL** (score < 60) — Returned to agent with specific failure notes for revision
