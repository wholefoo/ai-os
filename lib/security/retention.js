// Account retention: the code path behind the privacy notice's one hard deletion promise —
// "Account data — retained while your account is active and for 30 days after deletion request."
// SOC 2 gap item 23 (P4) and the counsel-prep doc's P-2 ("deletion promise has no code path").
//
// TWO-STEP BY DESIGN. A deletion REQUEST disables the account and revokes its sessions at once
// (the person asked to leave; they leave now), then a daily job PURGES the record after the
// 30-day grace. The grace is not a delay for its own sake: it is the window in which a mistaken
// request can be cancelled and in which the operator can settle billing, and it is exactly what
// the notice promises, so the job must neither run early nor never.
//
// WHAT A PURGE REMOVES, and what it does not:
//   removes  the user record; every session; the login-lockout counter; the person's AI business
//            clones (via the platform's own clone deletion, which already keeps commissioned work
//            as company records); the CRM contact and its activities and site links.
//   HOLDS    hosted sites owned by the account. Deleting a site is a gated infrastructure action
//            (web-studio.delete-site) that a human approves; a purge job running unattended must
//            not perform it. Held sites are reported by name on every run until the operator acts.
//
// PURE. Everything that touches state is injected, so tools/test-retention.js exercises every
// branch on a fake clock with no server, no SQLite, and no filesystem.

const GRACE_DAYS = 30;
const GRACE_MS = GRACE_DAYS * 86400000;

const keyOf = (email) => String(email || '').trim().toLowerCase();

/** Users whose deletion request has passed the grace period as of `now` (ms). */
function dueForPurge(users, now = Date.now()) {
  return (users || []).filter((u) => u && u.deletionRequestedAt && (now - new Date(u.deletionRequestedAt).getTime()) >= GRACE_MS);
}

/** Users with a pending request, each with when it falls due — for the operator's list. */
function pendingDeletions(users, now = Date.now()) {
  return (users || []).filter((u) => u && u.deletionRequestedAt).map((u) => {
    const requestedAt = new Date(u.deletionRequestedAt).getTime();
    return { email: u.email, requestedAt: u.deletionRequestedAt, requestedBy: u.deletionRequestedBy || null, dueAt: new Date(requestedAt + GRACE_MS).toISOString(), due: now - requestedAt >= GRACE_MS };
  });
}

/**
 * Purge every due account. Mutates `users` in place (splice) so the caller's array identity holds.
 * @param {object} io
 *   users            the live users array
 *   now              ms clock (tests inject)
 *   revokeSessions   (email) => count
 *   clearLockout     (email) => void
 *   clonesFor        (email) => clone[]           deleteClone(clone) => { retained }
 *   sitesFor         (email) => site[]            (held, never deleted here)
 *   eraseCrmContact  (email) => { erased, activities, siteLinks } | null when the CRM is not open
 *   log              (message, details) => void
 *   save             () => void                   persist users after the splice
 */
function purgeDueAccounts(io) {
  const now = typeof io.now === 'number' ? io.now : Date.now();
  const due = dueForPurge(io.users, now);
  const purged = [];
  for (const user of due) {
    const email = keyOf(user.email);
    const idx = io.users.indexOf(user);
    if (idx === -1) continue;
    let clones = 0, retained = 0;
    for (const clone of (io.clonesFor ? io.clonesFor(email) : [])) {
      const r = io.deleteClone ? io.deleteClone(clone) : { retained: 0 };
      clones++; retained += (r && r.retained) || 0;
    }
    const heldSites = (io.sitesFor ? io.sitesFor(email) : []).map((s) => s.id || s.slug || s.name || '?');
    let crm = null;
    try { crm = io.eraseCrmContact ? io.eraseCrmContact(email) : null; } catch (e) { crm = { erased: false, error: e.message }; }
    io.users.splice(idx, 1);
    const sessions = io.revokeSessions ? io.revokeSessions(email) : 0;
    if (io.clearLockout) io.clearLockout(email);
    const entry = { email, requestedAt: user.deletionRequestedAt, sessions, clones, recordsRetained: retained, crm, heldSites };
    purged.push(entry);
    if (io.log) io.log(`Account purged: ${email} — ${sessions} session(s), ${clones} clone(s) (${retained} records retained), CRM ${crm && crm.erased ? 'erased' : 'not present'}${heldSites.length ? `, ${heldSites.length} hosted site(s) HELD for the gated delete` : ''}`, { retention: true, ...entry });
  }
  if (purged.length && io.save) io.save();
  return { now: new Date(now).toISOString(), purged, held: purged.filter((p) => p.heldSites.length) };
}

module.exports = { GRACE_DAYS, GRACE_MS, dueForPurge, pendingDeletions, purgeDueAccounts };
