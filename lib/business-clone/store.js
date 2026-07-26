// lib/business-clone/store.js
// ============================================================
//  Clone records and the scoping rules around them.
//
//  TENANCY, read this before using any function here:
//  There is no workspace TABLE in this platform, but there IS a per-client identity: a session
//  carries role:'client' and an email, and records are scoped by owner email — exactly how
//  web-studio's wsOwns predicate (server.js) scopes sites. This module uses the same key, so a
//  clone and a site belonging to the same customer agree on who that customer is. Do not invent a
//  parallel id scheme here; a second notion of "who owns this" is how two subsystems end up
//  disagreeing about which records a client may see.
//
//  Every clone carries a clientId from the first record written, and EVERY read path takes a
//  clientId and filters by it. Because isolation is enforced HERE rather than by a database
//  boundary, the filtering is deliberately unconditional: there is no "list all clones" export,
//  and getClone requires the clientId to match even when you already hold the clone's unique id.
//  A caller that forgets to scope gets nothing back rather than everything — which is the
//  difference between a miss and leaking one customer's voice replica into another's drafts.
//
//  Pure functions over a caller-owned array — server.js owns loadState/saveState, matching how
//  pendingApprovals and the other state collections work. Nothing here touches disk or the network.
// ============================================================

'use strict';

const persona = require('./persona');
const interview = require('./interview'); // template ids only — store never runs an interview

// Fallback clientId for a session that has no email to key on — in practice the API_TOKEN service
// session (server.js resolveSession returns 'service@api-token' for it). Real clients and the
// admin always key on their own email, so this should be rare; it exists so an unkeyed caller
// lands in one identifiable bucket rather than silently sharing whatever the last id happened
// to be.
const OPERATOR_CLIENT_ID = 'operator';

const STATUSES = ['interviewing', 'ready', 'active', 'paused'];

// ONE CLONE PER PERSON. Not a quota — a definition. A clone replicates a specific human being, so
// a second one for the same person is not "more capacity", it is a second contradictory account of
// who they are, and the evolution loop would then have two personas learning from one person's
// edits. Someone who needs different registers for different situations gets that from the role
// templates at interview time (lib/business-clone/interview.js), not from a second persona.
//
// The per-instance licence limit is a separate, commercial ceiling that layers on top of this.
const MAX_CLONES_PER_PERSON = 1;
const MAX_INTERVIEW_TURNS = 400;
const MAX_FEEDBACK_ENTRIES = 500;

function nowIso() {
  return new Date().toISOString();
}

/** Record ids (the clone's own id). Appear in log lines and file paths, so keep them boring. */
function cleanId(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 64);
  return /^[\w.-]+$/.test(s) ? s : '';
}

/**
 * Client ids. This platform identifies a managed client by their session EMAIL — the same key
 * web-studio's wsOwns predicate uses to scope sites to their owner — so this accepts an address
 * and lower-cases it. Lower-casing is not cosmetic: wsOwns compares case-insensitively, and a
 * store that treated Mike@x.com and mike@x.com as two different clients would silently split one
 * customer's clones into two invisible halves.
 */
function cleanClientId(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().slice(0, 190);
  return /^[\w.+-]+@[\w.-]+\.\w+$/.test(s) || /^[\w.-]+$/.test(s) ? s : '';
}

/**
 * Build a new clone record. `id` is supplied by the caller (server.js owns uuid generation, as it
 * does everywhere else) so this module stays dependency-free and deterministic under test.
 */
function createClone({ id, clientId, name, templateId, ownerName = '' }) {
  const cid = cleanClientId(clientId);
  if (!cid) throw new Error('createClone: clientId is required');
  const rid = cleanId(id);
  if (!rid) throw new Error('createClone: id is required');

  return {
    id: rid,
    clientId: cid,
    name: String(name || '').trim().slice(0, 120) || 'Untitled clone',
    // Which interview to run. Validated against the real template list so an unknown id becomes the
    // default rather than silently producing an interview with no questions. Affects ASKING only —
    // it is never read when compiling the persona.
    templateId: interview.templateIds().includes(String(templateId)) ? String(templateId) : interview.DEFAULT_TEMPLATE,
    status: 'interviewing',
    createdAt: nowIso(),
    updatedAt: nowIso(),

    persona: persona.emptyPersona(),
    personaVersion: 0,          // bumped on every accepted persona change; drafts record the version
                                // that produced them, so bad output can be traced to a persona state

    interview: {
      turns: [],                // [{ role: 'interviewer'|'owner', text, dimension, at }]
      currentDimension: persona.DIMENSIONS[0],
      complete: false,
    },

    corpus: [],                 // [{ id, kind, label, chars, addedAt }] — METADATA ONLY.
                                // Raw corpus text is untrusted owner-external content and is never
                                // stored inline on the clone record, because this record is compiled
                                // into a system prompt. See P2's compiler + the untrusted fencing.

    feedback: [],               // [{ draftId, verdict, note, at, personaVersion }]
    metrics: { draftsProduced: 0, approved: 0, edited: 0, rejected: 0 },
  };
}

/** All clones belonging to one client. The only list path — there is intentionally no listAll. */
function listClones(clones, clientId) {
  const cid = cleanClientId(clientId);
  if (!cid) return [];
  return (clones || []).filter((c) => c && c.clientId === cid);
}

/** Fetch by id, scoped. Returns null on a cross-client id — a miss, never another client's clone. */
function getClone(clones, clientId, id) {
  const cid = cleanClientId(clientId);
  const rid = cleanId(id);
  if (!cid || !rid) return null;
  return (clones || []).find((c) => c && c.id === rid && c.clientId === cid) || null;
}

