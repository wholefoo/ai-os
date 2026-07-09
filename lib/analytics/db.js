// lib/analytics/db.js
// ============================================================
//  Analytics datastore — embedded SQLite via built-in node:sqlite, same pattern as
//  lib/crm/db.js (no native addon; WAL sidecars must be backed up together).
//
//  Two layers:
//    events_raw   — one row per interesting request (AI-bot hit or human pageview).
//                   30-day retention; feeds the live view and drill-downs.
//    rollup_daily — (day, site_id, metric, key) counters incremented at insert time,
//                   kept indefinitely (tiny); all charts read this. The `day` column is a
//                   generic bucket string, so an hourly rollup later is a data change,
//                   not a schema change.
//    ingest_state — key/value used by ingest-logs.js for byte offsets + inode (rotation).
//
//  Rollup metrics written in P0:
//    bot_hits   key = `${engine}|${bot}|${purpose}`
//    bot_page   key = path              (AI fetch count per page — "crawl heat")
//    page       key = path              (human pageviews)
//    ref        key = referrer class    (ai|search|social|direct|other)
//    ref_ai     key = AI engine name    (which answer engine sent the human)
// ============================================================

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS events_raw (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,                  -- ISO-8601 UTC
  site_id      TEXT NOT NULL DEFAULT 'platform',
  kind         TEXT NOT NULL,                  -- 'bot' | 'human'
  engine       TEXT,                           -- AI engine (bots) or referring engine (humans via AI ref)
  bot          TEXT,                           -- exact bot token (kind='bot')
  purpose      TEXT,                           -- training | search | live (kind='bot')
  path         TEXT NOT NULL,
  status       INTEGER,
  ref          TEXT,                           -- raw referrer (trimmed)
  ref_class    TEXT,                           -- ai|search|social|direct|other (kind='human')
  country      TEXT,
  visitor_hash TEXT                            -- daily-salted; unlinkable across days
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events_raw(ts);
CREATE INDEX IF NOT EXISTS idx_events_bot  ON events_raw(kind, ts DESC);

CREATE TABLE IF NOT EXISTS rollup_daily (
  day     TEXT NOT NULL,                       -- 'YYYY-MM-DD' (UTC)
  site_id TEXT NOT NULL DEFAULT 'platform',
  metric  TEXT NOT NULL,
  key     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site_id, metric, key)
);

