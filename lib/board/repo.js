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
//
// awaiting_approval is a HOLD that only a human releases (approve -> ready, or queued if its deps are
// not done yet). It exists because `queued` cannot hold anything: promoteReady() releases every queued
// task whose deps are done, and a task with NO deps satisfies that vacuously — so a task "held" in
// queued was released the moment any unrelated task finished. The approval gate needs a state that
// nothing automatic ever moves.
const TRANSITIONS = {
  awaiting_approval: ['ready', 'queued', 'cancelled'],
  queued:    ['ready', 'cancelled'],
  ready:     ['running', 'blocked', 'queued', 'cancelled'],
  running:   ['done', 'failed', 'blocked'],
  blocked:   ['ready', 'cancelled'],
  failed:    ['ready', 'cancelled'],   // requeue a failed task
  done:      [],                       // terminal
  cancelled: [],                       // terminal
};
const TERMINAL = new Set(['done', 'cancelled']);

// Per-task runner parameters. They become argv for the runner (no shell), so this is about refusing
// nonsense early with a clear error, not about injection — but a model name must still never look
// like an option, and the numbers stay inside what a single unattended run should ever be given.
const MODES = new Set(['task', 'plan']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;
const MAX_TASK_BUDGET_USD = 50;
const MAX_TASK_TURNS = 300;

function normalizeRunParams({ mode = 'task', model = '', budgetUsd = null, maxTurns = null } = {}) {
  const m = String(mode || 'task');
  if (!MODES.has(m)) throw new Error(`board: mode must be one of ${[...MODES].join('|')} (got "${m}")`);
  const mdl = String(model || '').trim();
  if (mdl && !MODEL_RE.test(mdl)) throw new Error(`board: invalid model name "${mdl}"`);
  let b = null;
  if (budgetUsd !== null && budgetUsd !== undefined && budgetUsd !== '') {
    b = Number(budgetUsd);
    if (!Number.isFinite(b) || b <= 0 || b > MAX_TASK_BUDGET_USD) throw new Error(`board: budgetUsd must be > 0 and <= ${MAX_TASK_BUDGET_USD}`);
  }
  let t = null;
  if (maxTurns !== null && maxTurns !== undefined && maxTurns !== '') {
    t = Number(maxTurns);
    if (!Number.isInteger(t) || t < 1 || t > MAX_TASK_TURNS) throw new Error(`board: maxTurns must be an integer 1..${MAX_TASK_TURNS}`);
  }
  return { mode: m, model: mdl, budgetUsd: b, maxTurns: t };
}

// Runner RESULT status -> board outcome. Kept here so the dispatcher stays dumb.
//   pushed / no_changes -> the run did its job (a no-op change is still a successful run)
//   planned             -> a --plan run produced its PLAN.md (nothing committed or pushed)
//   blocked             -> the agent paused for a human (HITL)
//   everything else     -> failed (tests_failed, agent_error, push_failed, unsafe, plan_violation…)
function outcomeFor(status) {
  if (status === 'pushed' || status === 'no_changes' || status === 'planned') return 'done';
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

// Create a task. Starts `ready` unless it has unmet dependencies (then `queued`). { start: false }
// HOLDS it in `awaiting_approval` until a human calls approve() — it used to park in `queued`, where
// promoteReady() released it as soon as any other task finished.
function create({
  title, body = '', priority = 100, assignee = '', createdBy = '', dependsOn = [], start = true, dedupeKey = null,
  mode = 'task', model = '', budgetUsd = null, maxTurns = null, missionId = null,
} = {}) {
  if (!title || !String(title).trim()) throw new Error('board.create: title is required');
  const p = normalizeRunParams({ mode, model, budgetUsd, maxTurns });
  const db = getDb();
  const id = uid('task');
  const ts = now();
  const state = start ? 'ready' : 'awaiting_approval';
  db.prepare(`INSERT INTO tasks (id, title, body, state, priority, assignee, created_by, dedupe_key,
                                 mode, model, budget_usd, max_turns, mission_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, String(title).trim(), String(body || ''), state, priority | 0, assignee || '', createdBy || '', dedupeKey || null,
      p.mode, p.model, p.budgetUsd, p.maxTurns, missionId || null, ts, ts);
  _event(id, 'created', { title, priority, assignee, dependsOn, mode: p.mode, model: p.model, budgetUsd: p.budgetUsd, maxTurns: p.maxTurns, missionId: missionId || null }, createdBy || 'system');
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
  const settable = ['workspace', 'branch', 'pr_url', 'result', 'worker', 'exit_code', 'cost_usd', 'blocked_reason', 'plan_md'];
  for (const k of settable) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); vals.push(patch[k]); }
  }
  if (TERMINAL.has(to) || to === 'failed') { cols.push('finished_at = ?'); vals.push(now()); }
  vals.push(id);
  db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  // The plan text can be long; the event records that a plan arrived, not the plan itself.
  const evPatch = { ...patch };
  if (evPatch.plan_md !== undefined) evPatch.plan_md = `${String(evPatch.plan_md).length} chars`;
  _event(id, 'state_change', { from: t.state, to, ...evPatch }, author);

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
function finish(id, { status, branch = '', prUrl = '', workspace = '', exitCode = null, costUsd = '', planMd = '' } = {}) {
  const to = outcomeFor(status);
  const patch = { result: status || '', branch, pr_url: prUrl, workspace, exit_code: exitCode, cost_usd: costUsd, author: 'dispatcher' };
  if (planMd) patch.plan_md = planMd;
  if (to === 'blocked') patch.blocked_reason = `runner reported: ${status}`;
  const t = setState(id, to, patch);
  _event(id, 'finished', { status, branch, prUrl, exitCode, costUsd, planChars: planMd ? planMd.length : 0 }, 'dispatcher');
  return t;
}

// Release a held task. Goes to `ready`, or to `queued` when its dependencies are not all done yet
// (promoteReady then releases it normally once they are).
function approve(id, author = 'system') {
  const t = get(id);
  if (!t) throw new Error(`board.approve: no task ${id}`);
  if (t.state !== 'awaiting_approval') throw new Error(`board.approve: task ${id} is ${t.state}, not awaiting_approval`);
  return setState(id, depsSatisfied(id) ? 'ready' : 'queued', { author });
}

// ---------- spend + the cross-process budget gate ----------

// USD recorded by board runs that finished after `sinceIso`. cost_usd is TEXT ('' until a run reports
// one), so blanks and non-numbers are skipped rather than counted as 0-dollar rows or NaN.
function spendSince(sinceIso) {
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS usd, COUNT(*) AS n FROM tasks
     WHERE finished_at IS NOT NULL AND finished_at > ? AND cost_usd != '' AND CAST(cost_usd AS REAL) > 0`).get(String(sinceIso));
  return { usd: Number(row.usd) || 0, count: Number(row.n) || 0 };
}

// Written by the web app (the process that owns budgets and the hard-cap switch); read by the
// dispatcher before every claim. One row, key 'global'.
function writeBudgetGate({ enforced, tripped = '', detail = {} } = {}) {
  getDb().prepare(
    `INSERT INTO budget_gate (key, enforced, tripped, detail, updated_at) VALUES ('global', ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET enforced=excluded.enforced, tripped=excluded.tripped,
       detail=excluded.detail, updated_at=excluded.updated_at`)
    .run(enforced ? 1 : 0, String(tripped || ''), JSON.stringify(detail || {}), now());
}

function readBudgetGate() {
  const r = getDb().prepare("SELECT * FROM budget_gate WHERE key = 'global'").get();
  if (!r) return null;
  let detail = {};
  try { detail = JSON.parse(r.detail || '{}'); } catch {}
  return { enforced: r.enforced === 1, tripped: r.tripped || '', detail, updatedAt: r.updated_at };
}

// May the dispatcher start a run right now? Fails CLOSED when the cap is enforced but the app has
// stopped refreshing the gate: the credit limit is the one constraint this platform promises, so an
// unknown budget must not be treated as an open one.
//   no row yet      -> allow (the app has never published — a board without the app, or first boot)
//   not enforced    -> allow (the hard cap is switched off; nothing to enforce)
//   tripped         -> deny
//   stale (> maxAgeMs since the app last wrote it) -> deny
function budgetAllowsClaim({ maxAgeMs = 5 * 60 * 1000, nowMs = Date.now() } = {}) {
  const g = readBudgetGate();
  if (!g) return { allow: true, reason: 'no budget gate published' };
  if (!g.enforced) return { allow: true, reason: 'hard budget off' };
  if (g.tripped) return { allow: false, reason: `${g.tripped} budget reached` };
  const age = nowMs - Date.parse(g.updatedAt);
  if (!(age <= maxAgeMs)) return { allow: false, reason: `budget gate stale (${Math.round(age / 1000)}s old) — is the app running?` };
  return { allow: true, reason: 'within budget' };
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
  TRANSITIONS, outcomeFor, normalizeRunParams,
  create, get, findByDedupe, list, counts, depsSatisfied, promoteReady,
  setState, claimNext, runningCount, finish, approve,
  comment, comments, events,
  block, unblock, cancel, requeue,
  spendSince, writeBudgetGate, readBudgetGate, budgetAllowsClaim,
};
