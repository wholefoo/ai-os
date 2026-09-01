// lib/capped-list.js
// ============================================================
//  One list normaliser, for every schema in this repo that stores a bounded list of short strings:
//  trim each item, cap its length, drop empties, de-duplicate case-insensitively while keeping the
//  FIRST occurrence's casing, and stop at maxItems.
//
//  This was written twice independently, with byte-identical loop bodies — once in
//  lib/business-clone/persona.js (voice phrases, domains, red lines) and once in
//  lib/library/catalog.js (readers, tags). It is worth having in one place because the loop encodes
//  a DECISION, not just a shape: `key = s.toLowerCase()` is what makes "Alice@x.com" and
//  "alice@x.com" one reader rather than two, and keeping the first occurrence rather than the last
//  is what stops a display-facing email or tag from being silently lower-cased. The day that rule
//  has to grow — Unicode case-folding, collapsing internal whitespace — it must grow once. Two
//  copies drift, and the copy that drifts permissive here is the one guarding a permission list.
//
//  What is deliberately NOT shared is which items are admissible in the first place: the persona
//  schema takes strings only, the catalog also accepts numbers. That is each caller's own rule
//  about its own data, so each passes its own `coerce`. It is the single point where the two
//  genuinely differ, which is why it is a parameter instead of a flag.
//
//  Pure: no state, no I/O, no requires.
// ============================================================

'use strict';

/**
 * Normalise a candidate list into a trimmed, capped, de-duplicated array of strings.
 *
 * @param {*} v  the candidate. Anything that is not an array yields `[]` — callers normalise
 *   arbitrary input, so a missing or wrong-typed field is a default, not an error.
 * @param {object} opts
 * @param {number} opts.cap  max characters kept per item, applied after trimming
 * @param {number} opts.maxItems  hard stop on output length
 * @param {(item: *, cap: number) => string} opts.coerce  turns one raw item into its capped string
 *   form, or returns `''` to reject it. Rejection and "trimmed to nothing" are deliberately the
 *   same answer: neither belongs in the output.
 * @returns {string[]}
 */
function cappedList(v, { cap, maxItems, coerce }) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const s = coerce(item, cap);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

module.exports = { cappedList };
