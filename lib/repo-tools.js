// lib/repo-tools.js
// ============================================================
//  Read-only Read/Grep/Glob over this instance's own repo.
//
//  Moved out of server.js on 2026-08-06 after the unbounded version took production down. It lived
//  inline, reachable only by dev-architect-grok, and was untestable except by regex-extracting source
//  — which is how a real defect survived in it. The denylist still lives in
//  lib/self-improve/plan-store.js and is INJECTED, never copied: one implementation of "what may be
//  read", or there are two lists to forget to update.
//
//  ── WHAT WENT WRONG, AND THE BOUND THAT ANSWERS IT ──
//  The old walk counted HITS, not files visited:
//
//      walkRepoFiles(BASE, (a, r) => { grepOneFile(a, r); return hits.length > 0; }, MAX_HITS)
//
//  With zero matches the callback returns false forever, `count` never increments, and the walk
//  crosses the WHOLE tree — reading every file with `readFileSync(abs,'utf-8')`, no size cap, no
//  binary skip, no byte ceiling, no clock. A grep for something that isn't there is the common case,
//  not the edge case. On a dev checkout (467 files) that is 1.3s and unnoticeable. On the VPS, where
//  the tree also holds hosted Web Studio sites and an unpruned `.magent/runs/`, it was enough to take
//  the process down mid-pipeline.
//
//  Every bound below is therefore on work ACTUALLY DONE — files visited, bytes read, wall clock —
//  never on results found. A budget that only counts successes does not bound a search that fails.
//
//  ── AND IT SAYS WHEN IT STOPPED EARLY ──
//  A truncated scan that reports like a complete one is the same defect as the 4000-char stage-input
//  cut: the caller cannot tell "no matches exist" from "I stopped looking". Every bounded result
//  carries a note naming which budget ran out.
//
//  Pure except for fs reads. No shell-out: Grep/Glob are a directory walk plus a JS RegExp, so there
//  is no command-injection surface.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

/** Directories never descended into, at any depth. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'commercial']);

/**
 * Extensions never read as text. Grepping a .webp produces megabytes of mojibake, zero useful hits,
 * and a large transient string — pure cost. `.svg` and `.map` are deliberately ABSENT: svg is XML an
 * audit may legitimately want, and a source map is text (the size cap handles the big ones).
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.webm', '.ogg',
  '.wasm', '.node', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.pyc',
]);

/**
 * Work budgets. Generous enough that no honest search on this repo notices them, small enough that a
 * pathological one cannot exhaust the box. Tuned against the real corpus: a full unmatched walk here
 * visits ~467 files / ~44MB, so every ceiling sits roughly an order of magnitude above normal use.
 */
const LIMITS = Object.freeze({
  maxHits: 200,            // results returned
  maxFilesScanned: 5000,   // files VISITED — the bound the old code was missing entirely
  maxBytesRead: 32 * 1024 * 1024,
  // Per file, for Grep. 512KB was too small and it mattered: server.js is 716KB, so the single most
  // important file in this repo was skipped SILENTLY — a grep for `buildRepoToolset` answered
  // "No matches." while the symbol was defined there. Found by the first real security-sweep
  // (run-1786080073868), which reproduced it first-hand. 2MB clears server.js with room; the 32MB
  // total still bounds the scan, so at worst 16 files this size are read.
  maxFileBytes: 2 * 1024 * 1024,
  maxOutputChars: 150_000,  // a single Read
  timeBudgetMs: 10_000,
});

/** Mutable per-call budget. `stopped` records WHICH ceiling ran out, for the caller-facing note. */
function newBudget(limits) {
  return {
    files: 0, bytes: 0, deadline: Date.now() + limits.timeBudgetMs, stopped: null,
    // Files the scan DECLINED to read. Tracked because omitting them silently is the same defect as
    // an unannounced truncation: the caller cannot tell "not present" from "not looked at".
    skippedLarge: [], skippedBinary: 0,
  };
}

const noteFor = (budget) => {
  const parts = [];
  if (budget.stopped) {
    const why = {
      files: `after scanning ${budget.files} files (limit ${LIMITS.maxFilesScanned})`,
      bytes: `after reading ${Math.round(budget.bytes / 1048576)}MB (limit ${Math.round(LIMITS.maxBytesRead / 1048576)}MB)`,
      time: `after ${LIMITS.timeBudgetMs / 1000}s`,
    }[budget.stopped];
    parts.push(`[... SEARCH INCOMPLETE: stopped ${why}. This is NOT "no more matches" — narrow the`
      + ` search with a \`path\` or a more specific pattern and run it again. Do not conclude anything`
      + ` from the absence of a result here. ...]`);
  }
  // Reported SEPARATELY from budget exhaustion: different cause, different remedy. A skipped file
  // means "read this one directly with Read"; an exhausted budget means "narrow the search".
  if (budget.skippedLarge.length) {
    parts.push(`[... NOT SEARCHED: ${budget.skippedLarge.length} file(s) exceed the ${Math.round(LIMITS.maxFileBytes / 1024)}KB`
      + ` per-file cap and were not read — ${budget.skippedLarge.slice(0, 10).join(', ')}`
      + `${budget.skippedLarge.length > 10 ? ', …' : ''}. A match inside them would NOT appear above.`
      + ` Use Read on a specific file to inspect one. ...]`);
  }
  if (budget.skippedBinary) {
    parts.push(`[... ${budget.skippedBinary} binary file(s) skipped by extension (images, fonts, archives). ...]`);
  }
  return parts.length ? '\n\n' + parts.join('\n') : '';
};

