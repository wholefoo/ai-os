// Tests lib/library/contribute: the leak refusal, the allowlist, and the narrow default.
//
// This is the highest-blast-radius path in the department — a clone publishing persona-derived
// material into a library EVERY agent reads would leak a named person's psychological profile
// platform-wide. §2 of the design doc calls that out as the failure mode if this is skipped, so
// these assertions are the phase's reason for existing, not its paperwork.
//
// The operator-override allowlist is tested here too: it is the other half of the same boundary.
// A contribution that only its author can read is worthless if an admin route reads past `readers`.
const catalog = require('../lib/library/catalog');
const readers = require('../lib/library/readers');
const contribute = require('../lib/library/contribute');
const documents = require('../lib/org/documents');
const { assert, done } = require('./test-util');

const H = 'a'.repeat(64);
const base = {
  id: 'c1', kind: 'personnel', contributor: 'sam@example.com',
  title: 'Handover notes', text: 'How we run the Tuesday review.', contentHash: H,
};

// --- the happy path defaults NARROW -------------------------------------------------------------
const ok = contribute.planContribution(base);
assert(ok.ok, 'a clean personnel contribution is accepted');
assert(ok.record.source === 'personnel-contribution', 'and is sourced as a personnel contribution');
assert(ok.record.readers.join() === 'sam@example.com',
  'with the contributor as the ONLY reader — absent named principals, a contribution nobody else can read is a recoverable mistake; one everybody can read is not');
assert(ok.record.sensitivity === 'confidential', 'and confidential, not internal — it is somebody\'s until they say otherwise');
assert(ok.record.store === 'org-docs' && ok.record.path === '',
  'bytes are addressed by record id, so the contributor\'s filename never reaches a path');
assert(ok.record.personaDerived === false, 'the always-false invariant holds');

// --- no input produces a broad grant ------------------------------------------------------------
for (const attempt of [
  { principals: [readers.ALL_AGENTS] },
  { principals: [readers.ALL_OPERATORS] },
  { principals: ['ALL-AGENTS'] },
  { principals: [' all-agents '] },
  { access: { allAgents: true } },
  { allAgents: true },
  { readers: [readers.ALL_AGENTS] },
]) {
  const r = contribute.planContribution({ ...base, ...attempt });
  assert(r.ok, `input ${JSON.stringify(attempt).slice(0, 40)} is accepted`);
  assert(!r.record.readers.includes(readers.ALL_AGENTS) && !r.record.readers.includes(readers.ALL_OPERATORS),
    `...and CANNOT produce a broad grant — no input to this module reaches a sentinel`);
}

const named = contribute.planContribution({ ...base, principals: ['lee@example.com', 'kim@example.com'] });
assert(named.record.readers.length === 3, 'named principals are added to the allowlist');
assert(named.record.readers.includes('lee@example.com'), 'by name');

// --- Rule 1: every FORBIDDEN_KEY is refused, WITH the path named --------------------------------
const FORBIDDEN = ['persona', 'prompt', 'compiledPersona', 'transcript', 'interview', 'corpus',
  'feedback', 'suggestion', 'proposed'];
for (const key of FORBIDDEN) {
  const r = contribute.planContribution({ ...base, [key]: { anything: true } });
  assert(r.ok === false, `a top-level "${key}" is refused`);
  assert(Array.isArray(r.leaks) && r.leaks.includes(key),
    `...and the refusal NAMES ${key} — surfaced, not silently dropped, or the only way to publish is guesswork`);
}

// Nested, because the tripwire walks the whole payload and a caller will nest before they give up.
const nested = contribute.planContribution({ ...base, meta: { author: { persona: { voice: {} } } } });
assert(nested.ok === false && nested.leaks.includes('meta.author.persona'),
  'a deeply nested forbidden key is found and reported with its full path');

const inArray = contribute.planContribution({ ...base, items: [{ ok: 1 }, { transcript: 'x' }] });
assert(inArray.ok === false && inArray.leaks.some((l) => l.includes('transcript')),
  'a forbidden key inside an array is found');

