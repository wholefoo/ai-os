// tools/test-deploy-guard.js
// ============================================================
//  deploy/push-update.sh — proves that a FAILED dependency install cannot reach the pm2 restart.
//
//  On 2026-08-11 that exact sequence took the main site down: `npm ci` wiped node_modules, the
//  rebuild did not complete, and the restart went ahead anyway against a partial tree. The script
//  runs under `set -euo pipefail`, which SHOULD abort on a failing ssh — but "should" is what this
//  file exists to replace. The finding was literally "nothing verifies step 4 succeeded", so
//  asserting the fix by reading it would repeat the original mistake.
//
//  Method: run the real script with `ssh` and `git` replaced by stubs on PATH, and observe which
//  steps it reaches. Nothing touches a network, a remote host, or this repo's git state.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'push-update.sh');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

/**
 * Run push-update.sh with stubbed `ssh`/`git`.
 * @param failOn substring of the remote command whose ssh invocation should exit non-zero
 */
function runDeploy(failOn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployguard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  // ssh stub: logs the remote command, then fails if it matches `failOn`.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "SSH_CMD: $*" >> "${dir.replace(/\\/g, '/')}/calls.log"
if [ -n "${failOn}" ] && printf '%s' "$*" | grep -q -- '${failOn}'; then exit 1; fi
exit 0
`, { mode: 0o755 });
  // git stub: never touch the real repo.
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
printf '%s\\n' "GIT: $*" >> "${dir.replace(/\\/g, '/')}/calls.log"
exit 0
`, { mode: 0o755 });

  let stdout = '', code = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT, 'deploy@example.invalid'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status;
    stdout = String(e.stdout || '') + String(e.stderr || '');
  }
  const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });

  // ⚠️ DO NOT ask "does the word 'pm2 restart' appear in calls" — step 4's own ERROR MESSAGE
  // contains the literal text `sudo -iu aios pm2 restart ai-os --update-env` as advice to the
  // operator, so a substring match reports a restart that never happened. My first version of this
  // test did exactly that and failed against a correct script. Match the actual INVOCATION: the
  // restart is the entire remote command, so anchor to the end of the logged line.
  const restarted = calls.split('\n').some(l => /pm2 restart ai-os --update-env"?$/.test(l.trim()));
  return { code, stdout, calls, restarted };
}

// --- THE GUARD. A failing install step must abort before pm2 is touched. ----------------------
ok('a FAILING dependency step aborts the deploy and never reaches pm2 restart', () => {
  const r = runDeploy('check-deps-installed');
  assert.notStrictEqual(r.code, 0, 'the deploy must exit non-zero when the install step fails');
  assert.ok(!r.restarted,
    `pm2 restart MUST NOT be invoked after a failed install — calls were:\n${r.calls}`);
  assert.ok(!/Deployment complete/.test(r.stdout), 'must not claim success');
});

ok('...and it stops at step 4, not after quietly doing steps 5 and 6', () => {
  const r = runDeploy('check-deps-installed');
  assert.ok(/\[4\/7\]/.test(r.stdout), 'should reach the install step');
  assert.ok(!/\[7\/7\]/.test(r.stdout), 'must not reach the restart step');
  assert.ok(!/aios-site-vhost|install -o root/.test(r.calls),
    'must not install root-owned hosting scripts after a failed dependency install');
});

// --- MUST NOT BREAK THE HAPPY PATH. -----------------------------------------------------------
ok('a clean run still reaches the restart and reports completion', () => {
  const r = runDeploy('');
  assert.strictEqual(r.code, 0, `clean deploy must exit 0, got ${r.code}:\n${r.stdout.slice(0, 400)}`);
  assert.ok(/pm2 restart/.test(r.calls), 'the restart must still happen on a good deploy');
  assert.ok(/Deployment complete/.test(r.stdout));
});

ok('the install step actually runs the completeness check, not just npm ci', () => {
  const r = runDeploy('');
  assert.ok(/npm ci --omit=dev/.test(r.calls), 'npm ci stays the primary install path');
  assert.ok(/check-deps-installed\.js/.test(r.calls),
    'the tree must be VERIFIED after install — trusting the exit code is what failed on 2026-08-11');
  // NO auto-repair. An earlier version of this change ran `npm install --omit=dev` automatically
  // when the check failed, and tools/test-deploy-determinism.js correctly rejected it: `npm install`
  // can silently rewrite the lockfile where `npm ci` errors, so it must not live in the automated
  // deploy path. The operator is told to run it; the script does not. Stopping the deploy is what
  // fixes the outage — repairing was extra, and it cost a guard.
  assert.ok(!/npm install --omit=dev/.test(r.calls),
    'the deploy must NOT auto-run `npm install` — that would defeat test-deploy-determinism.js');
});

// --- Ordering: verification must precede the restart, not merely coexist with it. --------------
ok('verification is ordered BEFORE the restart in the emitted commands', () => {
  const r = runDeploy('');
  const vi = r.calls.indexOf('check-deps-installed');
  const ri = r.calls.indexOf('pm2 restart');
  assert.ok(vi !== -1 && ri !== -1, 'both must appear');
  assert.ok(vi < ri, 'the completeness check must come BEFORE pm2 restart');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
