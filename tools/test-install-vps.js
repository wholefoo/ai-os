// Pins the install lessons from provisioning a fresh Debian 13 box (2026-09-20). Each assertion
// below names a failure that happened for real — a fresh install that stopped half-way, an SSH
// lockout, a verify block that died silently — so a later edit cannot quietly bring one back.
//
// Repo convention: shell is read as text, not executed (CI has no root, nginx or systemd). The
// fragments that CAN run off-box (the .env secret filler, the printed TLS commands, the admin-hash
// helper) were exercised against fixtures when this suite was written; this pins their shape.
const { assert, done, readRepoFile } = require('./test-util');

const inst = readRepoFile('deploy/install-vps.sh');
const tpl = readRepoFile('deploy/nginx.conf');
// Executable lines only: comments may (and do) quote the old, wrong commands to explain them.
const code = inst.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const at = (s) => inst.indexOf(s);

// ---------- 1. a fresh install gets past nginx -----------------------------------------------------
// The full vhost used an `aios_vhost` log format the installer never installed, and named a
// certificate that did not exist yet. Either failed `nginx -t` under `set -e`, so step 13 ended the
// run before .env, PM2 or the health check existed.
const firstNginxT = code.indexOf('nginx -t');
const logfmt = code.indexOf('/etc/nginx/conf.d/aios-logformat.conf');
assert(logfmt > 0, 'the installer installs deploy/aios-logformat.conf into conf.d');
assert(logfmt < firstNginxT, 'the log format is installed BEFORE the first `nginx -t`');
assert(/log_format aios_vhost/.test(readRepoFile('deploy/aios-logformat.conf')),
  'the installed file really defines the aios_vhost format the vhost uses');

const certGate = inst.indexOf('if [ -f "$CERT" ]; then');
const fullWrite = inst.indexOf('  write_full_vhost\n');
assert(certGate > 0 && fullWrite > certGate,
  'the full HTTPS vhost is written only once the certificate file exists');
assert(/write_bootstrap_vhost\n\s*nginx -t && systemctl reload nginx/.test(inst),
  'without a certificate, an HTTP bootstrap vhost is brought up first (it answers the ACME challenge)');
assert(!/^\s*(sudo\s+)?certbot\s+--nginx/m.test(code),
  'certbot --nginx is not run: it rewrites the vhost this script manages');
assert(/certbot certonly --webroot -w "\$ACME_ROOT"/.test(inst),
  'the certificate is obtained with certonly --webroot');
assert(/getent ahostsv4 "\$\{DOMAIN\}"/.test(inst) && /grep -qx "\$DNS_IP"/.test(inst),
  'a certificate is only requested when the domain resolves to THIS server (not a CDN proxy)');
assert(/cp "\$\{VHOST\}\.prev" "\$VHOST"/.test(inst),
  'a full vhost that fails nginx -t is rolled back rather than left in place');

// Renewal reuses the webroot, so the template's HTTP server must answer the challenge, not redirect it.
const httpBlock = tpl.slice(tpl.indexOf('server {'), tpl.indexOf('}', tpl.indexOf('server {')) + 60);
assert(/location \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/aios-acme; \}/.test(httpBlock),
  'deploy/nginx.conf HTTP block serves the ACME challenge from /var/www/aios-acme');
assert(/ACME_ROOT=\/var\/www\/aios-acme/.test(inst), 'installer and template agree on the ACME webroot');

// ---------- 2. fail2ban on Debian 12+ -----------------------------------------------------------------
// Debian 12+ ships no rsyslog, so /var/log/auth.log does not exist; a jail pointed at it fails to
// start and `systemctl restart fail2ban` failed the install.
assert(!/logpath\s*=\s*\/var\/log\/auth\.log/.test(code), 'fail2ban does not read the absent /var/log/auth.log');
assert(/\[sshd\][\s\S]*?backend\s*=\s*systemd/.test(inst), 'the sshd jail reads the journal (backend = systemd)');
assert(/install -y -qq fail2ban python3-systemd/.test(inst), 'python3-systemd is installed for that backend');
assert(/fail2ban-client status sshd >\/dev\/null/.test(inst),
  'the step checks the jail is RUNNING rather than reporting success unconditionally');

