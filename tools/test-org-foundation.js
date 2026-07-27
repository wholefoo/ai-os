// Tests lib/org/foundation: the order a company has to be built in — company profile, then the
// founder's clone, then everyone else — and that each gate refuses for a reason the person on the
// other side of it can act on.
const persona = require('../lib/business-clone/persona');
const store = require('../lib/business-clone/store');
const profileLib = require('../lib/org/profile');
const foundation = require('../lib/org/foundation');

const { assert, done } = require('./test-util');

const ORG = 'dana@whitfield.com';
const EMPLOYEE = 'sam@whitfield.com';

const FULL_PROFILE = profileLib.normalizeProfile({
  ownerEmail: ORG,
  identity: { businessName: 'Whitfield Dental Supply', industry: 'Dental distribution', whatTheyDo: 'We sell and install dental equipment.' },
  boundaries: { requiresHuman: ['contract dispute'], pricingDisclosure: 'ranges' },
});

// A persona with NOTHING about the business in it — no businessName, no whatTheyDo. This is what a
// persona should look like once the company is a separate artifact: entirely about the person.
const personalOnly = () => persona.normalize({
  identity: { ownerName: 'Dana', role: 'Owner', yearsExperience: 12, location: 'Leeds' },
  voice: { formality: 3, directness: 4, warmth: 3, humor: 'dry', signaturePhrases: ['Right then'], avoidPhrases: ['synergy'], signoff: '- Dana' },
  expertise: { domains: ['sterilisers'], knownFor: 'Straight answers', strongOpinions: [{ claim: 'Cheap kit costs more', rationale: 'You pay twice' }], faq: [{ question: 'Do you install?', answer: 'Yes.' }] },
  decisionStyle: { priorities: ['the patient'], riskPosture: 'balanced', escalationTriggers: ['legal'] },
  boundaries: { requiresHuman: ['refund'] },
});

const cloneFor = (clientId, p) => {
  // Clone ids are deliberately boring (they appear in log lines and file paths), so an email cannot
  // be one — derive something id-shaped rather than fighting the store's validator.
  const c = store.createClone({ id: `c-${clientId.replace(/[^\w.-]/g, '-')}`, clientId, name: clientId });
  if (p) store.setPersona(c, p);
  return c;
};

// --- what counts as a foundation
assert(foundation.profileGaps(null).length === 3, 'an absent profile is missing all three foundation facts');
assert(!foundation.isProfileEstablished(profileLib.emptyProfile(ORG)), 'an empty profile is not a foundation');
assert(!foundation.isProfileEstablished(profileLib.normalizeProfile({ identity: { businessName: 'X' } })), 'nor is a half-filled one');
assert(foundation.isProfileEstablished(FULL_PROFILE), 'all three facts makes it one');
assert(foundation.profileGaps(profileLib.normalizeProfile({ identity: { businessName: 'X', industry: 'Y' } })).includes('whatTheyDo'), 'the gap is named specifically, not just counted');

// --- STAGE 1: no profile, nobody may build anything — the founder included
const noProfile = foundation.status({ profile: null, clones: [], orgKey: ORG });
assert(noProfile.stage === 'profile' && !noProfile.complete, 'with no profile the org is at the profile stage');
assert(/business name/.test(noProfile.blockers[0]), 'and the blocker says which facts are missing');

const founderTooEarly = foundation.mayCreateClone({ profile: null, clones: [], orgKey: ORG, clientId: ORG });
assert(!founderTooEarly.ok, 'the FOUNDER cannot build a clone before the company profile exists');
assert(/comes before the first one/.test(founderTooEarly.error), 'and is told why the order is that way round');

const employeeTooEarly = foundation.mayCreateClone({ profile: null, clones: [], orgKey: ORG, clientId: EMPLOYEE });
assert(!employeeTooEarly.ok, 'nor can an employee');
assert(employeeTooEarly.error.includes(ORG), 'and they are told WHOSE move it is — "not yet" alone leaves them with nothing to do');

