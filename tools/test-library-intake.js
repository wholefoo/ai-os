// Tests lib/library/intake: the three-way duplicate / version / new decision, the version chain,
// and the metadata patch. All PURE — planIntake writes nothing, which is the point of the module
// living outside the route (see its header, and rev-5 lesson #5 on paths.js).
//
// The definition of done for P1, restated as assertions: uploading a document produces a cataloged
// record whose bytes are addressed by id and never by filename; re-uploading identical bytes is
// recognised as a duplicate; a changed file creates a new version linked to its predecessor.
const catalog = require('../lib/library/catalog');
const readers = require('../lib/library/readers');
const intake = require('../lib/library/intake');
const { assert, done } = require('./test-util');

const H = (c) => String(c).repeat(64).slice(0, 64);
const HASH_A = H('a');
const HASH_B = H('b');
const HASH_C = H('c');

const base = {
  id: 'rec-1',
  title: 'Company Overview.md',
  contentHash: HASH_A,
  format: 'md',
  bytes: 4427,
  addedBy: 'owner@example.com',
  addedAt: '2026-07-01T00:00:00.000Z',
};

// --- A first upload into an empty catalog -------------------------------------------------------
const first = intake.planIntake([], base);
assert(first.ok && first.action === 'new', 'an unseen document in an empty catalog is NEW');
assert(first.supersedes === null && first.record.supersedes === null, 'a first version supersedes nothing');
assert(first.record.store === 'org-docs', 'uploads land in org-docs — flat and uuid-named, so no filename ever reaches a path');
assert(first.record.path === '', 'the record carries NO path: bytes are addressed by the record id, and a second copy of that location could disagree with it');
assert(first.record.title === 'Company Overview.md', 'the filename survives as a label');
assert(first.record.source === 'company-doc',
  'an operator upload is sourced as company-doc — there is no "upload" member in the enum, and an invented one would NOT throw: normalizeRecord falls back to agent-output, silently relabelling every document a person uploads as something an agent produced');
assert(catalog.VALID_SOURCES.includes(first.record.source), 'and whatever it is, it is a real member of the enum');
assert(first.record.contentHash === HASH_A, 'the hash of the ORIGINAL BYTES is the identity, not a hash of the extracted text');

// --- Access is built as an allowlist, entry by entry --------------------------------------------
assert(first.record.readers.includes('owner@example.com'), 'the uploader is on the allowlist');
assert(!first.record.readers.includes(readers.ALL_AGENTS), 'and no broad grant appears without being asked for — a denylist would leak the day a field is added');
const shared = intake.planIntake([], { ...base, access: { allAgents: true, principals: ['sam@example.com'] } });
assert(shared.record.readers.includes(readers.ALL_AGENTS) && shared.record.readers.includes('sam@example.com'),
  'an explicit allAgents flag plus named principals both land');
const smuggled = intake.planIntake([], { ...base, access: { principals: [readers.ALL_AGENTS] } });
assert(!smuggled.record.readers.includes(readers.ALL_AGENTS),
  'the sentinel CANNOT arrive through a principals list — a broad grant must go through its own flag, so it is visible at the call site that makes it');

// --- Identical bytes are a duplicate, whatever they are called ----------------------------------
const catalogue = [first.record];
const same = intake.planIntake(catalogue, { ...base, id: 'rec-2' });
assert(same.action === 'duplicate', 're-uploading unchanged bytes is a DUPLICATE, not a second record');
assert(same.record === null, 'a duplicate mints no record');
assert(same.existing.id === 'rec-1', 'and hands back the record that already holds those bytes');

const renamed = intake.planIntake(catalogue, { ...base, id: 'rec-3', title: 'Overview FINAL v2.md' });
assert(renamed.action === 'duplicate',
  'the SAME BYTES under a different name are still a duplicate — filenames lie on copies, the hash is the only honest identity');

