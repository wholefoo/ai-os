// lib/self-improve/plan-store.js
// ============================================================
//  Applies an AI-PROPOSED code-change plan to the platform's own source tree — the single most
//  safety-critical write path in this codebase (it can modify the running platform itself). A plan
//  is NEVER applied directly from an agent's output: server.js's gateAction hard-gates this action
//  type behind human approval regardless of the operator's Auto-Mode setting (see ALWAYS_GATE) —
//  and even once approved, this module enforces its OWN independent safety net:
//   - a git snapshot commit is taken immediately before any write, so every apply has a rollback point
//   - every target path is checked against a path denylist — CHECKED here, not just declared (the
//     previous self-improvement engine declared a BLOCKED_PATHS list but never consulted it, and one
//     of its own cases wrote to server.js despite that list explicitly naming it)
//   - each file is written atomically (temp file + rename) so a crash mid-write can't leave a
//     half-written source file
//   - re-validates the plan at apply time even though the caller (the approval flow) already did —
//     this is the last line of defense before a write happens, not the only one
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Never touch these, no matter what a plan asks for. Prefix-matched against the plan's relative path
// (case-folded — see isPathAllowed. NTFS/APFS are case-insensitive by default, so a case-sensitive
// compare here would let ".GIT/hooks/pre-commit" or "COMMERCIAL/x.js" silently pass).
const DENIED_PATH_PREFIXES = [
  '.env', '.git/', 'node_modules/', '.magent/state/', '.magent/vault/raw/', '.magent/artifacts/',
  'commercial/', // a separate private repo mounted here — this module only ever touches the public core
];
const DENIED_EXACT = new Set(['.env', 'package-lock.json']);

/**
 * Denied to WRITE but safe to READ.
 *
 * `package-lock.json` is on DENIED_EXACT because letting a self-improve plan rewrite a lockfile is a
 * supply-chain risk — it could pin a malicious or downgraded version and the change would look like
 * routine churn. That reasoning is about WRITES and does not transfer to reads: the file is
 * git-tracked, contains no secrets, and is the single artifact a dependency audit most needs.
 *
 * Reusing the write denylist for the read tools made the `dependencies` stage structurally unable to
 * do its job, and worse, the denial was INVISIBLE — Glob returned nothing and the security-auditor
 * concluded no lockfile existed, filing a false HIGH finding (DEP-01, run-1786080073868) against a
 * lockfile that has been committed since July. A denial that reads as an absence is the same defect
 * as an unannounced truncation.
 *
 * `.env` is NOT here and must never be: it is denied for both.
 */
const READ_ONLY_EXCEPTIONS = new Set(['package-lock.json']);
const DENIED_PATH_PREFIXES_LOWER = DENIED_PATH_PREFIXES.map(p => p.toLowerCase());
const DENIED_EXACT_LOWER = new Set([...DENIED_EXACT].map(p => p.toLowerCase()));
// Windows reserved device names — legal-looking filenames that Windows treats specially (with or
// without an extension, e.g. "CON.js" is just as reserved as "CON"). A plan targeting one of these
// doesn't escape the sandbox, but writeAtomic can still create it as a REAL file via Node's long-path
// I/O, and git (which does NOT use long-path opens for these names) then permanently fails to snapshot
// the repo on every subsequent apply — a self-inflicted, hard-to-recover denial of service.
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const MAX_FILES_PER_PLAN = 40;
const MAX_FILE_CHARS = 400_000; // generous ceiling for a single source file; guards against a runaway plan

/**
 * Normalize a plan-supplied relative path to the canonical, case-folded, forward-slash form used for
 * every comparison in this module (the denylist, the reserved-name check, and validatePlan's
 * duplicate-path dedup key) — so "./a.js", "a.js", and "A.js" are all recognized as the same target
 * instead of slipping past each individual check under a different spelling. Returns null for any
 * shape that can't be a safe relative path at all (empty, traversal, absolute, drive-qualified, or
 * containing a colon — which also blocks NTFS Alternate-Data-Stream syntax like "file.js:stream").
 * @returns {string|null}
 */