/**
 * May this session use clones at all?
 *
 * Reachability and entitlement are different questions. `/api/clones` is on the client-API
 * allowlist so the surface EXISTS for non-admin roles — a licensee's employees need it. Whether a
 * particular person may use it is decided here, per user.
 *
 * FAILS CLOSED. A user record with no `cloneAccess` field gets nothing, which is precisely the
 * shape of the records the Stripe purchase path creates. That matters concretely: on the operator's
 * own instance, `role:'client'` means a managed-website customer, and their clone usage would spend
 * the OPERATOR's API key inside a fixed monthly fee. Employees on a licensee's self-hosted instance
 * are granted access explicitly when they are invited.
 *
 * Admin is the operator of the instance and always has access — they are the one paying for it.
 */
function hasCloneAccess(session, user) {
  if (!session) return false;
  if (session.role === 'admin') return true;
  return !!(user && user.cloneAccess === true);
}

function canCreate(clones, clientId) {
  const count = listClones(clones, clientId).length;
  return count < MAX_CLONES_PER_PERSON
    ? { ok: true }
    : { ok: false, error: 'this person already has a clone — a clone replicates one person, and one is all they get' };
}

/**
 * Replace a clone's persona wholesale, normalising and bumping the version. Callers never mutate
 * `clone.persona` directly — going through here is what guarantees caps are applied and that a
 * version bump is never forgotten (an unbumped version silently breaks draft traceability).
 */
function setPersona(clone, nextPersona) {
  clone.persona = persona.normalize(nextPersona);
  clone.personaVersion += 1;
  clone.updatedAt = nowIso();

  // Status follows readiness automatically, but never downgrades an owner's explicit pause.
  if (clone.status !== 'paused') {
    clone.status = persona.isUsable(clone.persona).usable
      ? (clone.status === 'interviewing' ? 'ready' : clone.status)
      : 'interviewing';
  }
  return clone;
}

function addInterviewTurn(clone, { role, text, dimension }) {
  if (clone.interview.turns.length >= MAX_INTERVIEW_TURNS) {
    throw new Error(`interview exceeded ${MAX_INTERVIEW_TURNS} turns`);
  }
  clone.interview.turns.push({
    role: role === 'owner' ? 'owner' : 'interviewer',
    text: String(text || '').slice(0, 4000),
    dimension: persona.DIMENSIONS.includes(dimension) ? dimension : clone.interview.currentDimension,
    at: nowIso(),
  });
  clone.updatedAt = nowIso();
  return clone;
}

/**
 * Record how a draft actually landed. This is the raw material the evolution loop (P4) turns into
 * proposed persona diffs, which is why the persona version is captured alongside — feedback about
 * a persona that has since changed must not be counted as evidence against the current one.
 */
function recordFeedback(clone, { draftId, verdict, note = '' }) {
  const allowed = ['approved', 'edited', 'rejected'];
  if (!allowed.includes(verdict)) throw new Error(`recordFeedback: bad verdict "${verdict}"`);

  clone.feedback.push({
    draftId: cleanId(draftId) || null,
    verdict,
    note: String(note || '').slice(0, 2000),
    personaVersion: clone.personaVersion,
    at: nowIso(),
  });
  if (clone.feedback.length > MAX_FEEDBACK_ENTRIES) {
    clone.feedback = clone.feedback.slice(-MAX_FEEDBACK_ENTRIES);
  }
  clone.metrics[verdict] = (clone.metrics[verdict] || 0) + 1;
  clone.updatedAt = nowIso();
  return clone;
}

function setStatus(clone, status) {
  if (!STATUSES.includes(status)) throw new Error(`setStatus: bad status "${status}"`);
  // Refuse to activate a clone that isn't fit to speak for someone. The API layer checks this too;
  // it is repeated here so no future caller can route around it.
  if (status === 'active') {
    const check = persona.isUsable(clone.persona);
    if (!check.usable) {
      throw new Error(`cannot activate: ${check.reasons.join('; ')}`);
    }
  }
  clone.status = status;
  clone.updatedAt = nowIso();
  return clone;
}

/**
 * Shape returned to the dashboard — no corpus metadata, no full interview transcript.
 *
 * `judgeBy` is the persona to assess readiness against, and callers should pass the EFFECTIVE one
 * (personal + inherited company policy). Defaults to the clone's own so a solo owner is unaffected.
 * Without it, an employee whose company supplies their escalation topics and identity facts reads as
 * "not ready" here while the drafting routes — which do use the effective persona — happily let them
 * work. Same class of bug as any other site reading the raw persona to decide something; it just
 * happens to live in this module rather than in the routes.
 */
function summarize(clone, judgeBy) {
  const assessed = judgeBy || clone.persona;
  const c = persona.completeness(assessed);
  const usable = persona.isUsable(assessed);
  return {
    id: clone.id,
    name: clone.name,
    templateId: clone.templateId || interview.DEFAULT_TEMPLATE,
    status: clone.status,
    personaVersion: clone.personaVersion,
    completeness: c.overall,
    byDimension: c.byDimension,
    usable: usable.usable,
    blockers: usable.reasons,
    corpusItems: clone.corpus.length,
    interviewTurns: clone.interview.turns.length,
    metrics: clone.metrics,
    createdAt: clone.createdAt,
    updatedAt: clone.updatedAt,
  };
}

module.exports = {
  OPERATOR_CLIENT_ID,
  STATUSES,
  MAX_CLONES_PER_PERSON,
  MAX_INTERVIEW_TURNS,
  createClone,
  listClones,
  getClone,
  hasCloneAccess,
  canCreate,
  setPersona,
  addInterviewTurn,
  recordFeedback,
  setStatus,
  summarize,
};
