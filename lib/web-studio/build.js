// lib/web-studio/build.js
// ============================================================
//  Single-flight runner for isolated site builds. Never executes site code on the
//  application host. The preinstalled worker image supplies dependencies offline.
//
//  This is the unified compile step: creation, AI-edit, and Monaco-edit all funnel
//  through runBuild() — a build is ALWAYS from the workspace on disk, never from an
//  in-memory diff.
// ============================================================

const { isolatedBuild } = require('./isolated-build');
const fs = require('fs');
const path = require('path');

const MAX_CONCURRENT = 1;          // serialize builds on the shared box
const BUILD_TIMEOUT_MS = 180000;   // 3 min hard cap on `astro build`

// --- Single-flight queue ---
let _active = 0;
const _waiters = [];
function _acquire() {
  if (_active < MAX_CONCURRENT) { _active++; return Promise.resolve(); }
  return new Promise((resolve) => _waiters.push(resolve));
}
function _release() {
  _active = Math.max(0, _active - 1);
  const next = _waiters.shift();
  if (next) { _active++; next(); }
}



/**
 * Build a scaffolded site workspace to dist/ using the isolated worker.
 * Always resolves (never throws) — a failed build returns { ok:false, log, error }.
 * @param {string} dir workspace root
 * @returns {Promise<{ok:boolean, distDir:string, log:string, durationMs:number, error?:string}>}
 */
async function runBuild(dir, { timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  await _acquire();
  const started = Date.now();
  const distDir = path.join(dir, 'dist');
  let log = '';
  try {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      return { ok: false, distDir, log: 'not a scaffolded workspace (no package.json)', durationMs: 0, error: 'no package.json' };
    }
    log = await isolatedBuild(dir, timeoutMs);
    const ok = fs.existsSync(path.join(distDir, 'index.html'));
    return { ok, distDir, log, durationMs: Date.now() - started, error: ok ? undefined : 'build produced no dist/index.html' };
  } catch (e) {
    return { ok: false, distDir, log: `${log}\n${e.buildLog || e.message}`, durationMs: Date.now() - started, error: e.killed ? 'build timed out' : e.message };
  } finally {
    _release();
  }
}

/**
 * "Build" an IMPORTED static site: mirror src/ to dist/ verbatim. No Astro, no npm,
 * no code execution — the imported files ARE the output. Used for kind:'imported' sites.
 * @returns {{ok:boolean, distDir:string, log:string, durationMs:number, error?:string}}
 */
function staticBuild(dir) {
  const started = Date.now();
  const src = path.join(dir, 'src');
  const distDir = path.join(dir, 'dist');
  try {
    if (!fs.existsSync(src)) return { ok: false, distDir, log: 'no src/ to publish', durationMs: 0, error: 'no src' };
    fs.rmSync(distDir, { recursive: true, force: true });
    // Never copy symlinks into the served dir (defense in depth — nothing plants them today,
    // but a symlink in dist/ would let nginx follow it out of the web root).
    fs.cpSync(src, distDir, { recursive: true, dereference: false, filter: (s) => { try { return !fs.lstatSync(s).isSymbolicLink(); } catch { return false; } } });
    const ok = fs.existsSync(path.join(distDir, 'index.html'));
    return { ok, distDir, log: ok ? 'static import: src -> dist' : 'no index.html at import root', durationMs: Date.now() - started, error: ok ? undefined : 'no index.html at the site root' };
  } catch (e) {
    return { ok: false, distDir, log: e.message, durationMs: Date.now() - started, error: e.message };
  }
}

module.exports = { runBuild, staticBuild, MAX_CONCURRENT };
