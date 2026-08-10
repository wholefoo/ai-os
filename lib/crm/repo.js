// lib/crm/repo.js
// ============================================================
//  The data-access boundary for the CRM. ALL reads/writes go through here so two
//  invariants hold everywhere:
//   1. email is normalized (trim + lowercase) on EVERY read and write — never trust
//      callers. The source seams are case-inconsistent today (free-audit + Stripe
//      compare raw email), so "Bob@x.com" and "bob@x.com" must collapse to ONE contact.
//   2. partial upserts MERGE — a sync that knows only the audit score must not wipe the
//      plan another sync set. Only provided (non-undefined) fields are written.
//
//  Swapping SQLite -> Postgres later is a change in THIS file, not in the routes.
// ============================================================

const { randomUUID } = require('crypto');
const { getDb } = require('./db');

// The ONLY sort clauses that may reach an ORDER BY. Values are interpolated into SQL (they cannot
// be bound as parameters — a placeholder is not legal in ORDER BY), so this table is the whole
// defence and the lookup below has to respect it.
const SORTS = Object.freeze({
  updated: 'updated_at DESC',
  created: 'created_at DESC',
  name: 'name COLLATE NOCASE ASC',
  score: 'audit_score DESC',
});

/**
 * Resolve a caller-supplied sort key to a clause from SORTS, or the default.
 *
 * `Object.hasOwn` is load-bearing, not defensive styling. The previous `SORTS[key] || SORTS.updated`
 * walked the PROTOTYPE CHAIN: `?sort=constructor` returned `Object` — a function, therefore truthy,
 * so the `||` fallback never fired — and that function was interpolated straight into the ORDER BY,
 * producing a malformed statement and an HTTP 500. Not injection (the caller controls only a key,
 * and every reachable value is a built-in), but a trivially reachable DoS on an admin route.
 *
 * Guarding by naming the bad keys would be the same mistake this repo has made before: a denylist
 * covers what someone remembered, and `Object.prototype` has members nobody enumerates. This guards
 * the CATEGORY — anything not declared in SORTS is not a sort. See tools/test-crm-sort.js.
 */
const resolveSort = (key) => (typeof key === 'string' && Object.hasOwn(SORTS, key) ? SORTS[key] : SORTS.updated);

const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
const b = (v) => (v ? 1 : 0);
const nowIso = () => new Date().toISOString();

// Columns a partial upsert/patch may set (email/id/created_at are never patched here).
const UPSERTABLE = {
  user_id: 's', name: 's', company: 's', stage: 's', is_lead: 'b', is_client: 'b',
  is_license: 'b', plan: 's', stripe_customer_id: 's', purchased_at: 's',
  support_expires_at: 's', audit_score: 'n', primary_domain: 's', owner: 's',
  source: 's', last_activity_at: 's',
};

function rowToContact(r) {
  if (!r) return null;
  return {
    ...r,
    is_lead: !!r.is_lead, is_client: !!r.is_client, is_license: !!r.is_license,
    tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
  };
}

