// Subject data export (lib/security/subject-export.js) — the "Access"/"Export" rights as code.
// SOC 2 gap item 22 (P5).
//
// Two properties matter more than completeness, and both are asserted on the SERIALISED output,
// which is what a person actually receives: (1) no credential, setup token or session token appears
// anywhere in it; (2) no OTHER person's data appears in it. Completeness is asserted per store.
const { assert, done, serverSource } = require('./test-util');
const X = require('../lib/security/subject-export');

const ME = 'Person@Example.io';       // mixed case on purpose — every store must match case-insensitively
const me = 'person@example.io';
const OTHER = 'other@example.io';
const SECRET = 'S3CR3T-HASH-$2b$12$abcdefghijklmnopqrstuv';
const SETUP = 'setup-token-ZZZZ';
const SESSION_TOKEN = 'session-token-QQQQ';

const src = {
  now: Date.parse('2026-09-05T00:00:00Z'),
  users: [
    { id: 'u1', email: ME, name: 'A Person', plan: 'business', role: 'client', createdAt: '2026-01-01', passwordHash: SECRET, setupToken: { token: SETUP }, stripeCustomerId: 'cus_123', apiKey: 'should-not-leak' },
    { id: 'u2', email: OTHER, name: 'Someone Else', passwordHash: 'other-hash' },
  ],
  sessionsFor: (e) => (e === me ? [{ token: SESSION_TOKEN, expiresAt: '2026-10-01' }] : []),
  clones: [{ id: 'c1', clientId: ME, name: 'My Clone', persona: { deep: 'private-ish' }, status: 'active' }, { id: 'c2', clientId: OTHER, name: 'Their Clone' }],
  sites: [{ id: 's1', ownerEmail: 'PERSON@example.io', name: 'My Site', domain: 'my.example', buildLog: 'huge' }, { id: 's2', ownerEmail: OTHER, name: 'Theirs' }],
  crmContact: (e) => (e === me ? { contact: { id: 'k1', email: me, name: 'A Person', stage: 'customer', internal_notes_secret: 'x' }, activities: [{ id: 'a1', type: 'note', body: 'their own words', created_at: '2026-02-02', meta: { ip: '1.2.3.4' } }] } : null),
  enrollments: [{ id: 'e1', email: me, sequenceId: 'seq1', status: 'active', step: 2 }, { id: 'e2', email: OTHER, sequenceId: 'seq1', status: 'active' }],
  suppression: ['PERSON@EXAMPLE.IO'],
  bookings: [{ id: 'b1', email: me, name: 'A Person', start: '2026-03-03T10:00', status: 'confirmed' }],
  tickets: [{ id: 't1', email: me, subject: 'Help', message: 'It broke', status: 'open' }, { id: 't2', email: OTHER, subject: 'Other' }],
  freeAudits: [{ id: 'f1', email: me, url: 'https://my.example', score: 71, createdAt: '2026-04-04' }],
  activity: [
    { type: 'auth', message: `Login: ${me} (client)`, details: {}, timestamp: '2026-05-05' },
    { type: 'auth', message: 'Login failed', details: { email: me, ip: '9.9.9.9', reason: 'bad-password' }, timestamp: '2026-05-06' },
    { type: 'auth', message: `Login: ${OTHER} (client)`, details: {}, timestamp: '2026-05-07' },
  ],
};

const b = X.collectSubjectData(ME, src);
const text = JSON.stringify(b);

// --- the two properties that matter -------------------------------------------------------------------
for (const s of [SECRET, SETUP, SESSION_TOKEN, 'should-not-leak', 'other-hash', 'internal_notes_secret', 'buildLog', 'huge']) {
  assert(!text.includes(s), `serialised export never contains "${s.slice(0, 24)}"`);
}
assert(!text.includes(OTHER) && !text.includes('Someone Else') && !text.includes('Their Clone') && !text.includes('Theirs'), 'no other person\'s data anywhere in the export');
assert(b.subject === me, 'subject is the normalised email');

