// lib/sqlite-store.js
// ============================================================
//  The shared node:sqlite bootstrap: open a database, apply a schema, then run ordered
//  migrations against `schema_meta.version` — behind a per-store singleton.
//
//  Extracted from lib/crm/db.js and lib/analytics/db.js, which had this identical. Not a
//  coincidence of shape: analytics/db.js says in its own header "same pattern as lib/crm/db.js",
//  because it was written from it. The test that mattered is whether a future change would have to
//  be made in both — and it would: the WAL sidecar/backup discipline, the busy_timeout, and how a
//  migration transaction rolls back are all one decision, not two.
//
//  DELIBERATELY NOT generalised further. This takes a schema, a migration list and one boolean;
//  it is not a query builder and must not become one. The next store that needs a fourth knob
//  should get a fourth argument only if the knob is genuinely shared — otherwise it keeps its own
//  openDb, and that is the correct outcome.
//
//  WAL note carried from the originals: journal_mode=WAL creates `-wal` / `-shm` sidecars. A backup
//  of .magent must checkpoint first (PRAGMA wal_checkpoint(TRUNCATE)) or copy all three files
//  together — copying the .sqlite alone mid-write restores corrupt state.
// ============================================================

const { DatabaseSync } = require('node:sqlite');

/**
 * Build a store with its own private connection singleton.
 *
 * @param {object}   opts
 * @param {string}   opts.name           label used in the not-opened error, e.g. 'CRM'
 * @param {string}   opts.schema         CREATE TABLE / CREATE INDEX DDL, run on every open
 * @param {Array}    [opts.migrations]   ordered [{ version, up(db) }]; each runs once, in order
 * @param {boolean}  [opts.foreignKeys]  PRAGMA foreign_keys = ON (CRM needs it; analytics does not)
 * @returns {{ openDb: (dbPath: string) => object, getDb: () => object }}
 *
 * The singleton lives in this closure rather than at module scope, so two stores in one process
 * cannot collide — the property the two original modules got by being separate files, preserved
 * here on purpose rather than by accident.
 */
function createStore({ name, schema, migrations = [], foreignKeys = false }) {
  let db = null;

  function openDb(dbPath) {
    if (db) return db;
    const conn = new DatabaseSync(dbPath);
    conn.exec('PRAGMA journal_mode = WAL;');
    if (foreignKeys) conn.exec('PRAGMA foreign_keys = ON;');
    conn.exec('PRAGMA busy_timeout = 5000;');
    conn.exec(schema);

    // Seed version 1 on first open so migration 2+ has a floor to compare against. A store that
    // never seeded would re-run every migration on every boot.
    const verRow = conn.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
    let version = verRow ? Number(verRow.value) : 0;
    if (!verRow) {
      conn.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '1')").run();
      version = 1;
    }

    for (const m of migrations) {
      if (m.version > version) {
        conn.exec('BEGIN');
        try {
          m.up(conn);
          conn.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(m.version));
          conn.exec('COMMIT');
          version = m.version;
        } catch (e) { conn.exec('ROLLBACK'); throw e; }
      }
    }

    db = conn;
    return db;
  }

  function getDb() {
    if (!db) throw new Error(`${name} db not opened — call openDb(path) at boot first`);
    return db;
  }

  return { openDb, getDb };
}

module.exports = { createStore };
