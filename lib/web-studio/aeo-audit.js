// lib/web-studio/aeo-audit.js
// ============================================================
//  Per-site AEO/SEO compliance: audit every page, rank the gaps, and propose the fixes that can be
//  made DETERMINISTICALLY. Built on lib/aeo/readability.js — the same 8-dimension, zero-token
//  scorer the public free audit uses — so a client's site is measured by the same ruler AI OS sells.
//
//  WHAT "SAFE AUTO-FIX" MEANS HERE, AND WHAT IT REFUSES TO DO.
//  Every fix below is sourced from the page's OWN content or from facts already in the plan. None
//  of them invent prose. That line matters: the scorer's biggest levers are FAQ format (15 pts),
//  structured data (15) and answer readiness (10), and the tempting "fix" for those is to
//  auto-write questions and answers. That would be fabricating claims on a customer's live domain,
//  so it is NOT offered. Those dimensions are reported as recommendations for a human to act on.
//
//  Fixes are PROPOSED with before/after and applied only when explicitly selected, because a meta
//  description is customer-visible copy.
// ============================================================
'use strict';

const { extractSignals, scoreReadability } = require('../aeo/readability');
const { htmlToText } = require('./sanitize-html');
const { articlePath, indexPath } = require('./articles');

// The scorer's own meta-quality bands (readability.js: title 30-60, description 120-160).
const TITLE_MIN = 30, TITLE_MAX = 60;
const DESC_MIN = 120, DESC_MAX = 160;

/** Audit one HTML document. Pure. */
function auditPage(path, html) {
  const sig = extractSignals(html);
  const scored = scoreReadability(sig);
  return {
    path,
    score: scored.score,
    grade: scored.grade,
    breakdown: scored.breakdown,
    recommendations: scored.recommendations,
    signals: {
      title: sig.title, titleLength: sig.title.length,
      description: sig.metaDesc, descriptionLength: sig.metaDesc.length,
      h1: sig.h1, h2: sig.h2, h3: sig.h3,
      words: sig.words, lists: sig.lists,
      schemaTypes: sig.schemaTypes, hasFaqSchema: sig.hasFaqSchema,
    },
  };
}

/** Audit a whole site's built HTML. @param {Array<{path:string,html:string}>} files */
function auditSite(files) {
  const pages = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.html === 'string' && /\.html?$/i.test(f.path || ''))
    .map((f) => auditPage(f.path, f.html));

  if (!pages.length) return { pages: [], summary: { pages: 0, score: 0, grade: 'n/a', weakest: [] } };

  const score = Math.round(pages.reduce((n, p) => n + p.score, 0) / pages.length);
  // Which dimensions lose the most across the WHOLE site — that is what to fix first, rather than
  // whichever page happens to sort last.
  const totals = {};
  for (const p of pages) {
    for (const [k, d] of Object.entries(p.breakdown)) {
      if (!totals[k]) totals[k] = { lost: 0, max: 0, key: k };
      totals[k].lost += (d.max - d.score);
      totals[k].max += d.max;
    }
  }
  const weakest = Object.values(totals)
    .filter((t) => t.lost > 0)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 4)
    .map((t) => ({
      dimension: t.key.replace(/_/g, ' '),
      lostPoints: Math.round(t.lost),
      pctOfMax: Math.round((t.lost / t.max) * 100),
    }));

  return {
    pages,
    summary: {
      pages: pages.length,
      score,
      grade: score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D',
      worstPage: pages.slice().sort((a, b) => a.score - b.score)[0].path,
      bestPage: pages.slice().sort((a, b) => b.score - a.score)[0].path,
      weakest,
    },
  };
}

// ---------- mapping a built file back to the plan entity that produced it ------------------------
function fileForPath(sitePath) {
  const p = String(sitePath || '/').replace(/^\/+|\/+$/g, '');
  return p ? p + '/index.html' : 'index.html';
}

