---
name: design-system
description: Generate and maintain a complete web design system — tokens, typography, color palette, component specs, spacing scale, and usage guidelines.
category: design
estimated_time: 25min
---

# Design System Skill

## Goal
Create a comprehensive, production-ready design system for web projects. Produces design tokens, component specifications, typography scales, color palettes, spacing systems, and documented usage guidelines that ensure visual consistency across an entire product.

## Process
1. **Discovery & Intake**
   - Gather brand identity inputs: existing logo, brand colors, typography preferences
   - Determine target platforms: web, mobile web, responsive
   - Identify design maturity: starting fresh vs. codifying existing patterns
   - Collect reference sites or style inspirations from user
   - Define audience and tone: corporate, playful, technical, minimal, bold

2. **Design Token Generation**
   - **Color Palette**
     - Primary, secondary, and accent color scales (50–950 shades)
     - Semantic colors: success, warning, danger, info
     - Neutral/gray scale for text, borders, backgrounds
     - Surface colors: background layers, card fills, overlays
     - Dark mode variants for every token
     - WCAG AA/AAA contrast ratio validation for all text/background pairs
   - **Typography Scale**
     - Font family selections: heading, body, monospace
     - Modular scale (1.125–1.333 ratio) for font sizes
     - Line height, letter spacing, and font weight mappings
     - Responsive type scale adjustments for mobile/tablet/desktop
   - **Spacing Scale**
     - Base unit (4px or 8px grid)
     - Named spacing tokens: xs, sm, md, lg, xl, 2xl, 3xl
     - Component-specific spacing: padding, margins, gaps
   - **Border & Shadow Tokens**
     - Border radius scale: none, sm, md, lg, full
     - Box shadow elevations: sm, md, lg, xl
     - Border widths and styles
   - **Motion Tokens**
     - Duration scale: fast (100ms), normal (200ms), slow (300ms), deliberate (500ms)
     - Easing curves: ease-in, ease-out, ease-in-out, spring
     - Transition property defaults per component type
   - **Breakpoints**
     - Mobile, tablet, desktop, wide definitions
     - Container max-widths per breakpoint

3. **Component Specifications**
   - For each core component, define:
     - Visual anatomy (padding, border, icon placement)
     - State variants: default, hover, active, focus, disabled, loading, error
     - Size variants: sm, md, lg
     - Color theme variants: primary, secondary, ghost, danger
     - Accessibility requirements: focus rings, ARIA roles, keyboard behavior
   - **Core component library:**
     - Buttons (solid, outline, ghost, icon-only)
     - Input fields (text, select, checkbox, radio, toggle, textarea)
     - Cards (basic, interactive, media, stat)
     - Navigation (navbar, sidebar, tabs, breadcrumbs)
     - Modals and dialogs
     - Alerts and toasts
     - Badges and tags
     - Tables (basic, sortable, with pagination)
     - Avatars and user indicators
     - Tooltips and popovers
     - Progress indicators (bar, spinner, skeleton)
     - Dividers and spacers

4. **Layout System**
   - Grid specifications: columns, gutters, margins per breakpoint
   - Common layout patterns: sidebar+main, dashboard grid, card grid, split view
   - Container widths and content max-widths
   - Z-index scale for layering (dropdown, sticky, modal, toast, overlay)

5. **Iconography & Assets**
   - Recommended icon library and sizing rules
   - Icon usage guidelines: stroke vs. fill, minimum sizes
   - Favicon and touch icon specifications
   - Image aspect ratio standards for cards, heroes, thumbnails

6. **Documentation & Guidelines**
   - Do/Don't usage examples for every component
   - Naming conventions for CSS classes and tokens
   - Composition patterns: how components combine in real layouts
   - Voice and tone guidelines for UI copy
   - Accessibility checklist per component

7. **Output Generation**
   - CSS custom properties file with all design tokens
   - Tailwind config (if applicable) mapping tokens to utilities
   - Component HTML/CSS reference snippets
   - Design system documentation in structured markdown

8. **Review & Deliver**
   - Reviewer validates contrast ratios and accessibility compliance
   - Cross-check component specs against WCAG 2.1 AA standards
   - Verify responsive behavior at all breakpoints

## Parameters
- `brand_name`: Required. Project or brand name.
- `brand_colors`: Optional. Existing brand hex colors to build palette from.
- `typography`: Optional. Preferred font families (e.g., "Inter for body, Space Grotesk for headings").
- `style`: minimal|bold|corporate|playful|technical (default: minimal)
- `dark_mode`: true|false (default: true)
- `framework`: vanilla|tailwind|bootstrap (default: vanilla)
- `reference_urls`: Optional. Array of sites whose design language to draw inspiration from.

## Agents Involved
- **Architect**: Defines token structure, spacing system, grid specs
- **Researcher**: Analyzes reference sites, best practices, accessibility standards
- **Coder**: Generates CSS custom properties, Tailwind config, component snippets
- **Writer**: Produces documentation and usage guidelines
- **Reviewer**: Validates accessibility compliance and consistency

## Error Handling
- If no brand colors provided → generate a balanced palette from the style parameter
- If reference URLs unreachable → continue with style-based defaults, note gap
- If contrast validation fails → auto-suggest closest compliant color alternatives

## Output
- `.magent/artifacts/code/design-tokens.css` — CSS custom properties for all tokens
- `.magent/artifacts/code/tailwind.config.js` — Tailwind mapping (if framework=tailwind)
- `.magent/artifacts/code/components/` — HTML/CSS reference for each component
- `.magent/artifacts/docs/design-system-<brand>.md` — full design system documentation
- `.magent/artifacts/docs/accessibility-checklist.md` — WCAG compliance reference