// --- STAGE 2: profile done, the founder goes first
const profileOnly = foundation.status({ profile: FULL_PROFILE, clones: [], orgKey: ORG });
assert(profileOnly.stage === 'founder', 'once the profile is set the org moves to the founder stage');
assert(profileOnly.profileReady && !profileOnly.founderReady, 'the first gate is passed and the second is not');
assert(profileOnly.founderClone === null, 'with no founder clone yet');

assert(foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [], orgKey: ORG, clientId: ORG }).ok,
  'the founder may now build theirs');
const employeeWaiting = foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [], orgKey: ORG, clientId: EMPLOYEE });
assert(!employeeWaiting.ok && employeeWaiting.stage === 'founder', 'an employee still waits');
assert(employeeWaiting.error.includes(ORG), 'and again knows who they are waiting on');

// A founder clone that exists but is half-built does NOT open the gate.
const halfBuilt = cloneFor(ORG, persona.normalize({ identity: { ownerName: 'Dana' } }));
const midway = foundation.status({ profile: FULL_PROFILE, clones: [halfBuilt], orgKey: ORG });
assert(midway.stage === 'founder' && !midway.founderReady, 'a half-built founder clone is not a finished one');
assert(midway.founderClone && midway.founderClone.id === halfBuilt.id, 'but it is reported, so the UI can show progress rather than nothing');
assert(midway.blockers.length > 0, 'with the same reasons the interview screen gives');
assert(!foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [halfBuilt], orgKey: ORG, clientId: EMPLOYEE }).ok,
  'and employees keep waiting');
assert(foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [halfBuilt], orgKey: ORG, clientId: ORG }).ok,
  'while the founder is never blocked BY the founder gate — it exists to hold everyone else');

// --- STAGE 3: ready
const ready = cloneFor(ORG, personalOnly());
const done3 = foundation.status({ profile: FULL_PROFILE, clones: [ready], orgKey: ORG });
assert(done3.stage === 'ready' && done3.complete, 'a finished founder clone completes the foundation');
assert(done3.blockers.length === 0, 'and nothing is in the way');
assert(foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [ready], orgKey: ORG, clientId: EMPLOYEE }).ok,
  'so employees may finally build theirs');

// =====================================================================================
//  THE POINT OF THE ORDER: a persona holds NOTHING about the business, and is still usable,
//  because the company profile supplies those facts at the point of use. Build the clone first
//  and this same persona is unusable — which is why the profile gate comes before the clone.
// =====================================================================================
assert(!persona.isUsable(ready.persona).usable, 'a purely personal persona is NOT usable on its own — it has no idea what the business does');
assert(persona.isUsable(profileLib.effectivePersona(ready.persona, FULL_PROFILE)).usable,
  'but IS once the company profile is merged in — the person answers about themselves, the company answers for itself');
assert(!JSON.stringify(ready.persona).includes('Whitfield'),
  'and the business name never gets copied into the person, so changing it later is one edit and not five');

// The founder is whoever is keyed to the ORG — no separate "isFounder" field to keep in sync.
assert(foundation.founderCloneOf([cloneFor(EMPLOYEE, personalOnly()), ready], ORG).id === ready.id, 'the founder clone is the one keyed to the org');
assert(foundation.founderCloneOf([cloneFor(EMPLOYEE, personalOnly())], ORG) === null, 'an employee clone is not mistaken for the founder\'s');
assert(foundation.founderCloneOf([ready], 'DANA@WHITFIELD.COM').id === ready.id, 'matching is case-insensitive, like every other org lookup');

// An employee's own clone does not satisfy the founder gate for anybody, including themselves.
const employeeOnly = [cloneFor(EMPLOYEE, personalOnly())];
assert(foundation.status({ profile: FULL_PROFILE, clones: employeeOnly, orgKey: ORG }).stage === 'founder',
  'employee clones existing does not mean the founder has been through it');

// --- fails closed
const noOrg = foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [ready], orgKey: '', clientId: EMPLOYEE });
assert(!noOrg.ok, 'no org key, no clone — there is nothing to check against, so the answer is no');
assert(!foundation.mayCreateClone({ profile: FULL_PROFILE, clones: [ready], orgKey: ORG, clientId: '' }).ok, 'and an unidentified caller is refused too');
assert(!foundation.mayCreateClone({}).ok, 'as is a call with nothing at all');

done();
