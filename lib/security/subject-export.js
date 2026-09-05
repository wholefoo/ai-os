// Subject access / data export — the "Access" and "Export" rights in the privacy notice as code.
// SOC 2 gap item 22 (P5): "subject data export". Deletion (lib/security/retention.js) is the other
// half of the same notice section.
//
// WHAT THIS IS: one JSON document with everything the platform holds ABOUT a person, keyed by their
// email, collected from every store that carries an email — account record, sessions, business
// clones, hosted sites, CRM contact and activities (their own words), sequence enrolments and
// suppression, bookings, support tickets, free-audit requests, and the activity-log lines about them.
//
// WHAT IT NEVER CONTAINS, enforced by test rather than by care: the password hash, a setup token,
// any session token, and any other person's data. Secrets are stripped by an allowlist per
// record, not by a denylist of field names — a new secret field added to a store tomorrow is
// absent from the export by default, not present until someone remembers to list it.
//
// PURE. Every source is injected as an array or a function of the email, so the collector is
// tested with fixtures and the server wires the live stores.

const keyOf = (email) => String(email || '').trim().toLowerCase();
const same = (a, b) => keyOf(a) === keyOf(b);

/** Copy only the named fields that are present. The allowlist IS the redaction. */
const pick = (obj, fields) => {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
};

const ACCOUNT_FIELDS = ['id', 'email', 'name', 'plan', 'role', 'createdAt', 'ownerEmail', 'stripeCustomerId', 'disabled', 'disabledAt', 'deletionRequestedAt'];
const CLONE_FIELDS = ['id', 'name', 'status', 'createdAt', 'updatedAt', 'voice', 'expertise', 'boundaries'];
const SITE_FIELDS = ['id', 'name', 'slug', 'domain', 'customDomain', 'status', 'createdAt', 'publishedAt', 'tier'];
const ENROLMENT_FIELDS = ['id', 'sequenceId', 'status', 'step', 'enrolledAt', 'nextAt', 'completedAt'];
const BOOKING_FIELDS = ['id', 'siteId', 'name', 'email', 'phone', 'start', 'end', 'notes', 'status', 'createdAt'];
const TICKET_FIELDS = ['id', 'email', 'subject', 'message', 'status', 'createdAt', 'resolvedAt', 'reply'];
const AUDIT_FIELDS = ['id', 'email', 'url', 'domain', 'createdAt', 'score'];
const ACTIVITY_FIELDS = ['type', 'message', 'timestamp'];

/**
 * @param {string} email
 * @param {object} src  every key optional
 *   users            user[]
 *   sessionsFor      (email) => [{ expiresAt }]      tokens never passed in
 *   clones           clone[]   (clientId = email)
 *   sites            site[]    (ownerEmail)
 *   crmContact       (email) => { contact, activities } | null
 *   enrollments      enrolment[] (email)
 *   suppression      string[] of emails
 *   bookings         booking[] (email)
 *   tickets          ticket[] (email)
 *   freeAudits       audit[] (email)
 *   activity         entry[]  ({ type, message, details, timestamp })
 *   now              ms
 */
function collectSubjectData(email, src = {}) {
  const e = keyOf(email);
  const user = (src.users || []).find((u) => u && same(u.email, e)) || null;
  const bundle = {
    generatedAt: new Date(typeof src.now === 'number' ? src.now : Date.now()).toISOString(),
    subject: e,
    notice: 'This is every record this AI OS instance holds that is keyed to the email above. Credentials, setup tokens and session tokens are never included. Hosted-site CONTENT is exported separately through Web Studio (ZIP or GitHub push).',
    account: user ? { ...pick(user, ACCOUNT_FIELDS), hasPassword: !!user.passwordHash, pendingSetup: !!user.setupToken } : null,
    sessions: (src.sessionsFor ? src.sessionsFor(e) : []).map((s) => ({ expiresAt: s.expiresAt || null })),
    clones: (src.clones || []).filter((c) => c && same(c.clientId, e)).map((c) => pick(c, CLONE_FIELDS)),
    sites: (src.sites || []).filter((s) => s && same(s.ownerEmail, e)).map((s) => pick(s, SITE_FIELDS)),
    crm: null,
    sequences: {
      enrollments: (src.enrollments || []).filter((x) => x && same(x.email, e)).map((x) => pick(x, ENROLMENT_FIELDS)),
      unsubscribed: (src.suppression || []).some((s) => same(s, e)),
    },
    bookings: (src.bookings || []).filter((b) => b && same(b.email, e)).map((b) => pick(b, BOOKING_FIELDS)),
    supportTickets: (src.tickets || []).filter((t) => t && same(t.email, e)).map((t) => pick(t, TICKET_FIELDS)),
    freeAudits: (src.freeAudits || []).filter((a) => a && same(a.email, e)).map((a) => pick(a, AUDIT_FIELDS)),
    activity: (src.activity || []).filter((a) => a && (same(a.details && a.details.email, e) || (typeof a.message === 'string' && a.message.toLowerCase().includes(e)))).map((a) => pick(a, ACTIVITY_FIELDS)),
  };
  try {
    const c = src.crmContact ? src.crmContact(e) : null;
    if (c && c.contact) {
      bundle.crm = {
        contact: pick(c.contact, ['id', 'email', 'name', 'company', 'phone', 'stage', 'plan', 'tags', 'primary_domain', 'created_at', 'updated_at']),
        activities: (c.activities || []).map((a) => pick(a, ['id', 'type', 'body', 'author', 'created_at'])),
      };
    }
  } catch (err) { bundle.crm = { error: err.message }; }
  bundle.counts = {
    sessions: bundle.sessions.length, clones: bundle.clones.length, sites: bundle.sites.length,
    crmActivities: bundle.crm && bundle.crm.activities ? bundle.crm.activities.length : 0,
    enrollments: bundle.sequences.enrollments.length, bookings: bundle.bookings.length,
    supportTickets: bundle.supportTickets.length, freeAudits: bundle.freeAudits.length, activity: bundle.activity.length,
  };
  return bundle;
}

module.exports = { collectSubjectData, ACCOUNT_FIELDS };
