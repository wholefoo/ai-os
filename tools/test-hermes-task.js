// The coding-instance task runner (deploy/coding-instance/hermes-task) and its protections.
//
// The runner is bash, so this suite drives it for real against fixtures instead of reading it as
// text: deploy/coding-instance/test/harness.sh builds local bare repos standing in for GitHub and a
// stub `claude` that misbehaves on demand (bills an API key, leaks the token, breaks the tests,
// declines probe steps). Each protection is proven by making it fire. When this suite was written,
// removing any one of nine protections from a copy of the runner failed at least one check here.
//
// It needs bash and git; where either is missing it reports a skip rather than a false pass.
const { spawnSync } = require('child_process');
const path = require('path');
const { assert, done } = require('./test-util');

const ci = (f) => require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'coding-instance', f), 'utf8');

// ---------- the operating-system boundary --------------------------------------------------------
// The Claude Code sandbox confined reads but not writes on the box: a sandboxed command wrote to the
// home directory. So Claude Code runs as a separate confined user whose limits the kernel enforces.
const launch = ci('hermes-agent-launch');
assert(/setpriv --reuid .* --regid .* --clear-groups/.test(launch), 'the launcher drops to the agent uid/gid and clears supplementary groups');
assert(/case "\$real\/" in "\$TASKS_ROOT"\/\*\)/.test(launch), 'the launcher refuses a workspace outside the tasks tree (no symlink escape)');
assert(/tr -d '\\r\\n' < "\$TOKEN_FILE"/.test(launch), 'the launcher reads the token from the file, not from argv');
// Only code lines: the header comment explains the API-key precedence, so scan for an actual
// assignment/export rather than any mention.
const launchCode = launch.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
assert(!/(export\s+|^\s*)ANTHROPIC_(API_KEY|AUTH_TOKEN)=/m.test(launchCode), 'the launcher never sets an API-key variable that would outrank the subscription token');
assert(/export CLAUDE_CODE_OAUTH_TOKEN="\$TOKEN"/.test(launch), 'the token reaches Claude Code through the environment, not a command line');

const inst = ci('install-agent-user.sh');
assert(/useradd -m -g "?\$GROUP"? .* "?\$AGENT/.test(inst) && /passwd -l "?\$AGENT/.test(inst), 'the agent user is created with the work group and locked (no login)');
assert(/chmod 711 "\$H_HOME"/.test(inst), 'the home directory is locked to 0711 (traverse, not read)');
assert(/for d in \.ssh \.config work/.test(inst), 'the secret subdirectories are locked to 0700');
assert(/NOPASSWD: \/usr\/local\/sbin\/hermes-agent-launch/.test(inst), 'hermes may run only the launcher via sudo');
assert(/visudo -cf/.test(inst), 'the sudoers rule is validated before install');
assert(/CANNOT create a file in ~hermes/.test(inst), 'the installer proves the kernel refuses a write into the home directory');

const runner = ci('hermes-task');
assert(/"\$\{LAUNCH\[@\]\}" "\$1" --/.test(runner), 'the runner launches Claude Code through the launcher array (handles `sudo -n <path>` and spaces)');

const harness = path.join(__dirname, '..', 'deploy', 'coding-instance', 'test', 'harness.sh');

// ---------- the sandbox policy -------------------------------------------------------------------
// On the first real run, "denyRead ~/ + allowRead ~/tasks" re-mounted the workspace read-only, the
// sandbox could not create its placeholder for .mcp.json there, and EVERY sandboxed command failed
// to start ("bwrap: Can't create file .../.mcp.json: Read-only file system"). The probe's positive
// control caught it. Secrets are denied by location instead; the workspace is never re-mounted.
const policy = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'deploy', 'coding-instance', 'claude-policy.json'), 'utf8'));
const fsPol = policy.sandbox.filesystem || {};
assert(!(fsPol.allowRead || []).length && !(fsPol.denyRead || []).includes('~/'),
  'the policy does not hide the home directory and re-open the workspace (that broke the sandbox)');
// Claude Code runs as hermes-agent, so ~ is /home/hermes-agent; the secret denies point at hermes's
// real paths absolutely (defence in depth — the kernel already blocks them). The agent's own home is
// writable so the sandbox can create ~/.npm etc. at startup (a HOME under the workspace could not).
for (const p of ['/home/hermes/.config', '/home/hermes/.ssh', '/home/hermes/work'])
  assert((fsPol.denyRead || []).includes(p), `the sandbox denies reading ${p}`);
assert((fsPol.allowWrite || []).includes('/home/hermes-agent'), 'the agent home is sandbox-writable (Claude Code sets up ~/.npm there at startup)');
assert(policy.sandbox.enabled && policy.sandbox.failIfUnavailable && policy.sandbox.allowUnsandboxedCommands === false,
  'sandbox on, refuses to start without it, no unsandboxed fallback');
assert(policy.sandbox.network.strictAllowlist && policy.sandbox.network.allowedDomains.join() === 'registry.npmjs.org',
  'network limited to the npm registry');
assert(policy.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1', 'credentials are scrubbed from subprocess environments');
// The scrub turns OFF sandbox auto-allow (documented under sandbox.autoAllowBashIfSandboxed). Without
// an explicit allow, every ordinary command "requires approval", nobody can approve in an unattended
// run, and `npm test` is refused — the third field probe found exactly that. With the scrub on,
// every command runs sandboxed, so allowing Bash leaves the sandbox as the boundary.
assert((policy.permissions.allow || []).includes('Bash'), 'Bash is explicitly allowed (the scrub disables sandbox auto-allow)');
assert(policy.permissions.deny.includes('Bash(git push *)'), 'git push stays denied (deny beats allow)');
const have = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

if (!have('bash') || !have('git')) {
  console.log('skip: bash or git not available — hermes-task harness not run');
  done();
} else {
  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/passed=(\d+) failed=(\d+)/);
  assert(!!m, 'the harness ran to completion' + (m ? '' : ': ' + out.split('\n').slice(-5).join(' | ')));
  if (m) {
    for (const line of out.split('\n').filter((l) => /^\s+FAIL\s/.test(l))) console.error('  ' + line.trim());
    assert(+m[2] === 0, `every runner protection holds (${m[1]} passed, ${m[2]} failed)`);
    assert(+m[1] >= 38, `the harness still exercises all ${m[1]} checks (expected at least 38)`);
  }
  done();
}
