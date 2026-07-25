// Tests lib/business-clone/interview: dimension targeting, prompt construction, and — the part
// that actually protects the owner's data — the additive merge semantics that stop a later
// extraction from wiping what earlier answers established.
const persona = require('../lib/business-clone/persona');
const interview = require('../lib/business-clone/interview');

const { assert, done } = require('./test-util');

// --- targeting: least-complete dimension, identity-first on ties
const blank = persona.emptyPersona();
const first = interview.nextDimension(blank);
assert(first.dimension === 'identity', `an empty persona starts at identity, got ${first.dimension}`);
assert(first.missing.includes('whatTheyDo'), 'the target reports which fields are missing');

const identityDone = persona.normalize({
  identity: { ownerName: 'Mike', role: 'Founder', businessName: 'AI OS', industry: 'SaaS', whatTheyDo: 'Agentic ops', yearsExperience: 12 },
});
assert(interview.nextDimension(identityDone).dimension === 'voice', 'a satisfied dimension is skipped');

// --- seed questions map to real schema fields, and only to missing ones
const seeds = interview.seedQuestions('voice', ['signaturePhrases', 'signoff', 'notAField']);
assert(seeds.length === 2, `unknown fields yield no question, got ${seeds.length}`);
assert(seeds[0].field === 'signaturePhrases' && /catch yourself saying/.test(seeds[0].question), 'seed question is returned with its field');

// Every seed question must name a field that actually exists on the persona — a question that maps
// to no field extracts to nothing, which is the quiet way an interview wastes an owner's time.
const empty = persona.emptyPersona();
for (const [dim, bank] of Object.entries(interview.SEED_QUESTIONS)) {
  for (const field of Object.keys(bank)) {
    assert(field in empty[dim], `SEED_QUESTIONS.${dim}.${field} maps to a real persona field`);
  }
}

// --- ROLE TEMPLATES ---------------------------------------------------------
// The same guarantee has to hold for every template, or a role's interview quietly asks questions
// whose answers land nowhere.
for (const id of interview.templateIds()) {
  const t = interview.getTemplate(id);
  assert(!!t.label && !!t.description, `template "${id}" has a label and description for the picker`);
  for (const [dim, bank] of Object.entries(t.questions || {})) {
    assert(persona.DIMENSIONS.includes(dim), `template "${id}" only defines real dimensions (got ${dim})`);
    for (const field of Object.keys(bank)) {
      assert(field in empty[dim], `template "${id}" question ${dim}.${field} maps to a real persona field`);
    }
  }
  // Walk order must cover every dimension exactly once — a template that omits one would leave that
  // part of the persona permanently unasked.
  const order = interview.dimensionOrder(id);
  assert(order.length === persona.DIMENSIONS.length, `template "${id}" walk order covers every dimension`);
  assert(new Set(order).size === order.length, `template "${id}" walk order has no duplicates`);
  assert(persona.DIMENSIONS.every((d) => order.includes(d)), `template "${id}" walk order omits nothing`);
}

// GATE: a template shapes the interview, never the persona. Running a template-driven interview
// with no answers must produce a persona indistinguishable from an untouched one.
for (const id of interview.templateIds()) {
  const clone = { persona: persona.emptyPersona(), templateId: id, interview: { turns: [] } };
  const built = interview.buildAskPrompt(clone);
  assert(!!built, `template "${id}" produces a first question`);
  assert(JSON.stringify(clone.persona) === JSON.stringify(persona.emptyPersona()),
    `template "${id}" wrote nothing into the persona just by being used`);
  assert(persona.completeness(clone.persona).overall === 0, `template "${id}" leaves completeness at 0`);
}

// GATE: templates must not move the usability bar. Completeness feeds persona.isUsable, which
// decides whether a clone may speak at all — a per-role threshold would be a template lowering it.
const halfPersona = persona.normalize({ identity: { ownerName: 'X', whatTheyDo: 'Y' } });
const baseline = persona.completeness(halfPersona).overall;
for (const id of interview.templateIds()) {
  assert(interview.progress(halfPersona, id).overall === baseline,
    `template "${id}" does not change the completeness score`);
  assert(interview.progress(halfPersona, id).usable === persona.isUsable(halfPersona).usable,
    `template "${id}" does not change the usability verdict`);
}

// Template wording wins where defined; everything else falls through to the generic bank.
const salesFaq = interview.seedQuestions('expertise', ['faq'], 'sales')[0];
assert(/objections/.test(salesFaq.question), `sales overrides the FAQ question, got: ${salesFaq.question}`);
assert(salesFaq.fromTemplate === true, 'an overridden question is marked as coming from the template');

