// lib/board/db.js
// ============================================================
//  Kanban CODING BOARD datastore — embedded SQLite via the BUILT-IN node:sqlite (same as
//  lib/crm/db.js and lib/analytics/db.js). No native addon, nothing to `npm rebuild` on a Node
//  major upgrade.
//
//  This is the durable queue behind the Hermes-Dev coding platform. A task is a unit of coding
//  work; the dumb dispatcher (dispatcher.js) claims a `ready` task, runs the hermes-task runner as
//  an OS process, and records where it landed (branch/PR/result). Every worker is a full OS process
//  coordinating through THIS board — never an in-process subagent (the failure class the phase-1
//  probe saga hit). The board is the single source of truth; the dashboard reads it, the dispatcher
//  writes it, both in the app process.
//
//  STATE MACHINE (enforced in repo.js, not here — SQLite can't):
//     queued ──deps satisfied──► ready ──claimed──► running ──► done | failed | blocked
//       │                          │                                          │
//       └──► cancelled             ├──► blocked ◄── (HITL: agent/human paused) ┘
//                                  └──► cancelled          blocked ──unblock──► ready
//     failed ──requeue──► ready            (done / cancelled are terminal)
//
//  WAL note (carried from the originals): journal_mode=WAL creates board.sqlite-wal / -shm sidecars.
//  A backup of .magent must checkpoint first (PRAGMA wal_checkpoint(TRUNCATE)) or copy all three
//  files together — copying board.sqlite alone mid-write restores corrupt state.
// ============================================================

// fallow-ignore-file duplicate-export
// openDb/getDb are the shared store contract (lib/crm/db.js and lib/analytics/db.js export the same
// two names). Every SQLite-backed domain opens on its own handle; nothing merges these into a barrel,
// so the duplicate-export heuristic is a false positive for the established store pattern.
const { createStore } = require('../sqlite-store');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',        -- the instruction handed to the agent
  state          TEXT NOT NULL DEFAULT 'queued',  -- queued|ready|running|blocked|done|failed|cancelled
  priority       INTEGER NOT NULL DEFAULT 100,    -- lower runs first
  assignee       TEXT NOT NULL DEFAULT '',        -- @agent or skill (advisory for now)
  created_by     TEXT NOT NULL DEFAULT '',
  workspace      TEXT NOT NULL DEFAULT '',        -- task dir once it runs
  branch         TEXT NOT NULL DEFAULT '',        -- pushed branch
  pr_url         TEXT NOT NULL DEFAULT '',        -- compare / PR link
  result         TEXT NOT NULL DEFAULT '',        -- runner status: pushed|tests_failed|no_changes|...
  worker         TEXT NOT NULL DEFAULT '',        -- dispatcher id that claimed it
  exit_code      INTEGER,
  cost_usd       TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  claimed_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_state    ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_updated  ON tasks(updated_at);

-- Append-only audit trail: every claim, state change, push, error. Never updated in place.
CREATE TABLE IF NOT EXISTS task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                       -- created|state_change|claimed|comment|finished|error
  data       TEXT NOT NULL DEFAULT '{}',          -- JSON
  author     TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);

-- HITL conversation on a task (block -> comment -> unblock).
CREATE TABLE IF NOT EXISTS task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id, created_at);

-- Dependency graph: from_task BLOCKS to_task (to_task cannot run until from_task is done).
CREATE TABLE IF NOT EXISTS task_links (
  id         TEXT PRIMARY KEY,
  from_task  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'blocks',      -- blocks|relates
  created_at TEXT NOT NULL,
  UNIQUE (from_task, to_task, type)
);
CREATE INDEX IF NOT EXISTS idx_links_to   ON task_links(to_task, type);
CREATE INDEX IF NOT EXISTS idx_links_from ON task_links(from_task, type);
`;

// Migration 2: dedupe_key for gateway intake (phase 2 slice 3). A retrying webhook must not create
// duplicate coding tasks, so an intake caller passes a stable key and the second POST returns the
// first task instead of spawning another run. Kept in a migration, not the base SCHEMA, because the
// base runs BEFORE migrations on every open: a fresh DB also starts at version 1 and runs this, so
// both fresh and already-created boards get the column + unique index exactly once.
const MIGRATIONS = [
  {
    version: 2,
    up(db) {
      db.exec('ALTER TABLE tasks ADD COLUMN dedupe_key TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL');
    },
  },
];

// foreignKeys ON: the board relies on ON DELETE CASCADE for events/comments/links, and on FK
// integrity for the dependency graph. (CRM needed it too; analytics did not.)
const store = createStore({ name: 'Board', schema: SCHEMA, migrations: MIGRATIONS, foreignKeys: true });

module.exports = { openDb: store.openDb, getDb: store.getDb };
