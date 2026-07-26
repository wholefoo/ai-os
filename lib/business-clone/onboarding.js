// lib/business-clone/onboarding.js
// ============================================================
//  The first thing that happens on a new instance: building the owner's clone.
//
//  Three things this module exists to get right.
//
//  DISCLOSURE BEFORE THE FIRST QUESTION. Someone about to answer "what do you say when a client is
//  late paying?" is handing over a profile of how they think. They are told what is collected, who
//  can see it, and how to delete it BEFORE they answer, not in a settings page afterwards. The
//  disclosure is VERSIONED: when what we can see changes — E4 gives employers visibility into
//  drafts — the version bumps and everyone re-accepts. A consent that silently covers more than it
//  did when it was given is not consent.
//
//  FINISHING LATER IS A FIRST-CLASS OUTCOME. The interview is long. Gating platform access behind it
//  would cost activations, so onboarding nudges and resumes but never blocks. "Dismissed" is a real
//  state, not a failure.
//
//  A DAILY CAP ON PAID TURNS. Every interview turn is two model calls. On a self-hosted instance
//  that spends the operator's own key and is self-limiting, but making clone creation the front
//  door means it is reachable by anyone who can sign up. The cap is cheap insurance that costs a
//  real human nothing — nobody answers sixty interview questions in a day — and bounds a script.
//  It is deliberately NOT the instance-wide kill switch: settings.security.hard_budget already
//  does that job for total spend. This one bounds a single clone's interview specifically.
//
//  Pure module: records, transitions, and counting. No model calls, no I/O.
// ============================================================

'use strict';

const persona = require('./persona');

// Bump when what we collect, who can see it, or what we do with it changes. A higher version than
// the one a person accepted means they are asked again before the next question.
//
// v2 (E4): employers can now see what an employee's clone drafts. That widened who can see what, so
// every v1 acceptance is void and everyone re-accepts before their next question. This is the
// versioning doing exactly the job it was built for — a consent that silently grows to cover more
// than it did when it was given is not consent.
const DISCLOSURE_VERSION = 2;

/**
 * The disclosure itself, as data rather than markup, so the same words can be rendered in the
 * dashboard, quoted in the docs, and asserted in a test. Phrased for the person answering, not for
 * a lawyer — a disclosure nobody reads protects nobody.
 */
const DISCLOSURE = {
  version: DISCLOSURE_VERSION,
  title: 'Before we start',
  points: [
    {
      heading: 'What this builds',
      body: 'A profile of how you write and decide — your phrases, your expertise, what you refuse to say. It is used to draft messages in your voice.',
    },
    {
      heading: 'Nothing is sent for you',
      body: 'Everything it writes is a draft. You read it and you send it. No message reaches a customer without you.',
    },
    {
      heading: 'Who can see your profile',
      body: 'Only you. Your answers, the profile built from them, and the exact instructions your clone receives are yours alone — nobody else on this instance can read them, including whoever runs it.',
    },
    {
      heading: 'Who can see what it writes',
      body: 'If an employer invited you, they can see every draft your clone produces, what you changed before sending, and anything that crossed a limit. That is company correspondence. They cannot see your profile, your answers, or the instructions your clone receives.',
    },
    {
      heading: 'You can correct or delete it',
      body: 'Every field is editable, and deleting your clone deletes the profile it learned about you. If an employer invited you, the drafts stay with the company as business records — but the profile of how you think does not.',
    },
    {
      heading: 'It costs money to run',
      body: 'Each question and each draft is a paid model call on this instance\'s API key. The interview is roughly fifteen to twenty exchanges.',
    },
  ],
};

const STATUSES = ['pending', 'in_progress', 'dismissed', 'completed'];

// Generous for a person, tight for a script. A real interview reaches a usable persona in roughly
// 15-20 turns; nobody legitimately does 60 in a day.
const INTERVIEW_DAILY_TURN_CAP = 60;

function nowIso() {
  return new Date().toISOString();
}

function createRecord(clientId) {
  return {
    clientId: String(clientId || '').trim().toLowerCase(),
    status: 'pending',
    disclosureAcceptedVersion: 0,
    disclosureAcceptedAt: null,
    startedAt: null,
    completedAt: null,
    dismissedAt: null,
  };
}