// --- completeness, per store --------------------------------------------------------------------------
assert(b.account && b.account.email === ME && b.account.hasPassword === true && b.account.pendingSetup === true && b.account.stripeCustomerId === 'cus_123', 'account: allowlisted fields + booleans for the secrets');
assert(b.account.passwordHash === undefined && b.account.setupToken === undefined && b.account.apiKey === undefined, 'account: unlisted fields are absent by default');
assert(b.sessions.length === 1 && b.sessions[0].expiresAt === '2026-10-01' && b.sessions[0].token === undefined, 'sessions: expiry only, never the token');
assert(b.clones.length === 1 && b.clones[0].id === 'c1' && b.clones[0].persona === undefined, 'clones: mine only, metadata only');
assert(b.sites.length === 1 && b.sites[0].id === 's1' && b.sites[0].domain === 'my.example', 'sites: mine only (owner matched case-insensitively), metadata only');
assert(b.crm && b.crm.contact.stage === 'customer' && b.crm.activities.length === 1 && b.crm.activities[0].body === 'their own words' && b.crm.activities[0].meta === undefined, 'crm: contact + activities in the person\'s own words; activity meta (IPs) not included');
assert(b.sequences.enrollments.length === 1 && b.sequences.enrollments[0].id === 'e1' && b.sequences.unsubscribed === true, 'sequences: my enrolments + unsubscribed flag (suppression matched case-insensitively)');
assert(b.bookings.length === 1 && b.supportTickets.length === 1 && b.freeAudits.length === 1 && b.freeAudits[0].score === 71, 'bookings, tickets, free audits: mine only');
assert(b.activity.length === 2 && b.activity.every((a) => a.details === undefined), 'activity: lines about me by message OR details.email, with details dropped (they carry IPs and reasons)');
assert(b.counts.activity === 2 && b.counts.sessions === 1 && b.counts.crmActivities === 1, 'counts summarise every section');

// --- absence and degradation ----------------------------------------------------------------------------
const nobody = X.collectSubjectData('nobody@example.io', src);
assert(nobody.account === null && nobody.crm === null && nobody.counts.sites === 0 && nobody.sequences.unsubscribed === false, 'an unknown email yields an empty, well-formed bundle — not an error, not someone else\'s data');
const crmDown = X.collectSubjectData(ME, { ...src, crmContact: () => { throw new Error('db locked'); } });
assert(crmDown.crm && crmDown.crm.error === 'db locked' && crmDown.account, 'a throwing CRM is reported in place; the rest of the export still builds');
const bare = X.collectSubjectData(ME, {});
assert(bare.account === null && bare.sessions.length === 0 && bare.counts.activity === 0, 'every source is optional');

// --- server wiring ---------------------------------------------------------------------------------------
const s = serverSource();
const self = s.slice(s.indexOf("app.get('/api/auth/me/export'"), s.indexOf("app.get('/api/admin/users/:email/export'"));
assert(/const session = resolveSession\(req\)/.test(self) && /buildSubjectExport\(session\.email\)/.test(self), 'self-service export uses the SESSION\'s email as the subject — the URL cannot name someone else');
assert(/if \(session\.service\) return res\.status\(403\)/.test(self), 'the API token has no self to export');
assert(/app\.get\('\/api\/admin\/users\/:email\/export', requireAdmin, requireHuman/.test(s), 'admin export is human-only');
const admin = s.slice(s.indexOf("app.get('/api/admin/users/:email/export'"), s.indexOf("app.post('/api/admin/users/:email/request-deletion'"));
assert(/status\(404\)/.test(admin), 'admin export of an unknown email is 404, not an empty bundle (no fishing)');
const send = s.slice(s.indexOf('function sendSubjectExport('), s.indexOf("app.get('/api/auth/me/export'"));
assert(/Content-Disposition.*attachment/.test(send) && /Cache-Control', 'no-store'/.test(send), 'served as a downloadable attachment with no-store');
assert(/counts: bundle\.counts/.test(self) && !/bundle\.account|bundle\.crm/.test(self.slice(self.indexOf('logActivity'))), 'the export is logged by COUNTS only — content never reaches the activity log');
const wire = s.slice(s.indexOf('function buildSubjectExport('), s.indexOf('function sendSubjectExport('));
for (const k of ['users,', 'sessionsFor:', 'clones: businessClones', 'sites: webStudioSites', 'crmContact:', 'enrollments: emailEnrollments', 'suppression: emailSuppression', 'bookings,', 'tickets: contactTickets', 'freeAudits: freeAuditLog', 'activity: activityLog']) {
  assert(wire.includes(k), `live wiring includes ${k}`);
}

done();
