// lib/crm/db.js
// ============================================================
//  CRM datastore — embedded SQLite via the BUILT-IN node:sqlite (Node 22.5+/24).
//  No native addon, nothing to `npm rebuild` on a Node major upgrade (deliberate:
//  the platform just got bitten by native-module breakage on the Node 24 jump).
//
//  This DB owns the UNBOUNDED CRM tables (contacts/activities/site_links). The
//  platform's JSON state (users, web_studio_sites, seo_audits, free_audit_log) stays
//  the system of record; the CRM indexes + overlays it. Migrating to Postgres later
//  is a repo-layer change (repo.js), not a server.js change.
//
//  WAL note: journal_mode=WAL creates crm.sqlite-wal / -shm sidecars. A backup of
//  .magent must checkpoint first (PRAGMA wal_checkpoint(TRUNCATE)) or copy all three
//  files together — copying crm.sqlite alone mid-write restores corrupt state.
// ============================================================

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS contacts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'master',
  email              TEXT NOT NULL,                 -- ALWAYS stored trim().toLowerCase()
  user_id            TEXT,                          -- mirror of users[].id (survives email change)
  name               TEXT DEFAULT '',
  company            TEXT DEFAULT '',
  stage              TEXT NOT NULL DEFAULT 'lead',  -- lead|audited|onboarding|customer|churned
  is_lead            INTEGER NOT NULL DEFAULT 0,
  is_client          INTEGER NOT NULL DEFAULT 0,    -- has >=1 linked web_studio_site
  is_license         INTEGER NOT NULL DEFAULT 0,    -- plan in {business, enterprise}
  plan               TEXT DEFAULT 'free',           -- mirror of users[].plan
  stripe_customer_id TEXT,
  purchased_at       TEXT,
  support_expires_at TEXT,
  audit_score        INTEGER,
  primary_domain     TEXT,
  owner              TEXT DEFAULT '',               -- CRM-owned
  tags               TEXT DEFAULT '[]',             -- CRM-owned (JSON array)
  source             TEXT DEFAULT '',               -- free-audit|stripe|web-studio|manual
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_activity_at   TEXT,
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_contacts_stage   ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_plan    ON contacts(plan);
CREATE INDEX IF NOT EXISTS idx_contacts_owner   ON contacts(owner);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at);

CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,            -- note|stage_change|audit|purchase|site_built|system
  body        TEXT DEFAULT '',
  meta        TEXT DEFAULT '{}',        -- JSON
  author      TEXT DEFAULT '',          -- admin handle or 'system'
  dedupe_key  TEXT,                     -- e.g. 'purchase:<sessionId>' / 'audit:<auditId>'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_dedupe ON activities(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS site_links (
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  site_id     TEXT NOT NULL,            -- web_studio_sites[].id (soft FK; sites live in JSON)
  domain      TEXT,
  linked_at   TEXT NOT NULL,
  PRIMARY KEY (contact_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_site_links_site ON site_links(site_id);
`;

// Ordered migrations from day one — the first prod schema change must not be manual
// surgery. Each entry runs once, in order, inside a transaction, bumping schema_meta.version.
const MIGRATIONS = [
  // { version: 2, up: (db) => db.exec('ALTER TABLE contacts ADD COLUMN ...') },
];

let _db = null;

function openDb(dbPath) {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const verRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  let version = verRow ? Number(verRow.value) : 0;
  if (!verRow) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '1')").run();
    version = 1;
  }
  for (const m of MIGRATIONS) {
    if (m.version > version) {
      db.exec('BEGIN');
      try {
        m.up(db);
        db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(m.version));
        db.exec('COMMIT');
        version = m.version;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  }

  _db = db;
  return db;
}

function getDb() {
  if (!_db) throw new Error('CRM db not opened — call openDb(path) at boot first');
  return _db;
}

module.exports = { openDb, getDb };
