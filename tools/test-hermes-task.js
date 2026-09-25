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

const harness = path.join(__dirname, '..', 'deploy', 'coding-instance', 'test', 'harness.sh');
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
    assert(+m[1] >= 33, `the harness still exercises all ${m[1]} checks (expected at least 33)`);
  }
  done();
}
