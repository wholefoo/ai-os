---
name: design-system
description: Generate and maintain a complete web design system — tokens, typography, color palette, component specs, spacing scale, and usage guidelines.
category: design
rubric: design
estimated_time: 25min
---

# Design System

## Goal
A developer can build a screen from this without asking a designer a question: every colour, size,
space and state they need has a name, a value, and a rule for when to use it.

## What good looks like
- Every text-on-background pair that the system permits meets WCAG 2.1 AA, and the measured ratio is
  recorded. A palette that looks right and fails contrast is the most common way a design system
  ships broken.
- Dark mode has a value for every token that light mode has. A half-themed system fails at the first
  component nobody checked.
- Every component specifies its states — default, hover, active, focus, disabled, loading, error —
  and its focus ring is visible against every surface it can appear on.
- Spacing derives from a single stated base unit. A one-off value anywhere means the scale is
  decorative rather than real.
- Every token is used by at least one component spec, and every component spec references only tokens
  that exist. The two lists must close.
- Documentation shows a do and a don't for each component. A spec with no counter-example gets
  misread the first time it is used.
- The output matches the requested framework — a Tailwind config when Tailwind was asked for, not CSS
  variables with a note about how to convert them.

## Guardrails
- Never ship a token pair that fails AA without flagging it and proposing the nearest compliant value.
- Never invent brand colours when the operator supplied them — build the scale around what was given.

## Team
- **architect** — token structure, spacing scale, grid, and the z-index layering
- **researcher** — reference sites, accessibility standards, and current practice
- **coder** — the CSS custom properties, framework config, and component snippets
- **writer** — usage guidelines, naming conventions, and the do/don't examples
- **reviewer** — contrast validation and whether the token and component lists close

## Parameters
- `brand_name`: Required. Project or brand name.
- `brand_colors`: Optional. Existing brand hex colors to build palette from.
- `typography`: Optional. Preferred font families.
- `style`: minimal|bold|corporate|playful|technical (default: minimal)
- `dark_mode`: true|false (default: true)
- `framework`: vanilla|tailwind|bootstrap (default: vanilla)
- `reference_urls`: Optional. Array of sites whose design language to draw inspiration from.

## Output
- `.magent/artifacts/code/design-tokens.css` — CSS custom properties for all tokens
- `.magent/artifacts/code/tailwind.config.js` — Tailwind mapping (if framework=tailwind)
- `.magent/artifacts/code/components/` — HTML/CSS reference for each component
- `.magent/artifacts/docs/design-system-<brand>.md` — full design system documentation
- `.magent/artifacts/docs/accessibility-checklist.md` — WCAG compliance reference
