// Tests lib/org/visibility: an employer sees what is said in the company's name and nothing about
// how their employee thinks. The leak check runs over WHOLE payloads rather than the fields someone
// remembered to check — a field-by-field assertion is the same denylist mistake one level up.
const persona = require('../lib/business-clone/persona');
const store = require('../lib/business-clone/store');
const drafts = require('../lib/business-clone/drafts');
const evolve = require('../lib/business-clone/evolve');
const vis = require('../lib/org/visibility');

const { assert, done } = require('./test-util');

// A fully-populated clone: every sensitive surface present, so a leak has something to leak.
const clone = store.createClone({ id: 'c-emp', clientId: 'sam@whitfield.com', name: 'Sam', templateId: 'support' });
store.setPersona(clone, persona.normalize({
  identity: { ownerName: 'Sam', role: 'Technician', businessName: 'Whitfield', industry: 'Dental', whatTheyDo: 'Fix sterilisers', yearsExperience: 6 },
  voice: { formality: 2, directness: 5, warmth: 3, humor: 'dry', signaturePhrases: ['Right then'], avoidPhrases: ['synergy'], signoff: '- Sam' },
  expertise: { domains: ['sterilisers'], methodologies: ['on-site'], credentials: ['6y'], strongOpinions: [{ claim: 'Cheap units cost more' }], faq: [{ question: 'q', answer: 'a' }] },
  decisionStyle: { priorities: ['safety'], tradeoffRules: [{ when: 'w', prefer: 'x', over: 'y' }], riskPosture: 'conservative', escalationTriggers: ['injury'] },
  boundaries: { neverSay: ['guaranteed'], neverPromise: ['same day'], requiresHuman: ['injury'], pricingDisclosure: 'ranges' },
}));
store.addInterviewTurn(clone, { role: 'interviewer', text: 'How blunt do you get?', dimension: 'voice' });
store.addInterviewTurn(clone, { role: 'owner', text: 'Very. I do not soften bad news about safety.', dimension: 'voice' });
store.recordFeedback(clone, { draftId: 'd1', verdict: 'edited', note: 'too soft' });

const draft = drafts.createDraft({ id: 'd1', cloneId: 'c-emp', clientId: 'sam@whitfield.com', channel: 'email', inbound: 'Is the unit safe to run?' });
draft.text = 'Yes, provided the seal is intact. Right then — book me in.';
draft.cost = 0.004;
draft.violations = [{ kind: 'neverSay', phrase: 'guaranteed', severity: 'block' }];
draft.blocked = true;
drafts.reviewDraft(draft, { verdict: 'edited', finalText: 'Yes, if the seal is intact.', note: 'too chatty' });

// --- the clone view: what the employer needs, nothing more
const view = vis.employerCloneView(clone, { name: 'Sam Reyes' });
assert(view.cloneId === 'c-emp' && view.person === 'sam@whitfield.com', 'the employer knows whose clone it is');
assert(view.status === clone.status && view.role === 'support', 'status and role are visible — they assigned the role');
assert(view.metrics.edited === 1, 'review metrics are visible');
assert(vis.findLeaks(view).length === 0, `the clone view leaks nothing: ${vis.findLeaks(view).join(', ')}`);

// spelled out, because these are the things that must never appear
assert(view.persona === undefined, 'no persona');
assert(view.transcript === undefined && view.interview === undefined, 'no interview transcript');
assert(view.feedback === undefined, 'no feedback log — it quotes their own notes back');
assert(view.corpus === undefined, 'no corpus');
assert(!JSON.stringify(view).includes('Right then'), 'no signature phrase anywhere in the payload');
assert(!JSON.stringify(view).includes('do not soften'), 'no interview answer anywhere in the payload');
assert(!JSON.stringify(view).includes('conservative'), 'no decision style');

// --- the draft view: the whole thing, because this IS the company's correspondence
const dv = vis.employerDraftView(draft);
assert(dv.inbound === 'Is the unit safe to run?', 'the customer message is visible');
assert(dv.text.includes('seal is intact'), 'what the clone wrote is visible');
assert(dv.finalText === 'Yes, if the seal is intact.', 'what was actually sent is visible');
assert(dv.status === 'edited' && dv.note === 'too chatty', 'the verdict and the note are visible');
assert(dv.blocked === true && dv.violations.length === 1, 'red-line violations are visible');
assert(dv.cost === 0.004, 'cost is visible');
assert(vis.findLeaks(dv).length === 0, 'the draft view leaks nothing structural');

// The forbidden list must actually name the sensitive surfaces. If someone adds a persona-adjacent
// field to a clone and does not add it here, the detector goes quietly blind.
for (const k of ['persona', 'transcript', 'interview', 'corpus', 'feedback', 'prompt']) {
  assert(vis.FORBIDDEN_KEYS.includes(k), `the leak detector watches for "${k}"`);
}

// --- the leak detector itself has to work, or every assertion above is worthless
assert(vis.findLeaks({ persona: {} }).includes('persona'), 'a top-level persona is caught');
assert(vis.findLeaks({ a: { b: { transcript: [] } } }).includes('a.b.transcript'), 'a deeply nested transcript is caught');
assert(vis.findLeaks({ list: [{ ok: 1 }, { prompt: 'x' }] }).includes('list[1].prompt'), 'one inside an array is caught');
assert(vis.findLeaks({ safe: 1, nested: { alsoSafe: 'x' } }).length === 0, 'clean payloads pass');
assert(vis.findLeaks(null).length === 0 && vis.findLeaks(undefined).length === 0, 'null input does not throw');

// a raw clone record MUST trip the detector — proving the tripwire is live, not vacuous
assert(vis.findLeaks(clone).length > 0, 'the raw clone record trips the detector, so a regression that returns it would fail');
assert(vis.findLeaks(store.summarize(clone)).length === 0, 'the owner-facing summary is already clean of these keys');

// a proposal is an analysis OF the persona and quotes the person's edits — never employer-facing
const prop = evolve.createProposal({
  id: 'p1', cloneId: 'c-emp', clientId: 'sam@whitfield.com', basedOnVersion: 1,
  rationale: 'Sam cuts filler', suggestion: { set: { voice: { signoff: '- S' } } },
  proposed: clone.persona, changes: [], refused: [], evidenceCount: 3,
});
assert(vis.findLeaks(prop).length > 0, 'a persona proposal trips the detector too — it is not employer-facing');

// --- missing input
assert(vis.employerCloneView(null) === null, 'no clone, no view');
assert(vis.employerDraftView(null) === null, 'no draft, no view');
const noUser = vis.employerCloneView(clone, null);
assert(noUser.personName === '', 'a missing user record yields an empty name rather than throwing');

done();
