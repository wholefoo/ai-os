#!/usr/bin/env bash
# Re-run ONLY the provisioning checks, and say WHY each failure happened.
# Read-only: changes nothing. Run as root.
#
#   bash verify.sh

HERMES_USER=hermes
HERMES_HOME=/home/$HERMES_USER
APP_DIR=$HERMES_HOME/work/ai-os
UNIT=/etc/systemd/system/ai-os-hermes.service

# Never `set -e` here: a failing check is the point of this file.
set +e

NODE_BIN=$(cat "$HERMES_HOME/.node-bin-path" 2>/dev/null)
NODE_MAJOR_FOUND=$("$NODE_BIN/node" -v 2>/dev/null | sed 's/^v//; s/\..*//')
[ -n "$NODE_MAJOR_FOUND" ] || NODE_MAJOR_FOUND=0

fail=0
# check <label> <command> <what-to-do-if-it-fails>
check() {
  if eval "$2" >/dev/null 2>&1; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n         -> %s\n' "$1" "$3"
    fail=1
  fi
}

echo "Verifying (read-only)"
echo "  node bin resolved as: ${NODE_BIN:-<empty>}"
echo

check "user $HERMES_USER exists" \
  "id -u $HERMES_USER" \
  "adduser --disabled-password --gecos '' $HERMES_USER"

check "$HERMES_USER has NO sudo" \
  "! id -nG $HERMES_USER | grep -qw sudo" \
  "deluser $HERMES_USER sudo   (this box should not be administered by the agent)"

check "repo cloned" \
  "[ -d $APP_DIR/.git ]" \
  "re-run provision.sh; the clone step did not complete"

check "node satisfies engines (>=24)" \
  "[ \"$NODE_MAJOR_FOUND\" -ge 24 ]" \
  "found major '$NODE_MAJOR_FOUND'. Check: cat $HERMES_HOME/.node-bin-path"

check "node_modules present" \
  "[ -d $APP_DIR/node_modules ]" \
  "sudo -u $HERMES_USER PATH=$NODE_BIN:/usr/bin:/bin bash -c 'cd $APP_DIR && npm ci'"

check "node_modules NOT root-owned" \
  "[ \"\$(stat -c %U $APP_DIR/node_modules 2>/dev/null)\" = $HERMES_USER ]" \
  "owned by \$(stat -c %U $APP_DIR/node_modules 2>/dev/null). chown -R $HERMES_USER:$HERMES_USER $APP_DIR"

check ".env exists" \
  "[ -f $APP_DIR/.env ]" \
  "re-run provision.sh to write the template"

check ".env is 0600" \
  "[ \"\$(stat -c %a $APP_DIR/.env 2>/dev/null)\" = 600 ]" \
  "chmod 600 $APP_DIR/.env"

check "ufw active" \
  "ufw status | grep -q '^Status: active'" \
  "ufw --force enable"

check "fail2ban sshd jail running" \
  "fail2ban-client status sshd" \
  "systemctl restart fail2ban; systemctl status fail2ban -l"

check "sshd still accepts passwords" \
  "sshd -T | grep -qi '^passwordauthentication yes'" \
  "NOT necessarily a problem: it means key auth is already in force"

# 80/443 are expected once add-https.sh has run. The invariant is the APP port.
check "app port 3000 not exposed" \
  "! ufw status | grep -q '^3000' && ! ss -tln | grep -Eq '(0\.0\.0\.0|\[::\]|\*):3000 '" \
  "remove HOST= from .env, restart ai-os-hermes, and: ufw delete allow 3000/tcp"

if [ -f /etc/nginx/sites-enabled/hermes ]; then
  D=$(awk '/server_name/{gsub(";","",$2); print $2; exit}' /etc/nginx/sites-enabled/hermes)
  check "nginx config valid" "nginx -t" "nginx -t   (shows the error)"
  check "HTTPS answers with a trusted cert ($D)" \
    "curl -sS -o /dev/null --max-time 10 https://$D/" \
    "certbot certificates ; systemctl status nginx"
  check "certificate valid for 14+ days" \
    "openssl x509 -checkend 1209600 -noout -in /etc/letsencrypt/live/$D/fullchain.pem" \
    "certbot renew ; systemctl list-timers certbot.timer"
fi

check "swap on" \
  "swapon --show | grep -q swapfile" \
  "swapon /swapfile"

check "bubblewrap works (userns)" \
  "sudo -u $HERMES_USER bwrap --ro-bind / / --unshare-user true" \
  "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   (needed for Astro builds only)"

check "systemd unit installed" \
  "systemctl cat ai-os-hermes.service" \
  "re-run provision.sh with ai-os-hermes.service beside it"

check "unit's node is executable" \
  "[ -x $NODE_BIN/node ]" \
  "NODE_BIN is '$NODE_BIN'. Check: sudo -u $HERMES_USER bash -c '. \$HOME/.nvm/nvm.sh && nvm which default'"

check "unit ExecStart matches that node" \
  "grep -q '^ExecStart=$NODE_BIN/node server.js$' $UNIT" \
  "unit says: \$(grep '^ExecStart=' $UNIT 2>/dev/null)"

# The ABSOLUTE path matters: given a bare unit name, systemd-analyze searches
# the current directory FIRST. Run from /root, where the template lives, it
# validates the un-substituted template (@APP_DIR@ etc.) and reports a fatal
# error about a unit that is not the one systemd actually loaded.
# Trust the exit code rather than grepping the output, which is full of
# non-fatal "Accepting user/group name..." style notes.
check "systemd accepts the unit" \
  "systemd-analyze verify $UNIT" \
  "systemd-analyze verify $UNIT   (note the full path)"

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Failures above, each with the fix on the -> line."
fi
exit $fail
