// tools/test-no-nested-repos.js
// ============================================================
//  Fails if a FOREIGN GIT REPOSITORY is sitting inside this working tree.
//
//  WHY. On 2026-08-20 a Codex-built app (`ai-blueprint-pulse/`) was created inside this repo. It
//  was untracked, so it never reached GitHub or the VPS — but it did two kinds of damage locally:
//    1. It has its own `.git`, so `git add -A` staged it as an EMBEDDED GIT REPOSITORY (a gitlink).
//       That landed in a commit and had to be undone with `git rm --cached` + `--amend`. A gitlink
//       pushed to origin is worse: clones get an empty directory and no way to obtain the contents.
//    2. Its `package.json` made `fallow dead-code` analyse a project that is not ours, so the local
//       gate failed while CI passed — a divergence that cost real time to attribute correctly,
//       because the obvious suspect is whatever branch you happen to be on.
//
//  WHY A CATEGORY GUARD, NOT AN IGNORE ENTRY. Adding `ai-blueprint-pulse/` to `.gitignore` would
//  protect against exactly one folder name and nothing else. Codex places projects in the current
//  directory by default, so the NEXT one will have a different name and reproduce both failures.
//  Guard the shape — a nested repo — not the instance.
//
//  SCOPE, stated honestly: this can only fail LOCALLY. CI clones just the tracked files, so a
//  foreign repo cannot exist there and this assertion is trivially true in CI. That is not a reason
//  to drop it — the accident happens in a working tree, which is precisely where this runs.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

/** Directories that legitimately contain a `.git` or that we simply never scan. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

// EXPECTED nested repos. This is an allowlist of the known-good, not a denylist of the known-bad:
// anything NOT named here fails, which is what keeps the guard category-level.
//
// `commercial/` is the open-core split — the private commercial repo is deliberately mounted here,
// and the VPS needs both. It is architecture, not an accident, and it is why this guard cannot
// simply assert "no nested repos at all". Two repos means two pulls and two pushes.
//
// Adding to this list should be RARE and deliberate. If you are tempted to add a folder because a
// tool dropped a project here, the right fix is to MOVE THE PROJECT OUT — that is what happened
// with the Codex-built app on 2026-08-20.
const EXPECTED = new Set(['commercial']);

/** Every nested `.git` under ROOT, excluding ROOT's own. */
function findNestedRepos(dir, depth = 0, out = []) {
  if (depth > 4) return out;                       // deep enough for a dropped-in project
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    // A worktree has a `.git` directory; a submodule/linked worktree has a `.git` FILE.
    if (fs.existsSync(path.join(p, '.git'))) out.push(path.relative(ROOT, p));
    else findNestedRepos(p, depth + 1, out);
  }
  return out;
}

ok('no UNEXPECTED git repository is nested inside this working tree', () => {
  const nested = findNestedRepos(ROOT).filter((n) => !EXPECTED.has(n.split(path.sep)[0]));
  assert.deepStrictEqual(nested, [],
    `Found ${nested.length} nested git repo(s) inside this repo:\n`
    + nested.map((n) => `  ${n}`).join('\n')
    + '\n\nThese break two things: `git add -A` stages them as embedded repos (gitlinks), and their\n'
    + 'package.json makes `fallow dead-code` analyse a project that is not ours, so the local gate\n'
    + 'diverges from CI. MOVE the project out of this directory rather than ignoring it — an ignore\n'
    + 'entry only covers this one name, and the next drop-in will have a different one.');
});

// `commercial/` must be RECOGNISED, not merely tolerated — if the detector stopped seeing it, the
// allowlist would be hiding a broken detector rather than an expected repo.
ok('the detector DOES see commercial/ (proving it works on a real repo, not just fixtures)', () => {
  const all = findNestedRepos(ROOT);
  assert.ok(all.includes('commercial'),
    'commercial/ is a real nested repo (the open-core split) and the detector must find it; '
    + `found: ${JSON.stringify(all)}`);
});

// The guard is worthless if the detector cannot see a repo. Prove it fires on a fixture, since a
// zero from a check that cannot detect anything is indistinguishable from a clean tree.
ok('the detector actually FIRES on a nested repo (fixture)', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nested-repo-'));
  try {
    const proj = path.join(tmp, 'some-dropped-in-app');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    const found = findNestedRepos(tmp);
    assert.deepStrictEqual(found.length, 1, 'the detector must find a directory containing .git');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
