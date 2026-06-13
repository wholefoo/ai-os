// lib/web-studio/build.js
// ============================================================
//  Single-flight build runner for site workspaces. Runs `npm install` (first build)
//  then `astro build`, capped by timeout + heap, ONE build at a time — so a site
//  build never starves the live AI OS process on the shared VPS.
//
//  This is the unified compile step: creation, AI-edit, and Monaco-edit all funnel
//  through runBuild() — a build is ALWAYS from the workspace on disk, never from an
//  in-memory diff.
// ============================================================

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_CONCURRENT = 1;          // serialize builds on the shared box
const BUILD_TIMEOUT_MS = 180000;   // 3 min hard cap on `astro build`
const INSTALL_TIMEOUT_MS = 300000; // 5 min for first-run `npm install`
const NODE_HEAP_MB = 512;          // cap the build process heap

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

function _exec(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${NODE_HEAP_MB}`, CI: '1', NO_COLOR: '1', ASTRO_TELEMETRY_DISABLED: '1' },
    }, (err, stdout, stderr) => {
      const log = `${stdout || ''}${stderr ? '\n' + stderr : ''}`;
      if (err) { err.buildLog = log; return reject(err); }
      resolve(log);
    });
  });
}

/**
 * Build a scaffolded site workspace to dist/. Installs deps on first run.
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
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      log += '$ npm install\n';
      log += await _exec('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, INSTALL_TIMEOUT_MS);
    }
    log += '\n$ astro build\n';
    log += await _exec('npx', ['--no-install', 'astro', 'build'], dir, timeoutMs);
    const ok = fs.existsSync(path.join(distDir, 'index.html'));
    return { ok, distDir, log, durationMs: Date.now() - started, error: ok ? undefined : 'build produced no dist/index.html' };
  } catch (e) {
    return { ok: false, distDir, log: `${log}\n${e.buildLog || e.message}`, durationMs: Date.now() - started, error: e.killed ? 'build timed out' : e.message };
  } finally {
    _release();
  }
}

module.exports = { runBuild, MAX_CONCURRENT };