// ---------- 3. --harden-ssh cannot lock you out ---------------------------------------------------------
const guard = at('SSH-hardening lockout guard');
assert(guard > 0 && guard < at('[1/${TOTAL_STEPS}]'), 'the lockout guard runs before step 1 (before any work)');
const guardBody = inst.slice(guard, at('[1/${TOTAL_STEPS}]'));
// The CONDITION must parse the key. Matching `ssh-keygen -l -f` anywhere is not enough: the guard's
// own error message tells the operator to run that command, so a check that had been weakened back
// to `test -s` still passed a loose match (caught by mutation testing).
assert(/if ssh-keygen -l -f "\$home\/\.ssh\/authorized_keys" >\/dev\/null 2>&1; then SSH_OK_USER=/.test(guardBody),
  'a key is proven by PARSING authorized_keys — a pasted fingerprint is non-empty and authenticates nothing');
assert(/getent group sudo/.test(guardBody), 'the key must belong to a non-root sudo user (root login is being disabled)');
assert(/\berr "--harden-ssh REFUSED/.test(guardBody), 'the guard REFUSES (err exits), it does not just warn');
assert(/sshd_config\.d\/00-aios-hardening\.conf/.test(inst),
  'hardening is a 00- drop-in, so a cloud-init drop-in cannot silently override it (sshd: first value wins)');
assert(!/^\s*sed -i .*PasswordAuthentication.*sshd_config/m.test(code), 'sshd_config itself is not sed-edited');
assert(/sshd -T 2>\/dev\/null \| grep -qi '\^passwordauthentication no'/.test(inst),
  'the result is verified against the EFFECTIVE config (sshd -T)');
assert(/rm -f "\$DROPIN"/.test(inst), 'a drop-in that fails sshd -t is removed, not left for the next reboot');
assert(!/Protocol 2/.test(code), 'the obsolete `Protocol 2` directive is no longer written');

// ---------- 4. first boot has auth; secrets are not clobbered -------------------------------------------
assert(/fill_if_blank API_TOKEN/.test(inst) && /fill_if_blank SESSION_SECRET/.test(inst),
  'blank API_TOKEN / SESSION_SECRET are generated, so the first boot is not "Auth: disabled"');
assert(!/fill_if_blank AIOS_SECRETS_KEY/.test(inst),
  'AIOS_SECRETS_KEY is NOT auto-generated — losing it makes sealed settings unreadable');
assert(/grep -q "\^\$\{key\}=\$" "\$f"/.test(inst), 'only an EMPTY value is filled; a set value is never overwritten');

// ---------- 5. the printed instructions are ones that work ------------------------------------------------
const echoes = inst.split('\n').filter((l) => /^\s*echo /.test(l)).join('\n');
assert(!/sudo -u \$\{APP_USER\} pm2/.test(echoes),
  'printed pm2 commands use `sudo -iu` — plain `sudo -u` reaches an empty daemon under /root/.pm2');
assert(!/require\('bcryptjs'\)\.hash\('YOUR_PASSWORD'/.test(inst),
  'the password one-liner (plaintext in history + ps, cwd-dependent require) is replaced');
assert(/deploy\/make-admin-hash\.sh/.test(echoes), 'next steps point at the hidden-input hash helper');
assert(/created ONCE/.test(echoes), 'next steps warn the admin account is seeded once');
assert(!/software-properties-common/.test(code), 'no unused package that may be absent from a release');
assert(!/sudo sed [^\n|]*> \/etc\//.test(echoes) && /\| sudo tee \/etc\/nginx\/sites-available\/ai-os/.test(echoes),
  'printed commands write /etc via `| sudo tee` — `sudo cmd > /etc/x` redirects as the caller and is denied');

// ---------- 6. the verify block reports instead of dying --------------------------------------------------
const verify = inst.slice(at('# Verify — report every check'), at('# Done!'));
assert(verify.indexOf('set +e') >= 0 && verify.indexOf('set +e') < verify.indexOf('vcheck()'),
  'set -e is OFF before the checks: an assignment from a failing pipeline would end the script silently');
assert(/node_modules owned by/.test(verify), 'it checks node_modules is not root-owned');
assert(/app port 3000 not exposed/.test(verify), 'it checks the app port is not public');

// ---------- 7. the hash helper ---------------------------------------------------------------------------------
const hash = readRepoFile('deploy/make-admin-hash.sh');
// Code lines only — the header comment quotes the old one-liner on purpose, to explain the change.
const hashCode = hash.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
assert(/read -r -s -p/.test(hashCode), 'the password is read hidden');
assert(/process\.env\.AIOS_PW/.test(hashCode) && !/hash\('/.test(hashCode), 'the password reaches node via env, never argv');
assert(/node_modules\/bcryptjs/.test(hash), 'bcryptjs is resolved from the app, not the current directory');

// ---------- 8. line endings ---------------------------------------------------------------------------------------
const ga = readRepoFile('.gitattributes');
for (const pat of ['*.sh', '*.service', '*.conf', 'deploy/**']) {
  assert(new RegExp('^' + pat.replace(/[.*]/g, (c) => '\\' + c) + '\\s+text eol=lf$', 'm').test(ga),
    `.gitattributes forces LF for ${pat} (a CRLF script fails: /usr/bin/env: 'bash\\r')`);
}
assert(!/^\*\s+text=auto/m.test(ga), 'no repo-wide text=auto (it would renormalise every file)');

// ---------- 9. the public docs match the installer ----------------------------------------------------------------
const dep = readRepoFile('dashboard/docs/deployment.html');
assert(!/Node\.js 20/.test(dep) && !/node:20-alpine/.test(dep),
  'deployment docs no longer say Node 20 (installer + Dockerfile use 24, and engines requires it)');
assert(!/certbot --nginx -d/.test(dep), 'deployment docs no longer tell operators to run certbot --nginx');

// ---------- 10. deploy/coding-instance ------------------------------------------------------------------------------
const ci = (f) => readRepoFile('deploy/coding-instance/' + f);
const prov = ci('provision.sh'), ver = ci('verify.sh'), https = ci('add-https.sh'), unit = ci('ai-os-hermes.service');
const all = [prov, ver, https, unit, ci('README.md')].join('\n');
assert(!/aimarketaudit|45\.76\.|Web Admin Files/.test(all), 'no single operator\'s hostname, IP or local path is published');
assert(/DOMAIN=\$\{DOMAIN:\?/.test(https), 'add-https.sh requires DOMAIN instead of defaulting to someone else\'s host');
assert(/NODE_MAJOR=\$\{NODE_MAJOR:-24\}/.test(prov), 'the coding instance installs Node 24 (engines requires >= 24)');
assert(/nvm which default/.test(prov) && !/bash -lc 'node/.test(prov),
  'the node path is resolved inside the nvm session, never via a non-interactive login shell');
assert(/systemd-analyze verify \/etc\/systemd\/system\/ai-os-hermes\.service/.test(prov) &&
  /systemd-analyze verify \$UNIT/.test(ver), 'systemd-analyze gets an ABSOLUTE path (a bare name searches the CWD first)');
assert(/set \+e/.test(prov) && /set \+e/.test(ver), 'both verify blocks run with set -e off');
assert(!/^[^#]*\/etc\/ssh/m.test(prov), 'the provisioner never edits /etc/ssh (no lockout path)');
assert(/AIOS_HARD_BUDGET=true/.test(prov) && /AIOS_AUTOMATION_MODE=supervised/.test(prov),
  'the unattended .env template turns the cost kill-switch ON and keeps the approval gate');
assert(/Journal matches|backend\s*=\s*systemd/.test(prov), 'its fail2ban jail reads the journal');
assert(/Auth: enabled/.test(https) && /No admin seeded/.test(https),
  'add-https.sh refuses to publish until the RUNNING app logged auth on and an admin seeded');
assert(/location = \/api\/auth\/login/.test(https),
  'the strict login rate limit is an EXACT match — a prefix would throttle /api/auth/me on every page load');

done();
