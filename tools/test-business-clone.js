// Tests lib/business-clone: persona normalisation + caps, completeness scoring, the usability bar,
// red-line checking on output, and — most importantly — that the clientId scoping in the store
// actually isolates one client's clone from another's.
const persona = require('../lib/business-clone/persona');
const store = require('../lib/business-clone/store');

const { assert, done } = require('./test-util');

// --- normalisation: unknown fields dropped, caps applied, dedupe
const dirty = persona.normalize({
  identity: { ownerName: '  Mike  ', role: 'Founder', yearsExperience: '12', evilExtra: 'ignore me' },
  voice: {
    formality: '3', directness: 9, humor: 'DRY', sentenceLength: 'nope',
    signaturePhrases: ['Let me be blunt', 'let me be blunt', '  ', 'Ship it'],
  },
  expertise: {
    faq: [{ question: 'Do you do refunds?', answer: 'Within 30 days.' }, { question: 'no answer' }],
    strongOpinions: [{ claim: 'Most SEO advice is noise', rationale: 'It optimises for crawlers' }, { rationale: 'orphan' }],
  },
  boundaries: { pricingDisclosure: 'ranges', neverSay: ['guaranteed results'] },
  bogusDimension: { x: 1 },
});
assert(dirty.identity.ownerName === 'Mike', 'strings are trimmed');
assert(dirty.identity.yearsExperience === 12, 'numeric-ish years coerced to a number');
assert(dirty.identity.evilExtra === undefined, 'unknown identity fields are dropped, not preserved');
assert(dirty.bogusDimension === undefined, 'unknown dimensions are dropped');
assert(dirty.voice.formality === 3, 'in-range scale kept');
assert(dirty.voice.directness === null, 'out-of-range scale rejected to null, not clamped silently');
assert(dirty.voice.humor === 'dry', 'enum case-normalised');
assert(dirty.voice.sentenceLength === '', 'invalid enum rejected to empty');
assert(dirty.voice.signaturePhrases.length === 2, `dedupe + blank-strip on lists, got ${JSON.stringify(dirty.voice.signaturePhrases)}`);
assert(dirty.expertise.faq.length === 1, 'FAQ entries missing an answer are dropped');
assert(dirty.expertise.strongOpinions.length === 1, 'opinions missing a claim are dropped');

const capped = persona.normalize({ voice: { vocabulary: Array.from({ length: 100 }, (_, i) => `word${i}`) } });
assert(capped.voice.vocabulary.length === persona.CAPS.listItems, `list capped at ${persona.CAPS.listItems}, got ${capped.voice.vocabulary.length}`);
const longAnswer = persona.normalize({ expertise: { faq: [{ question: 'q', answer: 'x'.repeat(9999) }] } });
assert(longAnswer.expertise.faq[0].answer.length === persona.CAPS.longText, 'long text truncated to cap');

// --- completeness reports what is MISSING, not just a score
const empty = persona.completeness(persona.emptyPersona());
assert(empty.overall === 0, `empty persona scores 0, got ${empty.overall}`);
assert(empty.byDimension.voice.missing.includes('signaturePhrases'), 'missing fields are named for the interviewer');
assert(Object.keys(empty.byDimension).length === persona.DIMENSIONS.length, 'every dimension is scored');

// --- the usability bar: a thin persona must not be allowed to speak for someone
const thin = persona.normalize({ identity: { ownerName: 'Mike', whatTheyDo: 'SEO for dentists' } });
const thinCheck = persona.isUsable(thin);
assert(!thinCheck.usable, 'a near-empty persona is not usable');
assert(thinCheck.reasons.some((r) => /escalation topics/.test(r)), 'no-escalation-topics is called out explicitly');

