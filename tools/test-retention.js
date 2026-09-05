// Account retention (lib/security/retention.js) — the deletion promise as code. SOC 2 item 23 / P-2.
//
// The privacy notice promises account data is kept "for 30 days after deletion request". So the
// purge must fire at day 30 and not at day 29, must remove everything it says it removes, must
// HOLD hosted sites (a gated infra action a job may not perform), and must keep working when the
// CRM is closed or a cascade throws. All on a fake clock, no server.
const { assert, done, serverSource, readRepoFile } = require('./test-util');
const R = require('../lib/security/retention');

const DAY = 86400000;
const T0 = Date.parse('2026-09-05T00:00:00Z');
const mk = (email, requestedDaysAgo, extra = {}) => ({ email, role: 'client', passwordHash: 'x', ...(requestedDaysAgo == null ? {} : { deletionRequestedAt: new Date(T0 - requestedDaysAgo * DAY).toISOString(), deletionRequestedBy: 'admin@x' }), ...extra });

// --- the boundary ------------------------------------------------------------------------------
assert(R.GRACE_DAYS === 30, 'grace is 30 days — the number in the notice');
let users = [mk('a@x.io', 29.99), mk('b@x.io', 30), mk('c@x.io', 45), mk('d@x.io', null)];
const due = R.dueForPurge(users, T0).map((u) => u.email);
assert(JSON.stringify(due) === '["b@x.io","c@x.io"]', `due at exactly 30 days and beyond, NOT at 29.99: ${JSON.stringify(due)}`);
const pending = R.pendingDeletions(users, T0);
assert(pending.length === 3 && pending.find((p) => p.email === 'a@x.io').due === false && pending.find((p) => p.email === 'b@x.io').due === true, 'pending list carries a due flag per request');
assert(pending.find((p) => p.email === 'b@x.io').dueAt === new Date(T0).toISOString(), 'dueAt = requestedAt + 30 days');

// --- a full purge, every cascade observed --------------------------------------------------------
const calls = { revoked: [], lock: [], clones: [], crm: [], logs: [], saved: 0 };
users = [mk('Gone@X.io', 31), mk('stay@x.io', 3), mk('never@x.io', null)];
const io = {
  users, now: T0,
  revokeSessions: (e) => { calls.revoked.push(e); return 2; },
  clearLockout: (e) => calls.lock.push(e),
  clonesFor: (e) => (e === 'gone@x.io' ? [{ id: 'c1' }, { id: 'c2' }] : []),
  deleteClone: (c) => { calls.clones.push(c.id); return { retained: 3 }; },
  sitesFor: (e) => (e === 'gone@x.io' ? [{ id: 'site-9' }] : []),
  eraseCrmContact: (e) => { calls.crm.push(e); return { erased: true, activities: 4, siteLinks: 1 }; },
  log: (m, d) => calls.logs.push({ m, d }),
  save: () => calls.saved++,
};
const report = R.purgeDueAccounts(io);
assert(report.purged.length === 1 && report.purged[0].email === 'gone@x.io', 'exactly the due account is purged, keyed by normalised email');
assert(users.length === 2 && !users.find((u) => /gone/i.test(u.email)), 'the user record is removed from the live array IN PLACE');
assert(calls.revoked[0] === 'gone@x.io' && report.purged[0].sessions === 2, 'sessions revoked and counted');
assert(calls.lock[0] === 'gone@x.io', 'lockout counter cleared');
assert(JSON.stringify(calls.clones) === '["c1","c2"]' && report.purged[0].clones === 2 && report.purged[0].recordsRetained === 6, 'clones deleted through the platform\'s own deletion, retained counts summed');
assert(calls.crm[0] === 'gone@x.io' && report.purged[0].crm.erased === true, 'CRM contact erased');
assert(JSON.stringify(report.purged[0].heldSites) === '["site-9"]' && report.held.length === 1, 'the hosted site is HELD, not deleted — gated infra action');
assert(calls.saved === 1, 'users persisted once');
assert(/Account purged: gone@x\.io/.test(calls.logs[0].m) && /1 hosted site\(s\) HELD/.test(calls.logs[0].m) && calls.logs[0].d.retention === true, 'one activity line per purge names what happened and what is held');

// --- nothing due: nothing touched ------------------------------------------------------------------
const quiet = R.purgeDueAccounts({ users: [mk('q@x.io', 10)], now: T0, save: () => { throw new Error('must not save'); }, log: () => { throw new Error('must not log'); } });
assert(quiet.purged.length === 0 && quiet.held.length === 0, 'nothing due → no writes, no log lines');

// --- degraded cascades ---------------------------------------------------------------------------
const noCrm = R.purgeDueAccounts({ users: [mk('n@x.io', 40)], now: T0, eraseCrmContact: () => null, save: () => {}, log: () => {} });
assert(noCrm.purged[0].crm === null && noCrm.purged.length === 1, 'CRM closed (null) → account still purged, crm reported null');
const crmThrows = R.purgeDueAccounts({ users: [mk('t@x.io', 40)], now: T0, eraseCrmContact: () => { throw new Error('db locked'); }, save: () => {}, log: () => {} });
assert(crmThrows.purged.length === 1 && crmThrows.purged[0].crm.error === 'db locked', 'a throwing CRM erase is captured on the report; the user record is still removed');
const bare = R.purgeDueAccounts({ users: [mk('m@x.io', 40)], now: T0 });
assert(bare.purged.length === 1 && bare.purged[0].sessions === 0 && bare.purged[0].clones === 0, 'every cascade hook is optional');

