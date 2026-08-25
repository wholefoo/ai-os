// No doc or script may tell an operator to run pm2 without a login shell.
//
// WHY. pm2 locates its daemon via $HOME. `sudo -u <user> pm2 …` leaves HOME as the CALLING user's,
// so pm2 reads /root/.pm2 instead of the app user's registry. The failure has more than one face —
// "Process or Namespace not found" as though the app name were wrong (deploy/push-update.sh step 7),
// and `spawn /usr/bin/node EACCES` from resolving the wrong Node (docs/RUNBOOK-vps.md) — and both
// share the property that makes them expensive: THE OLD CODE KEEPS SERVING. A deploy reads as clean
// while the fix never shipped. `sudo -iu` runs a login shell and sets HOME correctly.
//
// WHY A TEST AND NOT A REVIEW HABIT. This was already documented correctly in RUNBOOK-vps.md and
// push-update.sh, and STILL wrong in 16 places across 7 files — including two guidance files that
// instructed agents to use the broken form, while the runbook two directories away explained why it
// was broken. Written guidance did not hold the line; the repo contradicted itself for months and
// nothing noticed, because nothing was looking.
//
// SCOPE: every tracked .md/.sh/.js. `git ls-files` rather than a directory walk, so the set is
// exactly what the repo ships.
//
// KNOWN BLIND SPOT, stated rather than implied: `.gitignore:53` ignores `docs-export/` wholesale,
// which includes `generate-stripe-guide.js` — a GENERATOR, not generated output, and it carries two
// occurrences of the wrong form that feed customer-facing docs. Being untracked, it is invisible to
// this scan and cannot be fixed by a commit here. Tracking that generator would close the gap; until
// someone decides to, this guard covers the repo and not that file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { assert, done, repoRoot } = require('./test-util');

// Matches a pm2 invocation delegated with -u instead of -iu. The regex SOURCE deliberately contains
// no literal example of the bad form, so this file does not trip its own scan — the same
// self-matching trap tools/test-deploy-guard.js documents for its restart check.
const NO_LOGIN_SHELL = /sudo\s+-u\s+\w+\s+pm2/;

// A line may opt out by carrying this marker plus a reason — for prose that quotes the wrong form in
// order to explain it. Mirrors the `seclint-ok` convention already used in this repo.
const OPT_OUT = /pm2-ok:/;

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split('\n')
  .filter((f) => /\.(md|sh|js)$/.test(f) && !f.startsWith('commercial/'));

const violations = [];
for (const rel of tracked) {
  const abs = path.join(repoRoot, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  // CRLF normalised at the read boundary: this repo checks out CRLF on Windows, and a stray \r is
  // how line-based scanning here has silently broken before.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (NO_LOGIN_SHELL.test(line) && !OPT_OUT.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

assert(tracked.length > 100, `the scan actually found files to read (${tracked.length})`);
assert(violations.length === 0,
  violations.length
    ? `pm2 must be invoked through a login shell (-iu). Offending lines:\n    ${violations.join('\n    ')}`
    : 'no doc or script delegates pm2 without a login shell');

// --- The guard must be able to FAIL. ------------------------------------------------------------
// A detector that cannot fire is indistinguishable from a clean repo, and this repo has shipped that
// exact illusion before. The bad string is assembled rather than written out, so the positive
// control does not become a violation in the file that defines the rule.
const badForm = ['sudo', '-u', 'aios', 'pm2', 'restart', 'ai-os'].join(' ');
assert(NO_LOGIN_SHELL.test(badForm), 'the detector fires on a delegated pm2 call with no login shell');
assert(!NO_LOGIN_SHELL.test(badForm.replace('-u', '-iu')), '...and does NOT fire once it is a login shell');
assert(!NO_LOGIN_SHELL.test('sudo -u aios git -C /opt/ai-os pull origin master'),
  'git delegated with -u is untouched — it does not read $HOME, and running the pull as the app user is correct');
// The opt-out must be a real escape hatch, not a phrase that silences everything it touches.
const optedOut = `${badForm}  <!-- pm2-ok: counter-example -->`;
assert(NO_LOGIN_SHELL.test(optedOut) && OPT_OUT.test(optedOut),
  'an opted-out line still MATCHES the pattern — it is exempted by the marker, not by failing to look wrong');

done();
