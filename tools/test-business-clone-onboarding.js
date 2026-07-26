// Tests lib/business-clone/onboarding: versioned disclosure (an old acceptance must not carry
// forward), dismissal as a real state, completion DERIVED from a usable clone rather than claimed,
// and the daily turn cap on paid interview questions.
const persona = require('../lib/business-clone/persona');
const onboarding = require('../lib/business-clone/onboarding');

const { assert, done } = require('./test-util');

const usablePersona = persona.normalize({
  identity: { ownerName: 'Dana', role: 'Owner', businessName: 'W', industry: 'D', whatTheyDo: 'Equipment', yearsExperience: 18 },
  voice: { formality: 3, directness: 4, warmth: 4, humor: 'warm', signaturePhrases: ['x'], avoidPhrases: ['y'], signoff: '- D' },
  expertise: { domains: ['a'], methodologies: ['b'], credentials: ['c'], strongOpinions: [{ claim: 'd' }], faq: [{ question: 'q', answer: 'a' }] },
  decisionStyle: { priorities: ['p'], tradeoffRules: [{ when: 'w', prefer: 'x', over: 'y' }], riskPosture: 'balanced', escalationTriggers: ['legal'] },
  boundaries: { neverSay: ['n'], neverPromise: ['m'], requiresHuman: ['h'], pricingDisclosure: 'ranges' },
});
const usableClone = { id: 'c1', persona: usablePersona };
const thinClone = { id: 'c2', persona: persona.normalize({ identity: { ownerName: 'Dana' } }) };

// --- the disclosure is real content, not a placeholder
assert(onboarding.DISCLOSURE.points.length >= 4, 'the disclosure covers several points');
assert(onboarding.DISCLOSURE.version === onboarding.DISCLOSURE_VERSION, 'the disclosure carries its version');
const text = JSON.stringify(onboarding.DISCLOSURE).toLowerCase();
assert(/draft/.test(text), 'it states that output is a draft');
assert(/you read it and you send it|nothing is sent/.test(text), 'it states nothing is sent for them');
assert(/only you/.test(text), 'it states who can see it');
assert(/delet/.test(text), 'it states they can delete it');
assert(/paid|costs money/.test(text), 'it states that running it costs money');
// v2: employers can see what an employee's clone drafts, so the disclosure has to say so BEFORE
// anyone answers a question. If this assertion ever fails, someone widened visibility without
// widening what people were told.
assert(/employer/.test(text), 'it states that an employer can see what the clone writes');
assert(/company correspondence|business records/.test(text), 'it explains why, and what survives deletion');
assert(onboarding.DISCLOSURE_VERSION >= 2, 'and the version reflects that widening');

// --- versioned consent: an older acceptance does NOT carry forward
const rec = onboarding.createRecord('dana@example.com');
assert(rec.status === 'pending' && !onboarding.disclosureAccepted(rec), 'a new record has accepted nothing');

onboarding.acceptDisclosure(rec);
assert(onboarding.disclosureAccepted(rec), 'accepting the current version counts');
assert(rec.status === 'in_progress' && !!rec.startedAt, 'accepting starts the onboarding');
assert(!!rec.disclosureAcceptedAt, 'acceptance is timestamped');

const stale = onboarding.createRecord('old@example.com');
stale.disclosureAcceptedVersion = onboarding.DISCLOSURE_VERSION - 1;
stale.disclosureAcceptedAt = '2020-01-01T00:00:00Z';
assert(!onboarding.disclosureAccepted(stale), 'an acceptance of an OLDER disclosure does not carry forward — consent cannot silently widen');

// --- dismissal is a real state, and it stops the nudging
const d = onboarding.createRecord('x@example.com');
onboarding.acceptDisclosure(d);
assert(onboarding.shouldPrompt(d, []), 'an unstarted owner is nudged');
onboarding.dismiss(d);
assert(d.status === 'dismissed' && !!d.dismissedAt, 'dismissal is recorded');
assert(!onboarding.shouldPrompt(d, []), 'a dismissed owner is NOT nudged again — "later" is respected');
onboarding.resume(d);
assert(d.status === 'in_progress' && d.dismissedAt === null, 'resuming clears the dismissal');
assert(onboarding.shouldPrompt(d, []), 'and the nudge returns');

// --- completion is DERIVED from a usable clone, never merely claimed
const r2 = onboarding.createRecord('y@example.com');
onboarding.acceptDisclosure(r2);
onboarding.reconcile(r2, [thinClone]);
assert(r2.status === 'in_progress', 'a clone below the usability bar does not complete onboarding');
assert(onboarding.shouldPrompt(r2, [thinClone]), 'and the nudge continues');

