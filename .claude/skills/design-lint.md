---
name: design-lint
description: Run WCAG accessibility audit and token consistency checks on DESIGN.md
category: design
rubric: design
estimated_time: ~10s
---

# Design Lint

## Goal
Every accessibility and consistency problem in the design system is found and ranked, so a designer
knows which ones actually block a release and which are tidying.

## What good looks like
- Every contrast failure reports the measured ratio, the pair that produced it, and the level it
  failed — AA or AAA. "Low contrast" without the number cannot be verified or argued with.
- Findings are ranked error, warning, or pass, and the ranking reflects whether it blocks compliance,
  not how easy it is to fix.
- Spacing violations are measured against the 4px base grid, and touch targets against the 44px
  minimum. These are thresholds, not preferences.
- A token defined and never used is reported, and so is a font stack with no fallback — both are
  silent until they are not.
- A passing check is reported as a pass. A report listing only failures leaves a reader unable to
  tell what was examined.

## Guardrails
- Never auto-fix a contrast failure by changing a brand colour. Suggest the nearest compliant value
  and let a person choose.
- Auto-fix only applies to what `fix` explicitly permits — unused tokens and missing fallbacks.

## Team
- **design-system** — the audit and the severity ranking

## Parameters
- `level`: A|AA|AAA — WCAG level to check against (default: AA)
- `fix`: true|false — auto-fix simple issues, meaning unused tokens and missing fallbacks only (default: false)

## Output
- A severity-ranked finding list (error, warning, pass) with the measured value behind each finding
