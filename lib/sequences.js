// lib/sequences.js — email nurture sequences: enroll → wait → send → advance.
//
// Pure engine over injected state + deps, so the unit suite runs it with a mock sender and the
// server runs it against gateAction (Auto-Mode: 'email.sequence-send' is a medium-risk outward
// action — auto-runs in supervised/auto, queues an approval in manual).
//
// Data shapes (persisted by the server via saveState):
//   sequence   = { id, name, trigger: 'site-lead'|'free-audit'|'booking'|'all-leads', siteId|null, enabled,
//                  steps: [{ delayHours, subject, body }], createdAt }
//   enrollment = { id, sequenceId, email, name, siteId, step, nextAt, status:
//                  'active'|'gated'|'completed'|'stopped', history: [{step, at, ok, error?}] }
//   suppression = [normalized emails] — unsubscribed; never enrolled, never sent, never re-added.
//
// Rules the engine enforces (tested):
//   - one active enrollment per (email, sequence); suppressed or email-less contacts never enroll
//   - a step only fires once its delay has elapsed; steps advance in order; last step completes
//   - unsubscribe wins instantly: suppression stops active enrollments at the next tick
//   - a failed send retries next tick (capped), and never advances the step

const { randomUUID } = require('crypto');

const MAX_STEP_ATTEMPTS = 5;

const normEmail = (e) => String(e || '').trim().toLowerCase();

// {{name}} {{first_name}} {{email}} {{site}} — unknown tokens render as '' (never leak braces).
function renderStepTemplate(tpl, ctx = {}) {
  const first = String(ctx.name || '').trim().split(/\s+/)[0] || '';
  const map = { name: ctx.name || '', first_name: first, email: ctx.email || '', site: ctx.site || '' };
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in map ? map[k] : ''));
}

function validateSequence(seq) {
  const errs = [];
  if (!seq || typeof seq !== 'object') return ['sequence must be an object'];
  if (!String(seq.name || '').trim()) errs.push('name is required');
  if (!['site-lead', 'free-audit', 'booking', 'all-leads'].includes(seq.trigger)) errs.push('trigger must be site-lead, free-audit, booking, or all-leads');
  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  if (!steps.length) errs.push('at least one step is required');
  if (steps.length > 10) errs.push('at most 10 steps');
  steps.forEach((s, i) => {
    if (!String(s.subject || '').trim()) errs.push(`step ${i + 1}: subject required`);
    if (!String(s.body || '').trim()) errs.push(`step ${i + 1}: body required`);
    const d = Number(s.delayHours);
    if (!Number.isFinite(d) || d < 0 || d > 24 * 90) errs.push(`step ${i + 1}: delayHours must be 0–2160`);
  });
  return errs;
}

// Enroll a lead into every enabled sequence whose trigger matches. Returns new enrollments.
function enroll({ email, name = '', siteId = null, source }, { sequences, enrollments, suppression }, now = Date.now()) {
  const e = normEmail(email);
  if (!e || suppression.includes(e)) return [];
  const created = [];
  for (const seq of sequences) {
    if (!seq.enabled || !seq.steps.length) continue;
    const triggerMatch = seq.trigger === 'all-leads' || seq.trigger === source;
    const siteMatch = !seq.siteId || seq.siteId === siteId;
    if (!triggerMatch || !siteMatch) continue;
    const dup = enrollments.find((x) => x.sequenceId === seq.id && x.email === e && (x.status === 'active' || x.status === 'gated'));
    if (dup) continue;
    created.push({
      id: randomUUID(), sequenceId: seq.id, email: e, name: String(name || ''), siteId,
      step: 0, attempts: 0, status: 'active',
      nextAt: new Date(now + Number(seq.steps[0].delayHours) * 3600e3).toISOString(),
      enrolledAt: new Date(now).toISOString(), history: [],
    });
  }
  enrollments.push(...created);
  return created;
}

// Stop everything for an unsubscribed address (idempotent).
function suppress(email, { enrollments, suppression }) {
  const e = normEmail(email);
  if (!e) return false;
  if (!suppression.includes(e)) suppression.push(e);
  for (const en of enrollments) {
    if (en.email === e && (en.status === 'active' || en.status === 'gated')) en.status = 'stopped';
  }
  return true;
}

// One engine pass. deps.dispatchSend({enrollment, sequence, step, subject, body}) is the server's
// gateAction wrapper → { sent: true } | { pending: true } | { sent: false, error }.
async function tick({ sequences, enrollments, suppression }, deps, now = Date.now()) {
  const log = deps.log || (() => {});
  const out = { sent: 0, gated: 0, completed: 0, failed: 0, stopped: 0 };
  for (const en of enrollments) {
    if (en.status !== 'active') continue;
    if (suppression.includes(en.email)) { en.status = 'stopped'; out.stopped++; continue; }
    if (new Date(en.nextAt).getTime() > now) continue;
    const seq = sequences.find((s) => s.id === en.sequenceId);
    if (!seq || !seq.enabled) continue; // paused sequence: hold in place, resume when re-enabled
    const step = seq.steps[en.step];
    if (!step) { en.status = 'completed'; out.completed++; continue; }

    const ctx = { name: en.name, email: en.email, site: en.siteName || '' };
    const r = await deps.dispatchSend({
      enrollment: en, sequence: seq, stepIndex: en.step,
      subject: renderStepTemplate(step.subject, ctx),
      body: renderStepTemplate(step.body, ctx),
    });

    if (r && r.pending) { en.status = 'gated'; out.gated++; continue; } // approval queued — executor advances it
    if (r && r.sent) {
      advance(en, seq, now);
      out.sent++;
      if (en.status === 'completed') out.completed++;
    } else {
      en.attempts = (en.attempts || 0) + 1;
      en.history.push({ step: en.step, at: new Date(now).toISOString(), ok: false, error: (r && r.error) || 'send failed' });
      if (en.attempts >= MAX_STEP_ATTEMPTS) { en.status = 'stopped'; out.stopped++; log(`[sequences] ${en.email} stopped after ${MAX_STEP_ATTEMPTS} failed attempts`); }
      out.failed++;
    }
  }
  return out;
}

// Record a successful send and move to the next step (or complete). Shared by the immediate
// path (tick) and the approve-later executor, so both advance identically.
function advance(en, seq, now = Date.now()) {
  en.history.push({ step: en.step, at: new Date(now).toISOString(), ok: true });
  en.attempts = 0;
  en.step += 1;
  const next = seq.steps[en.step];
  if (!next) { en.status = 'completed'; en.nextAt = null; }
  else { en.status = 'active'; en.nextAt = new Date(now + Number(next.delayHours) * 3600e3).toISOString(); }
}

function stats(sequences, enrollments) {
  return sequences.map((s) => {
    const ens = enrollments.filter((e) => e.sequenceId === s.id);
    const sent = ens.reduce((n, e) => n + e.history.filter((h) => h.ok).length, 0);
    return {
      id: s.id, name: s.name, trigger: s.trigger, siteId: s.siteId || null, enabled: !!s.enabled,
      steps: s.steps.length, enrolled: ens.length,
      active: ens.filter((e) => e.status === 'active' || e.status === 'gated').length,
      completed: ens.filter((e) => e.status === 'completed').length,
      sent,
    };
  });
}

module.exports = { enroll, suppress, tick, advance, stats, renderStepTemplate, validateSequence, normEmail, MAX_STEP_ATTEMPTS };