// --- Changed bytes under the same title are the next version ------------------------------------
const v2 = intake.planIntake(catalogue, { ...base, id: 'rec-4', contentHash: HASH_B });
assert(v2.action === 'version', 'same title, different bytes is a VERSION');
assert(v2.supersedes === 'rec-1' && v2.record.supersedes === 'rec-1', 'and it points at its predecessor');
assert(v2.record.id === 'rec-4', 'the new version is a new record, not an edit of the old one — history is append-only');

// --- A third version chains to the HEAD, not back to the first ----------------------------------
const withV2 = [first.record, v2.record];
const v3 = intake.planIntake(withV2, { ...base, id: 'rec-5', contentHash: HASH_C });
assert(v3.supersedes === 'rec-4',
  'v3 supersedes v2, NOT v1 — anchoring on any record with the title instead of the chain head would fork the history into a tree');

const chain = intake.versionChain([first.record, v2.record, v3.record], 'rec-5');
assert(chain.map((r) => r.id).join(',') === 'rec-5,rec-4,rec-1', 'the chain walks newest to oldest');
assert(intake.chainHead([first.record, v2.record, v3.record], 'org-docs', base.title).id === 'rec-5',
  'the head is the record nobody supersedes');

// A cycle written by a bad import must not hang the walk.
const cyclic = [
  catalog.normalizeRecord({ id: 'x', title: 't', store: 'org-docs', contentHash: HASH_A, supersedes: 'y' }),
  catalog.normalizeRecord({ id: 'y', title: 't', store: 'org-docs', contentHash: HASH_B, supersedes: 'x' }),
];
assert(intake.versionChain(cyclic, 'x').length === 2, 'a cyclic supersedes chain terminates instead of looping forever');

// --- Titles are compared case- and whitespace-insensitively -------------------------------------
const loose = intake.planIntake(catalogue, { ...base, id: 'rec-6', title: '  company overview.MD  ', contentHash: HASH_B });
assert(loose.action === 'version' && loose.supersedes === 'rec-1',
  'a retyped filename differing only in case or padding is the same logical document, not a new one');

// --- An empty or malformed hash is refused, never defaulted -------------------------------------
for (const bad of ['', '   ', 'not-a-hash', H('a').slice(0, 63), `${H('a')}0`, 'g'.repeat(64)]) {
  const r = intake.planIntake(catalogue, { ...base, contentHash: bad });
  assert(r.ok === false, `a contentHash of ${JSON.stringify(String(bad).slice(0, 12))} is refused`);
}
// Uppercase hex is a VALID sha256, not a malformed one — casefolded, not rejected. Rejecting it
// would make the same bytes hash to two different identities depending on which tool printed them.
const upper = intake.planIntake([], { ...base, contentHash: 'A'.repeat(64) });
assert(upper.ok && upper.record.contentHash === 'a'.repeat(64), 'an uppercase hash is accepted and normalized to lowercase');
assert(intake.planIntake([], { ...base, title: '   ' }).ok === false, 'a blank title is refused');

// The reason the above matters, asserted directly: two DIFFERENT documents that both arrived with an
// empty hash must never be able to collapse into one another. This is rev-5 defect #3's shape.
const blanks = [
  intake.planIntake([], { ...base, id: 'b1', title: 'One.md', contentHash: '' }),
  intake.planIntake([], { ...base, id: 'b2', title: 'Two.md', contentHash: '' }),
];
assert(blanks.every((r) => r.ok === false),
  'neither of two hashless uploads is accepted — with an empty identity the second would have been reported as a duplicate of the first and silently discarded');

// --- personaDerived stays false over whole payloads ---------------------------------------------
const persona = intake.planIntake([], { ...base, personaDerived: true });
assert(persona.ok === false && /personaDerived/.test(persona.error),
  'a payload asserting personaDerived:true is REFUSED BY NAME at the request boundary — intake builds an explicit field list, so without this check the flag would be silently dropped and the caller would believe the record was marked');
assert(intake.planRegister([], { store: 'vault', path: 'wiki/x.md', contentHash: HASH_A, personaDerived: true }).ok === false,
  'and register refuses it too — one boundary check per entry point, not one for the entrance everyone remembers');
