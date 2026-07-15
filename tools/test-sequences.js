// Email sequences: engine semantics (enroll/dedup/suppress/tick/advance/retry-cap), template
// rendering, and lib/email's provider pick + unsubscribe-token integrity. No network — the
// sender is mocked; lib/email's transports are exercised only up to payload/provider selection.
const { assert, done } = require('./test-util');
const seq = require('../lib/sequences');
const email = require('../lib/email');

const HOUR = 3600e3;
const mkSeq = (over = {}) => ({
  id: 's1', name: 'Welcome', trigger: 'site-lead', siteId: null, enabled: true,
  steps: [
    { delayHours: 0, subject: 'Hi {{first_name}}', body: 'Thanks for reaching out about {{site}}.' },
    { delayHours: 24, subject: 'Following up', body: 'Still interested?' },
  ],
  ...over,
});

(async () => {
  // --- validation
  assert(seq.validateSequence(mkSeq()).length === 0, 'valid sequence passes validation');
  assert(seq.validateSequence({ name: '', trigger: 'nope', steps: [] }).length >= 3, 'invalid sequence collects errors');
  assert(seq.validateSequence(mkSeq({ steps: [{ delayHours: 99999, subject: 's', body: 'b' }] })).length === 1, 'absurd delay rejected');

  // --- rendering
  assert(seq.renderStepTemplate('Hi {{first_name}} ({{email}}) re {{site}}', { name: 'Jane Doe', email: 'j@x.com', site: 'Acme' }) === 'Hi Jane (j@x.com) re Acme', 'template tokens render');
  assert(seq.renderStepTemplate('x {{unknown}} y', {}) === 'x  y', 'unknown tokens render empty, never leak braces');

  // --- enrollment
  const state = { sequences: [mkSeq()], enrollments: [], suppression: ['blocked@x.com'] };
  const t0 = Date.now();
  const c1 = seq.enroll({ email: 'Lead@X.com', name: 'Lead One', siteId: 'site-1', source: 'site-lead' }, state, t0);
  assert(c1.length === 1 && c1[0].email === 'lead@x.com', 'lead enrolls (email normalized)');
  assert(seq.enroll({ email: 'lead@x.com', source: 'site-lead' }, state, t0).length === 0, 'duplicate active enrollment refused');
  assert(seq.enroll({ email: 'blocked@x.com', source: 'site-lead' }, state, t0).length === 0, 'suppressed address never enrolls');
  assert(seq.enroll({ email: 'other@x.com', source: 'free-audit' }, state, t0).length === 0, 'non-matching trigger does not enroll');
  state.sequences.push(mkSeq({ id: 's2', trigger: 'all-leads', siteId: 'site-9' }));
  assert(seq.enroll({ email: 'sited@x.com', siteId: 'site-1', source: 'site-lead' }, state, t0).length === 1, 'site-scoped sequence skips other sites (only s1 enrolled)');

  // --- tick: delay-0 step sends immediately; step 2 waits 24h
  const sends = [];
  const okSender = async ({ subject, body }) => { sends.push({ subject, body }); return { sent: true }; };
  let r = await seq.tick(state, { dispatchSend: okSender }, t0 + 1000);
  assert(r.sent === 2 && sends[0].subject === 'Hi Lead', 'due step-0 sends for both enrollments, rendered');
  const en = state.enrollments[0];
  assert(en.step === 1 && en.status === 'active' && new Date(en.nextAt).getTime() === t0 + 1000 + 24 * HOUR, 'advanced to step 2 with 24h delay');
  r = await seq.tick(state, { dispatchSend: okSender }, t0 + 2 * HOUR);
  assert(r.sent === 0, 'nothing due before the delay elapses');
  r = await seq.tick(state, { dispatchSend: okSender }, t0 + 26 * HOUR);
  assert(r.sent === 2 && en.status === 'completed' && en.nextAt === null, 'final step sends and completes');
  assert(en.history.filter((h) => h.ok).length === 2, 'history records both sends');

  // --- failed sends retry and cap out
  const s3 = { sequences: [mkSeq({ id: 's3', trigger: 'all-leads' })], enrollments: [], suppression: [] };
  seq.enroll({ email: 'fail@x.com', source: 'site-lead' }, s3, t0);
  const badSender = async () => ({ sent: false, error: 'smtp down' });
  for (let i = 0; i < seq.MAX_STEP_ATTEMPTS; i++) await seq.tick(s3, { dispatchSend: badSender }, t0 + 1000);
  const fen = s3.enrollments[0];
  assert(fen.step === 0 && fen.status === 'stopped' && fen.attempts === seq.MAX_STEP_ATTEMPTS, `never advances on failure; stops after ${seq.MAX_STEP_ATTEMPTS} attempts`);

  // --- gated (manual mode): enrollment parks, engine does not re-dispatch
  const s4 = { sequences: [mkSeq({ id: 's4', trigger: 'all-leads' })], enrollments: [], suppression: [] };
  seq.enroll({ email: 'gated@x.com', source: 'free-audit' }, s4, t0);
  let dispatches = 0;
  const gatedSender = async () => { dispatches++; return { pending: true }; };
  await seq.tick(s4, { dispatchSend: gatedSender }, t0 + 1000);
  await seq.tick(s4, { dispatchSend: gatedSender }, t0 + 2000);
  assert(s4.enrollments[0].status === 'gated' && dispatches === 1, 'gated enrollment queues exactly one approval');
  // the approve-later executor then advances via advance()
  seq.advance(s4.enrollments[0], s4.sequences[0], t0 + 3000);
  assert(s4.enrollments[0].status === 'active' && s4.enrollments[0].step === 1, 'executor advance resumes the enrollment');

  // --- unsubscribe wins instantly
  const s5 = { sequences: [mkSeq({ id: 's5', trigger: 'all-leads' })], enrollments: [], suppression: [] };
  seq.enroll({ email: 'bye@x.com', source: 'site-lead' }, s5, t0);
  seq.suppress('BYE@x.com', s5);
  assert(s5.suppression.includes('bye@x.com') && s5.enrollments[0].status === 'stopped', 'suppress normalizes, stops actives');
  const r5 = await seq.tick(s5, { dispatchSend: okSender }, t0 + 1000);
  assert(r5.sent === 0, 'suppressed enrollment never sends');

  // --- paused sequence holds in place
  const s6 = { sequences: [mkSeq({ id: 's6', trigger: 'all-leads', enabled: true })], enrollments: [], suppression: [] };
  seq.enroll({ email: 'hold@x.com', source: 'site-lead' }, s6, t0);
  s6.sequences[0].enabled = false;
  await seq.tick(s6, { dispatchSend: okSender }, t0 + 1000);
  assert(s6.enrollments[0].step === 0 && s6.enrollments[0].status === 'active', 'disabled sequence holds enrollments without sending');

  // --- lib/email: provider selection + unsubscribe token integrity
  assert(email.pickProvider({ resend_api_key: 'k' }) === 'resend', 'auto provider: resend when key set');
  assert(email.pickProvider({ smtp_host: 'h' }) === 'smtp', 'auto provider: smtp when host set');
  assert(email.pickProvider({}) === null && !email.isConfigured({}), 'unconfigured → null provider');
  assert(email.isConfigured({ resend_api_key: 'k', from_email: 'a@b.c' }), 'configured needs provider + from');
  const tok = email.unsubscribeToken('user@x.com', 'secret1');
  assert(email.verifyUnsubscribeToken('user@x.com', tok, 'secret1'), 'unsubscribe token verifies');
  assert(!email.verifyUnsubscribeToken('other@x.com', tok, 'secret1'), 'token bound to the address');
  assert(!email.verifyUnsubscribeToken('user@x.com', tok, 'secret2'), 'token bound to the secret');
  const html = email.textToHtml('Hello <b>\n\nSecond & para');
  assert(html.includes('&lt;b&gt;') && html.includes('&amp;') && (html.match(/<p /g) || []).length === 2, 'text→HTML escapes and paragraphs');
  const noCfg = await email.send({ cfg: {}, to: 'a@b.c', subject: 's', text: 'x' });
  assert(noCfg.ok === false && /not configured/.test(noCfg.error), 'send without config fails cleanly, never throws');

  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