const full = persona.normalize({
  identity: { ownerName: 'Mike', role: 'Founder', businessName: 'AI OS', industry: 'SaaS', whatTheyDo: 'Agentic ops platform', yearsExperience: 12 },
  voice: { formality: 2, directness: 5, warmth: 3, humor: 'dry', signaturePhrases: ['Ship it'], avoidPhrases: ['synergy'], signoff: '- Mike' },
  expertise: { domains: ['SEO'], methodologies: ['AEO audit'], strongOpinions: [{ claim: 'x' }], faq: [{ question: 'q', answer: 'a' }], credentials: ['12y'] },
  decisionStyle: { priorities: ['margin'], tradeoffRules: [{ when: 'tight deadline', prefer: 'scope cut', over: 'overtime' }], riskPosture: 'balanced', escalationTriggers: ['legal threat'] },
  boundaries: { neverSay: ['guaranteed rankings'], neverPromise: ['refund'], requiresHuman: ['contract dispute'], pricingDisclosure: 'ranges' },
});
const fullCheck = persona.isUsable(full);
assert(fullCheck.usable, `a complete persona is usable, blockers: ${JSON.stringify(fullCheck.reasons)}`);

// --- red lines are checked against OUTPUT, not merely stated in the prompt
const clean = persona.checkRedLines('Happy to help — here is how the audit works.', full);
assert(!clean.blocked && clean.violations.length === 0, 'benign copy passes clean');

const banned = persona.checkRedLines('We deliver guaranteed rankings within a month.', full);
assert(banned.blocked, 'a neverSay phrase blocks the draft');
assert(banned.violations[0].kind === 'neverSay', 'violation is typed');

// neverPromise: the subject alone is reviewable, the subject WITH promise language is a block.
// This distinction matters — an owner who bans promising refunds still needs to discuss refunds.
const refundTalk = persona.checkRedLines('Our refund window is 30 days.', full);
assert(!refundTalk.blocked, 'discussing a neverPromise subject without promising is not blocked');
assert(refundTalk.violations.some((v) => v.severity === 'review'), 'but it is flagged for review');

const refundPromise = persona.checkRedLines('I guarantee you a full refund, no risk.', full);
assert(refundPromise.blocked, 'subject + promise language blocks');
assert(refundPromise.violations.some((v) => v.matchedMarker === 'i guarantee'), 'the promise marker that fired is reported');

const escalate = persona.checkRedLines('Regarding your contract dispute, here is my view.', full);
assert(escalate.needsHuman, 'a requiresHuman topic escalates rather than blocking');

// Regex metacharacters in an owner-supplied phrase must be literal, not a pattern (and must not throw)
const rxPersona = persona.normalize({ boundaries: { neverSay: ['100% (guaranteed)'] } });
assert(persona.checkRedLines('we are 100% (guaranteed)', rxPersona).blocked, 'regex metacharacters in a red line are matched literally');
assert(!persona.checkRedLines('100% guaranteed', rxPersona).blocked, 'and do not match as a pattern');

// --- store: clientId scoping is the security property here
const clones = [];
const a = store.createClone({ id: 'clone-a', clientId: 'client-1', name: "Client One's clone" });
const b = store.createClone({ id: 'clone-b', clientId: 'client-2', name: "Client Two's clone" });
clones.push(a, b);

assert(store.listClones(clones, 'client-1').length === 1, 'list is scoped to one client');
assert(store.getClone(clones, 'client-1', 'clone-a').id === 'clone-a', 'own clone is retrievable');
assert(store.getClone(clones, 'client-1', 'clone-b') === null, 'another client\'s clone id returns null, not the record');
assert(store.getClone(clones, '', 'clone-a') === null, 'a missing clientId returns nothing rather than everything');
assert(typeof store.listClones !== 'undefined' && store.listAll === undefined, 'there is no unscoped listAll export');

let threw = false;
try { store.createClone({ id: 'x', name: 'no client' }); } catch { threw = true; }
assert(threw, 'createClone refuses a record with no clientId');