CREATE TABLE IF NOT EXISTS ingest_state (key TEXT PRIMARY KEY, value TEXT);
`;

const MIGRATIONS = [
  // { version: 2, up: (db) => db.exec('ALTER TABLE ...') },
];

let _db = null;

function openDb(dbPath) {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const verRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  let version = verRow ? Number(verRow.value) : 0;
  if (!verRow) { db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '1')").run(); version = 1; }
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
  if (!_db) throw new Error('analytics db not opened — call openDb(path) at boot first');
  return _db;
}

// Insert a batch of events and bump their rollup counters in one transaction.
// events: [{ts, siteId, kind, engine, bot, purpose, path, status, ref, refClass, country, visitorHash}]
function insertEvents(events) {
  if (!events || !events.length) return 0;
  const db = getDb();
  const insEvent = db.prepare(`INSERT INTO events_raw (ts, site_id, kind, engine, bot, purpose, path, status, ref, ref_class, country, visitor_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const incRollup = db.prepare(`INSERT INTO rollup_daily (day, site_id, metric, key, count) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(day, site_id, metric, key) DO UPDATE SET count = count + 1`);
  db.exec('BEGIN');
  try {
    for (const e of events) {
      const siteId = e.siteId || 'platform';
      insEvent.run(e.ts, siteId, e.kind, e.engine || null, e.bot || null, e.purpose || null,
        e.path, e.status ?? null, e.ref || null, e.refClass || null, e.country || null, e.visitorHash || null);
      const day = String(e.ts).slice(0, 10);
      if (e.kind === 'bot') {
        incRollup.run(day, siteId, 'bot_hits', `${e.engine}|${e.bot}|${e.purpose}`);
        incRollup.run(day, siteId, 'bot_page', e.path);
      } else {
        incRollup.run(day, siteId, 'page', e.path);
        incRollup.run(day, siteId, 'ref', e.refClass || 'other');
        if (e.refClass === 'ai' && e.engine) incRollup.run(day, siteId, 'ref_ai', e.engine);
      }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return events.length;
}

// ---------- ingest offset state ----------
function getState(key) {
  const row = getDb().prepare('SELECT value FROM ingest_state WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setState(key, value) {
  getDb().prepare('INSERT INTO ingest_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- queries (all read rollups except the live feed) ----------
const dayRange = (days) => {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
};

// AI engine leaderboard over N days: [{engine, bot, purpose, count}] descending.
function botLeaderboard(siteId, days = 7) {
  const since = dayRange(days)[0];
  const rows = getDb().prepare(`SELECT key, SUM(count) AS n FROM rollup_daily
    WHERE site_id = ? AND metric = 'bot_hits' AND day >= ? GROUP BY key ORDER BY n DESC`).all(siteId, since);
  return rows.map((r) => {
    const [engine, bot, purpose] = String(r.key).split('|');
    return { engine, bot, purpose, count: r.n };
  });
}

// Crawl heat: pages ranked by AI fetch count over N days.
function crawlHeat(siteId, days = 7, limit = 25) {
  const since = dayRange(days)[0];
  return getDb().prepare(`SELECT key AS path, SUM(count) AS count FROM rollup_daily
    WHERE site_id = ? AND metric = 'bot_page' AND day >= ? GROUP BY key ORDER BY count DESC LIMIT ?`).all(siteId, since, limit);
}

// Recent AI-bot events for the live feed (newest first).
function recentBotEvents(siteId, limit = 50) {
  return getDb().prepare(`SELECT ts, engine, bot, purpose, path, status FROM events_raw
    WHERE site_id = ? AND kind = 'bot' ORDER BY id DESC LIMIT ?`).all(siteId, limit);
}

// Summary counters for the top strip: totals over N days + per-day series for sparklines.
function summary(siteId, days = 7) {
  const sinceDays = dayRange(days);
  const since = sinceDays[0];
  const db = getDb();
  const tot = (metric) => db.prepare(`SELECT COALESCE(SUM(count),0) AS n FROM rollup_daily WHERE site_id = ? AND metric = ? AND day >= ?`).get(siteId, metric, since).n;
  const series = (metric) => {
    const rows = db.prepare(`SELECT day, SUM(count) AS n FROM rollup_daily WHERE site_id = ? AND metric = ? AND day >= ? GROUP BY day`).all(siteId, metric, since);
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
    return sinceDays.map((d) => ({ day: d, count: byDay[d] || 0 }));
  };
  const refRows = db.prepare(`SELECT key, SUM(count) AS n FROM rollup_daily WHERE site_id = ? AND metric = 'ref' AND day >= ? GROUP BY key ORDER BY n DESC`).all(siteId, since);
  const refAi = db.prepare(`SELECT key, SUM(count) AS n FROM rollup_daily WHERE site_id = ? AND metric = 'ref_ai' AND day >= ? GROUP BY key ORDER BY n DESC`).all(siteId, since);
  return {
    days,
    botHits: tot('bot_hits'),
    pageviews: tot('page'),
    botSeries: series('bot_hits'),
    pageSeries: series('page'),
    referrers: refRows.map((r) => ({ class: r.key, count: r.n })),
    aiReferrers: refAi.map((r) => ({ engine: r.key, count: r.n })),
  };
}

// Nightly retention: drop raw events older than `days` (rollups keep the history).
function pruneRaw(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = getDb().prepare('DELETE FROM events_raw WHERE ts < ?').run(cutoff);
  return r.changes;
}

module.exports = { openDb, getDb, insertEvents, getState, setState, botLeaderboard, crawlHeat, recentBotEvents, summary, pruneRaw };
