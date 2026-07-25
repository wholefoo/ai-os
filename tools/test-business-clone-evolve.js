// Tests lib/business-clone/evolve: evidence gathering (including the stale-feedback exclusion that
// stops the loop oscillating), the refusal to weaken boundaries, and the diff the owner reads.
const persona = require('../lib/business-clone/persona');
const evolve = require('../lib/business-clone/evolve');

const { assert, done } = require('./test-util');

const basePersona = persona.normalize({
  identity: { ownerName: 'Dana', role: 'Owner', businessName: 'Whitfield', industry: 'Dental', whatTheyDo: 'Equipment', yearsExperience: 18 },
  voice: { formality: 3, directness: 4, warmth: 4, humor: 'warm', signaturePhrases: ['Happy to sort it', 'To be honest'], avoidPhrases: ['circle back'], signoff: '— Dana' },
  expertise: { domains: ['dental equipment'], methodologies: ['survey first'], credentials: ['18 years'], strongOpinions: [{ claim: 'Cheap chairs cost more' }], faq: [{ question: 'Do you install?', answer: 'Always.' }] },
  decisionStyle: { priorities: ['trust'], tradeoffRules: [{ when: 'delay', prefer: 'telling early', over: 'waiting' }], riskPosture: 'conservative', escalationTriggers: ['legal'] },
  boundaries: { neverSay: ['lowest price anywhere'], neverPromise: ['next-day delivery'], requiresHuman: ['contract dispute'], confidentialTopics: ['supplier margins'], pricingDisclosure: 'ranges' },
});

const clone = { id: 'c1', persona: basePersona, personaVersion: 4 };
const draft = (o) => ({ cloneId: 'c1', status: 'edited', personaVersion: 4, reviewedAt: '2026-07-24T10:00:00Z', inbound: 'q', text: 'original', finalText: 'final', note: '', channel: 'email', ...o });

// --- evidence gathering
const empty = evolve.gatherEvidence(clone, []);
assert(empty.count === 0 && !empty.enough, 'no drafts means no evidence');

const two = evolve.gatherEvidence(clone, [draft({ id: 'd1' }), draft({ id: 'd2' })]);
assert(two.count === 2 && !two.enough, `two edits is below the ${evolve.MIN_EVIDENCE} bar — one edit is a mood, three is a pattern`);

const three = evolve.gatherEvidence(clone, [draft({ id: 'd1' }), draft({ id: 'd2' }), draft({ id: 'd3' })]);
assert(three.enough, 'three reviewed drafts is enough to propose');

// pending drafts and approvals are not evidence — nothing was corrected
const mixed = evolve.gatherEvidence(clone, [
  draft({ id: 'd1' }), draft({ id: 'd2', status: 'rejected' }),
  draft({ id: 'd3', status: 'pending' }), draft({ id: 'd4', status: 'approved' }),
]);
assert(mixed.count === 2, `only edited and rejected drafts count, got ${mixed.count}`);
assert(mixed.edits === 1 && mixed.rejections === 1, 'edits and rejections are counted separately');

// THE oscillation guard: feedback about a persona that has since changed must not count
const stale = evolve.gatherEvidence(clone, [
  draft({ id: 'd1' }), draft({ id: 'd2' }), draft({ id: 'd3' }),
  draft({ id: 'd4', personaVersion: 3 }), draft({ id: 'd5', personaVersion: 2 }),
]);
assert(stale.count === 3, `drafts from earlier persona versions are excluded, got ${stale.count}`);

// another clone's drafts are never evidence
assert(evolve.gatherEvidence(clone, [draft({ id: 'x', cloneId: 'other' })]).count === 0, 'another clone\'s drafts are ignored');

