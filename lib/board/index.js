// lib/board/index.js
// ============================================================
//  Public facade for the Kanban coding board. server.js requires THIS: it opens the DB at boot and,
//  only where enabled, starts the dispatcher. Like the CRM facade, the board is strictly additive —
//  if it is not opened, the repo throws a clear "not opened" error rather than corrupting anything,
//  and the dispatcher simply never starts.
//
//  Enabling the dispatcher is opt-in via env, because it runs real coding jobs:
//    HERMES_BOARD_DISPATCH=1        turn the pump on (default off — the board still records/serves)
//    HERMES_RUNNER_CMD="sudo -n -u hermes -H /usr/local/bin/hermes-task"   the runner (space-split)
//    HERMES_BOARD_CONCURRENCY=1     max simultaneous runs (default 1 — one task at a time)
//    HERMES_BOARD_POLL_MS=5000      dispatcher tick interval
// ============================================================

// fallow-ignore-file duplicate-export
// This facade re-exports `repo` (a name the CRM/analytics facades also use). That is the intended
// multi-domain pattern — each domain module is required on its own handle (board.repo, crm.repo),
// never merged into one barrel — so the duplicate-export heuristic is a false positive here.
// createDispatcher / parseRunnerOutput are intentionally NOT re-exported: they live only in
// ./dispatcher (tests import that module directly), so the facade never duplicates their names.
const db = require('./db');
const repo = require('./repo');
const { createDispatcher } = require('./dispatcher');   // used internally by startDefaultDispatcher
const { registerBoardRoutes } = require('./routes');

let _dispatcher = null;

function openDb(p) { db.openDb(p); }

// Start the dispatcher from env config. Returns the dispatcher, or null when disabled / misconfigured
// (a missing runner command disables it rather than crashing the whole server at boot).
function startDefaultDispatcher(overrides = {}) {
  if (_dispatcher) return _dispatcher;
  const on = String(process.env.HERMES_BOARD_DISPATCH || '') === '1' || overrides.enabled === true;
  if (!on) return null;
  const raw = overrides.runnerCmd || (process.env.HERMES_RUNNER_CMD || '').trim();
  const runnerCmd = Array.isArray(raw) ? raw : raw.split(/\s+/).filter(Boolean);
  if (!runnerCmd.length) { try { console.error('[board] HERMES_BOARD_DISPATCH is on but HERMES_RUNNER_CMD is empty — dispatcher NOT started'); } catch {} return null; }
  _dispatcher = createDispatcher({
    runnerCmd,
    maxConcurrency: Number(overrides.maxConcurrency || process.env.HERMES_BOARD_CONCURRENCY || 1) || 1,
    pollMs: Number(overrides.pollMs || process.env.HERMES_BOARD_POLL_MS || 5000) || 5000,
    timeoutMs: Number(overrides.timeoutMs || process.env.HERMES_BOARD_TIMEOUT_MS || 0) || 0,
    onLog: overrides.onLog || null,
    logDir: overrides.logDir || null,          // caller (server.js) supplies an absolute path under .magent
  });
  _dispatcher.start();
  try { console.log(`[board] dispatcher started (${_dispatcher.id}, concurrency ${_dispatcher.maxConcurrency})`); } catch {}
  return _dispatcher;
}

function stopDispatcher() { if (_dispatcher) { _dispatcher.stop(); _dispatcher = null; } }
function getDispatcher() { return _dispatcher; }

module.exports = {
  openDb,
  repo,
  registerBoardRoutes,
  startDefaultDispatcher,
  stopDispatcher,
  getDispatcher,
};