/** Build an index from built-file path -> { kind, index } in the plan. */
function planIndex(plan) {
  const map = new Map();
  (plan.pages || []).forEach((page, i) => map.set(fileForPath(page.path), { kind: 'page', index: i }));
  (plan.articles || []).forEach((a, i) => map.set(fileForPath(articlePath(plan, a.slug)), { kind: 'article', index: i }));
  map.set(fileForPath(indexPath(plan)), map.get(fileForPath(indexPath(plan))) || { kind: 'articleIndex', index: -1 });
  return map;
}

const trimToWord = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '').replace(/[,;:\-–—]$/, '').trim());

// Prefer to end a derived description at a SENTENCE boundary, falling back to a word boundary.
//
// Word-boundary trimming alone produced descriptions that read as broken prose on the real sites:
//   Learn more about our mission and values "Journalistic Integrity" is a comprehensive and engaging blog that del
// — two sentences run together and cut mid-thought. Every character is still the page's own text;
// the difference is where it stops. A sentence end inside the band is always the better cut.
function trimToSentence(s, max, min = 60) {
  const str = String(s || '').trim();
  if (str.length <= max) return str;
  // slice(0, max), NOT max + 1: with the extra character a sentence ending exactly at the limit
  // produced a 161-character description against a 160 maximum — a "fix" that left the value
  // outside the very band it was correcting, and still scored as too long.
  const window = str.slice(0, max);
  let best = -1;
  for (const m of window.matchAll(/[.!?](?=\s|$)/g)) {
    // Ignore a full stop that is part of an abbreviation or initial ("Mr." / "J. R.").
    const before = window.slice(Math.max(0, m.index - 3), m.index + 1);
    if (/\b[A-Z]\.$/.test(before)) continue;
    if (m.index + 1 >= min) best = m.index + 1;
  }
  return best > 0 ? window.slice(0, best).trim() : trimToWord(str, max);
}

// The OPENING PROSE of a page, for deriving a meta description.
//
// Not htmlToText() over the whole document: that flattens headings, nav and boilerplate into the
// text too, so the first 160 characters came out as "Heading Sub Sub2 Sub3 Deep Deep2 This page
// explains…" — a description made of the page's own navigation. Paragraphs only, in document
// order, which is what a human would have written anyway.
function leadText(html) {
  const paras = [...String(html || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1]));
  const joined = paras.filter((p) => p.length > 30).join(' ').replace(/\s+/g, ' ').trim();
  // No usable paragraphs (a page built entirely of divs): fall back to the flattened text rather
  // than proposing nothing at all, but only when it is substantial.
  return joined || htmlToText(html);
}

/**
 * Propose deterministic fixes. Returns [{id, path, target, field, issue, reason, before, after}].
 * NOTHING is invented: descriptions come from the page's own prose, and a title only ever gains the
 * site name, which is already a fact in the plan.
 */
