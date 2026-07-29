// Tests lib/library/readers: the library's access model. The library is read by every agent on
// every tier, so a permissive bug here leaks platform-wide rather than per-feature. These tests are
// written to fail on the ways an allowlist DEGRADES — a missing list treated as public, a broad
// grant that quietly admits people, an owner or admin shortcut smuggled in beside the list — not
// merely to confirm that the happy path returns true.
const readers = require('../lib/library/readers');

const { assert, done } = require('./test-util');

const AGENT = { kind: 'agent', id: 'chief-librarian' };
const OPERATOR = { kind: 'operator', id: 'mike@example.com' };
const OWNER = { kind: 'person', id: 'mike@example.com' };
const OTHER = { kind: 'person', id: 'rival@example.com' };

// --- buildReaders: the list is built, never inherited
const allow = readers.buildReaders({ owner: 'Mike@Example.com', principals: ['Legal@Example.com'] });
assert(allow.includes('mike@example.com'), 'the owner is in the list, so ownership needs no separate rule');
assert(allow.includes('legal@example.com'), 'named principals are included, normalised');
assert(!allow.includes(readers.ALL_AGENTS), 'all-agents is NOT granted by default — a default-broad grant is how a contribution path leaks');

const dupes = readers.buildReaders({ owner: 'a@b.com', contributor: 'A@B.COM', principals: ['a@b.com', ' a@b.com '] });
assert(dupes.length === 1, 'the same principal in four spellings is one entry, not four');

const empties = readers.buildReaders({ owner: '', contributor: null, principals: ['', '   ', undefined] });
assert(empties.length === 0, 'empty and whitespace entries are dropped rather than becoming a blank principal');

const smuggled = readers.buildReaders({ owner: 'a@b.com', principals: [readers.ALL_AGENTS, 'ALL-AGENTS'] });
assert(!smuggled.includes(readers.ALL_AGENTS), 'the sentinel cannot arrive through a principal list — granting it must be visible at the call site');

const explicit = readers.buildReaders({ owner: 'a@b.com', allAgents: true });
assert(explicit.includes(readers.ALL_AGENTS), 'the explicit flag does grant the sentinel');
assert(readers.buildReaders({ owner: 'a@b.com', allAgents: 'yes' }).includes(readers.ALL_AGENTS) === false,
  'only a literal true grants it — a truthy string does not, so a stray query param cannot widen access');

// --- canRead: the list is the only truth
const shared = { readers: readers.buildReaders({ owner: OWNER.id, allAgents: true }), owner: OWNER.id, sensitivity: 'internal' };
assert(readers.canRead(shared, AGENT) === true, 'an agent reads an all-agents record');
assert(readers.canRead(shared, OWNER) === true, 'a named person reads their own record');
assert(readers.canRead(shared, OTHER) === false, 'all-agents does NOT admit an unnamed PERSON — agent reads are fenced, human reads are not');

const narrow = { readers: readers.buildReaders({ owner: OWNER.id }), owner: OWNER.id, sensitivity: 'confidential' };
assert(readers.canRead(narrow, OWNER) === true, 'the owner is named, so the owner reads it');
assert(readers.canRead(narrow, AGENT) === false, 'an agent gets NOTHING without an explicit grant — no implicit agent access');
assert(readers.canRead(narrow, OTHER) === false, 'another person is refused');

// --- the two sentinels are separate grants, because agent reads are fenced and human reads are not
const agentsOnly = { readers: readers.buildReaders({ allAgents: true }) };
assert(readers.canRead(agentsOnly, AGENT) === true, 'all-agents admits an agent');
assert(readers.canRead(agentsOnly, OPERATOR) === false,
  'all-agents does NOT admit an operator — one sentinel for both would make every grant to a bot a grant to a human');
assert(readers.canRead(agentsOnly, OWNER) === false, 'nor a plain person');

const opsOnly = { readers: readers.buildReaders({ allOperators: true }) };
assert(readers.canRead(opsOnly, OPERATOR) === true, 'all-operators admits an operator');
assert(readers.canRead(opsOnly, AGENT) === false, 'all-operators does NOT admit an agent — the grants are not reciprocal');
assert(readers.canRead(opsOnly, OWNER) === false,
  'all-operators does NOT admit a non-operator human — a managed client is not an operator');

// This is the migrated-vault shape. It is the reason both sentinels exist: the legacy vault is
// readable by any authenticated operator today, so a migration granting only all-agents would show
// every human an empty vault while claiming to have preserved behaviour.
const migratedVault = { readers: readers.buildReaders({ allAgents: true, allOperators: true }) };
assert(readers.canRead(migratedVault, AGENT) === true && readers.canRead(migratedVault, OPERATOR) === true,
  'a migrated vault record is readable by both agents and operators — what the legacy routes actually allowed');