function normalizeRelPath(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return null;
  if (raw.split('/').includes('..')) return null; // no traversal segment anywhere, checked pre-normalize
  if (raw.includes(':')) return null; // drive letters, \\?\ and \\.\ prefixes, and ADS all contain ':'
  // path.posix.normalize only collapses "./" / "//" / redundant segments here — it can never introduce
  // a leading "../" since we already rejected every ".." segment above.
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || path.win32.isAbsolute(normalized)) return null;
  return normalized.toLowerCase();
}

function isPathAllowed(relPath) {
  const norm = normalizeRelPath(relPath);
  if (norm === null) return false;
  if (DENIED_EXACT_LOWER.has(norm)) return false;
  for (const prefix of DENIED_PATH_PREFIXES_LOWER) {
    const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    if (norm === bare || norm.startsWith(prefix)) return false;
  }
  for (const segment of norm.split('/')) {
    const base = segment.includes('.') ? segment.slice(0, segment.indexOf('.')) : segment;
    if (RESERVED_DEVICE_NAMES.has(base)) return false;
  }
  return true;
}

/**
 * Read-side allowance. Everything `isPathAllowed` permits, PLUS the write-only exceptions.
 *
 * Deliberately a separate function rather than a flag on isPathAllowed: the write path is the
 * security-critical one, and it must be impossible to widen it by passing the wrong argument. This
 * can only ever be MORE permissive than the write rule, never less, and only by the exact-path
 * entries in READ_ONLY_EXCEPTIONS — a prefix denial (`commercial/`, `.magent/state/`) still wins,
 * because `commercial/package-lock.json` normalises to a path that is not in that set.
 */
function isReadPathAllowed(relPath) {
  if (isPathAllowed(relPath)) return true;
  const norm = normalizeRelPath(relPath);
  return norm !== null && READ_ONLY_EXCEPTIONS.has(norm);
}

// Runtime (disk-touching) last line of defense, called right before each write: isPathAllowed is
// purely lexical and never sees the disk, so a symlink/junction sitting on an ALLOWED path could
// still resolve into repoRoot's parent or into a denied dir. Resolves the deepest EXISTING ancestor
// and asserts the real path stays inside repoRoot and still passes the denylist post-resolution.
function assertContained(repoRoot, relPath) {
  const target = path.join(repoRoot, relPath);
  // Walk up to the deepest EXISTING ancestor (only an existing dir can be a symlink/junction today —
  // anything below it will be freshly created by writeAtomic), remembering the not-yet-existing
  // intermediate names so the resolved path can be reconstructed in full below.
  let dir = path.dirname(target);
  const missingSuffix = [];
  while (!fs.existsSync(dir)) {
    missingSuffix.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root without finding an existing ancestor
    dir = parent;
  }
  const realRoot = fs.realpathSync(repoRoot);
  const realDir = fs.realpathSync(dir);
  const relFromRoot = path.relative(realRoot, realDir);
  if (relFromRoot === '..' || relFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relFromRoot)) {
    throw new Error(`refusing to write outside the repo root (symlink/junction escape?): ${relPath}`);
  }
  const resolvedRel = path.join(relFromRoot, ...missingSuffix, path.basename(target)).replace(/\\/g, '/');
  if (!isPathAllowed(resolvedRel)) {
    throw new Error(`refusing to write into a denied path reached via symlink: ${relPath} -> ${resolvedRel}`);
  }
}

/**
 * Validate a proposed plan's shape and paths WITHOUT touching disk. Called at proposal time (to
 * surface a bad plan before showing it to a human) AND again at apply time (defense in depth — the
 * plan a human approved must be exactly the plan that gets applied, re-checked, not re-trusted).
 * @returns {{ok: boolean, errors: string[]}}
 */
