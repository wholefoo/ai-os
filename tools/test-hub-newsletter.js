// tools/test-hub-newsletter.js
// The newsletter signup (hub integration, phase 4) and the consent boundary it introduced.
//
// Three properties matter more than the markup:
//   1. A newsletter subscriber is NOT a lead. 'all-leads' sequences must not reach them — without
//      this, adding the signup would have enrolled every subscriber into sales nurture.
//   2. The form never lies. No destination = no form (the hub posted to "#"); default copy claims
//      nothing Web Studio does not do (it does not email subscribers per post).
//   3. Site policy is the operator's. A `content` key cannot change hub settings.
'use strict';
const assert = require('assert');
const S = require('../lib/sequences');
const H = require('../lib/web-studio/hub-settings');
const A = require('../lib/web-studio/articles');
const P = require('../lib/web-studio/pipeline');
const K = require('../lib/security/service-keys');
const { serverSource } = require('./test-util');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
console.log('hub-newsletter');

// ---------- 1. the consent boundary ---------------------------------------------------------------
const seq = (id, trigger) => ({ id, name: id, trigger, siteId: null, enabled: true, steps: [{ delayHours: 0, subject: 's', body: 'b' }] });
const enrolIn = (source, sequences) => S.enroll({ email: 'p@example.com', source },
  { sequences, enrollments: [], suppression: [] }).map((e) => e.sequenceId).sort();

t('a newsletter subscriber is NOT enrolled in an all-leads sequence', () => {
  assert.deepStrictEqual(enrolIn('site-newsletter', [seq('nurture', 'all-leads')]), [],
    'a subscriber was enrolled into sales nurture');
});

t('a newsletter subscriber IS enrolled in a sequence built for subscribers', () => {
  assert.deepStrictEqual(enrolIn('site-newsletter', [seq('nurture', 'all-leads'), seq('welcome', 'site-newsletter')]), ['welcome']);
});

t('a real lead still reaches all-leads — the exclusion is specific', () => {
  for (const src of ['site-lead', 'free-audit', 'booking']) {
    assert.deepStrictEqual(enrolIn(src, [seq('nurture', 'all-leads')]), ['nurture'], src + ' lost its all-leads enrolment');
  }
});

t('a lead is not enrolled in the subscriber sequence', () => {
  assert.deepStrictEqual(enrolIn('site-lead', [seq('welcome', 'site-newsletter')]), []);
});

t('site-newsletter is an accepted trigger', () => {
  const errs = S.validateSequence(seq('w', 'site-newsletter'));
  assert.ok(!errs.some((e) => /trigger/.test(e)), 'rejected: ' + errs.join('; '));
});

// ---------- 2. the form never lies --------------------------------------------------------------
t('no destination renders NO form (the hub posted to "#")', () => {
  assert.strictEqual(P.renderSection({ type: 'newsletter', heading: 'x' }), '', 'a form with nowhere to go was rendered');
});

t('native mode posts to the lead route marked as a newsletter, with the honeypot', () => {
  const out = P.renderSection({ type: 'newsletter' }, { leadEndpoint: 'https://aios.example/api/public/site-lead/abc' });
  assert.ok(out.includes('action="https://aios.example/api/public/site-lead/abc"'), 'wrong action');
  assert.ok(out.includes('name="kind" value="newsletter"'), 'not marked as a newsletter — would be recorded as a lead');
  assert.ok(out.includes('name="website"'), 'no honeypot');
  assert.ok(out.includes('id="newsletter-thanks"'), 'no confirmation target');
  assert.ok(!out.includes('id="lead-thanks"'), 'shares the contact form anchor');
});

t('external mode posts to the provider, carries no Web Studio fields', () => {
  const out = P.renderSection({ type: 'newsletter', action: 'https://buttondown.example/api/emails/embed-subscribe/me' });
  assert.ok(out.includes('action="https://buttondown.example/api/emails/embed-subscribe/me"'));
  assert.ok(out.includes('name="email"'), 'provider needs an email field');
  assert.ok(!out.includes('name="kind"'), 'leaked a Web Studio field to a third party');
});

t('an http or javascript: action is never used', () => {
  for (const a of ['http://insecure.example/sub', 'javascript:alert(1)']) {
    const out = P.renderSection({ type: 'newsletter', action: a });
    assert.ok(!out.includes(a), 'rendered unsafe action ' + a);
  }
});

const plan = (newsletter) => ({ siteName: 'Demo', domain: 'demo.example', pages: [], newsletter,
  articles: [A.normalizeArticle({ title: 'Post', html: '<p>x</p>', tags: ['ai'] }, { now: '2026-09-18T00:00:00.000Z' })] });
const sectionsAt = (p, path) => A.expandArticlePages(p).pages.find((x) => x.path === path).sections;

t('default copy never promises an email per post', () => {
  for (const n of [{ enabled: true }, { enabled: true, action: 'https://buttondown.example/x' }]) {
    const s = sectionsAt(plan(n), '/article/post').find((x) => x.type === 'newsletter');
    assert.ok(!/new post|something new|each post|every post|when .* published/i.test(s.blurb), 'overclaims: ' + s.blurb);
  }
});

