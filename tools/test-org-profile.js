// Tests lib/org/profile: company facts fill blanks without overwriting, company limits are always
// present, and — the point of the whole design — none of the three paths that can modify a persona
// is able to remove a company limit, because merging at use means the limit was never in the
// persona for them to reach.
const persona = require('../lib/business-clone/persona');
const interview = require('../lib/business-clone/interview');
const evolve = require('../lib/business-clone/evolve');
const store = require('../lib/business-clone/store');
const profile = require('../lib/org/profile');

const { assert, done } = require('./test-util');

const ORG = profile.normalizeProfile({
  ownerEmail: 'dana@whitfield.com',
  identity: { businessName: 'Whitfield Dental Supply', industry: 'Dental distribution', whatTheyDo: 'We sell and install dental equipment.' },
  boundaries: {
    neverSay: ['lowest price anywhere'],
    neverPromise: ['next-day delivery'],
    requiresHuman: ['contract dispute'],
    confidentialTopics: ['supplier margins'],
    pricingDisclosure: 'ranges',
    competitorPolicy: 'Never name a competitor.',
  },
});

// --- identity: fill blanks, never overwrite
const blankIdentity = persona.normalize({ identity: { ownerName: 'Sam' } });
const filled = profile.effectivePersona(blankIdentity, ORG);
assert(filled.identity.businessName === 'Whitfield Dental Supply', 'an unanswered company fact is inherited');
assert(filled.identity.whatTheyDo === 'We sell and install dental equipment.', 'so is what the business does');
assert(filled.identity.ownerName === 'Sam', 'the person\'s own fields are untouched');

const ownWords = persona.normalize({ identity: { ownerName: 'Sam', whatTheyDo: 'I fix sterilisers, mostly.' } });
const kept = profile.effectivePersona(ownWords, ORG);
assert(kept.identity.whatTheyDo === 'I fix sterilisers, mostly.', 'someone who answered in their own words KEEPS their words — inheritance fills, it does not overwrite');

// --- boundaries: union, deduped
const personal = persona.normalize({
  boundaries: { neverSay: ['guaranteed results'], requiresHuman: ['anything legal'] },
});
const merged = profile.effectivePersona(personal, ORG);
assert(merged.boundaries.neverSay.includes('guaranteed results'), 'the person\'s own limits survive');
assert(merged.boundaries.neverSay.includes('lowest price anywhere'), 'and the company\'s are added');
assert(merged.boundaries.requiresHuman.includes('anything legal') && merged.boundaries.requiresHuman.includes('contract dispute'), 'lists union rather than replace');
assert(merged.boundaries.confidentialTopics.includes('supplier margins'), 'a company list the person never touched still applies');

const dupe = profile.effectivePersona(persona.normalize({ boundaries: { neverSay: ['LOWEST PRICE ANYWHERE'] } }), ORG);
assert(dupe.boundaries.neverSay.length === 1, 'a limit set by both is not duplicated');

// --- pricing: the MORE restrictive wins, whichever side it came from
const strictPerson = profile.effectivePersona(persona.normalize({ boundaries: { pricingDisclosure: 'none' } }), ORG);
assert(strictPerson.boundaries.pricingDisclosure === 'none', 'a person stricter than the company keeps their own rule');
const loosePerson = profile.effectivePersona(persona.normalize({ boundaries: { pricingDisclosure: 'full' } }), ORG);
assert(loosePerson.boundaries.pricingDisclosure === 'ranges', 'a person looser than the company is pulled back to the company rule');
const noPerson = profile.effectivePersona(persona.emptyPersona(), ORG);
assert(noPerson.boundaries.pricingDisclosure === 'ranges', 'someone who never set a pricing rule inherits the company one');

// --- no profile at all changes nothing
const solo = persona.normalize({ identity: { ownerName: 'Dana' }, boundaries: { neverSay: ['x'] } });
assert(JSON.stringify(profile.effectivePersona(solo, null)) === JSON.stringify(solo), 'with no company profile the persona is unchanged');

// =====================================================================================
//  THE POINT: none of the three paths that modify a persona can remove a company limit.
//  Not because three guards catch them, but because merging at use means the limit is not
//  in the persona they operate on.
// =====================================================================================
const employeeClone = store.createClone({ id: 'emp-1', clientId: 'sam@whitfield.com', name: 'Sam' });
store.setPersona(employeeClone, persona.normalize({
  identity: { ownerName: 'Sam', role: 'Technician', yearsExperience: 6 },
  voice: { formality: 3, directness: 4, warmth: 3, humor: 'dry', signaturePhrases: ['Right then'], avoidPhrases: ['synergy'], signoff: '- Sam' },
  boundaries: { neverSay: ['my own rule'] },
}));

