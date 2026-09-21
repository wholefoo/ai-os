#!/usr/bin/env bash
# Provision a Debian 13 (trixie) KVM box as an isolated AI OS / Hermes coding instance.
# Keep it SEPARATE from any server that hosts production or customer sites — see README.md here.
#
# Run ONCE, as root, on a FRESH box:
#     bash provision.sh
#
# What it deliberately does NOT do:
#   * install any web server, open any port but 22, or request a TLS certificate
#   * copy credentials from the production VPS (paste them by hand into .env afterwards)
#   * start the service (you fill in .env first, then `systemctl enable --now ai-os-hermes`)
#
# It is idempotent: re-running it is safe.

set -euo pipefail

HERMES_USER=hermes
HERMES_HOME=/home/$HERMES_USER
APP_DIR=$HERMES_HOME/work/ai-os
REPO=${REPO:-https://github.com/wholefoo/ai-os.git}
# The repo declares engines.node ">=24.0.0" and CI runs 24. Do not lower this
# without changing both — npm only WARNS on an engine mismatch, so a too-old
# Node installs cleanly here and fails at runtime instead.
NODE_MAJOR=${NODE_MAJOR:-24}

# Resolve the unit file next to this script, and fail NOW rather than after
# several minutes of installing and cloning.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNIT_SRC=$SCRIPT_DIR/ai-os-hermes.service

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
[ -f "$UNIT_SRC" ] || {
  echo "ai-os-hermes.service not found next to this script (looked in $SCRIPT_DIR)."
  echo "Copy BOTH files to the same directory and re-run."
  exit 1
}
. /etc/os-release
[ "${ID:-}" = debian ] || warn "expected Debian, found ${ID:-unknown} — continuing anyway"
[ "${VERSION_ID:-}" = 13 ] || warn "expected Debian 13 (trixie), found ${VERSION_ID:-unknown}"

# ---------------------------------------------------------------- on SSH -----
# This script does NOT touch sshd. Password authentication stays exactly as the
# provider configured it, and nothing here can lock you out.
#
# That is a deliberate choice, not an oversight. The trade: a box on a public IP
# with password login is probed by bots within hours of existing (they turned up
# on the last one inside a day). fail2ban below is what carries that weight, so
# it is configured explicitly rather than left to defaults.
#
# Two things worth doing by hand, neither of which needs keys:
#   * a long random root password, not one you use anywhere else
#   * if your home IP is stable, restrict SSH to it:
#       ufw delete allow 22/tcp && ufw allow from <your-ip> to any port 22 proto tcp
#     Set SSH_ALLOW_FROM=<your-ip> below and this script does it for you.

# ---------------------------------------------------------------- packages ---
log "Updating and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  git curl ca-certificates gnupg jq unzip \
  build-essential python3 \
  bubblewrap \
  ufw fail2ban \
  unattended-upgrades

# ------------------------------------------------------------------- swap ---
# 2 GB. On 4 GB of RAM this is insurance, not a working set: it turns a rare
# overlap of `npm ci` and an Astro build from an OOM kill into a slow minute.
if ! swapon --show | grep -q '/swapfile'; then
  log "Creating 2 GB swapfile"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM; only reach for swap under real pressure.
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-hermes-swap.conf
  sysctl -q -p /etc/sysctl.d/99-hermes-swap.conf
else
  log "Swap already present, skipping"
fi

# --------------------------------------------------------------- firewall ---
log "Configuring ufw (SSH only)"
# No `ufw --force reset`: re-running this script must not silently delete the
# 80/443 rules that add-https.sh adds, taking the dashboard offline.
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
if [ -n "${SSH_ALLOW_FROM:-}" ]; then
  # Narrowing SSH to one source address is the single biggest win available
  # without keys — the bot traffic simply never reaches sshd.
  ufw allow from "$SSH_ALLOW_FROM" to any port 22 proto tcp >/dev/null
  log "SSH restricted to $SSH_ALLOW_FROM (the provider's web console still works if that changes)"
else
  ufw allow 22/tcp >/dev/null
fi
ufw --force enable >/dev/null

# ------------------------------------------------------------ ssh hardening --
log "Leaving sshd untouched (password login stays as the provider set it)"

# fail2ban is now the only thing between a password prompt and the internet, so
# configure the sshd jail explicitly rather than trusting distro defaults to
# have enabled it. Debian ships fail2ban with most jails off.
log "Configuring fail2ban for sshd"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
port     = ssh
maxretry = 5
findtime = 10m
bantime  = 1h
# Repeat offenders get progressively longer bans instead of retrying forever.
bantime.increment = true
bantime.factor    = 2
bantime.maxtime   = 1w
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || warn "fail2ban failed to restart — check: systemctl status fail2ban"

# ------------------------------------------------------- unprivileged userns --
# Bubblewrap needs unprivileged user namespaces. Debian 13 ships AppArmor with
# a restriction on them; the sysctl below is a no-op on kernels that lack the
# knob, so it is safe either way. Verified at the end of this script.
log "Allowing unprivileged user namespaces (needed by bubblewrap)"
cat > /etc/sysctl.d/99-hermes-userns.conf <<'EOF'
kernel.apparmor_restrict_unprivileged_userns=0
EOF
sysctl -q -p /etc/sysctl.d/99-hermes-userns.conf 2>/dev/null || true

# ------------------------------------------------------------------- user ---
if ! id -u "$HERMES_USER" >/dev/null 2>&1; then
  log "Creating user $HERMES_USER"
  adduser --disabled-password --gecos "" "$HERMES_USER"
else
  log "User $HERMES_USER already exists"
fi

# Deliberately NOT added to sudo. This box builds branches; it does not
# administer anything. You su to it from root when you need a shell.
install -d -m 0700 -o "$HERMES_USER" -g "$HERMES_USER" "$HERMES_HOME/.ssh"
# No key handling. To get a shell as this user:  su - hermes   (from root)
#
# $HERMES_USER has NO password set, so they cannot log in over SSH at all. That
# is fine and slightly safer — the account exists to own files and run the
# service, not to be logged into. If you later want direct SSH as them, either
# set a password (passwd hermes) or drop a key in $HERMES_HOME/.ssh/.

# ------------------------------------------------- node + repo, AS the user ---
# Everything below runs as $HERMES_USER. Running npm as root in the app dir is
# what left root-owned node_modules on the production box and broke the next
# deploy; this script never does it.
log "Installing Node $NODE_MAJOR via nvm and cloning the repo (as $HERMES_USER)"
sudo -u "$HERMES_USER" -H bash -euo pipefail <<USERSETUP
export HOME=$HERMES_HOME
export NVM_DIR=\$HOME/.nvm
# sudo keeps root's cwd (/root), which $HERMES_USER cannot read — nvm's
# installer then prints "find: Failed to restore initial working directory".
# Harmless, but it looks like a failure. Start somewhere readable.
cd "\$HOME"

if [ ! -s "\$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "\$NVM_DIR/nvm.sh"
nvm install $NODE_MAJOR
nvm alias default $NODE_MAJOR

mkdir -p \$HOME/work
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
else
  echo "repo already cloned, skipping"
fi

cd "$APP_DIR"
npm ci
echo "node: \$(node -v)  npm: \$(npm -v)"

# Record the resolved bin directory for the parent shell.
#
# Do NOT discover this later with \`bash -lc\`: Debian's ~/.bashrc returns early
# for non-interactive shells, and nvm's init is appended AFTER that return — so
# a non-interactive login shell has no node on PATH and no \$NVM_DIR. Resolving
# it HERE, where nvm is demonstrably loaded, is the only reliable moment.
dirname "\$(nvm which default)" > \$HOME/.node-bin-path
USERSETUP

# Read the path nvm resolved for us above. No `|| true` fallback: a wrong path
# here produces a unit that cannot start, and an earlier version of this script
# masked exactly that failure into a plausible-looking but broken ExecStart.
NODE_BIN=$(cat "$HERMES_HOME/.node-bin-path" 2>/dev/null || true)
if [ ! -x "$NODE_BIN/node" ]; then
  echo "could not resolve node's bin dir (got '${NODE_BIN:-empty}')." >&2
  echo "Check: sudo -u $HERMES_USER -H bash -c '. \$HOME/.nvm/nvm.sh && nvm which default'" >&2
  exit 1
fi
log "node bin: $NODE_BIN"

# --------------------------------------------------------------- .env stub ---
if [ ! -f "$APP_DIR/.env" ]; then
  log "Writing .env template (FILL THIS IN before starting the service)"
  cat > "$APP_DIR/.env" <<'ENVTEMPLATE'
# ---- Identity of THIS instance -------------------------------------------
# A distinct state dir keeps this box's state from ever colliding with prod's.
AIOS_STATE_SUBDIR=hermes-coder
NODE_ENV=production
PORT=3000

# ---- Credentials: paste by hand. Do NOT copy prod's .env wholesale. -------
# A SEPARATE Anthropic key with its OWN spend cap set in the Anthropic console.
ANTHROPIC_API_KEY=
# Admin login for this instance's dashboard (its own, not prod's).
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
API_TOKEN=
# Fine-grained GitHub PAT: Contents=write on the ai-os repo ONLY.
# Protect master with a branch rule so this token cannot merge or force-push.
AIOS_SELF_IMPROVE_GITHUB_PAT=

# ---- Guardrails for an UNATTENDED box ------------------------------------
# Hard cost kill-switch. Off by default in the app; ON here is the whole point
# of running unattended — a runaway overnight loop stops at the ceiling.
AIOS_HARD_BUDGET=true
# Keep the approval gate. 'auto' would let irreversible actions through
# with nobody awake to see them.
AIOS_AUTOMATION_MODE=supervised
# Default concurrency is 8, sized for a bigger box. 3 fits 4 GB with an
# Astro build running alongside.
AGENT_MAX_CONCURRENCY=3
# Per-call wall clock (default 900000 = 15 min). This is the real per-task
# timeout; the systemd unit deliberately does not restart the server on a timer.
AGENT_CALL_MAX_TOTAL_MS=900000
ENVTEMPLATE
  chown "$HERMES_USER:$HERMES_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  log ".env already exists, left untouched"
fi

# ----------------------------------------------------------- systemd unit ---
log "Installing ai-os-hermes.service"
sed -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@HERMES_USER@|$HERMES_USER|g" \
    -e "s|@HERMES_HOME@|$HERMES_HOME|g" \
    -e 's/\r$//' \
    "$UNIT_SRC" > /etc/systemd/system/ai-os-hermes.service
systemctl daemon-reload

# ------------------------------------------------------------ unattended ---
log "Enabling unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ------------------------------------------------------------- verify -------
log "Verifying"
# `set -e` must not apply from here on: a FAILING CHECK IS THE POINT of this
# block, and an earlier version aborted the whole script — silently — on the
# first command that returned non-zero. The verify block has to survive its own
# failures in order to report them.
set +e
fail=0

# npm only WARNS on an engines mismatch, so a too-old Node installs cleanly and
# fails at runtime instead. Use the absolute path, never a login shell.
NODE_MAJOR_FOUND=$("$NODE_BIN/node" -v 2>/dev/null | sed 's/^v//; s/\..*//')
[ -n "$NODE_MAJOR_FOUND" ] || NODE_MAJOR_FOUND=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

check "user $HERMES_USER exists"          "id -u $HERMES_USER"
check "$HERMES_USER has NO sudo"          "! id -nG $HERMES_USER | grep -qw sudo"
check "repo cloned"                       "[ -d $APP_DIR/.git ]"
check "node satisfies engines (>=24)"     "[ \"\$NODE_MAJOR_FOUND\" -ge 24 ]"
check "node_modules present"              "[ -d $APP_DIR/node_modules ]"
check "node_modules NOT root-owned"       "[ \"\$(stat -c %U $APP_DIR/node_modules)\" = $HERMES_USER ]"
check ".env is 0600"                      "[ \"\$(stat -c %a $APP_DIR/.env)\" = 600 ]"
check "ufw active"                        "ufw status | grep -q '^Status: active'"
# fail2ban carries the whole load now that passwords are allowed, so prove the
# jail is actually RUNNING rather than merely that the package is installed.
check "fail2ban sshd jail running"        "fail2ban-client status sshd"
check "sshd still accepts passwords"      "sshd -T | grep -qi '^passwordauthentication yes'"
# 80/443 are legitimately open once add-https.sh has run; the invariant is that
# the APP port never is — nginx is the only thing facing the internet.
check "app port 3000 not exposed"         "! ufw status | grep -q '^3000' && ! ss -tln | grep -Eq '(0\.0\.0\.0|\[::\]|\*):3000 '"
check "swap on"                           "swapon --show | grep -q swapfile"
check "bubblewrap works (userns)"         "sudo -u $HERMES_USER bwrap --ro-bind / / --unshare-user true"
check "systemd unit installed"            "systemctl cat ai-os-hermes.service"
# The unit is useless if ExecStart points at a node that is not there — the
# failure this script previously masked with a '|| true'.
check "unit's node is executable"         "[ -x $NODE_BIN/node ]"
check "unit ExecStart matches that node"  "grep -q '^ExecStart=$NODE_BIN/node server.js$' /etc/systemd/system/ai-os-hermes.service"
# Absolute path: a bare name makes systemd-analyze search the CWD first, where
# the un-substituted TEMPLATE lives — it then reports a fatal error about the
# wrong file. Trust the exit code, not a grep of its chatty output.
check "systemd accepts the unit"          "systemd-analyze verify /etc/systemd/system/ai-os-hermes.service"

echo
if [ "$fail" -eq 0 ]; then
  cat <<DONE
Provisioning complete, and nothing is running yet — by design.

Next, in order:
  1. Fill in $APP_DIR/.env   (every blank credential; use a SEPARATE Anthropic key)
  2. Apply the GitHub rules in README.md (this folder), and RUN ITS PROBE.
     Master's existing protection does NOT stop a push from this box on its own:
     PRs are not required, and enforce_admins is false so a PAT minted from an
     admin account bypasses the lot.
  3. Prove the box before trusting it. Note the explicit PATH: a non-interactive
     login shell does NOT load nvm on Debian (~/.bashrc returns early), so
     'bash -lc npm test' would fail with "npm: not found".

       sudo -u $HERMES_USER PATH=$NODE_BIN:/usr/bin:/bin \\
         bash -c 'cd $APP_DIR && npm test'
  4. systemctl enable --now ai-os-hermes
  5. journalctl -u ai-os-hermes -f

The dashboard listens on 127.0.0.1:3000 only. Reach it over an SSH tunnel:
  ssh -N -L 3000:127.0.0.1:3000 $HERMES_USER@<this-box>
DONE
else
  echo "Some checks FAILED above. Fix them before starting the service."
  exit 1
fi
