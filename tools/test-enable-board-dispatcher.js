// Pins the safety shape of deploy/coding-instance/enable-board-dispatcher.sh — the switch that turns
// the Coding Board dispatcher on on the box. Each assertion names a way this could go wrong: minting a
// sudoers grant the design does not need, wiring the dispatcher on a box where the app is not the
// runner user, corrupting .env, or chaining an install before a restart (which took a live box down
// once). Shell is read as text — CI has no systemd/root — and executable lines are separated from
// comments so the comments (which explain what the script deliberately does NOT do) can't false-match.
const { assert, done, readRepoFile } = require('./test-util');

const src = readRepoFile('deploy/coding-instance/enable-board-dispatcher.sh');
const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// runs as root, against a real unit
assert(/\[ "\$\(id -u\)" -eq 0 \]/.test(code), 'refuses unless run as root');
assert(/systemctl cat "\$SERVICE"/.test(code), 'checks the systemd unit exists before touching anything');

// THE core safety property: the dispatcher runs the runner AS the app user, so it must refuse anywhere
// the app user is not the runner user (hermes) — otherwise enabling would need a privilege grant.
assert(/APP_USER=\$\(systemctl show -p User --value/.test(code), 'reads the actual app user from systemd, not an assumption');
assert(/\[ "\$APP_USER" = "\$EXPECT_USER" \] \|\| die/.test(code), 'refuses when the app user is not the runner user (would need a wider grant)');
assert(/EXPECT_USER=\$\{EXPECT_USER:-hermes\}/.test(code), 'the expected app user is hermes');

// adds NO sudoers rule and never edits sudoers — the whole point (the app IS hermes and already has
// the one rule it needs). A future edit that reaches for sudoers here should fail this test loudly.
// It may READ the launcher rule to verify the prereq, but must never WRITE a sudoers file: no
// redirection, install, tee or cp targeting a sudoers path, and no visudo.
assert(!/(>>?\s*"?[^"\n]*sudoers)|(\b(install|tee|cp)\b[^\n]*sudoers)/.test(code),
  'writes NO sudoers rule (the app user already is the runner user)');
assert(!/\bvisudo\b/.test(code), 'never runs visudo — it grants nothing');

// but it DOES require the launcher sudoers rule hermes already needs, and fails loudly if absent
assert(/hermes-agent-launch/.test(code) && /-l -U "\$APP_USER"/.test(code), 'verifies the app user can reach hermes-agent-launch before enabling');

// never chains an install/build before the restart (npm ci && restart once caused a 40-min outage)
assert(!/npm (ci|install)/.test(code), 'runs no npm ci / npm install (an env switch, not an install)');
assert(!/apt-get/.test(code), 'installs no packages');

// .env is edited safely: backed up first, no duplicate keys, ownership/mode preserved via a temp+mv
const backupAt = code.indexOf('cp -p "$ENV_FILE"');
const editAt = code.indexOf('grep -vE');
assert(backupAt > 0 && editAt > backupAt, '.env is backed up BEFORE it is edited');
assert(/grep -vE '\^\(HERMES_BOARD_DISPATCH\|HERMES_RUNNER_CMD\|HERMES_BOARD_CONCURRENCY\|HERMES_BOARD_POLL_MS\)='/.test(code),
  'drops any existing HERMES_BOARD_* lines before appending — no duplicate keys (dotenv takes the last, a silent trap)');
assert(/mv -f "\$TMP" "\$ENV_FILE"/.test(code), 'writes via a temp file then mv, never sed -i in place');
assert(/chmod --reference="\$ENV_FILE"/.test(code) && /chown --reference="\$ENV_FILE"/.test(code), 'preserves .env ownership and mode (0600, hermes)');

// the on/off switch itself
assert(/HERMES_BOARD_DISPATCH=1/.test(code) && /HERMES_RUNNER_CMD=\$RUNNER/.test(code), 'ON writes DISPATCH=1 and the runner command');
assert(/MODE=off/.test(code) && /HERMES_BOARD_DISPATCH=0/.test(code), '--off writes DISPATCH=0');
assert(/RUNNER=\$\{RUNNER:-\/usr\/local\/bin\/hermes-task\}/.test(code), 'the runner command defaults to the installed hermes-task');

// restart + prove it came back, and confirm the dispatcher actually started
assert(/systemctl restart "\$SERVICE"/.test(code), 'restarts the service');
assert(/systemctl is-active --quiet "\$SERVICE" \|\|/.test(code), 'fails loudly (and points at the backup) if the service does not come back');
assert(/\[board\] dispatcher started/.test(code), 'verifies the dispatcher logged that it started');
assert(/START=\$\(date /.test(code) && /--since "\$START"/.test(code), 'verify scans from the restart moment, not a fixed short window (this app boots slowly)');
assert(/for _ in \$\(seq 1 30\)/.test(code) && /seen=failed/.test(code) && /board failed to initialise/.test(code),
  'verify polls up to ~90s and fails loudly if the board init errored');

// the switch is actually wired to the app: the facade reads exactly these env vars
const facade = readRepoFile('lib/board/index.js');
assert(/HERMES_BOARD_DISPATCH/.test(facade) && /HERMES_RUNNER_CMD/.test(facade), 'lib/board reads the env vars this script sets');

// discoverable: the .env template ships the vars OFF by default
const prov = readRepoFile('deploy/coding-instance/provision.sh');
assert(/HERMES_BOARD_DISPATCH=0/.test(prov), 'the provisioned .env template ships the dispatcher OFF by default');
assert(/HERMES_RUNNER_CMD=\/usr\/local\/bin\/hermes-task/.test(prov), 'the .env template names the runner command');

done();
