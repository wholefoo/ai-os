// Tests lib/business-clone/compile: determinism, lossy-on-purpose omission, correct scale
// rendering, and that the boundaries block lands last and intact.
const persona = require('../lib/business-clone/persona');
const compile = require('../lib/business-clone/compile');

const { assert, done } = require('./test-util');

const full = persona.normalize({
  identity: { ownerName: 'Mike', role: 'Founder', businessName: 'AI OS', industry: 'SaaS', whatTheyDo: 'Agentic ops platform for small teams', yearsExperience: 12 },
  voice: { formality: 2, directness: 5, warmth: 3, humor: 'dry', sentenceLength: 'short', signaturePhrases: ['Ship it'], avoidPhrases: ['synergy'], vocabulary: ['orchestration'], greeting: 'Hi —', signoff: '- Mike' },
  expertise: {
    domains: ['SEO', 'automation'], methodologies: ['AEO audit'], credentials: ['12 years'],
    strongOpinions: [{ claim: 'Most SEO advice is noise', rationale: 'It optimises for crawlers, not buyers' }],
    faq: [{ question: 'Do you do refunds?', answer: 'Within 30 days, no argument.' }],
  },
  decisionStyle: {
    priorities: ['margin', 'reputation'],
    tradeoffRules: [{ when: 'a deadline is tight', prefer: 'cutting scope', over: 'overtime' }],
    riskPosture: 'balanced', escalationTriggers: ['legal threat'],
  },
  boundaries: {
    neverSay: ['guaranteed rankings'], neverPromise: ['a refund'], requiresHuman: ['contract disputes'],
    confidentialTopics: ['client names'], pricingDisclosure: 'ranges', competitorPolicy: 'Never name them.',
  },
});

// --- determinism: this underpins diffing, fingerprinting, and traceability
const a = compile.compile(full);
const b = compile.compile(full);
assert(a === b, 'the same persona compiles byte-identically');
assert(compile.compile(JSON.parse(JSON.stringify(full))) === a, 'a structurally-equal persona compiles identically');
assert(compile.fingerprint(full) === compile.fingerprint(full), 'fingerprint is stable');
assert(/^[0-9a-f]{12}$/.test(compile.fingerprint(full)), 'fingerprint is a short hex digest');

const tweaked = persona.normalize({ ...full, voice: { ...full.voice, signoff: '- M' } });
assert(compile.fingerprint(tweaked) !== compile.fingerprint(full), 'a persona change changes the fingerprint');

// --- framing
assert(/You are drafting as Mike/.test(a), 'the header names the owner');
assert(/reviewed by Mike before it goes anywhere/.test(a), 'the draft-only frame is stated, so the model does not hedge defensively');

// --- content actually lands
assert(/Agentic ops platform for small teams/.test(a), 'what the business does is included verbatim');
assert(/Ship it/.test(a), 'signature phrases are included');
assert(/synergy/.test(a), 'avoid-phrases are included');
assert(/Do you do refunds\?/.test(a) && /Within 30 days, no argument\./.test(a), 'FAQ carries both question and the owner\'s real answer');
assert(/Most SEO advice is noise — It optimises for crawlers, not buyers/.test(a), 'opinion renders with its rationale');
assert(/1\. margin/.test(a) && /2\. reputation/.test(a), 'priorities are numbered, preserving the order that carries the signal');
assert(/When a deadline is tight: choose cutting scope over overtime\./.test(a), 'tradeoff rules render as readable rules');

// --- scales render as words, at the right index (an off-by-one here is a silent voice bug)
assert(/Blunt\. Lead with the conclusion/.test(a), 'directness 5 renders as the blunt guidance');
assert(/Casual and relaxed/.test(a), 'formality 2 renders as the casual guidance');
assert(/Professionally friendly/.test(a), 'warmth 3 renders as the middle guidance');
assert(!/\b[1-5]\/5\b/.test(a), 'no raw n/5 scale values leak into the prompt');
assert(!/formality|directness:|warmth:/i.test(a), 'scale field names never appear — they are rendered as behaviour, not as labelled numbers');

const low = compile.compile(persona.normalize({ voice: { formality: 1, directness: 1, warmth: 1 } }));
assert(/Very casual/.test(low) && /Diplomatic and indirect/.test(low) && /Clinical and impersonal/.test(low), 'scale index 1 maps to the first guidance, not the second');

// --- boundaries land last and intact
const idx = a.indexOf('## Hard limits');
assert(idx > 0, 'the boundaries block is present');
assert(idx > a.indexOf('## How you write'), 'boundaries come after voice');
assert(idx > a.indexOf('## What you are expert in'), 'boundaries come after expertise');
const tail = a.slice(idx);
assert(/guaranteed rankings/.test(tail), 'neverSay entries are in the boundaries block');
assert(/contract disputes/.test(tail), 'requiresHuman entries are in the boundaries block');
assert(/client names/.test(tail), 'confidential topics are in the boundaries block');
assert(/broad pricing ranges/.test(tail), 'pricing policy renders as guidance, not as an enum value');
assert(/Never name them\./.test(tail), 'competitor policy is included');
assert(/rather than inventing an answer/.test(tail), 'the anti-fabrication instruction is always present');

// --- lossy on purpose: nothing empty, nothing leaked
const bare = compile.compile(persona.emptyPersona());
assert(!/undefined|null|NaN|\[object Object\]/.test(bare), 'an empty persona leaks no placeholder junk');
assert(!/unknown|n\/a/i.test(bare), 'unset fields are omitted rather than described as unknown');
assert(!/\n\n\n/.test(bare), 'omitted sections do not leave blank-line gaps');
assert(!/\n\n\n/.test(a), 'a full persona also has no blank-line gaps');
assert(/drafting as the owner/.test(bare), 'a nameless persona still gets a sensible frame');
assert(bare.length < a.length, 'an empty persona compiles to something much shorter');
assert(/Hard limits/.test(bare), 'the anti-fabrication limit survives even with no boundaries set');

// partial personas must not emit their empty neighbours
const partial = compile.compile(persona.normalize({ identity: { ownerName: 'Dana' }, voice: { signoff: '- D' } }));
assert(/Sign off with: - D/.test(partial), 'a set field renders');
assert(!/Open with:/.test(partial), 'an unset sibling field is omitted entirely');
assert(!/What you are expert in/.test(partial), 'an entirely-empty dimension emits no heading');

// --- cost visibility
const tokens = compile.estimateTokens(full);
assert(tokens > 100 && tokens < 4000, `token estimate is in a sane range for a full persona, got ${tokens}`);
assert(compile.estimateTokens(persona.emptyPersona()) < tokens, 'an empty persona estimates cheaper');

done();