function getRecord(records, clientId) {
  const cid = String(clientId || '').trim().toLowerCase();
  return (records || []).find((r) => r && r.clientId === cid) || null;
}

/** Has this person accepted the CURRENT disclosure? An older acceptance does not carry forward. */
function disclosureAccepted(record) {
  return !!record && Number(record.disclosureAcceptedVersion) >= DISCLOSURE_VERSION;
}

function acceptDisclosure(record) {
  record.disclosureAcceptedVersion = DISCLOSURE_VERSION;
  record.disclosureAcceptedAt = nowIso();
  if (record.status === 'pending' || record.status === 'dismissed') {
    record.status = 'in_progress';
    record.startedAt = record.startedAt || nowIso();
    record.dismissedAt = null;
  }
  return record;
}

/** Finish later. Not a failure state — it stops the nudging and nothing else. */
function dismiss(record) {
  record.status = 'dismissed';
  record.dismissedAt = nowIso();
  return record;
}

function resume(record) {
  if (record.status === 'dismissed') {
    record.status = record.completedAt ? 'completed' : 'in_progress';
    record.dismissedAt = null;
  }
  return record;
}

/**
 * Reconcile the record against reality. Completion is DERIVED from whether a usable clone exists,
 * not from a button someone pressed — a record claiming "completed" while every clone is still
 * below the usability bar would be a lie the UI then repeats.
 */
function reconcile(record, clones) {
  const usable = (clones || []).some((c) => c && persona.isUsable(c.persona).usable);
  if (usable && record.status !== 'completed') {
    record.status = 'completed';
    record.completedAt = record.completedAt || nowIso();
  } else if (!usable && record.status === 'completed') {
    // The only way back: the owner deleted or gutted their clone. Re-open rather than claim done.
    // Which state it re-opens INTO is decided by whether they ever accepted the disclosure, not by
    // whether any clones happen to remain. "pending" means never started; someone who accepted and
    // then deleted their only clone has started, and labelling that pending would make the same
    // situation report two different statuses depending on the path taken to reach it.
    record.status = disclosureAccepted(record) ? 'in_progress' : 'pending';
    record.completedAt = null;
  }
  return record;
}

/**
 * Should the dashboard nudge? True when there is real work left and the person has not asked to be
 * left alone. Deliberately false once dismissed — a nudge that ignores "later" is nagging.
 */
function shouldPrompt(record, clones) {
  if (!record) return true;
  if (record.status === 'dismissed' || record.status === 'completed') return false;
  return !(clones || []).some((c) => c && persona.isUsable(c.persona).usable);
}

/** Interview turns this clone has taken in the last 24h — the paid ones, so interviewer turns. */
function interviewTurnsToday(clone, nowMs = Date.now()) {
  const dayAgo = nowMs - 86400000;
  return ((clone && clone.interview && clone.interview.turns) || [])
    .filter((t) => t && t.role === 'interviewer' && new Date(t.at).getTime() > dayAgo)
    .length;
}

function withinDailyCap(clone, nowMs = Date.now()) {
  const used = interviewTurnsToday(clone, nowMs);
  return {
    ok: used < INTERVIEW_DAILY_TURN_CAP,
    used,
    cap: INTERVIEW_DAILY_TURN_CAP,
    remaining: Math.max(0, INTERVIEW_DAILY_TURN_CAP - used),
  };
}

/** Shape for the onboarding UI. */
function overview(record, clones) {
  const list = clones || [];
  const best = list.reduce((acc, c) => Math.max(acc, persona.completeness(c.persona).overall), 0);
  return {
    status: record ? record.status : 'pending',
    disclosureAccepted: disclosureAccepted(record),
    disclosureVersion: DISCLOSURE_VERSION,
    shouldPrompt: shouldPrompt(record, list),
    clonesStarted: list.length,
    bestCompleteness: best,
    startedAt: record ? record.startedAt : null,
    completedAt: record ? record.completedAt : null,
  };
}

module.exports = {
  DISCLOSURE,
  DISCLOSURE_VERSION,
  STATUSES,
  INTERVIEW_DAILY_TURN_CAP,
  createRecord,
  getRecord,
  disclosureAccepted,
  acceptDisclosure,
  dismiss,
  resume,
  reconcile,
  shouldPrompt,
  interviewTurnsToday,
  withinDailyCap,
  overview,
};