const stillLocked = (label, p) => {
  const eff = profile.effectivePersona(p, ORG);
  assert(eff.boundaries.neverSay.includes('lowest price anywhere'), `${label}: the company's neverSay survives`);
  assert(eff.boundaries.requiresHuman.includes('contract dispute'), `${label}: the company's escalation topic survives`);
  assert(eff.boundaries.confidentialTopics.includes('supplier margins'), `${label}: the company's confidential topic survives`);
  assert(eff.boundaries.pricingDisclosure === 'ranges', `${label}: the company's pricing rule survives`);
};

// PATH 1 — the correction form. An employee submits a persona with every company limit stripped.
store.setPersona(employeeClone, persona.normalize({
  identity: { ownerName: 'Sam' },
  boundaries: { neverSay: [], neverPromise: [], requiresHuman: [], confidentialTopics: [], pricingDisclosure: 'full' },
}));
assert(employeeClone.persona.boundaries.neverSay.length === 0, 'the correction did clear their PERSONAL list, as it should');
stillLocked('correction form', employeeClone.persona);

// PATH 2 — interview extraction. A model returns a patch that names the company's limits.
const afterExtract = interview.mergePatch(employeeClone.persona, {
  boundaries: { neverSay: [], requiresHuman: [], pricingDisclosure: 'full' },
});
stillLocked('interview extraction', afterExtract);

// PATH 3 — the evolution loop. A proposal explicitly asks to remove them.
const { proposed, refused } = evolve.computeProposed(employeeClone.persona, {
  remove: [
    { dimension: 'boundaries', field: 'neverSay', value: 'lowest price anywhere' },
    { dimension: 'boundaries', field: 'requiresHuman', value: 'contract dispute' },
    { dimension: 'boundaries', field: 'pricingDisclosure' },
  ],
  set: { boundaries: { pricingDisclosure: 'full' } },
});
assert(refused.length >= 3, `evolution refuses boundary removals outright too (${refused.length} refused)`);
stillLocked('evolution proposal', proposed);

// And the employee CAN still add their own limits on top — the lock is one-way, not a freeze.
const withOwn = interview.mergePatch(employeeClone.persona, { boundaries: { neverSay: ['we never subcontract'] } });
const effWithOwn = profile.effectivePersona(withOwn, ORG);
assert(effWithOwn.boundaries.neverSay.includes('we never subcontract'), 'an employee may still ADD a limit');
assert(effWithOwn.boundaries.neverSay.includes('lowest price anywhere'), 'without displacing the company\'s');

// --- red lines are checked against the EFFECTIVE persona, or company policy is not enforced at all
const eff = profile.effectivePersona(employeeClone.persona, ORG);
assert(persona.checkRedLines('We are the lowest price anywhere.', eff).blocked, 'output violating a COMPANY limit is blocked');
assert(!persona.checkRedLines('We are the lowest price anywhere.', employeeClone.persona).blocked,
  'and would NOT be caught against the raw persona — which is exactly why every decision site must read the effective one');

// --- what the UI needs to show as inherited
const inh = profile.inheritedFrom(ORG);
assert(inh.boundaries.neverSay.includes('lowest price anywhere'), 'inherited values are reportable for display');
assert(inh.identity.businessName === 'Whitfield Dental Supply', 'including the company facts');
assert(profile.inheritedIdentityFields(ORG).length === 3, 'all three company identity fields are known-answered');
assert(profile.inheritedIdentityFields(profile.emptyProfile('x@y.com')).length === 0, 'an empty profile inherits nothing, so the interview asks everything');

// --- profile normalisation reuses the persona caps rather than inventing its own
const capped = profile.normalizeProfile({ boundaries: { neverSay: Array.from({ length: 80 }, (_, i) => `r${i}`) } });
assert(capped.boundaries.neverSay.length === persona.CAPS.listItems, 'company lists obey the same caps as personal ones');
const bogus = profile.normalizeProfile({ boundaries: { pricingDisclosure: 'whatever' }, identity: { businessName: 'X', madeUp: 'y' } });
assert(bogus.boundaries.pricingDisclosure === '', 'an invalid enum is rejected');
assert(bogus.identity.madeUp === undefined, 'unknown fields are dropped');

assert(profile.getProfile([ORG], 'DANA@whitfield.com') === ORG, 'profile lookup is case-insensitive');
assert(profile.getProfile([ORG], 'other@x.com') === null, 'another org has no profile here');

done();