const salesCreds = interview.seedQuestions('expertise', ['credentials'], 'sales')[0];
assert(/qualifications, certifications/.test(salesCreds.question), 'a field the template does not define falls through to the generic bank');
assert(salesCreds.fromTemplate === false, 'a fallen-through question is not marked as template-sourced');

const supportFaq = interview.seedQuestions('expertise', ['faq'], 'support')[0];
assert(/complaints/.test(supportFaq.question), 'support asks about complaints, not objections');
assert(supportFaq.question !== salesFaq.question, 'two roles genuinely get different questions');

// An unknown template falls back rather than producing an empty interview.
const bogus = interview.seedQuestions('expertise', ['faq'], 'astronaut')[0];
assert(!!bogus && bogus.fromTemplate === false, 'an unknown template id falls back to the generic bank');
assert(interview.dimensionOrder('astronaut').length === persona.DIMENSIONS.length, 'an unknown template still yields a full walk order');

// Walk order actually changes which dimension is asked first.
const idDone = persona.normalize({
  identity: { ownerName: 'Dana', role: 'Owner', businessName: 'W', industry: 'D', whatTheyDo: 'Equipment', yearsExperience: 18 },
});
assert(interview.nextDimension(idDone, 'owner').dimension === 'voice', 'owner goes identity -> voice');
assert(interview.nextDimension(idDone, 'support').dimension === 'boundaries', 'support goes identity -> boundaries, because what it must not say matters before how it sounds');
assert(interview.nextDimension(idDone, 'operations').dimension === 'expertise', 'operations goes identity -> expertise');

// Default behaviour is unchanged when no template is supplied — the pre-template call signature.
assert(interview.nextDimension(idDone).dimension === 'voice', 'omitting a template behaves exactly as before');

// --- ask prompt
const clone = { persona: blank, interview: { turns: [] } };
const ask = interview.buildAskPrompt(clone);
assert(ask.dimension === 'identity' && ask.seeds.length > 0, 'ask prompt carries its dimension and seeds');
assert(/ONE question at a time/.test(ask.system), 'ask prompt forbids question lists');
assert(/this is the first question/.test(ask.task), 'empty transcript is stated rather than left blank');

const withTurns = {
  persona: blank,
  interview: { turns: [{ role: 'interviewer', text: 'What is the business called?' }, { role: 'owner', text: 'AI OS.' }] },
};
assert(/OWNER: AI OS\./.test(interview.buildAskPrompt(withTurns).task), 'prior turns are included so the model does not repeat itself');

// --- extract prompt (also proves EXTRACT_SHAPES is initialised by call time)
const ex = interview.buildExtractPrompt({ dimension: 'voice', question: 'How do you sign off?', answer: '- Mike, always.' });
assert(/transcriber, not an author/.test(ex.system), 'extract prompt frames the model as a transcriber');
assert(/Extract ONLY what the owner explicitly stated/.test(ex.system), 'anti-fabrication rule is present');
assert(/"signoff"/.test(ex.task), 'the shape hint for the dimension is included');
assert(/"voice"/.test(ex.task), 'shape hint is nested under the dimension, not flat');
const exLong = interview.buildExtractPrompt({ dimension: 'voice', question: 'q', answer: 'x'.repeat(20000) });
assert(exLong.task.length < 12000, 'a huge pasted answer is truncated before it reaches the prompt');

// --- MERGE: the safety-critical part
let p = persona.emptyPersona();

p = interview.mergePatch(p, { voice: { signaturePhrases: ['Ship it', 'Let me be blunt'], signoff: '- Mike' } });
assert(p.voice.signaturePhrases.length === 2 && p.voice.signoff === '- Mike', 'first patch applies');

// A later patch mentioning fewer items must UNION, not replace.
p = interview.mergePatch(p, { voice: { signaturePhrases: ['No fluff'] } });
assert(p.voice.signaturePhrases.length === 3, `lists union across turns, got ${JSON.stringify(p.voice.signaturePhrases)}`);
assert(p.voice.signaturePhrases[0] === 'Ship it', 'earlier entries keep their position');

// Case-insensitive dedupe, with the original casing winning.
p = interview.mergePatch(p, { voice: { signaturePhrases: ['SHIP IT'] } });
assert(p.voice.signaturePhrases.length === 3, 'duplicate in different casing is not re-added');
assert(p.voice.signaturePhrases.includes('Ship it'), 'the owner\'s original casing is preserved');

