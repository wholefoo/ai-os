// Tests lib/library/paths: the library's path-traversal boundary. Every store has its own rule
// because the stores have different shapes, and the whole point of these tests is that the rule which
// is correct for a FLAT directory (basename) is not correct for a NESTED one — the bug the design
// review caught before implementation. Written as attacks, not as happy paths.
const path = require('path');
const { resolveRecordPath, VAULT_FOLDERS } = require('../lib/library/paths');

const { assert, done } = require('./test-util');

const ROOTS = {
  vault: path.resolve('/srv/app/.magent/vault'),
  orgDocs: path.resolve('/srv/app/.magent/org-docs'),
  artifacts: path.resolve('/srv/app/.magent/artifacts'),
};
const at = (store, p) => resolveRecordPath({ store, path: p }, ROOTS);

// --- vault: flat per folder
assert(at('vault', 'wiki/agent-roster.md') === path.join(ROOTS.vault, 'wiki', 'agent-roster.md'), 'a normal vault path resolves');
assert(VAULT_FOLDERS.length === 3, 'the vault has exactly the three folders the stores actually contain');
for (const f of VAULT_FOLDERS) assert(at('vault', `${f}/x.md`) !== null, `folder is allowed: ${f}`);
assert(at('vault', 'secrets/x.md') === null, 'an unknown vault folder is refused — the allowlist is the folder, not the file');
assert(at('vault', 'x.md') === null, 'a vault path with no folder is refused rather than assumed');

// traversal attempts
// basename alone does NOT catch this: it flattens 'wiki/../../../../etc/passwd' to '<vault>/wiki/passwd'
// — inside the vault, so not an escape, but a DIFFERENT file than the record names. The explicit
// dot-dot refusal is what makes this null instead of a silent substitution.
assert(at('vault', 'wiki/../../../../etc/passwd') === null, 'dot-dot in a vault path is refused, not silently flattened to another real file');
assert(at('vault', '../org-docs/secret.txt') === null, 'escaping via a dot-dot FOLDER is refused (not an allowlisted folder)');
assert(at('vault', 'wiki\\..\\..\\etc\\passwd') === null, 'backslash separators are normalised, so a Windows-style traversal cannot slip past the / split');
assert(at('vault', 'wiki/.hidden') === null, 'a dotfile is refused, matching the legacy vault routes');
assert(at('vault', 'wiki/..') === null, 'a bare dot-dot filename is refused');
assert(at('vault', 'wiki/') === null, 'a folder with no file is refused');

// --- org-docs: id only
assert(at('org-docs', 'a1b2-c3d4.txt') === path.join(ROOTS.orgDocs, 'a1b2-c3d4.txt'), 'a uuid-shaped id resolves');
assert(at('org-docs', 'a1b2-c3d4') === path.join(ROOTS.orgDocs, 'a1b2-c3d4.txt'), 'the .txt suffix is optional in the record');
assert(at('org-docs', '../vault/wiki/x.md') === null, 'anything with a separator is refused — the id is not a path expression');
assert(at('org-docs', 'a/b.txt') === null, 'a nested org-docs path is refused; the store is flat by construction');
assert(at('org-docs', '..') === null, 'dot-dot is not a valid id');
assert(at('org-docs', 'file.name.txt') === null, 'an id containing a dot is refused — ids are word chars and hyphens only');

// --- artifacts: nested tree, containment is the rule
assert(at('artifacts', 'docs/plan.md') === path.join(ROOTS.artifacts, 'docs', 'plan.md'), 'a nested artifact path resolves');
assert(at('artifacts', 'web-studio/site/index.html') === path.join(ROOTS.artifacts, 'web-studio', 'site', 'index.html'),
  'a DEEPLY nested artifact resolves — this is the case a basename guard would have broken, which is why the guard is per store');
assert(at('artifacts', '../vault/wiki/x.md') === null, 'escaping the artifacts root is refused by containment');
assert(at('artifacts', 'docs/../../org-docs/x.txt') === null, 'a traversal buried mid-path is refused');
assert(at('artifacts', 'docs/../code/x.js') === null,
  'even a traversal that would stay INSIDE the root is refused — no legitimate record path contains dot-dot, so refusing costs nothing and removes the need to reason about where it lands');
assert(at('artifacts', '') === null, 'an empty path is refused');
assert(at('artifacts', '.') === null, 'the root itself is not a record');

// --- shape and store validation
assert(resolveRecordPath(null, ROOTS) === null, 'no record, no path');
assert(resolveRecordPath({ store: 'vault', path: 'wiki/x.md' }, null) === null, 'no roots, no path');
assert(at('unknown-store', 'x') === null, 'an unrecognised store is refused, not guessed at — a new store states its own rule first');
assert(at('vault', 'wiki/x\0.md') === null, 'a NUL byte is refused before any join sees it — it truncates paths in some syscalls');
assert(resolveRecordPath({ store: 'vault' }, ROOTS) === null, 'a record with no path is refused');
assert(resolveRecordPath({ store: 'vault', path: null }, ROOTS) === null, 'a null path is refused rather than stringified to "null"');

// A missing root for the requested store must deny, not fall back to a different store's root.
assert(resolveRecordPath({ store: 'artifacts', path: 'docs/x.md' }, { vault: ROOTS.vault }) === null,
  'a store whose root was not supplied is refused rather than resolved against whatever root is present');

done();
