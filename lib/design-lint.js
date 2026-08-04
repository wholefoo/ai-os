// lib/design-lint.js
// ============================================================
//  The design linter that actually lints.
//
//  Until 2026-08-03 `POST /api/design-system/lint` ignored its request body entirely and returned a
//  hardcoded findings array. `web-builder`'s handbook called it the quality gate and promised to
//  refuse `ready` on error-severity findings — the canned array contained none, so that refusal
//  could never fire. It also blessed the token object's stored contrast figures, 8 of 9 of which
//  were wrong, three of them claiming `passes: true` while failing AA.
//
//  Two jobs, deliberately separate because they answer different questions:
//    lintTokens(tokens)      — is the design SYSTEM internally sound? (the dashboard's question)
//    lintHtml(html, tokens)  — is this BUILT PAGE accessible and on-token? (web-builder's question)
//
//  ── WHAT THIS CANNOT DO. Read before trusting a clean result. ──
//  lintHtml is a STATIC MARKUP linter. It does not build a DOM, resolve the CSS cascade, or compute
//  final styles, so it can only judge what is visible in the markup itself: inline styles, literal
//  attributes, and hex values in embedded CSS. A colour set by an external stylesheet or a class is
//  invisible to it. **A clean result means "nothing detectable in the markup", NOT "WCAG AA".**
//  Every message here says which it is. Overclaiming is the failure this module exists to end.
//
//  Contrast maths is reimplemented here rather than shared with tools/test-brand-book.js or the
//  brand book page, and that is deliberate in all three cases: the test must not share an
//  implementation with what it checks (it would prove only agreement), and the brand book must be a
//  self-contained openable file. A future de-duplication pass should REFUSE to unify these three.
// ============================================================

'use strict';

/** WCAG 2.1 relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Contrast ratio between two #rrggbb colours, 1..21. */
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Expand #abc to #aabbcc; return null for anything that is not a hex colour. */
function normalizeHex(raw) {
  const m = String(raw || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h);
}

const AA_NORMAL = 4.5;   // body text
const AA_LARGE = 3;      // 18pt+/14pt bold, and UI component boundaries
const finding = (rule, status, message, severity) => ({ rule, status, message, severity });

/**
 * Lint the design system itself. Every number is computed here and now.
 *
 * @param {object} tokens  designSystem.tokens — { colors, typography, spacing, radius } (+ components)
 * @param {Array}  [components]
 * @returns {Array<{rule,status,message,severity}>}
 */
function lintTokens(tokens, components = []) {
  const out = [];
  const colors = (tokens && tokens.colors) || {};
  const bg = colors.background && normalizeHex(colors.background.hex);

  // --- contrast, computed per colour ---------------------------------------------------------------
  for (const [name, t] of Object.entries(colors)) {
    const hex = normalizeHex(t && t.hex);
    if (!hex) { out.push(finding('color-token', 'fail', `${name} has no valid hex value ("${t && t.hex}")`, 'high')); continue; }
    if (name === 'background' || name === 'surface') continue;   // these ARE the backgrounds
    const onWhite = contrastRatio(hex, '#ffffff');
    const onDark = bg ? contrastRatio(hex, bg) : null;
    if (onWhite < AA_NORMAL) {
      const dark = onDark ? ` — passes on the dark surface (${onDark.toFixed(2)}:1)` : '';
      const sev = onWhite < AA_LARGE ? 'high' : 'medium';
      out.push(finding('color-contrast', 'warning',
        `${name} (${hex}) fails WCAG AA on white background (${onWhite.toFixed(2)}:1, needs ${AA_NORMAL}:1)${onDark && onDark >= AA_NORMAL ? dark : ''}`, sev));
    }
    if (onDark !== null && onDark < AA_LARGE) {
      out.push(finding('color-contrast', 'fail',
        `${name} (${hex}) fails even large-text contrast on the app's own background (${onDark.toFixed(2)}:1, needs ${AA_LARGE}:1) — it is unreadable where the product actually uses it`, 'high'));
    }
  }
  const contrastIssues = out.filter((f) => f.rule === 'color-contrast').length;
  if (!contrastIssues && Object.keys(colors).length) {
    out.push(finding('color-contrast', 'pass', `All ${Object.keys(colors).length} colours meet WCAG AA where used`, 'low'));
  }

  // --- 4px spacing grid -------------------------------------------------------------------------------
  const offGrid = Object.entries((tokens && tokens.spacing) || {})
    .filter(([, v]) => { const n = parseInt(v, 10); return Number.isNaN(n) || n % 4 !== 0; })
    .map(([k, v]) => `${k}=${v}`);
  out.push(offGrid.length
    ? finding('spacing-consistency', 'fail', `Spacing tokens off the 4px grid: ${offGrid.join(', ')}`, 'medium')
    : finding('spacing-consistency', 'pass', 'Spacing values follow the 4px base grid', 'low'));

  // --- font fallbacks ---------------------------------------------------------------------------------
  const GENERIC = /(sans-serif|serif|monospace|system-ui|cursive|fantasy)\s*$/i;
  const stacks = Object.entries(((tokens && tokens.typography) || {}).fontFamily || {});
  const noFallback = stacks.filter(([, v]) => !GENERIC.test(String(v))).map(([k]) => k);
  out.push(noFallback.length
    ? finding('font-fallback', 'fail', `Font stacks with no generic fallback: ${noFallback.join(', ')}`, 'medium')
    : finding('font-fallback', 'pass', 'All font stacks end in a system fallback', 'low'));

  // --- components reference roles, not literals ---------------------------------------------------------
  const literal = components.filter((c) => Object.values(c).some((v) => normalizeHex(v))).map((c) => c.id || c.name);
  out.push(literal.length
    ? finding('component-refs', 'fail', `Components with hardcoded colour values: ${literal.join(', ')} — reference a role instead`, 'high')
    : finding('component-refs', 'pass', `All ${components.length} components reference roles, not hardcoded values`, 'high'));

  return out;
}

