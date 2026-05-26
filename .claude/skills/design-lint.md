---
name: design-lint
description: Run WCAG accessibility audit and token consistency checks on DESIGN.md
category: design
agent: design-system
est: ~10s
parameters:
  - name: level
    type: string
    description: WCAG level to check against
    default: AA
    options: [A, AA, AAA]
  - name: fix
    type: boolean
    description: Auto-fix simple issues (unused tokens, missing fallbacks)
    default: false
---

# Design Lint

Audits the design system for:
- Color contrast (WCAG AA/AAA compliance)
- Unused token definitions
- Font stack fallbacks
- Spacing grid consistency (4px base)
- Touch target minimums (44px)

Returns severity-ranked results: error, warning, pass.