// --- server wiring ---------------------------------------------------------------------------------
const src = serverSource();
const wired = src.slice(src.indexOf('function runRetentionPurge('), src.indexOf("app.post('/api/admin/users/:email/request-deletion'"));
for (const k of ['revokeSessions: revokeSessionsFor', 'deleteClone: deleteCloneRecords', 'sitesFor:', 'eraseCrmContact:', "saveState('users', users)"]) {
  assert(wired.includes(k), `runRetentionPurge wires ${k}`);
}
assert(/sendNotification\('Retention purge: hosted sites held'/.test(wired), 'held sites raise a high-priority notification');
for (const r of ['/api/admin/users/:email/request-deletion', '/api/admin/users/:email/cancel-deletion', '/api/admin/retention/run']) {
  assert(new RegExp(`app\\.post\\('${r.replace(/[/:]/g, (c) => '\\' + c)}', requireAdmin, requireHuman`).test(src), `${r} is admin + HUMAN only`);
}
assert(/app\.get\('\/api\/admin\/retention', requireAdmin/.test(src), 'the pending list is admin-readable');
const req = src.slice(src.indexOf("app.post('/api/admin/users/:email/request-deletion'"), src.indexOf("app.post('/api/admin/users/:email/cancel-deletion'"));
assert(/user\.disabled = true/.test(req) && req.indexOf('user.disabled = true') < req.indexOf('revokeSessionsFor('), 'a request disables NOW and revokes sessions');
assert(/cannot request deletion of the last enabled admin/.test(req), 'last-admin guard');
assert(/status\(409\)/.test(req), 'a second request is 409, not a reset of the clock');
const cancel = src.slice(src.indexOf("app.post('/api/admin/users/:email/cancel-deletion'"), src.indexOf("app.get('/api/admin/retention'"));
assert(/account remains disabled/.test(cancel) && !/delete user\.disabled/.test(cancel), 'cancelling the erasure does not reactivate the account');
assert(/cron\.schedule\('20 3 \* \* \*', \(\) => \{\s*try \{\s*const r = runRetentionPurge\('scheduler'\)/.test(src), 'the daily job is registered unconditionally at 03:20');

// CRM erase, run for REAL against a temp SQLite (node:sqlite), because the schema's ON DELETE
// CASCADE is decorative on a connection that never enables foreign keys — the explicit child
// deletes are the erasure, and only executing them proves they reach every table.
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-crm-'));
  try {
    const crm = require('../lib/crm');
    crm.openDb(path.join(dir, 'crm.sqlite'));
    const cId = crm.repo.contacts.upsertByEmail({ email: 'Erase@X.io', name: 'Erase Me' }); // returns the id
    const otherId = crm.repo.contacts.upsertByEmail({ email: 'keep@x.io', name: 'Keep' });
    crm.repo.activities.add({ contactId: cId, type: 'note', body: 'their own words' });
    crm.repo.activities.add({ contactId: cId, type: 'note', body: 'more' });
    crm.repo.activities.add({ contactId: otherId, type: 'note', body: 'unrelated' });
    crm.repo.links.add({ contactId: cId, siteId: 'site-1' });
    const r = crm.repo.contacts.eraseByEmail('erase@x.io');
    assert(r.erased === true && r.activities === 2 && r.siteLinks === 1, `real erase removed the contact, 2 activities, 1 site link: ${JSON.stringify(r)}`);
    assert(crm.repo.contacts.findByEmail('erase@x.io') === null, 'the contact is gone');
    assert(crm.repo.activities.forContact(cId).length === 0, 'its activities are gone (no orphans — the words the lead wrote are erased too)');
    assert(crm.repo.contacts.findByEmail('keep@x.io') && crm.repo.activities.forContact(otherId).length === 1, 'the other contact and its activity are untouched');
    assert(crm.repo.contacts.eraseByEmail('erase@x.io').erased === false, 'erasing again is a no-op that says so');
    assert(crm.repo.contacts.eraseByEmail('').erased === false, 'an empty email erases nothing');
  } finally {
    // lib/crm/db.js exposes no close(); on Windows the open WAL sidecars make the directory
    // undeletable until the process exits. Best-effort here, and a tiny temp dir if it fails.
    try { require('../lib/crm/db').getDb().close(); } catch { /* no close on this driver */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leaves ~50KB in %TEMP% */ }
  }
}

// CRM erase is explicit about the cascade (foreign_keys is never turned on).
const repo = readRepoFile('lib/crm/repo.js');
const erase = repo.slice(repo.indexOf('eraseByEmail(email)'), repo.indexOf('findByDomain('));
assert(/DELETE FROM activities WHERE contact_id/.test(erase) && /DELETE FROM site_links WHERE contact_id/.test(erase) && /DELETE FROM contacts WHERE id/.test(erase), 'children are deleted explicitly, then the contact');
assert(/BEGIN/.test(erase) && /COMMIT/.test(erase) && /ROLLBACK/.test(erase), 'inside an explicit transaction');
assert(erase.indexOf('DELETE FROM contacts') > erase.indexOf('DELETE FROM site_links'), 'the contact row goes LAST');

done();
