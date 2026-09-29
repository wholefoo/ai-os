// Pins the safety + shape of the Coding Board dispatcher SERVICE: the standalone entrypoint
// (lib/board/run-dispatcher.js), its systemd unit (deploy/coding-instance/ai-os-board-dispatcher.service),
// and the enable script that installs/manages it. The dispatcher runs as its OWN unhardened `hermes`
// service — separate from the hardened web app — because the runner must `sudo` the launcher and chmod
// setgid task dirs, which the app unit's NoNewPrivileges/RestrictSUIDSGID block. Shell is read as text
// (CI has no systemd/root); comments are stripped from the "does X" checks so they can't false-match.
const { assert, done, readRepoFile } = require('./test-util');

const sh = readRepoFile('deploy/coding-instance/enable-board-dispatcher.sh');
const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const unit = readRepoFile('deploy/coding-instance/ai-os-board-dispatcher.service');
const entry = readRepoFile('lib/board/run-dispatcher.js');

// ---------- the entrypoint (what the service runs) -----------------------------------------------
assert(/board\.openDb\(path\.join\(MAGENT_DIR, 'board\.sqlite'\)\)/.test(entry), 'entrypoint opens the SAME board.sqlite the app uses (shared over WAL)');
assert(/process\.env\.HERMES_RUNNER_CMD/.test(entry), 'entrypoint takes the runner command from HERMES_RUNNER_CMD');
assert(/logDir: path\.join\(MAGENT_DIR, 'board-logs'\)/.test(entry), 'entrypoint persists run logs to .magent/board-logs');
assert(/dispatcher\.start\(\)/.test(entry), 'entrypoint starts the dispatcher pump');
assert(/on\('SIGTERM'/.test(entry) && /dispatcher\.stop\(\)/.test(entry), 'entrypoint stops cleanly on SIGTERM (systemd stop)');

// ---------- the systemd unit: unhardened ON PURPOSE ----------------------------------------------
// The whole reason this service exists is to NOT carry the app's seccomp hardening — those directives
// block the runner's sudo + setgid chmod. If a future edit adds them back, this test fails loudly.
assert(!/NoNewPrivileges\s*=\s*(yes|true)/i.test(unit), 'the dispatcher unit does NOT set NoNewPrivileges (it must sudo the launcher)');
assert(!/RestrictSUIDSGID\s*=\s*(yes|true)/i.test(unit), 'the dispatcher unit does NOT set RestrictSUIDSGID (it must chmod setgid task dirs)');
assert(/User=@HERMES_USER@/.test(unit) && /SupplementaryGroups=hermes-work/.test(unit), 'the dispatcher runs as the hermes user in the hermes-work group');
assert(/ExecStart=@NODE_BIN@\/node lib\/board\/run-dispatcher\.js/.test(unit), 'the unit runs the standalone entrypoint');
assert(/EnvironmentFile=@APP_DIR@\/\.env/.test(unit), 'the unit reads the app .env (runner config lives there)');
assert(/After=.*ai-os-hermes\.service/.test(unit), 'the dispatcher starts after the app so board.sqlite exists');

// ---------- the enable script: safe + correct ----------------------------------------------------
assert(/\[ "\$\(id -u\)" -eq 0 \]/.test(code), 'refuses unless run as root');
assert(/\[ "\$APP_USER" = "\$EXPECT_USER" \] \|\| die/.test(code) && /EXPECT_USER=\$\{EXPECT_USER:-hermes\}/.test(code),
  'refuses when the app user is not hermes');

// it does NOT weaken the web app or mint privileges: no sudoers writes, no editing the app unit
assert(!/(>>?\s*"?[^"\n]*sudoers)|(\b(install|tee|cp)\b[^\n]*sudoers)/.test(code), 'writes NO sudoers rule');
assert(!/\bvisudo\b/.test(code), 'never runs visudo');
assert(!/NoNewPrivileges|RestrictSUIDSGID/.test(code), 'does not touch the app unit hardening — it stands up a SEPARATE service instead');
assert(!/npm (ci|install)/.test(code) && !/apt-get/.test(code), 'runs no install/build');

// it installs + enables the SEPARATE service from the template, substituting the paths
assert(/DISP_SERVICE=\$\{DISP_SERVICE:-ai-os-board-dispatcher\}/.test(code), 'the dispatcher service name is ai-os-board-dispatcher');
assert(/sed -e "s\|@HERMES_USER@\|/.test(code) && /"s\|@NODE_BIN@\|/.test(code) && /> "\$UNIT_DST"/.test(code),
  'the unit template placeholders (@HERMES_USER@/@NODE_BIN@/@APP_DIR@) are substituted into the installed unit');
assert(/systemctl daemon-reload/.test(code) && /systemctl enable --now "\$DISP_SERVICE"/.test(code), 'installs, daemon-reloads, enables + starts the service');
assert(/systemctl is-active --quiet "\$DISP_SERVICE" \|\|/.test(code), 'fails loudly if the service does not come up');
assert(/\[board-dispatcher\] started/.test(code), 'verifies the dispatcher service logged that it started');

// the app is forced to NOT run the in-process pump (no double-dispatch), edited safely
assert(/HERMES_BOARD_DISPATCH=0/.test(code) && !/HERMES_BOARD_DISPATCH=1/.test(code), 'forces HERMES_BOARD_DISPATCH=0 in the app .env (the separate service is the only pump)');
const backupAt = code.indexOf('cp -p "$ENV_FILE"');
const editAt = code.indexOf('grep -vE');
assert(backupAt > 0 && editAt > backupAt, '.env is backed up before it is edited');
assert(/grep -vE '\^\(HERMES_BOARD_DISPATCH\|HERMES_RUNNER_CMD\|HERMES_BOARD_CONCURRENCY\|HERMES_BOARD_POLL_MS\)='/.test(code),
  'drops existing HERMES_BOARD_* keys before appending — no duplicate keys');
assert(/mv -f "\$tmp" "\$ENV_FILE"/.test(code), 'writes .env via temp+mv, never sed -i in place');

// --off tears down the service
assert(/MODE=off/.test(code) && /systemctl disable --now "\$DISP_SERVICE"/.test(code), '--off disables + stops the dispatcher service');

// discoverable defaults still ship OFF in the provisioned .env
const prov = readRepoFile('deploy/coding-instance/provision.sh');
assert(/HERMES_BOARD_DISPATCH=0/.test(prov), 'the provisioned .env template ships the in-process pump OFF');

done();