// newest first, and capped
const many = Array.from({ length: 20 }, (_, i) => draft({ id: `d${i}`, reviewedAt: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z` }));
const capped = evolve.gatherEvidence(clone, many);
assert(capped.count === evolve.MAX_EVIDENCE_ITEMS, `evidence is capped at ${evolve.MAX_EVIDENCE_ITEMS}, got ${capped.count}`);
assert(capped.items[0].draftId === 'd19', 'the most recent review comes first');

// --- prompt
const prompt = evolve.buildProposalPrompt(clone);
assert(/gap between what was drafted and what the owner actually sent/.test(prompt.system), 'the prompt names the edit gap as the evidence');
assert(/WEAKENS them/.test(prompt.system), 'the prompt forbids weakening boundaries');
assert(/return empty "set" and "remove"/.test(prompt.system), '"no clear pattern" is offered as a valid answer');
assert(/"rationale"/.test(prompt.task) && /"remove"/.test(prompt.task), 'the response shape includes rationale and removals');

const blocks = evolve.evidenceBlocks(three);
assert(blocks.length === 3 && /Owner actually sent/.test(blocks[0].text), 'evidence blocks carry the owner\'s rewrite');
assert(/Reviewed draft 1 \(edited\)/.test(blocks[0].label), 'blocks are labelled with the verdict');
const rejBlocks = evolve.evidenceBlocks(evolve.gatherEvidence(clone, [draft({ id: 'r1', status: 'rejected' })]));
assert(/Owner rejected it\./.test(rejBlocks[0].text), 'a rejection says so rather than showing an empty rewrite');

// --- computeProposed: sets
const setOnly = evolve.computeProposed(basePersona, { set: { voice: { signoff: '— D', signaturePhrases: ['Let me check'] } } });
assert(setOnly.proposed.voice.signoff === '— D', 'a scalar set is applied');
assert(setOnly.proposed.voice.signaturePhrases.length === 3, 'a list set unions rather than replacing');
assert(setOnly.proposed.voice.signaturePhrases.includes('Happy to sort it'), 'existing entries survive a set');

const blankSet = evolve.computeProposed(basePersona, { set: { voice: { signoff: '' } } });
assert(blankSet.proposed.voice.signoff === '— Dana', 'a blank set does not erase an existing value');

// --- computeProposed: removals are the point of the feature
const removed = evolve.computeProposed(basePersona, { remove: [{ dimension: 'voice', field: 'signaturePhrases', value: 'To be honest' }] });
assert(removed.proposed.voice.signaturePhrases.length === 1, 'a phrase can be removed');
assert(!removed.proposed.voice.signaturePhrases.includes('To be honest'), 'the named phrase is gone');
assert(removed.proposed.voice.signaturePhrases.includes('Happy to sort it'), 'the others are untouched');

const removedCase = evolve.computeProposed(basePersona, { remove: [{ dimension: 'voice', field: 'signaturePhrases', value: 'to BE honest' }] });
assert(removedCase.proposed.voice.signaturePhrases.length === 1, 'removal matches case-insensitively');

const removeObj = evolve.computeProposed(basePersona, { remove: [{ dimension: 'expertise', field: 'faq', value: 'Do you install?' }] });
assert(removeObj.proposed.expertise.faq.length === 0, 'object-list entries are removable by their key field');

// --- boundaries cannot be weakened, and the refusal is reported
for (const field of ['neverSay', 'neverPromise', 'requiresHuman', 'confidentialTopics']) {
  const attempt = evolve.computeProposed(basePersona, { remove: [{ dimension: 'boundaries', field, value: basePersona.boundaries[field][0] }] });
  assert(attempt.proposed.boundaries[field].length === 1, `${field} cannot be emptied by a proposal`);
  assert(attempt.refused.length === 1 && attempt.refused[0].field === field, `the refusal to weaken ${field} is reported to the owner`);
}

// SCALAR boundary fields are protected too. This is the case a live run caught that the original
// guard missed: it enumerated four LIST fields, so a removal of pricingDisclosure blanked the
// owner's pricing policy — leaving the clone with no pricing instruction at all, which is looser
// than what they set.
const blankPricing = evolve.computeProposed(basePersona, { remove: [{ dimension: 'boundaries', field: 'pricingDisclosure' }] });
assert(blankPricing.proposed.boundaries.pricingDisclosure === 'ranges', 'pricingDisclosure cannot be blanked by a removal');
assert(blankPricing.refused.length === 1, 'and the attempt is reported');

const blankPolicy = evolve.computeProposed(basePersona, { remove: [{ dimension: 'boundaries', field: 'competitorPolicy' }] });
assert(blankPolicy.refused.length === 1, 'every boundary field is protected, not an enumerated subset');

// The same weakening can arrive as a SET rather than a removal — the other door into the same hole.
const loosen = evolve.computeProposed(basePersona, { set: { boundaries: { pricingDisclosure: 'full' } } });
assert(loosen.proposed.boundaries.pricingDisclosure === 'ranges', 'pricing cannot be loosened by a set');
assert(loosen.refused.some((r) => r.field === 'pricingDisclosure'), 'the attempted loosening is reported');

// Tightening in the same direction IS allowed — the rule is one-way, not frozen.
const tightenPricing = evolve.computeProposed(basePersona, { set: { boundaries: { pricingDisclosure: 'none' } } });
assert(tightenPricing.proposed.boundaries.pricingDisclosure === 'none', 'pricing may be tightened');
assert(tightenPricing.refused.length === 0, 'tightening is not refused');

const bogusPricing = evolve.computeProposed(basePersona, { set: { boundaries: { pricingDisclosure: 'whatever' } } });
assert(bogusPricing.proposed.boundaries.pricingDisclosure === 'ranges', 'an unrecognised pricing value is refused rather than stored');

// tightening a boundary IS allowed — the restriction is one-way
const tighten = evolve.computeProposed(basePersona, { set: { boundaries: { neverSay: ['cheapest in town'] } } });
assert(tighten.proposed.boundaries.neverSay.length === 2, 'a proposal may ADD a red line');
assert(tighten.refused.length === 0, 'adding a limit is not refused');

// removals from non-boundary dimensions are unaffected by the guard
const okRemove = evolve.computeProposed(basePersona, { remove: [{ dimension: 'decisionStyle', field: 'escalationTriggers', value: 'legal' }] });
assert(okRemove.proposed.decisionStyle.escalationTriggers.length === 0, 'non-boundary removals still work');

// --- garbage in
assert(evolve.computeProposed(basePersona, null).proposed.voice.signoff === '— Dana', 'a null suggestion is a no-op');
assert(evolve.computeProposed(basePersona, { set: { notADimension: { x: 1 } }, remove: [{ dimension: 'nope', field: 'x' }] }).proposed.identity.ownerName === 'Dana', 'unknown dimensions are ignored');
assert(evolve.computeProposed(basePersona, { set: { voice: { madeUp: 'x' } } }).proposed.voice.madeUp === undefined, 'unknown fields are dropped');

// --- the diff the owner reads
const { proposed } = evolve.computeProposed(basePersona, {
  set: { voice: { signoff: '— D' }, boundaries: { neverSay: ['cheapest in town'] } },
  remove: [{ dimension: 'voice', field: 'signaturePhrases', value: 'To be honest' }],
});
const changes = evolve.diffPersona(basePersona, proposed);
assert(changes.length === 3, `every change is listed, got ${changes.length}: ${JSON.stringify(changes.map(c => c.field))}`);

const signoffChange = changes.find((c) => c.field === 'signoff');
assert(signoffChange.kind === 'value' && signoffChange.from === '— Dana' && signoffChange.to === '— D', 'a value change shows both sides verbatim');

const phraseChange = changes.find((c) => c.field === 'signaturePhrases');
assert(phraseChange.kind === 'list' && phraseChange.removed.includes('To be honest') && phraseChange.added.length === 0, 'a list change separates additions from removals');

const redlineChange = changes.find((c) => c.field === 'neverSay');
assert(redlineChange.added.includes('cheapest in town'), 'an added red line shows as an addition');

assert(evolve.diffPersona(basePersona, basePersona).length === 0, 'an unchanged persona diffs to nothing');

// --- proposal records + scoping
const props = [];
const p1 = evolve.createProposal({ id: 'p1', cloneId: 'c1', clientId: 'dana@x.com', basedOnVersion: 4, rationale: 'because', suggestion: {}, proposed, changes, refused: [], evidenceCount: 3 });
props.push(p1);
assert(p1.status === 'pending' && p1.decidedAt === null, 'a new proposal is pending and undecided');
assert(evolve.hasPending(props, 'c1'), 'an open proposal is detected');
assert(!evolve.hasPending(props, 'c2'), 'another clone has no open proposal');

p1.status = 'accepted';
assert(!evolve.hasPending(props, 'c1'), 'a decided proposal is no longer pending');

props.push(evolve.createProposal({ id: 'p9', cloneId: 'c9', clientId: 'someone@else.com', basedOnVersion: 1, rationale: '', suggestion: {}, proposed, changes: [], refused: [], evidenceCount: 3 }));
assert(evolve.listProposals(props, 'dana@x.com').length === 1, 'proposals are client-scoped');
assert(evolve.getProposal(props, 'dana@x.com', 'p9') === null, 'another client\'s proposal is a miss, not a read');
assert(evolve.getProposal(props, 'dana@x.com', 'p1').id === 'p1', 'own proposal is retrievable');

done();