/**
 * Build the toolset bound to one repo root and one path-allowance predicate.
 *
 * @param {{base: string, isPathAllowed: (rel: string) => boolean, limits?: object}} deps
 */
function createRepoTools({ base, isPathAllowed, limits = LIMITS } = {}) {
  if (!base) throw new Error('createRepoTools: base is required');
  if (typeof isPathAllowed !== 'function') throw new Error('createRepoTools: isPathAllowed is required');

  const rel = (abs) => path.relative(base, abs).replace(/\\/g, '/');

  /** Depth-first walk, bounded by FILES VISITED and the clock — not by how many results were found. */
  function walk(startDir, onFile, budget) {
    const stack = [startDir];
    while (stack.length) {
      if (budget.files >= limits.maxFilesScanned) { budget.stopped = 'files'; return; }
      if (Date.now() > budget.deadline) { budget.stopped = 'time'; return; }
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (budget.files >= limits.maxFilesScanned) { budget.stopped = 'files'; return; }
        if (Date.now() > budget.deadline) { budget.stopped = 'time'; return; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        const r = rel(abs);
        if (!isPathAllowed(r)) continue;
        budget.files++;                       // counted per file CONSIDERED, pass or fail
        if (onFile(abs, r) === 'stop') return;
      }
    }
  }

  function readTextFile(abs, budget) {
    // Every `return null` below is a file the caller will never hear about unless it is RECORDED.
    // That was the bug: a skip identical in output to "searched and found nothing".
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) { budget.skippedBinary++; return null; }
    let size;
    try { size = fs.statSync(abs).size; } catch { return null; }
    if (size > limits.maxFileBytes) { budget.skippedLarge.push(rel(abs)); return null; }
    if (budget.bytes + size > limits.maxBytesRead) { budget.stopped = 'bytes'; return null; }
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { return null; }
    budget.bytes += size;
    return text;
  }

  function grep(args, budget) {
    let re;
    try { re = new RegExp(String(args.pattern || '')); } catch { return 'Error: invalid regex pattern.'; }
    const hits = [];
    const scan = (abs, r) => {
      if (hits.length >= limits.maxHits) return 'stop';
      const text = readTextFile(abs, budget);
      if (text === null) return budget.stopped === 'bytes' ? 'stop' : undefined;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limits.maxHits) return 'stop';
        if (re.test(lines[i])) hits.push(`${r}:${i + 1}: ${lines[i].slice(0, 200)}`);
      }
      return undefined;
    };

    if (args.path) {
      // May name a single FILE (natural right after a Read) or a directory to scope the search.
      const r = String(args.path);
      if (!isPathAllowed(r)) return `Error: reading "${r}" is not allowed.`;
      const abs = path.join(base, r);
      if (!abs.startsWith(base)) return 'Error: path escapes the repo root.';
      let st;
      try { st = fs.statSync(abs); } catch { return `Error: no such file or directory: ${r}`; }
      if (st.isFile()) { budget.files++; scan(abs, r); }
      else if (st.isDirectory()) walk(abs, scan, budget);
      else return `Error: no such file or directory: ${r}`;
    } else {
      walk(base, scan, budget);
    }
    return (hits.length ? hits.join('\n') : 'No matches.') + noteFor(budget);
  }

  function glob(args, budget) {
    // Minimal glob (no dependency): '**' -> any depth, '*' -> any run of non-slash chars.
    const pattern = String(args.pattern || '*');
    const reSrc = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$';
    let re;
    try { re = new RegExp(reSrc); } catch { return 'Error: invalid glob pattern.'; }
    const matches = [];
    walk(base, (abs, r) => {
      if (matches.length >= limits.maxHits) return 'stop';
      if (re.test(r)) matches.push(r);
      return undefined;
    }, budget);
    return (matches.length ? matches.join('\n') : 'No files matched.') + noteFor(budget);
  }

  function read(args) {
    const r = String(args.path || '');
    if (!isPathAllowed(r)) return `Error: reading "${r}" is not allowed.`;
    const abs = path.join(base, r);
    if (!abs.startsWith(base)) return 'Error: path escapes the repo root.';
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Error: no such file: ${r}`;
    const content = fs.readFileSync(abs, 'utf-8');
    return content.length > limits.maxOutputChars
      ? content.slice(0, limits.maxOutputChars) + '\n...[truncated]'
      : content;
  }

  /** Single entry point. Never throws: a tool must return an error string, not reject. */
  async function run(name, args) {
    const a = args || {};
    try {
      if (name === 'Read') return read(a);
      if (name === 'Grep') return grep(a, newBudget(limits));
      if (name === 'Glob') return glob(a, newBudget(limits));
      return `Error: unknown tool "${name}"`;
    } catch (e) {
      return `Error: ${(e && e.message) || e}`;
    }
  }

  return { run, NAMES: new Set(['Read', 'Grep', 'Glob']) };
}

module.exports = { createRepoTools, LIMITS, SKIP_DIRS, BINARY_EXT };