function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] };
  if (!Array.isArray(plan.files) || !plan.files.length) errors.push('plan.files must be a non-empty array');
  if (Array.isArray(plan.files) && plan.files.length > MAX_FILES_PER_PLAN) {
    errors.push(`plan touches ${plan.files.length} files — capped at ${MAX_FILES_PER_PLAN} per apply; split into multiple proposals`);
  }
  const seen = new Set();
  for (const f of (plan.files || [])) {
    if (!f || typeof f.path !== 'string') { errors.push('each file entry needs a string path'); continue; }
    if (!isPathAllowed(f.path)) { errors.push(`path not allowed: ${f.path}`); continue; }
    // Dedup on the NORMALIZED, case-folded path, not the raw string — "a.js" and "A.js" (or
    // "./a.js") are the same file on this filesystem, and writing both in sequence would silently
    // clobber the first with no error (see normalizeRelPath's header comment).
    const key = normalizeRelPath(f.path);
    if (seen.has(key)) { errors.push(`duplicate path in plan (same file once normalized): ${f.path}`); continue; }
    seen.add(key);
    if (typeof f.content !== 'string') errors.push(`file ${f.path}: content must be a string (full new file contents, not a diff)`);
    else if (f.content.length > MAX_FILE_CHARS) errors.push(`file ${f.path}: content exceeds the ${MAX_FILE_CHARS}-char cap`);
  }
  return { ok: errors.length === 0, errors };
}

// Write `content` to `absPath` atomically (temp file in the same dir, then rename) so a crash
// mid-write never leaves a truncated/corrupt source file. Creates parent dirs as needed.
function writeAtomic(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, absPath);
}

/**
 * Apply an APPROVED plan to the repo at `repoRoot`. Snapshots first (a git commit capturing
 * whatever is currently dirty, not just this plan's own change — that's intentional: it's a
 * rollback point for the pre-apply state, not a curated commit), then writes every file
 * atomically. Throws — without writing anything — if validation fails or the git snapshot itself
 * fails (no snapshot, no apply: this is a hard requirement, not best-effort).
 * @param {string} repoRoot
 * @param {{files: Array<{path:string, content:string}>}} plan
 * @returns {{ rollbackCommit: string, filesWritten: string[] }}
 */
function applyPlan(repoRoot, plan) {
  const v = validatePlan(plan);
  if (!v.ok) throw new Error(`refusing to apply an invalid plan: ${v.errors.join('; ')}`);

  let rollbackCommit;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
    if (status) execFileSync('git', ['commit', '-a', '-m', 'Auto-snapshot before AI-proposed upgrade apply'], { cwd: repoRoot, encoding: 'utf-8' });
    rollbackCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch (e) {
    throw new Error(`refusing to apply without a git snapshot (no rollback point): ${e.message}`);
  }

  const filesWritten = [];
  const newlyCreated = []; // paths that did not exist before this apply — removed by hand on failure,
                            // since `git reset --hard` never touches untracked files
  try {
    for (const f of plan.files) {
      const abs = path.join(repoRoot, f.path);
      assertContained(repoRoot, f.path);
      if (!fs.existsSync(abs)) newlyCreated.push(abs);
      writeAtomic(abs, f.content);
      filesWritten.push(f.path);
    }
  } catch (e) {
    // The plan is all-or-nothing: on any failure mid-loop, revert tracked-file changes to the
    // snapshot and delete anything this apply newly created, rather than leaving a half-applied
    // repo. Deliberately NOT `git clean -fd` — that would also delete unrelated pre-existing
    // untracked files the operator may have had sitting in the working tree.
    let rollbackError = null;
    try {
      execFileSync('git', ['reset', '--hard', rollbackCommit], { cwd: repoRoot, encoding: 'utf-8' });
      for (const p of newlyCreated) { try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ } }
    } catch (re) { rollbackError = re; }
    if (rollbackError) {
      throw new Error(`apply failed AND automatic rollback failed — manual recovery required (rollback point: ${rollbackCommit}): ${e.message}; rollback error: ${rollbackError.message}`);
    }
    throw new Error(`apply failed partway through — automatically rolled back to ${rollbackCommit}: ${e.message}`);
  }
  return { rollbackCommit, filesWritten };
}

// assertContained is exported for the LEGACY enterprise applyProposal path (server.js), so both
// self-modification systems share ONE containment implementation instead of the legacy one keeping
// its own weaker copy — the 2026-08-28 agent-overhead audit found it guarding writes with a 4-entry
// substring denylist and no traversal/symlink check at all.
module.exports = { validatePlan, applyPlan, isPathAllowed, isReadPathAllowed, assertContained, DENIED_PATH_PREFIXES, READ_ONLY_EXCEPTIONS };