onboarding.reconcile(r2, [thinClone, usableClone]);
assert(r2.status === 'completed' && !!r2.completedAt, 'a usable clone completes onboarding');
assert(!onboarding.shouldPrompt(r2, [thinClone, usableClone]), 'a completed owner is not nudged');

// and it reverses honestly if the clone is deleted or gutted
onboarding.reconcile(r2, [thinClone]);
assert(r2.status === 'in_progress', 'losing the usable clone re-opens onboarding rather than claiming done');
assert(r2.completedAt === null, 'the stale completion timestamp is cleared');
onboarding.reconcile(r2, []);
assert(r2.status === 'in_progress', 'someone who accepted the disclosure stays in_progress even with no clones — "pending" means never started, and they have started');

// pending is reserved for a record that genuinely has not begun
const untouched = onboarding.createRecord('z@example.com');
onboarding.reconcile(untouched, []);
assert(untouched.status === 'pending', 'a record that never accepted the disclosure stays pending');

// The SAME end state must report the same status however it was reached. A live run caught this:
// completed -> delete the only clone landed on "pending" while in_progress -> delete landed on
// "in_progress", so one situation had two labels depending on the path taken to it.
const viaCompleted = onboarding.createRecord('path-a@example.com');
onboarding.acceptDisclosure(viaCompleted);
onboarding.reconcile(viaCompleted, [usableClone]);   // -> completed
onboarding.reconcile(viaCompleted, []);              // clone deleted
const viaProgress = onboarding.createRecord('path-b@example.com');
onboarding.acceptDisclosure(viaProgress);
onboarding.reconcile(viaProgress, []);
assert(viaCompleted.status === viaProgress.status,
  `accepted-with-no-clones reports one status regardless of path (got ${viaCompleted.status} vs ${viaProgress.status})`);
assert(viaCompleted.status === 'in_progress', 'and that status is in_progress, because they started');

// Someone who NEVER accepted still lands on pending when a clone disappears.
const neverAccepted = onboarding.createRecord('path-c@example.com');
neverAccepted.status = 'completed';
onboarding.reconcile(neverAccepted, []);
assert(neverAccepted.status === 'pending', 'without an acceptance it re-opens as pending');

// a missing record still nudges — a brand-new instance has no record yet
assert(onboarding.shouldPrompt(null, []), 'no record at all means nudge');

// --- daily turn cap
const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
const cloneWithTurns = (turns) => ({ interview: { turns } });

assert(onboarding.interviewTurnsToday(cloneWithTurns([])) === 0, 'no turns is zero');
assert(onboarding.interviewTurnsToday({ }) === 0, 'a malformed clone counts zero rather than throwing');

const mixed = cloneWithTurns([
  { role: 'interviewer', at: at(10) },
  { role: 'owner', at: at(9) },          // the owner's answer is not a paid question
  { role: 'interviewer', at: at(8) },
  { role: 'interviewer', at: at(60 * 30) }, // 30h ago — outside the window
]);
assert(onboarding.interviewTurnsToday(mixed) === 2, `only interviewer turns inside 24h count, got ${onboarding.interviewTurnsToday(mixed)}`);

const fresh = onboarding.withinDailyCap(cloneWithTurns([]));
assert(fresh.ok && fresh.remaining === onboarding.INTERVIEW_DAILY_TURN_CAP, 'a fresh clone is within the cap');

const atCap = cloneWithTurns(Array.from({ length: onboarding.INTERVIEW_DAILY_TURN_CAP }, () => ({ role: 'interviewer', at: at(5) })));
const capped = onboarding.withinDailyCap(atCap);
assert(!capped.ok && capped.remaining === 0, 'hitting the cap closes it');
assert(capped.used === onboarding.INTERVIEW_DAILY_TURN_CAP, 'usage is reported so the UI can explain the refusal');

const yesterday = cloneWithTurns(Array.from({ length: onboarding.INTERVIEW_DAILY_TURN_CAP }, () => ({ role: 'interviewer', at: at(60 * 26) })));
assert(onboarding.withinDailyCap(yesterday).ok, 'the cap is a rolling 24h window, not a permanent ceiling');

// --- summary shape
const s = onboarding.overview(r2, [thinClone, usableClone]);
assert(typeof s.status === 'string' && typeof s.shouldPrompt === 'boolean', 'summary carries status and nudge flag');
assert(s.bestCompleteness > 0 && s.clonesStarted === 2, 'summary reports progress');
assert(s.disclosureVersion === onboarding.DISCLOSURE_VERSION, 'summary carries the current disclosure version so the UI can re-prompt');

done();
