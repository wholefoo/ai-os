// lib/library/paths.js
// ============================================================
//  Turning a catalog record into a file path on disk, safely — PER STORE, because the three stores
//  are not the same shape and one rule does not fit them.
//
//  This module exists as its own file for one reason: it is the library's path-traversal boundary, and
//  a boundary that cannot be unit-tested is a boundary nobody can verify. It was originally written
//  inline in server.js, where the only way to exercise it was to craft a hostile catalog record and
//  restart the server. Now it takes its store roots as an argument and is a pure function.
//
//  The three rules, and why they differ:
//
//    vault      — FLAT per folder ('wiki/agent-roster.md'). basename the file and confirm the folder
//                 is one the vault actually has. This is what the legacy /api/vault routes do, and it
//                 is sufficient ONLY because each vault folder is flat.
//    org-docs   — ID-ONLY. The filename is a uuid we generated, never anything a user typed, so there
//                 is nothing to sanitise beyond confirming that is still true. Strongest of the three.
//    artifacts  — NESTED TREE ('docs/plan.md', 'web-studio/site/x.html'). basename CANNOT express a
//                 valid path here, so containment is the rule: resolve, then prove the result is still
//                 under the root. This is the general form; the vault's basename check is a special
//                 case of it that happens to work for a flat directory.
//
//  Every branch fails closed and returns null. A caller treats null as "not readable" and does not
//  probe further — there is deliberately no error message distinguishing "bad path" from "wrong
//  store", because the difference is only useful to someone testing our guard.
//
//  Pure module: no fs, no state. Existence is the caller's problem; legitimacy is ours.
// ============================================================

'use strict';

const path = require('path');

/** The vault's folders. Kept here as well as in server.js on purpose: this module must not depend on
 *  server.js, and the list is a property of the store's layout, not of any one route. */
const VAULT_FOLDERS = Object.freeze(['raw', 'wiki', 'outputs']);

/**
 * Resolve a record to an absolute path, or null if it does not legitimately resolve.
 *
 * @param {object} record             needs `store` and `path` (store-root-relative)
 * @param {object} roots              `{ vault, orgDocs, artifacts }` absolute store roots
 * @returns {string|null}
 */
function resolveRecordPath(record, roots) {
  if (!record || typeof record !== 'object' || !roots) return null;
  const rel = String(record.path == null ? '' : record.path);
  if (!rel) return null;
  // A NUL byte truncates a path in some syscalls — refuse before any join sees it.
  if (rel.includes('\0')) return null;

  // Refuse '..' as a segment, in EVERY store, before any store-specific rule runs.
  //
  // This is stricter than it needs to be for safety, and deliberately so. The vault rule below uses
  // path.basename, which does not escape — but it does silently REWRITE: 'wiki/../../../etc/passwd'
  // would flatten to '<vault>/wiki/passwd', a real file that is not the file the record names. A guard
  // that quietly resolves to something else is worse than one that refuses, because the caller cannot
  // tell it happened. No legitimate record path contains '..' — they are generated from real
  // directory entries — so refusing costs nothing and removes a whole class of reasoning.
  const segments = rel.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) return null;

  if (record.store === 'vault') {
    if (!roots.vault) return null;
    // Normalise separators so a Windows-style 'wiki\..\..\x' cannot slip past the '/' split.
    const norm = rel.replace(/\\/g, '/');
    const slash = norm.indexOf('/');
    if (slash < 0) return null;
    const folder = norm.slice(0, slash);
    if (!VAULT_FOLDERS.includes(folder)) return null;
    const file = path.basename(norm.slice(slash + 1));
    if (!file || file === '.' || file === '..' || file.startsWith('.')) return null;
    const dir = path.join(roots.vault, folder);
    const full = path.join(dir, file);
    return path.dirname(full) === dir ? full : null;
  }

  if (record.store === 'org-docs') {
    if (!roots.orgDocs) return null;
    const id = rel.replace(/\.txt$/i, '');
    // Word chars and hyphens only — no dots, no separators, so there is no path expression to build.
    if (!/^[\w-]+$/.test(id)) return null;
    return path.join(roots.orgDocs, `${id}.txt`);
  }

  if (record.store === 'artifacts') {
    if (!roots.artifacts) return null;
    const root = path.resolve(roots.artifacts);
    const full = path.resolve(root, rel);
    const inside = path.relative(root, full);
    // Empty means the path IS the root (a directory, not a record); '..' means it escaped; absolute
    // means a different drive on Windows, which `..` alone does not catch.
    if (!inside || inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
    return full;
  }

  // An unknown store is refused rather than guessed at — the same reasoning as the format allowlist
  // in lib/org/documents.js. A new store must state its own rule here before it can be read.
  return null;
}

module.exports = { resolveRecordPath, VAULT_FOLDERS };