const handSet = contribute.planContribution({ ...base, personaDerived: true });
assert(handSet.ok === false && handSet.leaks.includes('personaDerived'),
  'a hand-set personaDerived:true is caught by the same refusal path, not by a throw');

// The refusal must run BEFORE validation, or an invalid-but-leaking payload reports the wrong problem
// and the contributor strips the wrong thing.
const both = contribute.planContribution({ kind: 'nonsense', persona: {} });
assert(both.ok === false && Array.isArray(both.leaks) && both.leaks.includes('persona'),
  'when a payload is BOTH invalid and leaking, the leak is what gets reported — it is the one that matters');

// --- clean prose is NOT refused, and the honest limit of the guard ------------------------------
const prose = contribute.planContribution({ ...base, text: 'My persona is friendly and I prefer short prompts.' });
assert(prose.ok === true,
  'prose merely CONTAINING the words persona/prompt is accepted — findPersonaLeaks is a structural guard over object KEYS, not a content classifier, and pretending otherwise would block ordinary writing while catching nothing more');

// --- kind + required fields ---------------------------------------------------------------------
assert(contribute.planContribution({ ...base, kind: 'clone', cloneId: 'clone-1' }).record.source === 'clone-contribution',
  'a clone contribution is sourced distinctly from a personnel one');
assert(contribute.planContribution({ ...base, kind: 'clone' }).ok === false,
  'a clone contribution must name its clone');
assert(contribute.planContribution({ ...base, kind: 'agent' }).ok === false,
  'an unrecognised kind is refused — it would otherwise normalise to agent-output, which is exactly the source class the operator override CAN read');
for (const [field, bad] of [['contributor', ''], ['title', '   '], ['text', ''], ['contentHash', 'nope']]) {
  assert(contribute.planContribution({ ...base, [field]: bad }).ok === false, `a missing/invalid ${field} is refused`);
}
assert(contribute.planContribution({ ...base, text: 'x'.repeat(documents.MAX_TEXT_CHARS + 1) }).ok === false,
  'an oversized contribution is refused at one shared ceiling');

// --- the other half of the boundary: the operator override ---------------------------------------
const contributed = ok.record;
const companyDoc = catalog.normalizeRecord({ title: 'Pricing', store: 'org-docs', contentHash: H, source: 'company-doc' });
const fact = catalog.normalizeRecord({ title: 'Model count', source: 'canonical-fact', value: '6', store: 'vault', path: 'canonical/x', contentHash: H });

assert(readers.operatorMayOverride(companyDoc) === true, 'the operator override reaches the instance\'s own company docs');
assert(readers.operatorMayOverride(fact) === true, '...and the canonical-facts shelf');
assert(readers.operatorMayOverride(contributed) === false,
  '...and STOPS at a personnel contribution — otherwise the narrow reader set is decorative');
assert(readers.operatorMayOverride(catalog.normalizeRecord({ ...contributed, source: 'clone-contribution' })) === false,
  '...and at a clone contribution');
assert(readers.operatorMayOverride(null) === false, 'and fails closed on a missing record');

// The allowlist shape is the point: a source nobody has invented yet must NOT be overridable.
assert(!readers.OPERATOR_OVERRIDABLE_SOURCES.includes('clone-contribution')
  && !readers.OPERATOR_OVERRIDABLE_SOURCES.includes('personnel-contribution'),
  'neither contribution source is on the override allowlist');
assert(readers.operatorMayOverride({ source: 'some-future-source' }) === false,
  'a source added later is NOT overridable by default — an allowlist denies on omission, where a list of exclusions would have disclosed');

// --- an operator still cannot read one via the ordinary path -------------------------------------
assert(readers.canRead(contributed, { kind: 'operator', id: 'operator@example.com' }) === false,
  'an operator is not on the reader list, so canRead refuses them too');
assert(readers.canRead(contributed, { kind: 'agent', id: 'researcher' }) === false,
  'and no agent can read it — there is no all-agents grant to inherit');
assert(readers.canRead(contributed, { kind: 'person', id: 'sam@example.com' }) === true,
  'the contributor can read their own contribution');

done();