assert(intake.planIntake([], base).record.personaDerived === false, 'every minted record carries the always-false invariant');
let threw = false;
try { catalog.normalizeRecord({ personaDerived: true }); } catch { threw = true; }
assert(threw, 'normalizeRecord still THROWS on it — the boundary returns 400-shaped errors, the invariant beneath stays a programmer-error throw for any caller that bypasses intake');

// The register source is validated, not defaulted, for the same reason as UPLOAD_SOURCE above.
assert(intake.planRegister([], { store: 'vault', path: 'wiki/x.md', contentHash: HASH_A, source: 'made-up' }).ok === false,
  'an unknown source is refused rather than silently becoming agent-output');
assert(intake.planRegister([], { store: 'vault', path: 'wiki/x.md', contentHash: HASH_A, source: 'canonical-fact' }).ok === true,
  'a real member of the enum passes');

// --- register-in-place --------------------------------------------------------------------------
const reg = intake.planRegister([], {
  id: 'reg-1', store: 'artifacts', path: 'research/brief.md', contentHash: HASH_A,
  addedBy: 'owner@example.com', format: 'md', bytes: 120,
});
assert(reg.ok && reg.action === 'new', 'a file already in a store can be cataloged in place');
assert(reg.record.path === 'research/brief.md', 'and it keeps its real path — nothing moves');
assert(reg.record.store === 'artifacts', 'in the store it already lives in');

const regAgain = intake.planRegister([reg.record], {
  id: 'reg-2', store: 'artifacts', path: 'research/brief.md', contentHash: HASH_A, addedBy: 'owner@example.com',
});
assert(regAgain.action === 'duplicate',
  're-registering the same store+path+bytes is a no-op — this must agree with library-migrate.js, or a hand-registered file becomes two records on the next sweep');

assert(intake.planRegister([], { store: 'nope', path: 'a', contentHash: HASH_A }).ok === false, 'an unknown store is refused');
assert(intake.planRegister([], { store: 'vault', path: '', contentHash: HASH_A }).ok === false, 'a blank path is refused');

// --- applyPatch: curate metadata, never identity ------------------------------------------------
const target = v3.record;
const patched = intake.applyPatch(target, {
  title: 'Company Overview (2026)', tags: ['canon', 'pricing'], sensitivity: 'confidential',
  store: 'vault', contentHash: HASH_A, supersedes: 'rec-1', id: 'hijacked', path: '../../etc/passwd',
});
assert(patched.ok, 'a metadata patch applies');
assert(patched.record.title === 'Company Overview (2026)' && patched.record.sensitivity === 'confidential', 'curated fields change');
assert(patched.record.tags.join(',') === 'canon,pricing', 'tags are replaced wholesale');
assert(patched.record.id === target.id, 'the id is NOT editable');
assert(patched.record.store === target.store && patched.record.path === target.path, 'store and path are NOT editable — a patched path is path traversal with extra steps');
assert(patched.record.contentHash === target.contentHash, 'the contentHash is NOT editable — it is the dedupe key');
assert(patched.record.supersedes === target.supersedes, 'the version pointer is NOT editable — rewriting history by hand is how a chain silently forks');

const reopened = intake.applyPatch(target, { readers: ['sam@example.com', readers.ALL_AGENTS] });
assert(reopened.record.readers.includes('sam@example.com'), 'a patch can name new readers');
assert(!reopened.record.readers.includes(readers.ALL_AGENTS),
  'but CANNOT smuggle the all-agents sentinel through the readers array — the one place a raw list reaches the catalog');
assert(intake.applyPatch(target, { access: { allAgents: true } }).record.readers.includes(readers.ALL_AGENTS),
  'the broad grant is available, through its explicit flag only');

const held = intake.applyPatch(catalog.normalizeRecord({ ...target, legalHold: true }), { legalHold: false });
assert(held.record.legalHold === true,
  'legalHold is NOT clearable by a metadata patch — lifting a hold is a legal decision that P3 puts through the approval gate');

assert(intake.applyPatch(null, { title: 'x' }).ok === false, 'patching a missing record fails rather than minting one');

done();