function proposeFixes(plan, audit, files) {
  const byFile = new Map((files || []).map((f) => [f.path, f.html]));
  const index = planIndex(plan || {});
  const out = [];
  const siteName = (plan && plan.siteName) || '';

  for (const page of (audit.pages || [])) {
    const ref = index.get(page.path);
    if (!ref || ref.index < 0) continue;                 // generated pages have no editable source
    const entity = ref.kind === 'article' ? plan.articles[ref.index] : plan.pages[ref.index];
    if (!entity) continue;
    const titleField = ref.kind === 'article' ? 'title' : 'title';
    const descField = ref.kind === 'article' ? 'excerpt' : 'description';
    const prose = leadText(byFile.get(page.path) || '');

    // --- meta description -------------------------------------------------------------------
    const desc = String(entity[descField] || '');
    if (!desc.trim()) {
      const derived = trimToSentence(prose, DESC_MAX);
      if (derived.length >= 40) {
        out.push({
          id: `${ref.kind}:${ref.index}:${descField}:missing`,
          path: page.path, target: ref.kind, index: ref.index, field: descField,
          issue: 'No meta description',
          reason: 'Meta quality is 10 points and an absent description scores 0. Taken from this page’s own opening text — no new claims.',
          before: '', after: derived,
        });
      }
    } else if (desc.length > DESC_MAX) {
      out.push({
        id: `${ref.kind}:${ref.index}:${descField}:long`,
        path: page.path, target: ref.kind, index: ref.index, field: descField,
        issue: `Description is ${desc.length} characters (over ${DESC_MAX})`,
        reason: 'Trimmed at a word boundary. Nothing is added; the tail is cut where search engines already truncate it.',
        before: desc, after: trimToSentence(desc, DESC_MAX),
      });
    } else if (desc.length < DESC_MIN && prose.length > DESC_MIN) {
      // Extend using the page's own prose, only when the existing text is a prefix of it — otherwise
      // the description is bespoke copy and must not be rewritten.
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      if (norm(prose).startsWith(norm(desc).slice(0, 40)) && norm(desc).length >= 10) {
        const extended = trimToSentence(norm(prose), DESC_MAX);
        if (extended.length > desc.length + 20) {
          out.push({
            id: `${ref.kind}:${ref.index}:${descField}:short`,
            path: page.path, target: ref.kind, index: ref.index, field: descField,
            issue: `Description is ${desc.length} characters (under ${DESC_MIN})`,
            reason: 'Extended from the page’s own opening text, which the current description already quotes.',
            before: desc, after: extended,
          });
        }
      }
    }

    // --- title ------------------------------------------------------------------------------
    const title = String(entity[titleField] || '');
    if (title && title.length > TITLE_MAX) {
      const trimmed = trimToWord(title, TITLE_MAX);
      if (trimmed.length >= 20) {
        out.push({
          id: `${ref.kind}:${ref.index}:${titleField}:long`,
          path: page.path, target: ref.kind, index: ref.index, field: titleField,
          issue: `Title is ${title.length} characters (over ${TITLE_MAX})`,
          reason: 'Trimmed at a word boundary. Review this one — a title is the page’s strongest label and trimming loses words.',
          before: title, after: trimmed, review: true,
        });
      }
    } else if (title && title.length < TITLE_MIN && siteName
      && !title.toLowerCase().includes(siteName.toLowerCase())) {
      const suffixed = `${title} | ${siteName}`;
      if (suffixed.length <= TITLE_MAX) {
        out.push({
          id: `${ref.kind}:${ref.index}:${titleField}:short`,
          path: page.path, target: ref.kind, index: ref.index, field: titleField,
          issue: `Title is ${title.length} characters (under ${TITLE_MIN})`,
          reason: 'Appends the site name, which is already a fact in the plan. No new claims.',
          before: title, after: suffixed,
        });
      }
    }
  }
  return out;
}

/** Apply a selection of proposed fixes. Returns a NEW plan; the input is not mutated. */
function applyFixes(plan, proposals, selectedIds) {
  const want = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const chosen = (proposals || []).filter((p) => want.has(p.id));
  if (!chosen.length) return { plan, applied: [] };

  const next = {
    ...plan,
    pages: (plan.pages || []).map((p) => ({ ...p })),
    articles: (plan.articles || []).map((a) => ({ ...a })),
  };
  const applied = [];
  for (const fix of chosen) {
    const list = fix.target === 'article' ? next.articles : next.pages;
    const entity = list[fix.index];
    if (!entity) continue;
    // Refuse if the current value is not what the proposal was computed against: the plan may have
    // changed since the audit ran, and silently overwriting newer copy would be data loss.
    if (String(entity[fix.field] || '') !== String(fix.before || '')) {
      applied.push({ id: fix.id, ok: false, reason: 'the current value changed since the audit — re-run it' });
      continue;
    }
    entity[fix.field] = fix.after;
    applied.push({ id: fix.id, ok: true, field: fix.field, path: fix.path });
  }
  return { plan: next, applied };
}

module.exports = { auditPage, auditSite, proposeFixes, applyFixes, fileForPath, planIndex, trimToWord, trimToSentence, leadText,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX };
