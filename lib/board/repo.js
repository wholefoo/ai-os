// lib/board/repo.js
// ============================================================
//  Board data access + the STATE MACHINE. db.js owns the tables; this owns every legal transition,
//  the atomic claim, the event log, comments and the dependency graph. Nothing else writes `tasks`.
//
//  Why the transitions live here and not in SQLite: SQLite can enforce shapes and foreign keys, not
//  "running may only become done/failed/blocked". Centralising it in one guarded function means a
//  bad transition throws instead of silently corrupting the board — and the test suite reverts each
//  guard to prove it fires.
// ============================================================

const crypto = require('crypto');
const { getDb } = require('./db');

const now = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

// The only legal state edges. Anything not listed throws in setState().
const TRANSITIONS = {
  queued:    ['ready', 'cancelled'],
  ready:     ['running', 'blocked', 'queued', 'cancelled'],
  running:   ['done', 'failed', 'blocked'],
  blocked:   ['ready', 'cancelled'],
  failed:    ['ready', 'cancelled'],   // requeue a failed task
  done:      [],                       // terminal
  cancelled: [],                       // terminal
};
const TERMINAL = new Set(['done', 'cancelled']);

// Runner RESULT status -> board outcome. Kept here so the dispatcher stays dumb.
//   pushed / no_changes -> the run did its job (a no-op change is still a successful run)
//   blocked             -> the agent paused for a human (HITL)
//   everything else     -> failed (tests_failed, agent_error, push_failed, unsafe, push_failed…)
function outcomeFor(status) {
  if (status === 'pushed' || status === 'no_changes') return 'done';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}

function _event(taskId, type, data = {}, author = 'system') {
  getDb().prepare('INSERT INTO task_events (id, task_id, type, data, author, created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('ev'), taskId, type, JSON.stringify(data || {}), author, now());
}

function get(id) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
}

// Look up a task by its intake dedupe key (gateway intake retry-safety). Null when unused.
function findByDedupe(key) {
  if (!key) return null;
  return getDb().prepare('SELECT * FROM tasks WHERE dedupe_key = ?').get(String(key)) || null;
}

function list({ state, limit = 500 } = {}) {
  const db = getDb();
  if (state) return db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY priority ASC, created_at ASC LIMIT ?').all(state, limit);
  return db.prepare('SELECT * FROM tasks ORDER BY priority ASC, created_at ASC LIMIT ?').all(limit);
}

function counts() {
  const rows = getDb().prepare('SELECT state, COUNT(*) n FROM tasks GROUP BY state').all();
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

// Create a task. Starts `ready` unless it has unmet dependencies (then `queued`), or the caller
// explicitly holds it with { start: false }.
function create({ title, body = '', priority = 100, assignee = '', createdBy = '', dependsOn = [], start = true, dedupeKey = null } = {}) {
  if (!title || !String(title).trim()) throw new Error('board.create: title is required');
  const db = getDb();
  const id = uid('task');
  const ts = now();
  const state = start ? 'ready' : 'queued';
  db.prepare(`INSERT INTO tasks (id, title, body, state, priority, assignee, created_by, dedupe_key, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, String(title).trim(), String(body || ''), state, priority | 0, assignee || '', createdBy || '', dedupeKey || null, ts, ts);
  _event(id, 'created', { title, priority, assignee, dependsOn }, createdBy || 'system');
  for (const dep of dependsOn || []) {
    if (dep && dep !== id) {
      db.prepare('INSERT OR IGNORE INTO task_links (id, from_task, to_task, type, created_at) VALUES (?,?,?,?,?)')
        .run(uid('lnk'), dep, id, 'blocks', ts);
    }
  }
  // A task with unmet deps must not sit in `ready`; drop it to queued.
  if (state === 'ready' && !depsSatisfied(id)) {
    db.prepare("UPDATE tasks SET state='queued', updated_at=? WHERE id=?").run(now(), id);
  }
  return get(id);
}

// Are all of a task's blocking dependencies done?
function depsSatisfied(id) {
  const rows = getDb().prepare(
    `SELECT t.state FROM task_links l JOIN tasks t ON t.id = l.from_task
     WHERE l.to_task = ? AND l.type = 'blocks'`).all(id);
  return rows.every((r) => r.state === 'done');
}

// Validated transition. `to` must be reachable from the current state or this throws.
function setState(id, to, { author = 'system', ...patch } = {}) {
  const db = getDb();
  const t = get(id);
  if (!t) throw new Error(`board.setState: no task ${id}`);
  if (t.state === to) return t;
  const allowed = TRANSITIONS[t.state] || [];
  if (!allowed.includes(to)) throw new Error(`board.setState: illegal transition ${t.state} -> ${to} (task ${id})`);

  const cols = ['state = ?', 'updated_at = ?'];
  const vals = [to, now()];
  const settable = ['workspace', 'branch', 'pr_url', 'result', 'worker', 'exit_code', 'cost_usd', 'blocked_reason'];
  for (const k of settable) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); vals.push(patch[k]); }
  }
  if (TERMINAL.has(to) || to === 'failed') { cols.push('finished_at = ?'); vals.push(now()); }
  vals.push(id);
  db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  _event(id, 'state_change', { from: t.state, to, ...patch }, author);

  // Reaching `done` may unblock dependents: promote any queued task whose deps are now all done.
  if (to === 'done') promoteReady();
  return get(id);
}

// Move every `queued` task whose blocking deps are all done into `ready`. Idempotent.
function promoteReady() {
  const db = getDb();
  const queued = db.prepare("SELECT id FROM tasks WHERE state = 'queued'").all();
  let promoted = 0;
  for (const { id } of queued) {
    if (depsSatisfied(id)) {
      db.prepare("UPDATE tasks SET state='ready', updated_at=? WHERE id=? AND state='queued'").run(now(), id);
      _event(id, 'state_change', { from: 'queued', to: 'ready', reason: 'deps_satisfied' });
      promoted++;
    }
  }
  return promoted;
}

function runningCount() {
  return getDb().prepare("SELECT COUNT(*) n FROM tasks WHERE state = 'running'").get().n;
}

// Atomically claim the top-priority ready task for `worker`. Returns the claimed task or null.
// BEGIN IMMEDIATE takes the write lock up front; the `AND state='ready'` guard is the compare-and-set
// so two concurrent claimers can never both win the same row (one sees 0 changes and gets null).
function claimNext(worker) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE state = 'ready' ORDER BY priority ASC, created_at ASC LIMIT 1").get();
    if (!row) { db.exec('COMMIT'); return null; }
    const ts = now();
    const res = db.prepare(
      "UPDATE tasks SET state='running', worker=?, claimed_at=?, updated_at=?, attempts=attempts+1 WHERE id=? AND state='ready'")
      .run(worker || '', ts, ts, row.id);
    if (res.changes !== 1) { db.exec('ROLLBACK'); return null; }  // lost the race
    db.exec('COMMIT');
    _event(row.id, 'claimed', { worker }, 'system');
    return get(row.id);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

// Record the runner's outcome and move the card. status is the runner RESULT string.
function finish(id, { status, branch = '', prUrl = '', workspace = '', exitCode = null, costUsd = '' } = {}) {
  const to = outcomeFor(status);
  const patch = { result: status || '', branch, pr_url: prUrl, workspace, exit_code: exitCode, cost_usd: costUsd, author: 'dispatcher' };
  if (to === 'blocked') patch.blocked_reason = `runner reported: ${status}`;
  const t = setState(id, to, patch);
  _event(id, 'finished', { status, branch, prUrl, exitCode, costUsd }, 'dispatcher');
  return t;
}

function comment(id, body, author = '') {
  if (!get(id)) throw new Error(`board.comment: no task ${id}`);
  const c = { id: uid('cm'), task_id: id, author: author || '', body: String(body || ''), created_at: now() };
  getDb().prepare('INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?,?,?,?,?)')
    .run(c.id, c.task_id, c.author, c.body, c.created_at);
  _event(id, 'comment', { author, body: String(body || '').slice(0, 200) }, author || 'system');
  return c;
}

function comments(id) {
  return getDb().prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(id);
}

function events(id, limit = 200) {
  return getDb().prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?').all(id, limit);
}

// Convenience wrappers around the guarded setState.
const block = (id, reason = '', author = 'system') => setState(id, 'blocked', { blocked_reason: reason, author });
const unblock = (id, author = 'system') => setState(id, 'ready', { blocked_reason: '', author });
const cancel = (id, author = 'system') => setState(id, 'cancelled', { author });
const requeue = (id, author = 'system') => setState(id, 'ready', { author });

module.exports = {
  TRANSITIONS, outcomeFor,
  create, get, findByDedupe, list, counts, depsSatisfied, promoteReady,
  setState, claimNext, runningCount, finish,
  comment, comments, events,
  block, unblock, cancel, requeue,
};