assert(readers.canRead(migratedVault, OTHER) === false, 'but still not by an arbitrary person');

assert(readers.KIND_SENTINEL.person === null,
  'the kind->sentinel table gives `person` no broad grant, so a new branch cannot hand it one by accident');
for (const kind of readers.REQUESTER_KINDS) {
  assert(kind in readers.KIND_SENTINEL, `every recognised kind has an explicit sentinel decision: ${kind}`);
}

// --- fail closed: every malformed shape denies rather than discloses
assert(readers.canRead(null, OWNER) === false, 'no record, no read');
assert(readers.canRead({}, OWNER) === false, 'a record with no readers field is unreadable, not public');
assert(readers.canRead({ readers: [] }, OWNER) === false, 'an EMPTY reader list is an unreadable record — this is the branch that turns a migration bug into a denial instead of a disclosure');
assert(readers.canRead({ readers: 'mike@example.com' }, OWNER) === false, 'a string where an array belongs fails closed rather than being coerced');
assert(readers.canRead(shared, null) === false, 'no requester, no read');
assert(readers.canRead(shared, { kind: 'agent' }) === false, 'a requester with no id is refused');
assert(readers.canRead(shared, { kind: 'service', id: 'cron' }) === false, 'an unrecognised requester kind is refused, not guessed at');
assert(readers.canRead(shared, { kind: '', id: 'chief-librarian' }) === false, 'a blank kind is refused even when the id would match');

// --- no bypass inside canRead: ownership and sensitivity are not enforcement inputs
const ownedButNotListed = { readers: ['someone@else.com'], owner: OWNER.id, sensitivity: 'public' };
assert(readers.canRead(ownedButNotListed, OWNER) === false,
  'the owner field alone grants nothing — ownership is expressed by being IN the list, so there is one mechanism to audit');
assert(readers.canRead(ownedButNotListed, AGENT) === false,
  'sensitivity:public grants nothing either — the label is human-facing, the list is the policy');
const adminish = { readers: ['someone@else.com'], isAdmin: true, admin: true, bypass: true };
assert(readers.canRead(adminish, OWNER) === false,
  'no flag on the RECORD can widen access — operator override is a route-level decision, written where a reviewer sees it');

// --- readableBy: the filter cannot drift from the predicate
const corpus = [shared, narrow, ownedButNotListed];
const agentSees = readers.readableBy(corpus, AGENT);
assert(agentSees.length === 1 && agentSees[0] === shared, 'the list filter agrees with canRead exactly');
assert(readers.readableBy(corpus, OTHER).length === 0, 'a stranger sees nothing');
assert(readers.readableBy(null, AGENT).length === 0, 'a malformed corpus yields an empty result, not a throw');

// --- persona tripwire: whole-payload, not field-by-field
assert(readers.findPersonaLeaks({ title: 'Pricing', tags: ['sales'] }).length === 0, 'an ordinary record is clean');
assert(readers.findPersonaLeaks({ title: 'x', persona: { voice: {} } }).length > 0, 'a top-level persona is caught');
assert(readers.findPersonaLeaks({ title: 'x', meta: { nested: { transcript: ['...'] } } }).length > 0,
  'a persona field buried three levels down is caught — the walk is why this is not a field-by-field check');
assert(readers.findPersonaLeaks({ title: 'x', items: [{ compiledPersona: 'p' }] }).length > 0, 'a forbidden key inside an array element is caught');
assert(readers.findPersonaLeaks({ title: 'x', personaDerived: true }).length > 0,
  'personaDerived:true is itself a leak — it means a record was hand-built past catalog.normalize');
assert(readers.findPersonaLeaks({ title: 'x', personaDerived: false }).length === 0, 'the invariant holding is not a leak');
assert(readers.isPublishable({ title: 'ok' }) === true, 'isPublishable agrees on a clean payload');
assert(readers.isPublishable({ prompt: 'leak' }) === false, 'isPublishable agrees on a dirty one');

// The tripwire must stay coupled to the org module's list rather than keeping a private copy that
// drifts when a new persona field is added there.
assert(Array.isArray(readers.FORBIDDEN_KEYS) && readers.FORBIDDEN_KEYS.includes('persona'),
  'FORBIDDEN_KEYS is re-exported from lib/org/visibility, not redefined here');
for (const key of readers.FORBIDDEN_KEYS) {
  assert(readers.findPersonaLeaks({ [key]: 'x' }).length > 0, `every forbidden key is actually caught: ${key}`);
}

done();
