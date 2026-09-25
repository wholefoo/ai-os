#!/usr/bin/env bash
# Phase 1b: an operating-system boundary under the agent, because the Claude Code sandbox confined
# reads but not writes on this box. Creates a confined `hermes-agent` user that runs Claude Code,
# owns nothing outside the current task tree, and cannot read or write /home/hermes's secrets — the
# kernel enforces it regardless of the sandbox.
#
#   bash install-agent-user.sh        # as root, with hermes-agent-launch beside it
#
# Prerequisites: provision.sh and install-claude-code.sh have run (the `hermes` user, Node 24 via
# nvm at ~/.node-bin-path, Claude Code, /etc/claude-code/managed-settings.json). Idempotent.
set -euo pipefail

H_USER=hermes
H_HOME=/home/$H_USER
AGENT=hermes-agent
GROUP=hermes-work
TASKS=$H_HOME/tasks
LAUNCH_SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/hermes-agent-launch
SUDOERS=/etc/sudoers.d/hermes-agent
NODE_BIN=$(cat "$H_HOME/.node-bin-path" 2>/dev/null || true)

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$LAUNCH_SRC" ] || die "hermes-agent-launch not found next to this script"
id -u "$H_USER" >/dev/null 2>&1 || die "no '$H_USER' user — run provision.sh first"
[ -x "$NODE_BIN/node" ] || die "node not found via $H_HOME/.node-bin-path"
[ -x "$NODE_BIN/claude" ] || die "claude not found — run install-claude-code.sh first"
command -v setpriv >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq util-linux; }
sed -i 's/\r$//' "$LAUNCH_SRC"

# ---- group + confined user -----------------------------------------------------------------------
log "Creating group $GROUP and confined user $AGENT"
getent group "$GROUP" >/dev/null || groupadd "$GROUP"
if ! id -u "$AGENT" >/dev/null 2>&1; then
  # Primary group is the shared work group, so files the agent creates in a task are readable and
  # committable by hermes. No password and no key means no way to log in.
  useradd -m -g "$GROUP" -s /bin/bash "$AGENT"
  passwd -l "$AGENT" >/dev/null
fi
usermod -aG "$GROUP" "$H_USER"
chmod 750 "/home/$AGENT"

# ---- lock down /home/hermes ----------------------------------------------------------------------
# 0711: other users may TRAVERSE to a known path (the tasks tree, node) but cannot list the home or
# read its files. The secret subdirectories are 0700, so traversal stops at them.
log "Locking /home/$H_USER (0711) and its secret subdirectories (0700)"
chmod 711 "$H_HOME"
for d in .ssh .config work .nvm/.cache; do [ -e "$H_HOME/$d" ] && chmod 700 "$H_HOME/$d"; done
[ -f "$H_HOME/.bash_history" ] && chmod 600 "$H_HOME/.bash_history"
# node/claude must stay executable by the agent: .nvm itself and the version tree are traversable
# and world-readable (they hold no secrets), only its cache is closed above.
chmod 755 "$H_HOME/.nvm" 2>/dev/null || true

# ---- shared tasks tree ---------------------------------------------------------------------------
# 2770 setgid, owned hermes:hermes-work: hermes creates each workspace, the agent (in the group)
# reads and writes it, and new files inherit the group so hermes can commit them.
log "Preparing the shared tasks tree at $TASKS"
mkdir -p "$TASKS"
chown "$H_USER:$GROUP" "$TASKS"
chmod 2770 "$TASKS"

# ---- launcher + sudoers --------------------------------------------------------------------------
log "Installing the launcher (root-owned) and the scoped sudoers rule"
install -o root -g root -m 755 "$LAUNCH_SRC" /usr/local/sbin/hermes-agent-launch
# hermes may run ONLY the launcher, as root, without a password. hermes-agent gets no sudo at all.
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/hermes-agent-launch\n' "$H_USER" > "$SUDOERS.tmp"
chmod 440 "$SUDOERS.tmp"
if visudo -cf "$SUDOERS.tmp" >/dev/null 2>&1; then mv -f "$SUDOERS.tmp" "$SUDOERS"
else rm -f "$SUDOERS.tmp"; die "sudoers rule failed visudo -c — not installed"; fi

# ---- verify --------------------------------------------------------------------------------------
log "Verifying (the kernel boundary, proven by trying it)"
set +e
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
check "$AGENT exists, no login"              "passwd -S $AGENT | grep -qE ' L '"
check "$AGENT primary group is $GROUP"       "[ \"\$(id -gn $AGENT)\" = $GROUP ]"
check "$H_USER is in $GROUP"                 "id -nG $H_USER | grep -qw $GROUP"
check "/home/$H_USER is 0711"               "[ \"\$(stat -c %a $H_HOME)\" = 711 ]"
check "$AGENT CANNOT read the token dir"     "! sudo -u $AGENT test -r $H_HOME/.config"
check "$AGENT CANNOT read ~/.ssh"            "! sudo -u $AGENT test -r $H_HOME/.ssh"
check "$AGENT CANNOT read ~/work"            "! sudo -u $AGENT test -r $H_HOME/work"
check "$AGENT CANNOT create a file in ~hermes" "! sudo -u $AGENT bash -c 'touch $H_HOME/probe-should-fail 2>/dev/null'; ! test -e $H_HOME/probe-should-fail"
check "$AGENT CAN run node"                  "sudo -u $AGENT $NODE_BIN/node -e 'process.exit(0)'"
check "$AGENT CAN write the tasks tree"      "sudo -u $AGENT bash -c 'd=$TASKS/.probe-\$\$; mkdir \$d && rmdir \$d'"
check "launcher is root:root 755"            "[ \"\$(stat -c '%U:%G %a' /usr/local/sbin/hermes-agent-launch)\" = 'root:root 755' ]"
check "$AGENT has NO sudo"                   "! sudo -u $AGENT -n true 2>/dev/null"
check "$H_USER may run the launcher"         "sudo -l -U $H_USER 2>/dev/null | grep -q hermes-agent-launch"
rm -f "$H_HOME/probe-should-fail"
set -e

echo
[ "$fail" -eq 0 ] || die "some checks failed above — do not run tasks until the boundary holds"
cat <<DONE
The operating-system boundary is in place. hermes-agent runs Claude Code and cannot read the token,
the deploy key or ~/work, nor write anywhere under /home/$H_USER except the shared tasks tree.

Re-run the probe — this time the home-directory writes must be refused by the kernel:
  sudo -iu $H_USER hermes-task --probe
DONE