// An omitted or blank field must never blank an answered one — EXTRACT omits fields constantly.
p = interview.mergePatch(p, { voice: { signoff: '' } });
assert(p.voice.signoff === '- Mike', 'a blank value does not erase an existing answer');
p = interview.mergePatch(p, { voice: {} });
assert(p.voice.signoff === '- Mike', 'an omitted field does not erase an existing answer');
p = interview.mergePatch(p, {});
assert(p.voice.signaturePhrases.length === 3, 'an empty patch is a no-op');
p = interview.mergePatch(p, null);
assert(p.voice.signaturePhrases.length === 3, 'a null patch (failed extraction) is a no-op, not a wipe');

// Scalars DO overwrite when a real value arrives — owners correct themselves mid-interview.
p = interview.mergePatch(p, { voice: { signoff: '- M' } });
assert(p.voice.signoff === '- M', 'a real value overwrites an earlier answer');

// Object lists dedupe on their key field, not by deep equality.
p = interview.mergePatch(p, { expertise: { faq: [{ question: 'Do you do refunds?', answer: 'Within 30 days.' }] } });
p = interview.mergePatch(p, { expertise: { faq: [{ question: 'do you do REFUNDS?', answer: 'Different answer.' }] } });
assert(p.expertise.faq.length === 1, 'FAQ dedupes on the question, case-insensitively');
assert(p.expertise.faq[0].answer === 'Within 30 days.', 'the first answer wins rather than being overwritten');

p = interview.mergePatch(p, { decisionStyle: { tradeoffRules: [{ when: 'tight deadline', prefer: 'scope cut', over: 'overtime' }] } });
assert(p.decisionStyle.tradeoffRules.length === 1, 'tradeoff rules merge as objects');

// Model output goes through normalize, so caps and enums apply to it exactly as to hand input.
p = interview.mergePatch(p, { voice: { humor: 'DRY', formality: '3', directness: 99 } });
assert(p.voice.humor === 'dry' && p.voice.formality === 3, 'enums and scales are normalised on merge');
assert(p.voice.directness === null, 'an out-of-range value from the model is rejected, not stored');

p = interview.mergePatch(p, { voice: { vocabulary: Array.from({ length: 60 }, (_, i) => `w${i}`) } });
assert(p.voice.vocabulary.length === persona.CAPS.listItems, 'caps apply to model-supplied lists');

// A hallucinated field or dimension is dropped rather than stored.
p = interview.mergePatch(p, { voice: { madeUpField: 'x' }, notADimension: { y: 1 } });
assert(p.voice.madeUpField === undefined && p.notADimension === undefined, 'unknown fields and dimensions are dropped');

// Type confusion: a model returning a string where a list belongs must not corrupt the field.
const before = p.voice.signaturePhrases.length;
p = interview.mergePatch(p, { voice: { signaturePhrases: 'just one string' } });
assert(p.voice.signaturePhrases.length === before, 'a scalar sent for a list field is ignored, not coerced');

// --- completion is the same bar as activation
assert(!interview.isComplete(p), 'an incomplete persona is not complete');
const full = persona.normalize({
  identity: { ownerName: 'Mike', role: 'Founder', businessName: 'AI OS', industry: 'SaaS', whatTheyDo: 'Agentic ops', yearsExperience: 12 },
  voice: { formality: 2, directness: 5, warmth: 3, humor: 'dry', signaturePhrases: ['Ship it'], avoidPhrases: ['synergy'], signoff: '- Mike' },
  expertise: { domains: ['SEO'], methodologies: ['AEO audit'], strongOpinions: [{ claim: 'x' }], faq: [{ question: 'q', answer: 'a' }], credentials: ['12y'] },
  decisionStyle: { priorities: ['margin'], tradeoffRules: [{ when: 'w', prefer: 'p', over: 'o' }], riskPosture: 'balanced', escalationTriggers: ['legal'] },
  boundaries: { neverSay: ['guaranteed'], neverPromise: ['refund'], requiresHuman: ['dispute'], pricingDisclosure: 'ranges' },
});
assert(interview.isComplete(full), 'a full persona completes the interview');
assert(interview.buildAskPrompt({ persona: full, interview: { turns: [] } }) === null, 'no further questions once complete');
assert(persona.isUsable(full).usable, 'and a completed interview yields a usable clone');

// --- progress payload
const prog = interview.progress(p);
assert(typeof prog.overall === 'number' && prog.currentDimension, 'progress reports overall score and current dimension');
assert(interview.progress(full).currentDimension === null, 'a finished interview has no current dimension');

done();
