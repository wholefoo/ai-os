// Deploy-time dependency resolution must be REPRODUCIBLE.
//
// DEP-01, raised by the first real security-sweep (run-1786080073868). The finding's headline —
// "no root lockfile" — was FALSE (package-lock.json has been committed since July; the auditor could
// not see it because the read tools reused the WRITE denylist, which denies that file). But the
// second half was true and is what this pins: both deploy paths ran `npm install --production`, which
// re-resolves semver ranges at deploy time. Two deploys of the SAME commit could therefore install
// different transitive versions — an unpinned supply chain on a box holding live API keys.
//
// `npm ci` installs exactly what the lockfile pins and FAILS LOUDLY when lock and manifest disagree.
// That failure mode is the point: a stale lockfile should stop a deploy, not be silently papered over.
const fs = require('fs');
const path = require('path');
const { assert, done, repoRoot: ROOT, readRepoFile: read } = require('./test-util');

// --- the lockfile exists and is committed -------------------------------------------------------------
assert(fs.existsSync(path.join(ROOT, 'package-lock.json')),
  'a root package-lock.json exists — npm ci cannot run without one');
const lock = JSON.parse(read('package-lock.json'));
assert(lock.lockfileVersion >= 2, `lockfileVersion ${lock.lockfileVersion} — v2+ records the full transitive tree`);
assert(!/^package-lock\.json$/m.test(read('.gitignore')),
  'and it is NOT gitignored — an uncommitted lockfile pins nothing for anyone but the machine that made it');

// --- both deploy paths install from the lockfile -------------------------------------------------------
for (const script of ['deploy/install-vps.sh', 'deploy/push-update.sh']) {
  const body = read(script);
  assert(/npm ci --omit=dev/.test(body), `${script} installs app dependencies with \`npm ci --omit=dev\``);

  // Scan EXECUTABLE lines only. Comments in these scripts explain why `npm install` is wrong here, so
  // a naive scan flags the very documentation that prevents the regression.
  const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // The distinction that matters: `npm install -g <tool>` is a GLOBAL tool install (pm2, n8n, codex).
  // Those have no project lockfile and are legitimate. What must not survive is an `npm install` of
  // THIS project's dependencies, which is what re-resolves ranges.
  const appInstalls = (code.match(/npm install[^\n]*/g) || []).filter((l) => !/-g\b/.test(l));
  assert(appInstalls.length === 0,
    `${script} has no non-global \`npm install\` left${appInstalls.length ? ` — found: ${appInstalls.join(' | ')}` : ''}`);

  assert(!/npm install --production/.test(body),
    `${script} no longer uses the deprecated --production flag (superseded by --omit=dev)`);
}

// Global tool installs are untouched — this suite must not push anyone into "fixing" them.
assert(/npm install -g pm2/.test(read('deploy/install-vps.sh')),
  'global tool installs (pm2) are deliberately left as `npm install -g` — no project lockfile applies to them');

// --- the operator-facing instructions match what the scripts do ------------------------------------------
// A printed "next steps" block that still says `npm install` teaches the unpinned habit by hand even
// when the automation is correct.
const printed = read('deploy/install-vps.sh').match(/echo -e "\s+sudo -u \$\{APP_USER\} npm [^"]*"/g) || [];
for (const line of printed) {
  assert(/npm ci/.test(line), `printed instruction uses npm ci, not npm install — found: ${line.trim()}`);
}

console.log(`  info: lockfileVersion ${lock.lockfileVersion}, ${Object.keys(lock.packages || {}).length} packages pinned`);
done();
