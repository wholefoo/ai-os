// Tests tools/library-migrate's reconcile pass. Narrow on purpose: it covers the one operation in the
// migration tool that DELETES, and deletion is where this feature has already gone wrong twice.
//
// The canonical-facts shelf has now been silently destroyed by two different mechanisms that both
// assumed every record maps to a file on disk:
//   1. dedupeByHash collapsed five facts into one, because seeding them with path:'' and
//      contentHash:'' gave every fact the identical dedupe key `vault::::`.
//   2. reconcile pruned all five, because the synthetic `canonical/<slug>` path added to FIX (1) has
//      no bytes behind it, and reconcile's whole test is "do the bytes still exist".
//
// Both were total, both were silent, and both were only visible by counting records afterwards. That
// is what these assertions exist to prevent — not a plausible bug, a twice-actual one.
const migrate = require('./library-migrate');

const { assert, done } = require('./test-util');

const fact = (title, value) => ({
  id: `fact-${title}`, title, value, source: 'canonical-fact',
  store: 'vault', path: `canonical/${title}`, contentHash: 'a'.repeat(64),
});
const doc = (path) => ({
  id: `doc-${path}`, title: path, source: 'company-doc',
  store: 'vault', path, contentHash: 'b'.repeat(64),
});

// --- a bytes-less record survives a prune it could never pass
const shelf = [fact('department-count', '11'), fact('licensed-agent-count', '68')];
const r1 = migrate.reconcile(shelf);
assert(r1.survivors.length === 2, 'canonical facts survive reconcile — they have no bytes, so the existence test is meaningless for them');
assert(r1.pruned.length === 0, 'and none are reported as pruned');

// --- a real document whose bytes are gone IS pruned; reconcile still does its job
const ghost = doc('wiki/definitely-does-not-exist-xyz.md');
const r2 = migrate.reconcile([ghost]);
assert(r2.pruned.length === 1 && r2.pruned[0].id === ghost.id, 'a document record with no bytes on disk is still pruned — the fix must not disable reconcile');
assert(r2.survivors.length === 0, 'and it does not survive');

// --- mixed: the shelf is kept while the dangling document goes
const r3 = migrate.reconcile([...shelf, ghost]);
assert(r3.survivors.length === 2, 'in a mixed catalog the facts are kept...');
assert(r3.pruned.length === 1 && r3.pruned[0].id === ghost.id, '...and only the genuinely dangling document is pruned');
assert(r3.survivors.every((s) => s.source === 'canonical-fact'), 'the survivors are exactly the bytes-less records');

// --- the allowlist is positive, and adding a bytes-less source requires updating it
assert(Array.isArray(migrate.BYTELESS_SOURCES), 'BYTELESS_SOURCES is exported so this rule is inspectable rather than buried in a branch');
assert(migrate.BYTELESS_SOURCES.includes('canonical-fact'), 'canonical-fact is on the bytes-less allowlist');
for (const source of migrate.BYTELESS_SOURCES) {
  const rec = { id: 'x', source, store: 'vault', path: 'canonical/whatever-nonexistent', contentHash: 'c'.repeat(64) };
  assert(migrate.reconcile([rec]).pruned.length === 0, `every declared bytes-less source is actually spared: ${source}`);
}

// A source NOT on the allowlist must not be spared by accident — otherwise the guard has quietly
// become "prune nothing", which would look like a pass while disabling the feature.
const notListed = { id: 'y', source: 'agent-output', store: 'artifacts', path: 'docs/gone-xyz.md', contentHash: 'd'.repeat(64) };
assert(migrate.reconcile([notListed]).pruned.length === 1, 'a source outside the allowlist is still subject to pruning — the guard is an exception, not a blanket');

// --- shape tolerance: a malformed record must not crash the prune pass mid-catalog
const messy = migrate.reconcile([null, undefined, {}, fact('model-count', '6')]);
assert(messy.survivors.some((s) => s && s.source === 'canonical-fact'), 'a valid fact still survives alongside malformed entries');
assert(!messy.survivors.includes(null), 'null entries are not carried forward as survivors');

done();