/**
 * Lint built markup. See the module header for what this can and cannot see.
 *
 * @param {string} html
 * @param {object} [tokens]  when supplied, hex literals outside the palette are reported
 * @returns {Array<{rule,status,message,severity}>}
 */
function lintHtml(html, tokens = null) {
  const out = [];
  const src = String(html || '');
  if (!src.trim()) return [finding('input', 'fail', 'No HTML supplied to lint', 'high')];

  // --- images without alt text (error: it is the single most common real a11y defect) -------------------
  const imgs = src.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((tag) => !/\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(tag));
  const emptyAltNoRole = imgs.filter((tag) => /\balt\s*=\s*(""|'')/.test(tag) && !/role\s*=\s*["']presentation["']/i.test(tag));
  if (noAlt.length) {
    out.push(finding('img-alt', 'fail', `${noAlt.length} of ${imgs.length} <img> tags have no alt attribute — e.g. ${noAlt[0].slice(0, 80)}`, 'high'));
  }
  if (emptyAltNoRole.length) {
    out.push(finding('img-alt', 'warning', `${emptyAltNoRole.length} <img> tags use alt="" without role="presentation" — decorative images should say so explicitly`, 'medium'));
  }
  if (imgs.length && !noAlt.length && !emptyAltNoRole.length) {
    out.push(finding('img-alt', 'pass', `All ${imgs.length} images carry alt text`, 'high'));
  }

  // --- document language --------------------------------------------------------------------------------
  if (/<html\b/i.test(src)) {
    out.push(/<html\b[^>]*\blang\s*=/i.test(src)
      ? finding('html-lang', 'pass', 'Document declares a language', 'medium')
      : finding('html-lang', 'fail', '<html> has no lang attribute — screen readers cannot choose a pronunciation', 'medium'));
  }

  // --- inline contrast, where BOTH colours are literally present ------------------------------------------
  // Only pairs inside one style attribute are judged. Anything relying on the cascade is invisible here
  // and is deliberately not guessed at.
  let checked = 0;
  for (const m of src.matchAll(/style\s*=\s*"([^"]*)"/gi)) {
    const decl = m[1];
    const fg = normalizeHex((decl.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i) || [])[1]);
    const bgc = normalizeHex((decl.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1]);
    if (!fg || !bgc) continue;
    checked++;
    const r = contrastRatio(fg, bgc);
    if (r < AA_NORMAL) {
      out.push(finding('color-contrast', r < AA_LARGE ? 'fail' : 'warning',
        `Inline style sets ${fg} on ${bgc} — ${r.toFixed(2)}:1, below the ${AA_NORMAL}:1 AA minimum for body text`,
        r < AA_LARGE ? 'high' : 'medium'));
    }
  }
  if (checked) out.push(finding('color-contrast', 'pass', `${checked} inline foreground/background pair(s) checked`, 'low'));

  // --- token compliance ------------------------------------------------------------------------------------
  if (tokens && tokens.colors) {
    const palette = new Set(Object.values(tokens.colors).map((t) => normalizeHex(t.hex)).filter(Boolean));
    const used = new Set();
    for (const m of src.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const hex = normalizeHex(m[0]);
      if (hex && !palette.has(hex)) used.add(hex);
    }
    out.push(used.size
      ? finding('token-compliance', 'warning',
        `${used.size} colour literal(s) outside the palette: ${[...used].slice(0, 8).join(', ')}${used.size > 8 ? '…' : ''} — reference a token role instead`, 'medium')
      : finding('token-compliance', 'pass', 'All colour literals map to palette tokens', 'medium'));
  }

  out.push(finding('scope', 'pass',
    'Static markup only: inline styles and literal attributes. External stylesheets, classes and computed layout are NOT evaluated — a clean result is not a full WCAG audit.', 'low'));
  return out;
}

/** Roll findings into the shape the dashboard and web-builder both consume. */
function summarizeFindings(results) {
  const passed = results.filter((r) => r.status === 'pass').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const failures = results.filter((r) => r.status === 'fail').length;
  return {
    total: results.length, passed, warnings, failures,
    score: results.length ? Math.round((passed / results.length) * 100) : 0,
    // The property web-builder gates on. Errors block a build; warnings do not.
    hasErrors: failures > 0,
  };
}

module.exports = { lintTokens, lintHtml, summarizeFindings, contrastRatio, normalizeHex, AA_NORMAL, AA_LARGE };
