#!/usr/bin/env bash
# Phase 1 of the coding instance: install Claude Code, the sandbox policy and the task runner.
#
#   bash install-claude-code.sh        # as root, with claude-policy.json and hermes-task beside it
#
# Prerequisites (the script refuses without them):
#   * provision.sh has run (the `hermes` user, Node 24 via nvm, ~/.node-bin-path)
#   * the subscription token is saved at ~hermes/.config/hermes-runner/claude-oauth-token (mode 600)
#
# What it installs, and who owns it — ownership is the point:
#   Claude Code          -> hermes's nvm prefix, installed AS hermes (never `sudo npm -g`)
#   sandbox policy       -> /etc/claude-code/managed-settings.json   root:root 644
#   task runner          -> /usr/local/bin/hermes-task               root:root 755
# The agent runs as hermes and can edit neither the policy that confines it nor the script that
# decides what gets pushed.
#
# Idempotent. Re-run it to upgrade Claude Code or to reinstall a changed policy or runner.
set -euo pipefail

H_USER=hermes
H_HOME=/home/$H_USER
TOKEN_FILE=$H_HOME/.config/hermes-runner/claude-oauth-token
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
POLICY_SRC=$SCRIPT_DIR/claude-policy.json
RUNNER_SRC=$SCRIPT_DIR/hermes-task
MIN_CLAUDE=2.1.259

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight ---
[ "$(id -u)" -eq 0 ] || die "run as root"
for f in "$POLICY_SRC" "$RUNNER_SRC"; do [ -f "$f" ] || die "$(basename "$f") not found next to this script"; done
id -u "$H_USER" >/dev/null 2>&1 || die "no '$H_USER' user — run provision.sh first"
NODE_BIN=$(cat "$H_HOME/.node-bin-path" 2>/dev/null || true)
[ -x "$NODE_BIN/node" ] || die "node not found via $H_HOME/.node-bin-path — run provision.sh first"
[ -s "$TOKEN_FILE" ] || die "no token at $TOKEN_FILE — save it first (see the coding-instance README)"
[ "$(stat -c '%a %U' "$TOKEN_FILE")" = "600 $H_USER" ] || die "$TOKEN_FILE must be mode 600, owned by $H_USER"
[ "$(wc -l < "$TOKEN_FILE")" -le 1 ] || die "$TOKEN_FILE has more than one line — re-save the token"

# Files copied from Windows carry CRLF; a CRLF shebang or JSON is broken on arrival.
sed -i 's/\r$//' "$POLICY_SRC" "$RUNNER_SRC"

# ------------------------------------------------------ sandbox dependencies ---
log "Installing sandbox dependencies (bubblewrap, socat, ripgrep)"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq bubblewrap socat ripgrep

# --------------------------------------------------------------- Claude Code ---
log "Installing Claude Code as $H_USER"
# As the user, into nvm's prefix: `sudo npm install -g` is what leaves root-owned files behind.
sudo -u "$H_USER" -H env PATH="$NODE_BIN:/usr/bin:/bin" HOME="$H_HOME" \
  npm install -g @anthropic-ai/claude-code@latest --no-audit --no-fund --loglevel=error
CLAUDE=$NODE_BIN/claude
[ -x "$CLAUDE" ] || die "claude not found at $CLAUDE after install"
VER=$(sudo -u "$H_USER" -H env PATH="$NODE_BIN:/usr/bin:/bin" "$CLAUDE" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ "$(printf '%s\n%s\n' "$MIN_CLAUDE" "$VER" | sort -V | head -1)" = "$MIN_CLAUDE" ] || die "Claude Code $VER is older than $MIN_CLAUDE"
log "Claude Code $VER"

# ------------------------------------------------------------------- policy ---
log "Installing the sandbox policy (root-owned managed settings)"
"$NODE_BIN/node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$POLICY_SRC" || die "claude-policy.json is not valid JSON"
install -d -o root -g root -m 755 /etc/claude-code
install -o root -g root -m 644 "$POLICY_SRC" /etc/claude-code/managed-settings.json

# ------------------------------------------------------------------- runner ---
log "Installing the task runner (root-owned)"
install -o root -g root -m 755 "$RUNNER_SRC" /usr/local/bin/hermes-task
install -d -o "$H_USER" -g "$H_USER" -m 700 "$H_HOME/tasks"

# The base clone needs an upstream remote the runner can fetch from — credential-less HTTPS, so
# it can fetch and can never push.
BASE=$H_HOME/work/ai-os
if ! sudo -u "$H_USER" -H git -C "$BASE" remote get-url upstream >/dev/null 2>&1; then
  sudo -u "$H_USER" -H git -C "$BASE" remote add upstream https://github.com/wholefoo/ai-os.git
fi

# ------------------------------------------------------------------- verify ---
log "Verifying"
set +e
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
check "claude runs as $H_USER (v$VER)"          "sudo -u $H_USER -H env PATH=$NODE_BIN:/usr/bin:/bin $CLAUDE --version"
check "claude files owned by $H_USER, not root" "[ \"\$(stat -c %U \$(readlink -f $CLAUDE))\" = $H_USER ]"
check "policy is root:root 644"                 "[ \"\$(stat -c '%U:%G %a' /etc/claude-code/managed-settings.json)\" = 'root:root 644' ]"
check "runner is root:root 755"                 "[ \"\$(stat -c '%U:%G %a' /usr/local/bin/hermes-task)\" = 'root:root 755' ]"
check "$H_USER cannot write the policy"         "! sudo -u $H_USER test -w /etc/claude-code/managed-settings.json"
check "$H_USER cannot write the runner"         "! sudo -u $H_USER test -w /usr/local/bin/hermes-task"
check "bubblewrap works as $H_USER"             "sudo -u $H_USER bwrap --ro-bind / / --unshare-user true"
check "socat present"                           "command -v socat"
check "base clone has a fetch-only upstream"    "sudo -u $H_USER -H git -C $BASE remote get-url upstream | grep -q '^https://'"
check "token file 600 $H_USER, one line"        "[ \"\$(stat -c '%a %U' $TOKEN_FILE)\" = '600 $H_USER' ] && [ \"\$(wc -l < $TOKEN_FILE)\" -le 1 ]"
set -e

echo
if [ "$fail" -ne 0 ]; then echo "Some checks FAILED above. Fix them before running any task."; exit 1; fi
cat <<NEXT
Installed. Now prove it, in this order — each step must pass before the next:

  1. Which credential is Claude Code using? (a one-line request on your subscription)
       sudo -iu $H_USER hermes-task --auth-check
     Expect: AUTH CHECK: PASS, and apiKeySource that is NOT ANTHROPIC_API_KEY.

  2. Can the agent reach anything it shouldn't?
       sudo -iu $H_USER hermes-task --probe
     Expect: PROBE: PASS. INCONCLUSIVE means the model skipped a step: re-run it; it is not a pass.

  3. A first real task, small and safe:
       sudo -iu $H_USER hermes-task "Fix one typo or unclear sentence in README.md"
     Expect: RESULT: pushed, and a link to open the draft PR.
NEXT
