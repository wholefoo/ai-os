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
function runDeploy(failOn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployguard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const D = dir.replace(/\\/g, '/');

  // ssh stub: logs the remote command, then fails if it matches `failOn`. With opts.failOnce only
  // the FIRST matching invocation fails (a counter file carries state between invocations) — that
  // is how "the new commit is unhealthy but the rolled-back one is fine" is simulated. Anything
  // containing `rev-parse` prints a fake SHA so the script has a rollback target to record; the
  // fake is a different value per repo so a rollback aimed at the wrong one is visible.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "SSH_CMD: $*" >> "${D}/calls.log"
if printf '%s' "$*" | grep -q 'commercial' && printf '%s' "$*" | grep -q 'rev-parse'; then echo c0ffee0; exit 0; fi
if printf '%s' "$*" | grep -q 'rev-parse'; then echo deadbee; exit 0; fi
if [ -n "${failOn}" ] && printf '%s' "$*" | grep -q -- '${failOn}'; then
  n=0; [ -f "${D}/fails" ] && n=$(cat "${D}/fails"); n=$((n+1)); echo $n > "${D}/fails"
  if [ "${opts.failOnce ? 1 : 0}" = "1" ] && [ $n -gt 1 ]; then exit 0; fi
  exit 1
fi
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
      // HEALTH_TRIES/INTERVAL only shape the remote loop text; the stub never sleeps. Kept small so
      // the logged command is short.
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HEALTH_TRIES: '2', HEALTH_INTERVAL: '0' },
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
  const lines = calls.split('\n');
  const restarted = lines.some(l => /pm2 restart ai-os --update-env"?$/.test(l.trim()));
  const restarts = lines.filter(l => /pm2 restart ai-os --update-env"?$/.test(l.trim())).length;
  return { code, stdout, calls, restarted, restarts };
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
  assert.ok(/\[4\/8\]/.test(r.stdout), 'should reach the install step');
  assert.ok(!/\[7\/8\]/.test(r.stdout), 'must not reach the restart step');
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

// --- Step 8: the restart must be PROVEN, and a failed proof must put the old commit back. -------
// Until 2026-09-04 the script ended by printing a curl command for a human. SOC 2 gap item 24.
ok('a clean run checks the ORIGIN health after restart and reports the deployed SHA', () => {
  const r = runDeploy('');
  const hi = r.calls.indexOf('localhost:3000/api/health');
  const ri = r.calls.indexOf('pm2 restart');
  assert.ok(hi !== -1, 'a health check against localhost must be issued');
  assert.ok(hi > ri, 'the health check comes AFTER the restart');
  assert.ok(/\[8\/8\]/.test(r.stdout));
  assert.ok(/origin healthy at deadbee/.test(r.stdout), `completion must name the SHA read back from the box, got:\n${r.stdout.slice(-300)}`);
  assert.ok(!/git reset --hard/.test(r.calls), 'a healthy deploy never rolls back');
  assert.strictEqual(r.restarts, 1, 'exactly one restart on a healthy deploy');
});

ok('the rollback targets are recorded BEFORE the pull, for both repos', () => {
  const r = runDeploy('');
  const rp = r.calls.indexOf('git rev-parse HEAD');
  const pull = r.calls.indexOf('git pull origin master');
  assert.ok(rp !== -1 && pull !== -1 && rp < pull, 'rev-parse must precede the pull — after it the old SHA is only in the reflog');
  assert.ok(/commercial.*rev-parse HEAD/.test(r.calls), 'the commercial checkout is recorded too');
  assert.ok(/running: core deadbee \/ commercial c0ffee0/.test(r.stdout), 'both recorded SHAs are echoed');
});

ok('an UNHEALTHY new commit is rolled back to the recorded SHAs, reinstalled, restarted, and the deploy still exits non-zero', () => {
  const r = runDeploy('api/health', { failOnce: true });   // first health check fails, the post-rollback one passes
  assert.notStrictEqual(r.code, 0, 'a rolled-back deploy is a FAILED deploy — exit code must say so');
  assert.ok(/git reset --hard deadbee/.test(r.calls), `core must be reset to the SHA recorded in step 2, calls:\n${r.calls}`);
  assert.ok(/commercial && sudo -u aios git reset --hard c0ffee0/.test(r.calls), 'commercial must be reset to ITS recorded SHA, not the core one');
  const resetAt = r.calls.indexOf('git reset --hard');
  const ciAfter = r.calls.indexOf('npm ci --omit=dev', resetAt);
  const checkAfter = r.calls.indexOf('check-deps-installed', resetAt);
  assert.ok(ciAfter !== -1 && checkAfter !== -1 && ciAfter < checkAfter, 'the OLD commit\'s pinned deps are reinstalled and verified after the reset');
  assert.strictEqual(r.restarts, 2, 'restart once for the deploy, once for the rollback');
  assert.ok(/ROLLED BACK\. Origin is healthy again at deadbee/.test(r.stdout), 'the operator is told service is restored AND that the deploy failed');
  assert.ok(!/Deployment complete/.test(r.stdout), 'must not claim completion');
  assert.ok(!/npm install --omit=dev/.test(r.calls), 'rollback must not auto-run npm install either (test-deploy-determinism)');
});

ok('if the rollback ALSO fails health, it says the origin is DOWN and exits non-zero', () => {
  const r = runDeploy('api/health');   // every health check fails
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.restarts, 2, 'it still attempted the rollback restart');
  assert.ok(/ROLLBACK ALSO FAILED — the origin is DOWN/.test(r.stdout), 'the worst case is named, not hidden behind a generic failure');
  assert.ok(!/ROLLED BACK\. Origin is healthy/.test(r.stdout), 'must not claim recovery');
});

ok('the health check hits the origin on localhost, not the public hostname (CDN caching lesson)', () => {
  const r = runDeploy('');
  const line = r.calls.split('\n').find(l => l.includes('api/health')) || '';
  assert.ok(/http:\/\/localhost:3000\/api\/health/.test(line), `expected a localhost origin check, got: ${line}`);
  assert.ok(/"status":"ok"/.test(line.replace(/\\"/g, '"')), 'it checks the body says status ok, not just that something answered');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