// clientId is the session EMAIL, matching how web-studio scopes sites by ownerEmail. Case must
// collapse — treating Mike@x.com and mike@x.com as two clients would split one customer's clones
// into two halves, each invisible from the other.
const emailClones = [];
const e1 = store.createClone({ id: 'clone-e', clientId: 'Mike@Example.com', name: 'Email-keyed' });
emailClones.push(e1);
assert(e1.clientId === 'mike@example.com', `email clientId is lower-cased, got ${e1.clientId}`);
assert(store.listClones(emailClones, 'mike@example.com').length === 1, 'retrievable by the lower-case address');
assert(store.listClones(emailClones, 'MIKE@EXAMPLE.COM').length === 1, 'and by any casing the session presents');
assert(store.getClone(emailClones, 'mike@example.com', 'clone-e') !== null, 'getClone accepts an email clientId');
assert(store.getClone(emailClones, 'other@example.com', 'clone-e') === null, 'a different address is still a miss');
assert(store.listClones(emailClones, 'not an email at all!').length === 0, 'a malformed clientId matches nothing');
assert(store.createClone({ id: 'clone-f', clientId: 'operator' }).clientId === 'operator', 'the non-email fallback id is still accepted');

// --- entitlement: reachable is not the same as permitted
// /api/clones stays on the client-API allowlist so a licensee's EMPLOYEES can reach it. Whether a
// given person may use it is decided per user, and it fails closed — which is exactly the shape of
// the records the Stripe purchase path creates for managed-website customers.
assert(store.hasCloneAccess({ role: 'admin' }, null) === true, 'admin always has clone access — they pay for the instance');
assert(store.hasCloneAccess({ role: 'admin', email: 'a@b.com' }, { email: 'a@b.com' }) === true, 'admin does not need the flag');
assert(store.hasCloneAccess({ role: 'client' }, null) === false, 'a client with no user record gets nothing');
assert(store.hasCloneAccess({ role: 'client' }, {}) === false, 'a user record with no cloneAccess field FAILS CLOSED — this is the Stripe-created managed client');
assert(store.hasCloneAccess({ role: 'client' }, { cloneAccess: false }) === false, 'explicitly false is false');
assert(store.hasCloneAccess({ role: 'client' }, { cloneAccess: true }) === true, 'an entitled client (an invited employee) has access');
assert(store.hasCloneAccess({ role: 'client' }, { cloneAccess: 'yes' }) === false, 'only a real boolean true grants it — no truthy strings');
assert(store.hasCloneAccess(null, { cloneAccess: true }) === false, 'no session means no access regardless of the record');
assert(store.hasCloneAccess({ role: 'user' }, { cloneAccess: true }) === true, 'the flag governs any non-admin role, not just client');

// --- persona versioning + status transitions
assert(a.personaVersion === 0 && a.status === 'interviewing', 'new clone starts unversioned and interviewing');
store.setPersona(a, full);
assert(a.personaVersion === 1, 'setPersona bumps the version');
assert(a.status === 'ready', `a usable persona moves the clone to ready, got ${a.status}`);

store.setPersona(a, thin);
assert(a.personaVersion === 2, 'version bumps even when the persona got worse');
assert(a.status === 'interviewing', 'a persona that falls below the bar returns the clone to interviewing');

store.setPersona(a, full);
store.setStatus(a, 'active');
assert(a.status === 'active', 'a usable clone can be activated');

threw = false;
try { store.setStatus(b, 'active'); } catch { threw = true; }
assert(threw, 'an empty-persona clone cannot be activated');

store.setStatus(a, 'paused');
store.setPersona(a, full);
assert(a.status === 'paused', 'setPersona never silently un-pauses a clone the owner paused');

// --- feedback records the persona version it applies to
store.recordFeedback(a, { draftId: 'd1', verdict: 'edited', note: 'too formal' });
assert(a.feedback[0].personaVersion === a.personaVersion, 'feedback captures the persona version that produced the draft');
assert(a.metrics.edited === 1, 'metrics increment');
threw = false;
try { store.recordFeedback(a, { draftId: 'd2', verdict: 'shipped' }); } catch { threw = true; }
assert(threw, 'an unknown verdict is rejected');

// --- summary shape is safe to hand to the dashboard
const sum = store.summarize(a);
assert(sum.completeness > 0 && typeof sum.usable === 'boolean', 'summary carries completeness and usability');
assert(sum.persona === undefined && sum.interview === undefined, 'summary does not leak the full persona or transcript');

done();