const contacts = {
  findByEmail(email) {
    const e = normEmail(email);
    if (!e) return null;
    return rowToContact(getDb().prepare('SELECT * FROM contacts WHERE tenant_id = ? AND email = ?').get('master', e));
  },

  get(id) {
    return rowToContact(getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id));
  },

  /** Earliest contact whose primary_domain matches (used to auto-link sites by domain). */
  findByDomain(domain) {
    if (!domain) return null;
    return rowToContact(getDb().prepare(
      "SELECT * FROM contacts WHERE tenant_id = 'master' AND primary_domain = ? ORDER BY created_at LIMIT 1").get(domain));
  },

  /**
   * Insert or MERGE a contact keyed on normalized email. Only provided fields are
   * written on update. Returns the contact id.
   */
  upsertByEmail(fields) {
    const db = getDb();
    const email = normEmail(fields.email);
    if (!email) throw new Error('CRM upsert: email required');
    const existing = db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND email = ?').get('master', email);
    const ts = nowIso();

    if (!existing) {
      const id = fields.id || randomUUID();
      db.prepare(`INSERT INTO contacts
        (id, tenant_id, email, user_id, name, company, stage, is_lead, is_client, is_license,
         plan, stripe_customer_id, purchased_at, support_expires_at, audit_score, primary_domain,
         owner, tags, source, created_at, updated_at, last_activity_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, 'master', email, fields.user_id ?? null, fields.name ?? '', fields.company ?? '',
        fields.stage ?? 'lead', b(fields.is_lead), b(fields.is_client), b(fields.is_license),
        fields.plan ?? 'free', fields.stripe_customer_id ?? null, fields.purchased_at ?? null,
        fields.support_expires_at ?? null, fields.audit_score == null ? null : Number(fields.audit_score),
        fields.primary_domain ?? null, fields.owner ?? '', JSON.stringify(fields.tags || []),
        fields.source ?? '', ts, ts, fields.last_activity_at ?? null);
      return id;
    }

    const sets = [], vals = [];
    for (const [col, kind] of Object.entries(UPSERTABLE)) {
      if (fields[col] !== undefined && fields[col] !== null) {
        sets.push(`${col} = ?`);
        vals.push(kind === 'b' ? b(fields[col]) : kind === 'n' ? Number(fields[col]) : fields[col]);
      }
    }
    if (fields.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(fields.tags || [])); }
    sets.push('updated_at = ?'); vals.push(ts);
    vals.push(existing.id);
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return existing.id;
  },

  /** Patch CRM-owned fields by id (dashboard edits). Returns the updated contact. */
  patch(id, fields) {
    const db = getDb();
    const allow = { name: 's', company: 's', stage: 's', owner: 's', source: 's' };
    const sets = [], vals = [];
    for (const [col, kind] of Object.entries(allow)) {
      if (fields[col] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[col]); }
    }
    if (fields.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(fields.tags || [])); }
    if (!sets.length) return contacts.get(id);
    sets.push('updated_at = ?'); vals.push(nowIso());
    vals.push(id);
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return contacts.get(id);
  },

  /** Filtered, sorted, paginated list. Returns { rows, total }. */
  page(opts = {}) {
    const db = getDb();
    const where = ["tenant_id = 'master'"], args = [];
    if (opts.q) { where.push('(email LIKE ? OR name LIKE ? OR company LIKE ? OR primary_domain LIKE ?)'); const like = `%${opts.q}%`; args.push(like, like, like, like); }
    if (opts.stage) { where.push('stage = ?'); args.push(opts.stage); }
    if (opts.plan) { where.push('plan = ?'); args.push(opts.plan); }
    if (opts.owner) { where.push('owner = ?'); args.push(opts.owner); }
    if (opts.flag === 'lead') where.push('is_lead = 1');
    else if (opts.flag === 'client') where.push('is_client = 1');
    else if (opts.flag === 'license') where.push('is_license = 1');
    if (opts.tag) { where.push('tags LIKE ?'); args.push(`%${JSON.stringify(String(opts.tag)).slice(1, -1)}%`); }

    const w = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM contacts ${w}`).get(...args).c;

    const order = resolveSort(opts.sort);
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const rows = db.prepare(`SELECT * FROM contacts ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { rows: rows.map(rowToContact), total, limit, offset };
  },

  stats() {
    const db = getDb();
    const one = (sql, ...a) => db.prepare(sql).get(...a).c;
    const byStage = db.prepare('SELECT stage, COUNT(*) AS c FROM contacts GROUP BY stage').all()
      .reduce((m, r) => { m[r.stage] = r.c; return m; }, {});
    return {
      total: one('SELECT COUNT(*) AS c FROM contacts'),
      leads: one('SELECT COUNT(*) AS c FROM contacts WHERE is_lead = 1'),
      clients: one('SELECT COUNT(*) AS c FROM contacts WHERE is_client = 1'),
      licenses: one('SELECT COUNT(*) AS c FROM contacts WHERE is_license = 1'),
      byStage,
    };
  },
};

const activities = {
  /** Insert an activity. With a dedupe_key, a second insert is a silent no-op. Returns true if inserted. */
  add({ contactId, type, body = '', meta = {}, author = '', dedupeKey = null }) {
    const db = getDb();
    const res = db.prepare(`INSERT OR IGNORE INTO activities (id, contact_id, type, body, meta, author, dedupe_key, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), contactId, type, body, JSON.stringify(meta || {}), author, dedupeKey, nowIso());
    if (res.changes > 0) {
      db.prepare('UPDATE contacts SET last_activity_at = ? WHERE id = ?').run(nowIso(), contactId);
    }
    return res.changes > 0;
  },

  forContact(contactId) {
    return getDb().prepare('SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at DESC').all(contactId)
      .map((r) => ({ ...r, meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })() }));
  },

  /** Site leads inbox: site_lead activities for ONE site (joined with the contact), newest
   *  first. Powers the owner-facing Manage tab — meta.siteId is stamped by the public lead
   *  endpoint, so this is the per-site view of what the contact form captured. */
  leadsForSite(siteId, limit = 100) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return getDb().prepare(`SELECT a.id, a.body, a.meta, a.created_at, c.email, c.name
      FROM activities a JOIN contacts c ON c.id = a.contact_id
      WHERE a.type = 'site_lead' AND json_extract(a.meta, '$.siteId') = ?
      ORDER BY a.created_at DESC LIMIT ?`).all(String(siteId), cap)
      .map((r) => ({ ...r, meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })() }));
  },
};

const links = {
  add({ contactId, siteId, domain = null }) {
    getDb().prepare(`INSERT OR IGNORE INTO site_links (contact_id, site_id, domain, linked_at) VALUES (?,?,?,?)`)
      .run(contactId, siteId, domain, nowIso());
    getDb().prepare('UPDATE contacts SET is_client = 1, updated_at = ? WHERE id = ?').run(nowIso(), contactId);
  },
  forContact(contactId) {
    return getDb().prepare('SELECT * FROM site_links WHERE contact_id = ?').all(contactId);
  },
  linkedSiteIds() {
    return new Set(getDb().prepare('SELECT site_id FROM site_links').all().map((r) => r.site_id));
  },
  unlinkSite(siteId) {
    getDb().prepare('DELETE FROM site_links WHERE site_id = ?').run(siteId);
  },
};

module.exports = { contacts, activities, links, normEmail, resolveSort, SORTS };