t('the unsubscribe claim appears only in native mode, where it is provably true', () => {
  const native = sectionsAt(plan({ enabled: true }), '/article/post').find((x) => x.type === 'newsletter');
  const ext = sectionsAt(plan({ enabled: true, action: 'https://buttondown.example/x' }), '/article/post').find((x) => x.type === 'newsletter');
  assert.ok(/unsubscribe/i.test(native.blurb), 'native copy omits the unsubscribe it guarantees');
  assert.ok(!/unsubscribe/i.test(ext.blurb), 'claimed unsubscribe behaviour on behalf of a third party');
});

t('the signup is opt-in: absent unless enabled', () => {
  assert.ok(!sectionsAt(plan(undefined), '/article/post').some((x) => x.type === 'newsletter'));
  assert.ok(!sectionsAt(plan({ enabled: false }), '/article/post').some((x) => x.type === 'newsletter'));
  assert.ok(sectionsAt(plan({ enabled: true }), '/article/post').some((x) => x.type === 'newsletter'));
});

t('it goes on entry pages, not on listings', () => {
  const p = plan({ enabled: true });
  for (const path of ['/articles', '/tags/ai', '/tags']) {
    assert.ok(!sectionsAt(p, path).some((x) => x.type === 'newsletter'), 'signup on listing ' + path);
  }
});

// ---------- settings validation ------------------------------------------------------------------
t('the provider action must be https', () => {
  assert.ok(H.normalizeHubSettings({ newsletter: { action: 'http://x.example' } }, {}).errors);
  assert.ok(H.normalizeHubSettings({ newsletter: { action: 'javascript:alert(1)' } }, {}).errors);
  assert.strictEqual(H.normalizeHubSettings({ newsletter: { action: 'https://x.example/s' } }, {}).settings.newsletter.action, 'https://x.example/s');
  assert.strictEqual(H.normalizeHubSettings({ newsletter: { action: null } }, { newsletter: { action: 'https://x' } }).settings.newsletter.action, '');
});

t('a partial update keeps the other settings', () => {
  const cur = { newsletter: { enabled: true, heading: 'Hi', action: '' }, ingestAutoPublish: true, startHereTitle: 'Begin' };
  const s = H.normalizeHubSettings({ newsletter: { blurb: 'New text' } }, cur).settings;
  assert.strictEqual(s.newsletter.enabled, true); assert.strictEqual(s.newsletter.heading, 'Hi');
  assert.strictEqual(s.newsletter.blurb, 'New text');
  assert.strictEqual(s.ingestAutoPublish, true); assert.strictEqual(s.startHereTitle, 'Begin');
});

t('types and lengths are enforced', () => {
  assert.ok(H.normalizeHubSettings({ ingestAutoPublish: 'yes' }, {}).errors);
  assert.ok(H.normalizeHubSettings({ newsletter: { enabled: 1 } }, {}).errors);
  assert.ok(H.normalizeHubSettings({ newsletter: { heading: 'x'.repeat(81) } }, {}).errors);
});

// ---------- 3. site policy is the operator's -----------------------------------------------------
t('a content key cannot change hub settings (it could switch auto-publish on)', () => {
  const k = { scope: 'content', siteId: 'site-a' };
  assert.strictEqual(K.decideScope(k, 'PUT', '/api/web-studio/sites/site-a/hub-settings').allow, false);
});

// ---------- the server side ----------------------------------------------------------------------
const src = serverSource();
const lead = src.slice(src.indexOf("app.post('/api/public/site-lead/:siteId'"));
const leadBody = lead.slice(0, lead.indexOf("\napp."));

t('the lead route ALLOW-LISTS kind — a visitor cannot name an arbitrary sequence source', () => {
  assert.ok(/const isNewsletter = body\.kind === 'newsletter';/.test(leadBody), 'kind is not compared to a literal');
  assert.ok(/const source = isNewsletter \? 'site-newsletter' : 'site-lead';/.test(leadBody), 'source is not one of two literals');
  assert.ok(!/source:\s*body\./.test(leadBody) && !/source = body\./.test(leadBody), 'source taken from the request body');
  assert.ok(/enrollLead\(\{ email, name, siteId: site\.id, source \}\)/.test(leadBody), 'enrolment does not use the resolved source');
});

t('a subscriber gets the newsletter confirmation, not the contact one', () => {
  assert.ok(leadBody.includes("res.locals.thanksHash = 'newsletter-thanks'"), 'no newsletter anchor');
  assert.ok(leadBody.includes("ref.hash = res.locals.thanksHash || 'lead-thanks'"), 'redirect ignores it');
});

t('enabling native signup records the lead endpoint an adopted site lacks', () => {
  const hs = src.slice(src.indexOf("app.put('/api/web-studio/sites/:id/hub-settings'"));
  const hsBody = hs.slice(0, hs.indexOf('\napp.'));
  assert.ok(/if \(next\.newsletter\.enabled && !next\.newsletter\.action && !next\.leadEndpoint\)/.test(hsBody), 'no endpoint backfill');
  assert.ok(hsBody.includes('wsFindSite(req, res)'), 'not ownership-scoped');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
