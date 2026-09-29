#!/usr/bin/env node
// lib/board/run-dispatcher.js
// ============================================================
//  Standalone Coding Board dispatcher — runs the coding-job pump in ITS OWN process (systemd unit
//  ai-os-board-dispatcher.service) instead of inside the web app.
//
//  WHY separate: the runner MUST `sudo -n hermes-agent-launch` (to drop to the confined agent) and
//  `chmod` setgid task directories. The web app's systemd unit is hardened with NoNewPrivileges=yes
//  and RestrictSUIDSGID=yes — which block exactly those two operations — and those directives can't be
//  selectively dropped for a child process. Rather than punch holes in the PUBLIC web app, the pump
//  runs as its own unhardened hermes service. It shares board.sqlite with the app over WAL (a second
//  connection sees the app's committed writes and vice-versa), so the app keeps serving the board API
//  and this process just claims ready tasks and runs them.
//
//  Trade-off noted: because this is a separate process it cannot push the app's WebSocket updates, so
//  the dashboard reflects dispatcher-driven state changes on refresh rather than live. App-side writes
//  (create/comment/actions) still broadcast normally.
// ============================================================

const path = require('path');
const board = require('./index');
const { createDispatcher } = require('./dispatcher');

// board.sqlite lives at <app>/.magent/board.sqlite — the same path server.js uses (BASE = its
// __dirname = the app root). This file is <app>/lib/board/, so the app root is two levels up.
const APP_ROOT = path.join(__dirname, '..', '..');
const MAGENT_DIR = path.join(APP_ROOT, '.magent');

const raw = (process.env.HERMES_RUNNER_CMD || '/usr/local/bin/hermes-task').trim();
const runnerCmd = raw.split(/\s+/).filter(Boolean);

board.openDb(path.join(MAGENT_DIR, 'board.sqlite'));

const dispatcher = createDispatcher({
  runnerCmd,
  maxConcurrency: Number(process.env.HERMES_BOARD_CONCURRENCY || 1) || 1,
  pollMs: Number(process.env.HERMES_BOARD_POLL_MS || 5000) || 5000,
  timeoutMs: Number(process.env.HERMES_BOARD_TIMEOUT_MS || 0) || 0,
  logDir: path.join(MAGENT_DIR, 'board-logs'),
});
dispatcher.start();
console.log(`[board-dispatcher] started (${dispatcher.id}, concurrency ${dispatcher.maxConcurrency}, runner: ${runnerCmd.join(' ')})`);

function shutdown(sig) {
  console.log(`[board-dispatcher] ${sig} — stopping`);
  try { dispatcher.stop(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The pump's interval is unref'd (so it never blocks a host that embeds it); as a standalone service
// we must keep the process alive ourselves.
setInterval(() => {}, 1 << 30);
