#!/usr/bin/env bash
# ============================================================
#  AI OS Virtual Corporate HQ — Complete VPS Setup Script
#  Targets: Ubuntu 22.04 / 24.04 LTS and Debian 12 / 13 (KVM; 2 GB RAM minimum, 4 GB recommended)
#  Usage: sudo bash install-vps.sh yourdomain.com [--with-n8n] [--with-codex] [--harden-ssh]
#  Optional env: COMMERCIAL_REPO_URL=<authenticated-url>  → also mount the private commercial
#                modules at /opt/ai-os/commercial (Business/Enterprise). Omit for Community tier.
#                LE_EMAIL=<you@example.com>  → Let's Encrypt registration email.
#
#  Copied this file from a Windows machine? Strip carriage returns first, or bash fails with
#  "bad interpreter: /usr/bin/env: 'bash\r'":   sed -i 's/\r$//' install-vps.sh
#  (.gitattributes keeps *.sh as LF in a git checkout; a copy through an editor or the
#  clipboard can still reintroduce CRLF.)
# ============================================================

set -euo pipefail

# --- Parse arguments ---
DOMAIN=""
WITH_N8N=false
WITH_CODEX=false
HARDEN_SSH=false

for arg in "$@"; do
  case "$arg" in
    --with-n8n)   WITH_N8N=true ;;
    --with-codex) WITH_CODEX=true ;;
    --harden-ssh) HARDEN_SSH=true ;;
    -*)           echo "Unknown flag: $arg"; exit 1 ;;
    *)            [ -z "$DOMAIN" ] && DOMAIN="$arg" ;;
  esac
done

APP_DIR="/opt/ai-os"
APP_USER="aios"
NODE_VERSION="24"   # Node 24 (Active LTS) — security support through ~2028-04. Node 20 went EOL 2026-04-30.
REPO_URL="https://github.com/wholefoo/ai-os.git"
TOTAL_STEPS=16

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[XX]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}━━━ ${1} ━━━${NC}"; }

# --- Pre-flight checks ---
if [ -z "$DOMAIN" ]; then
  err "Usage: sudo bash install-vps.sh yourdomain.com [--with-n8n] [--with-codex] [--harden-ssh]"
fi

if [ "$EUID" -ne 0 ]; then
  err "This script must be run as root — use sudo"
fi

# --- SSH-hardening lockout guard (runs BEFORE any work) ---
# --harden-ssh disables root login AND password authentication. If no OTHER account can get in
# with a working key and then become root, that locks you out of the box — recoverable only
# through the provider's web console. This used to be a printed warning followed by hardening
# anyway; a warning does not stop the next step, so this is now a refusal.
#
# "Working key" is checked by PARSING the file (ssh-keygen -l), not by it being non-empty: a
# pasted key fingerprint ("256 SHA256:... (ED25519)") is a non-empty authorized_keys that
# authenticates nothing, and passed the old check in the field.
if [ "$HARDEN_SSH" = true ]; then
  SSH_OK_USER=""
  for u in $(getent group sudo | cut -d: -f4 | tr ',' ' '); do
    home=$(getent passwd "$u" | cut -d: -f6)
    [ -n "$home" ] && [ -s "$home/.ssh/authorized_keys" ] || continue
    if ssh-keygen -l -f "$home/.ssh/authorized_keys" >/dev/null 2>&1; then SSH_OK_USER="$u"; break; fi
  done
  if [ -z "$SSH_OK_USER" ]; then
    err "--harden-ssh REFUSED: no non-root user in the 'sudo' group has a valid SSH key.
     Hardening would disable root login and passwords and lock you out. First:
       adduser <you> && usermod -aG sudo <you>
       install your PUBLIC key in /home/<you>/.ssh/authorized_keys (a line starting ssh-ed25519 / ssh-rsa)
       ssh-keygen -l -f /home/<you>/.ssh/authorized_keys     # must print a fingerprint, not an error
       log in as <you> from a SECOND terminal and run 'sudo -v'
     Then re-run with --harden-ssh. Or re-run without it and keep password login (fail2ban still applies)."
  fi
  log "SSH lockout guard: ${SSH_OK_USER} has a parseable key and sudo"
fi

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  AI OS Virtual Corporate HQ — Production VPS Installer  ${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "  ${BOLD}Domain:${NC}       ${DOMAIN}"
echo -e "  ${BOLD}Target:${NC}       ${APP_DIR}"
echo -e "  ${BOLD}Node.js:${NC}      v${NODE_VERSION}"
echo -e "  ${BOLD}n8n:${NC}          ${WITH_N8N}"
echo -e "  ${BOLD}Codex:${NC}        ${WITH_CODEX}"
echo -e "  ${BOLD}SSH harden:${NC}   ${HARDEN_SSH}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

# ============================================================
step "[1/${TOTAL_STEPS}] System Updates"
# ============================================================
apt-get update -qq
apt-get upgrade -y -qq
# No software-properties-common: nothing here uses add-apt-repository (NodeSource is added by
# hand in step 7), and a package that is absent from a release fails the whole install under -e.
apt-get install -y -qq curl wget git build-essential unzip jq cron openssl
# Minimal cloud images often ship without cron; the health-check and backup
# schedules depend on it. Ensure the daemon is installed and running.
systemctl enable --now cron 2>/dev/null || true
log "System packages updated"

# ============================================================
step "[2/${TOTAL_STEPS}] Swap File"
# ============================================================
if swapon --show | grep -q '/swapfile'; then
  log "Swap already active: $(swapon --show --noheadings | awk '{print $3}')"
else
  if [ -f /swapfile ]; then
    warn "/swapfile exists but is not active — activating"
  else
    fallocate -l 2G /swapfile
    log "Created 2GB swap file"
  fi
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile

  # Persist across reboots
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  # Reduce swappiness for a server (prefer RAM, swap only under pressure)
  sysctl vm.swappiness=10
  if ! grep -q 'vm.swappiness' /etc/sysctl.conf; then
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
  fi

  log "Swap enabled: $(swapon --show --noheadings | awk '{print $3}')"
fi

# ============================================================
step "[3/${TOTAL_STEPS}] Unattended Security Upgrades"
# ============================================================
apt-get install -y -qq unattended-upgrades apt-listchanges

cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'UUCFG'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
UUCFG

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOCFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
AUTOCFG

log "Unattended security upgrades configured (security patches only)"

# ============================================================
step "[4/${TOTAL_STEPS}] Firewall — UFW"
# ============================================================
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment "SSH"
ufw allow 80/tcp   comment "HTTP"
ufw allow 443/tcp  comment "HTTPS"
ufw --force enable
log "Firewall configured: SSH, HTTP, HTTPS"

# ============================================================
step "[5/${TOTAL_STEPS}] Fail2ban"
# ============================================================
# python3-systemd: the journal backend below needs it.
apt-get install -y -qq fail2ban python3-systemd

# backend = systemd, NOT logpath = /var/log/auth.log. Debian 12+ no longer installs rsyslog, so
# there is no auth.log at all: a jail pointed at it fails to start, `systemctl restart fail2ban`
# returns non-zero, and under `set -e` the whole installer stopped here. The journal exists on
# every target (Ubuntu too), so reading sshd from it works everywhere.
cat > /etc/fail2ban/jail.local <<'F2BCFG'
[DEFAULT]
bantime  = 600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled  = true
backend  = systemd
port     = ssh
maxretry = 5
bantime  = 1h
# Repeat offenders get progressively longer bans instead of retrying forever.
bantime.increment = true
bantime.factor    = 2
bantime.maxtime   = 1w
F2BCFG

systemctl enable fail2ban
if systemctl restart fail2ban && sleep 2 && fail2ban-client status sshd >/dev/null 2>&1; then
  log "Fail2ban active — sshd jail RUNNING (5 retries, 1h ban, doubling to 1 week)"
else
  # Not fatal: ufw is up and the install should finish. But say so loudly — "installed" is not
  # "protecting", and the old step reported success whether or not the jail ever started.
  warn "Fail2ban installed but the sshd jail is NOT running — check: journalctl -u fail2ban -n 30"
fi

# ============================================================
step "[6/${TOTAL_STEPS}] SSH Hardening"
# ============================================================
if [ "$HARDEN_SSH" = true ]; then
  echo ""
  warn "=========================================================="
  warn "  SSH HARDENING — READ CAREFULLY BEFORE PROCEEDING"
  warn "=========================================================="
  warn ""
  warn "  This will DISABLE root login and password authentication."
  warn "  You MUST have SSH key-based access configured FIRST."
  warn ""
  warn "  If you have not set up SSH keys, you will be LOCKED OUT."
  warn ""
  warn "  Test your key login in a SEPARATE terminal before continuing."
  warn "=========================================================="
  echo ""

  # A DROP-IN, not sed on sshd_config. sshd takes the FIRST value it reads for each keyword, and
  # Ubuntu/Debian's sshd_config `Include`s sshd_config.d/*.conf at the TOP. Cloud images ship a
  # drop-in there (e.g. 50-cloud-init.conf: PasswordAuthentication yes), so editing the main file
  # could be silently overridden — "hardened" printed while passwords still worked. 00- sorts
  # first, so these values win. (The obsolete `Protocol 2` line is gone: modern OpenSSH ignores
  # it with a deprecation warning.) The pre-flight guard above has already proved a sudo user
  # with a working key exists.
  DROPIN=/etc/ssh/sshd_config.d/00-aios-hardening.conf
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat > "$DROPIN" <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 3
SSHD
  if ! sshd -t 2>/dev/null; then
    # Remove it rather than leave a broken file for the next reboot/upgrade to apply unattended.
    rm -f "$DROPIN"
    warn "sshd -t FAILED — hardening drop-in REMOVED, sshd unchanged"
  else
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    # Verify against the EFFECTIVE config, not the file we wrote.
    if sshd -T 2>/dev/null | grep -qi '^passwordauthentication no' && sshd -T 2>/dev/null | grep -qi '^permitrootlogin no'; then
      log "SSH hardened (verified with sshd -T): root login + password auth disabled"
    else
      warn "sshd reloaded but sshd -T still allows passwords or root — check: grep -r . /etc/ssh/sshd_config.d/"
    fi
    warn "Log in as ${SSH_OK_USER} from ANOTHER terminal now, before closing this one"
  fi
else
  log "SSH hardening skipped (pass --harden-ssh to enable)"
fi

# ============================================================
step "[7/${TOTAL_STEPS}] Node.js ${NODE_VERSION}"
# ============================================================
# DEP-07: this used to be `curl https://deb.nodesource.com/setup_X.x | bash -`, i.e. download an
# opaque script over the network and execute it AS ROOT, unreviewed and unverified, on every
# provision. Whatever that URL served at that moment became root on the box.
#
# Replaced with NodeSource's own apt repository, added by hand: fetch their signing KEY (data, not
# code), dearmor it into a keyring, and register the repo as `signed-by` that keyring. Nothing
# downloaded is executed — apt verifies every package against the pinned key before installing, so
# the trust anchor becomes a signature we control the storage of rather than a shell script.
#
# `nodistro` is NodeSource's current distribution-agnostic channel; it is their documented layout,
# not a guess. If they change it, THIS STEP FAILS LOUDLY at `apt-get update` rather than silently
# installing something unexpected — which is the direction a supply-chain step should fail in.
install_nodejs_from_nodesource() {
  apt-get install -y -qq ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  # -o to a temp file first: a truncated or failed download must not leave a partial keyring in
  # place that apt would then reject with a confusing signature error.
  local tmpkey; tmpkey="$(mktemp)"
  if ! curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmpkey"; then
    rm -f "$tmpkey"; err "Could not fetch the NodeSource signing key — refusing to continue"
  fi
  gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg < "$tmpkey"
  rm -f "$tmpkey"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
}

if command -v node &>/dev/null; then
  CURRENT_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$CURRENT_NODE" -ge "$NODE_VERSION" ]; then
    log "Node.js already installed: $(node --version)"
  else
    warn "Node.js $(node --version) found, upgrading to v${NODE_VERSION}..."
    install_nodejs_from_nodesource
  fi
else
  install_nodejs_from_nodesource
fi
log "Node: $(node --version), npm: $(npm --version)"

# ============================================================
step "[8/${TOTAL_STEPS}] PM2 Process Manager"
# ============================================================
npm install -g pm2 --quiet
log "PM2 installed: $(pm2 --version)"

# ============================================================
step "[9/${TOTAL_STEPS}] Nginx"
# ============================================================
apt-get install -y -qq nginx
systemctl enable nginx
log "Nginx installed and enabled"

# ============================================================
step "[10/${TOTAL_STEPS}] Certbot — Let's Encrypt"
# ============================================================
apt-get install -y -qq certbot python3-certbot-nginx

# Verify auto-renewal timer/cron is set up
if systemctl list-timers | grep -q certbot; then
  log "Certbot renewal timer already active"
elif [ -f /etc/cron.d/certbot ]; then
  log "Certbot renewal cron already configured"
else
  # Create a systemd timer for auto-renewal
  cat > /etc/systemd/system/certbot-renewal.timer <<'TIMER'
[Unit]
Description=Certbot renewal timer

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
TIMER

  cat > /etc/systemd/system/certbot-renewal.service <<'SERVICE'
[Unit]
Description=Certbot renewal
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
SERVICE

  systemctl daemon-reload
  systemctl enable certbot-renewal.timer
  systemctl start certbot-renewal.timer
  log "Certbot auto-renewal timer created (daily at 03:30 +/- 1h)"
fi
log "Certbot installed — TLS renewal verified"

# ============================================================
step "[11/${TOTAL_STEPS}] App User & Directory"
# ============================================================
if ! id "${APP_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${APP_USER}"
  log "Created user: ${APP_USER}"
else
  log "User ${APP_USER} already exists"
fi

mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/.magent/state"
mkdir -p "${APP_DIR}/.magent/vault/raw"
mkdir -p "${APP_DIR}/.magent/vault/wiki"
mkdir -p "${APP_DIR}/.magent/vault/outputs"
mkdir -p "${APP_DIR}/.magent/artifacts"
mkdir -p "${APP_DIR}/logs"
mkdir -p "${APP_DIR}/deploy"
chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"
log "App directory ready: ${APP_DIR}"

# ============================================================
step "[12/${TOTAL_STEPS}] Clone / Update Repository"
# ============================================================
if [ -d "${APP_DIR}/.git" ]; then
  cd "${APP_DIR}"
  sudo -u ${APP_USER} git pull origin master
  log "Repository updated"
else
  # Clone into temp then move contents
  TMPDIR=$(mktemp -d)
  git clone "${REPO_URL}" "${TMPDIR}"
  cp -r "${TMPDIR}"/* "${TMPDIR}"/.* "${APP_DIR}/" 2>/dev/null || true
  rm -rf "${TMPDIR}"
  chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"
  log "Repository cloned from ${REPO_URL}"
fi

# Commercial/enterprise modules live in a SEPARATE PRIVATE repo (ai-os-commercial). Set
# COMMERCIAL_REPO_URL to an authenticated URL (SSH with a deploy key already configured, or HTTPS
# with a token) to mount them at ${APP_DIR}/commercial. Without it, the app runs Community tier.
if [ -n "${COMMERCIAL_REPO_URL:-}" ]; then
  if [ -d "${APP_DIR}/commercial/.git" ]; then
    sudo -u ${APP_USER} git -C "${APP_DIR}/commercial" pull origin master && log "Commercial modules updated"
  elif sudo -u ${APP_USER} git clone "${COMMERCIAL_REPO_URL}" "${APP_DIR}/commercial"; then
    log "Commercial modules mounted at ${APP_DIR}/commercial"   # URL not echoed (may carry a token)
  else
    warn "Commercial clone failed — running Community tier (check COMMERCIAL_REPO_URL / deploy-key access)"
  fi
else
  log "COMMERCIAL_REPO_URL not set — running open-source Community tier"
fi

# Install dependencies
# `npm ci`, NOT `npm install`: ci installs EXACTLY what package-lock.json pins and fails loudly if the
# lock and package.json disagree. `npm install` re-resolves semver ranges at deploy time, so two
# deploys of the same commit could install different transitive versions — an unpinned supply chain on
# a box holding live API keys. (`--omit=dev` replaces the deprecated `--production`.)
# If this step ever fails with EUSAGE, the lockfile is out of date: run `npm install` locally, commit
# the updated package-lock.json, and redeploy. Do NOT "fix" it by reverting to `npm install` here.
cd "${APP_DIR}"
sudo -u ${APP_USER} npm ci --omit=dev --quiet
log "Dependencies installed from lockfile"

# ============================================================
step "[13/${TOTAL_STEPS}] Nginx Configuration"
# ============================================================
# TWO PHASES, because the full vhost cannot pass `nginx -t` on a fresh box:
#   * it logs in the `aios_vhost` format, which lives in deploy/aios-logformat.conf and was never
#     installed by this script ("unknown log format"); and
#   * it names /etc/letsencrypt/live/<domain>/fullchain.pem, which does not exist until certbot
#     has run — and certbot used to be a "next step" AFTER this script.
# Either one failed `nginx -t && systemctl reload nginx` under `set -e`, so a fresh install
# stopped here and never reached .env, PM2, tuning or the health check. Now: install the log
# format, bring up a plain-HTTP bootstrap vhost that answers the ACME challenge, obtain the
# certificate, then swap in the full vhost — and never leave a config that does not parse.
install -o root -g root -m 644 "${APP_DIR}/deploy/aios-logformat.conf" /etc/nginx/conf.d/aios-logformat.conf
rm -f /etc/nginx/sites-enabled/default

# Add rate limit zone to nginx.conf if not present
if ! grep -q "zone=api" /etc/nginx/nginx.conf; then
  sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' /etc/nginx/nginx.conf
fi

ACME_ROOT=/var/www/aios-acme
mkdir -p "${ACME_ROOT}/.well-known/acme-challenge"
VHOST=/etc/nginx/sites-available/ai-os
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
TLS_READY=false

write_bootstrap_vhost() {
  cat > "$VHOST" <<BOOTSTRAP
# Bootstrap vhost (HTTP only) — written by install-vps.sh until a certificate exists.
# Login will NOT work here: the session cookie is Secure in production and browsers drop it
# over plain HTTP. It exists to answer the ACME challenge and serve /api/health.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
BOOTSTRAP
  ln -sf "$VHOST" /etc/nginx/sites-enabled/ai-os
}

write_full_vhost() {
  sed "s/yourdomain\.com/${DOMAIN}/g" "${APP_DIR}/deploy/nginx.conf" > "$VHOST"
  ln -sf "$VHOST" /etc/nginx/sites-enabled/ai-os

  # n8n reverse proxy block (injected if --with-n8n)
  if [ "$WITH_N8N" = true ] && ! grep -q 'location /n8n/' "$VHOST"; then
    sed -i '/# --- Block sensitive paths ---/i\
    # --- n8n Workflow Automation ---\
    location /n8n/ {\
        proxy_pass http://127.0.0.1:5678/;\
        proxy_http_version 1.1;\
        proxy_set_header Upgrade $http_upgrade;\
        proxy_set_header Connection "upgrade";\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\
        proxy_set_header X-Forwarded-Proto $scheme;\
        proxy_read_timeout 300s;\
        proxy_send_timeout 300s;\
        client_max_body_size 50M;\
    }\
' "$VHOST"
    log "Nginx: n8n reverse proxy block added at /n8n/"
  fi
}

# Phase 1 — a certificate. Skipped if one already exists (re-runs, or a cert obtained by hand).
if [ ! -f "$CERT" ]; then
  write_bootstrap_vhost
  nginx -t && systemctl reload nginx

  # Only ask Let's Encrypt when the name points HERE. Behind Cloudflare's proxy (orange cloud) it
  # resolves to Cloudflare, and the challenge fails or is redirected by "Always Use HTTPS".
  MY_IPS=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1)
  DNS_IP=$(getent ahostsv4 "${DOMAIN}" | awk 'NR==1{print $1}')
  if [ -n "$DNS_IP" ] && echo "$MY_IPS" | grep -qx "$DNS_IP"; then
    if [ -n "${LE_EMAIL:-}" ]; then LE_ARGS=(--email "${LE_EMAIL}"); else LE_ARGS=(--register-unsafely-without-email); fi
    if certbot certonly --webroot -w "$ACME_ROOT" -d "${DOMAIN}" --agree-tos --non-interactive "${LE_ARGS[@]}"; then
      log "Certificate issued for ${DOMAIN}"
    else
      warn "certbot failed — staying on the HTTP bootstrap vhost (see /var/log/letsencrypt/letsencrypt.log)"
    fi
  else
    warn "${DOMAIN} resolves to '${DNS_IP:-nothing}', not this server ($(echo $MY_IPS | tr '\n' ' '))."
    warn "Certificate NOT requested. Point an A record here (in Cloudflare: 'DNS only', grey cloud,"
    warn "at least while issuing), then finish TLS with the three commands printed at the end."
  fi
fi

# Phase 2 — the full HTTPS vhost, only once the certificate is really there.
if [ -f "$CERT" ]; then
  cp "$VHOST" "${VHOST}.prev" 2>/dev/null || true
  write_full_vhost
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    TLS_READY=true
    log "Nginx configured for https://${DOMAIN}"
  else
    nginx -t || true
    # A config that does not parse must never replace one that does.
    if [ -f "${VHOST}.prev" ]; then cp "${VHOST}.prev" "$VHOST"; else write_bootstrap_vhost; fi
    nginx -t && systemctl reload nginx
    warn "Full vhost failed nginx -t — kept the previous config. Fix, then: nginx -t && systemctl reload nginx"
  fi
fi

# ============================================================
# Web Studio — multi-site static hosting substrate
# ============================================================
# Per-site built output lives under ${APP_DIR}/sites/<domain>/current (served by
# nginx). Custom-domain vhosts + TLS are created at RUNTIME by the app via three
# root-owned scripts; here we only lay down the substrate + the privilege boundary.

# Hosted-site content root (aios owns it; nginx/www-data needs read + traverse).
mkdir -p "${APP_DIR}/sites"
chown ${APP_USER}:${APP_USER} "${APP_DIR}/sites"
chmod 755 "${APP_DIR}/sites"
# Least-privilege traverse: let www-data reach sites/<domain>/current without joining
# the aios group. o+x grants traversal only (NOT listing/reading) of the app dir.
chmod o+x "${APP_DIR}" || true

# Shared ACME http-01 webroot — certbot writes challenges here; every per-site HTTP
# vhost serves /.well-known/acme-challenge/ from it.
mkdir -p /var/www/aios-acme/.well-known/acme-challenge
chown -R ${APP_USER}:${APP_USER} /var/www/aios-acme
chmod -R 755 /var/www/aios-acme

# Optional ACME registration email (root-managed; site-cert.sh reads it). Set by
# exporting LE_EMAIL before running the installer; otherwise certs register w/o email.
mkdir -p /etc/aios
if [ -n "${LE_EMAIL:-}" ]; then
  printf '%s\n' "${LE_EMAIL}" > /etc/aios/acme-email
  chmod 644 /etc/aios/acme-email
fi

# Reload nginx after ANY cert renewal. We issue certs with `certbot certonly` (webroot),
# which does NOT reload the web server on renewal — so without this hook a renewed cert
# isn't actually served until a manual reload. This global deploy hook fires after every
# successful renewal and covers every hosted site's cert.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# Install the THREE privilege-boundary scripts ROOT-OWNED at /usr/local/sbin.
# SECURITY INVARIANT: they MUST stay root:root 755 (NOT aios-writable) — otherwise
# the sudoers grant below becomes a root escalation. `install` enforces owner/mode.
if [ -d "${APP_DIR}/deploy/hosting" ]; then
  install -o root -g root -m 755 "${APP_DIR}/deploy/hosting/site-vhost.sh"  /usr/local/sbin/aios-site-vhost
  install -o root -g root -m 755 "${APP_DIR}/deploy/hosting/site-cert.sh"   /usr/local/sbin/aios-site-cert
  install -o root -g root -m 755 "${APP_DIR}/deploy/hosting/site-remove.sh" /usr/local/sbin/aios-site-remove

  # Install the sudoers allowlist, validating the STAGED copy first — a malformed
  # sudoers file can lock the box out of sudo entirely.
  install -o root -g root -m 440 "${APP_DIR}/deploy/hosting/aios-hosting.sudoers" /etc/sudoers.d/aios-hosting.tmp
  if visudo -cf /etc/sudoers.d/aios-hosting.tmp >/dev/null 2>&1; then
    mv -f /etc/sudoers.d/aios-hosting.tmp /etc/sudoers.d/aios-hosting
    log "Web Studio hosting: scripts + sudoers installed (3 root-owned domain ops)"
  else
    rm -f /etc/sudoers.d/aios-hosting.tmp
    warn "aios-hosting.sudoers failed visudo -c — NOT installed; Web Studio domain ops disabled"
  fi
else
  warn "deploy/hosting not found — skipping Web Studio hosting substrate"
fi

# ============================================================
step "[14/${TOTAL_STEPS}] Environment, PM2 & Log Rotation"
# ============================================================
# Create .env if it doesn't exist
if [ ! -f "${APP_DIR}/.env" ]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  chown ${APP_USER}:${APP_USER} "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  warn ".env created from template — you MUST edit it with your API keys"
else
  log ".env already exists"
fi

# Random secrets for anything left BLANK, so the first boot is not "Auth: disabled". A value that
# is already set is never overwritten (that would log everyone out / break automations).
# AIOS_SECRETS_KEY is deliberately NOT generated: losing it makes sealed settings unreadable, so it
# must be a key the operator chose and backed up, not one that exists only on this disk.
fill_if_blank() {
  local key="$1" val="$2" f="${APP_DIR}/.env"
  if grep -q "^${key}=$" "$f"; then
    sed -i "s|^${key}=$|${key}=${val}|" "$f"; log "${key} generated"
  elif ! grep -q "^${key}=" "$f"; then
    printf '%s=%s\n' "$key" "$val" >> "$f"; log "${key} generated"
  elif grep -Eiq "^${key}=.*(change|your|example|placeholder|xxx)" "$f"; then
    warn "${key} in .env looks like a placeholder — replace it: openssl rand -hex 32"
  fi
}
fill_if_blank API_TOKEN "$(openssl rand -hex 32)"
fill_if_blank SESSION_SECRET "$(openssl rand -hex 32)"
chown ${APP_USER}:${APP_USER} "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

# Add n8n env vars if --with-n8n
if [ "$WITH_N8N" = true ]; then
  if ! grep -q 'N8N_WEBHOOK_BASE' "${APP_DIR}/.env"; then
    cat >> "${APP_DIR}/.env" <<ENVN8N

# --- n8n Workflow Automation ---
N8N_WEBHOOK_BASE=https://${DOMAIN}/n8n/
N8N_PORT=5678
N8N_PROTOCOL=https
N8N_HOST=${DOMAIN}
N8N_PATH=/n8n/
ENVN8N
    log "n8n env vars appended to .env"
  fi
fi

# Set up PM2 startup
pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER} 2>/dev/null || true

# Start the app (or restart if already running)
cd "${APP_DIR}"
sudo -u ${APP_USER} pm2 start ecosystem.config.js --env production 2>/dev/null || \
  sudo -u ${APP_USER} pm2 restart ai-os --update-env 2>/dev/null || true
sudo -u ${APP_USER} pm2 save
log "PM2 started and saved"

# PM2 log rotation
sudo -u ${APP_USER} pm2 install pm2-logrotate 2>/dev/null || true
sudo -u ${APP_USER} pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
sudo -u ${APP_USER} pm2 set pm2-logrotate:retain 7 2>/dev/null || true
sudo -u ${APP_USER} pm2 set pm2-logrotate:compress true 2>/dev/null || true
sudo -u ${APP_USER} pm2 set pm2-logrotate:workerInterval 30 2>/dev/null || true
log "PM2 log rotation: 10M max, 7 files retained, compressed"

# ============================================================
step "[15/${TOTAL_STEPS}] System Tuning"
# ============================================================

# --- File descriptor limits for aios user ---
if ! grep -q "${APP_USER}" /etc/security/limits.conf 2>/dev/null; then
  cat >> /etc/security/limits.conf <<LIMITS
# AI OS — raised file descriptor limits
${APP_USER} soft nofile 65535
${APP_USER} hard nofile 65535
LIMITS
  log "File descriptor limits set: ${APP_USER} nofile 65535"
else
  log "File descriptor limits already configured for ${APP_USER}"
fi

# --- Kernel network tuning ---
SYSCTL_TUNING="/etc/sysctl.d/99-ai-os.conf"
cat > "${SYSCTL_TUNING}" <<'SYSCTL'
# AI OS production tuning
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.netdev_max_backlog = 65535
fs.file-max = 2097152
SYSCTL

sysctl -p "${SYSCTL_TUNING}" >/dev/null 2>&1
log "Kernel tuning applied (somaxconn=65535, file-max=2M)"

# ============================================================
step "[16/${TOTAL_STEPS}] Health Check & n8n (optional)"
# ============================================================

# --- Health check script ---
cat > "${APP_DIR}/deploy/healthcheck.sh" <<'HEALTHCHECK'
#!/usr/bin/env bash
# AI OS Health Check — exit 0 = healthy, exit 1 = unhealthy
# Run manually or via cron every 5 minutes

ERRORS=0

# 1. Node / PM2 process running
if ! pm2 pid ai-os >/dev/null 2>&1 || [ -z "$(pm2 pid ai-os 2>/dev/null)" ]; then
  echo "[FAIL] PM2 process 'ai-os' is not running"
  ERRORS=$((ERRORS + 1))
else
  echo "[OK]   PM2 process 'ai-os' is running (PID $(pm2 pid ai-os))"
fi

# 2. Nginx responding
if ! systemctl is-active --quiet nginx; then
  echo "[FAIL] Nginx is not running"
  ERRORS=$((ERRORS + 1))
else
  echo "[OK]   Nginx is active"
fi

# 3. HTTP health endpoint (local)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "[OK]   Health endpoint returned 200"
else
  echo "[FAIL] Health endpoint returned ${HTTP_CODE}"
  ERRORS=$((ERRORS + 1))
fi

# 4. Disk space (warn at 85%, fail at 95%)
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -ge 95 ]; then
  echo "[FAIL] Disk usage critical: ${DISK_PCT}%"
  ERRORS=$((ERRORS + 1))
elif [ "$DISK_PCT" -ge 85 ]; then
  echo "[WARN] Disk usage high: ${DISK_PCT}%"
else
  echo "[OK]   Disk usage: ${DISK_PCT}%"
fi

# 5. Memory (warn at 90%)
MEM_PCT=$(free | awk '/Mem:/{printf "%.0f", $3/$2*100}')
if [ "$MEM_PCT" -ge 90 ]; then
  echo "[WARN] Memory usage high: ${MEM_PCT}%"
else
  echo "[OK]   Memory usage: ${MEM_PCT}%"
fi

# 6. Swap usage
SWAP_TOTAL=$(free | awk '/Swap:/{print $2}')
if [ "$SWAP_TOTAL" -gt 0 ]; then
  SWAP_PCT=$(free | awk '/Swap:/{printf "%.0f", $3/$2*100}')
  echo "[INFO] Swap usage: ${SWAP_PCT}%"
else
  echo "[INFO] No swap configured"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "UNHEALTHY — ${ERRORS} check(s) failed"
  exit 1
else
  echo ""
  echo "HEALTHY — all checks passed"
  exit 0
fi
HEALTHCHECK

chmod +x "${APP_DIR}/deploy/healthcheck.sh"
chown ${APP_USER}:${APP_USER} "${APP_DIR}/deploy/healthcheck.sh"
log "Health check script created: ${APP_DIR}/deploy/healthcheck.sh"

# Add cron job for health checks (every 5 minutes)
CRON_LINE="*/5 * * * * ${APP_DIR}/deploy/healthcheck.sh >> ${APP_DIR}/logs/healthcheck.log 2>&1"
( crontab -u ${APP_USER} -l 2>/dev/null | grep -v 'healthcheck.sh'; echo "${CRON_LINE}" ) | crontab -u ${APP_USER} -
log "Health check cron: every 5 minutes -> ${APP_DIR}/logs/healthcheck.log"

# --- n8n (optional) ---
if [ "$WITH_N8N" = true ]; then
  echo ""
  log "Installing n8n workflow automation..."
  npm install -g n8n --quiet

  # Create PM2 ecosystem entry for n8n
  cat > /tmp/n8n-ecosystem.config.js <<N8NECOSYSTEM
module.exports = {
  apps: [{
    name: 'n8n',
    script: '$(which n8n)',
    args: 'start',
    env: {
      N8N_PORT: 5678,
      N8N_PROTOCOL: 'https',
      N8N_HOST: '${DOMAIN}',
      N8N_PATH: '/n8n/',
      WEBHOOK_URL: 'https://${DOMAIN}/n8n/',
      N8N_BASIC_AUTH_ACTIVE: 'true',
      N8N_BASIC_AUTH_USER: 'admin',
      N8N_BASIC_AUTH_PASSWORD: 'CHANGE_ME_IMMEDIATELY',
      GENERIC_TIMEZONE: 'UTC',
      N8N_USER_FOLDER: '/home/${APP_USER}/.n8n'
    },
    cwd: '/home/${APP_USER}',
    max_memory_restart: '512M',
    autorestart: true
  }]
};
N8NECOSYSTEM

  sudo -u ${APP_USER} pm2 start /tmp/n8n-ecosystem.config.js 2>/dev/null || \
    sudo -u ${APP_USER} pm2 restart n8n --update-env 2>/dev/null || true
  sudo -u ${APP_USER} pm2 save
  rm -f /tmp/n8n-ecosystem.config.js
  log "n8n installed and running on port 5678 via PM2"
  warn "CHANGE the n8n basic auth password immediately!"
fi

# ============================================================
# Optional: Codex CLI (cross-model adversarial review)
# ============================================================
if [ "$WITH_CODEX" = true ]; then
  step "Optional: Codex CLI (cross-model verification engine)"

  npm install -g @openai/codex
  log "Codex CLI installed: $(codex --version 2>/dev/null || echo 'installed')"

  CODEX_HOME="/home/${APP_USER}/.codex"
  mkdir -p "${CODEX_HOME}/prompts"

  # Main config: API-key auth (no browser on a server) + trust the app dir
  cat > "${CODEX_HOME}/config.toml" <<CODEXCONF
preferred_auth_method = "apikey"

[projects.'${APP_DIR}']
trust_level = "trusted"
CODEXCONF

  # Reviewer profile: read-only sandbox, never prompts — safe for headless panel calls.
  # NOTE: profiles live in separate <name>.config.toml files, not [profiles.*] tables.
  cat > "${CODEX_HOME}/reviewer.config.toml" <<REVIEWERCONF
model = "gpt-5.5"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
approval_policy = "never"
REVIEWERCONF

  # /crossreview prompt — staged-diff review with SHIP/REVISE verdict
  cat > "${CODEX_HOME}/prompts/crossreview.md" <<'CROSSREVIEW'
---
description: Cross-model review of staged changes (read-only)
argument-hint: [optional focus area]
---
Review the staged changes only. Run `git diff --staged` to see them.

For each issue, report:
- severity: blocker | should-fix | nit
- location: file:line
- problem: what's wrong (one line)
- fix: a concrete suggested change

Check correctness, edge cases, error handling, and whether existing tests
cover the change. Don't restate what the code does. Do not edit any files.
End with a one-line verdict: SHIP or REVISE.

If arguments are provided, focus the review on: $ARGUMENTS
CROSSREVIEW

  chown -R ${APP_USER}:${APP_USER} "${CODEX_HOME}"
  log "Codex configured: reviewer profile + /crossreview prompt + trusted ${APP_DIR}"
  warn "Codex needs OPENAI_API_KEY — add it to ${APP_DIR}/.env (the panel invocation exports it)"
fi

# ============================================================
# Verify — report every check, never abort on one
# ============================================================
# `set -e` is switched off for this block on purpose: a failing check is the POINT here, and an
# assignment like X=$(failing | pipeline) under set -e/pipefail ends the script silently — the
# output just stops after the heading, which reads like a hang, not a failure.
set +e
step "Verification"
VFAIL=0
vcheck() { if eval "$2" >/dev/null 2>&1; then echo -e "  ${GREEN}ok${NC}    $1"; else echo -e "  ${RED}FAIL${NC}  $1"; VFAIL=1; fi; }
vcheck "node satisfies engines (>= ${NODE_VERSION})" "[ \"\$(node -v | sed 's/^v//; s/\..*//')\" -ge ${NODE_VERSION} ]"
vcheck "node_modules owned by ${APP_USER}, not root" "[ \"\$(stat -c %U ${APP_DIR}/node_modules)\" = ${APP_USER} ]"
vcheck ".env is mode 600"                            "[ \"\$(stat -c %a ${APP_DIR}/.env)\" = 600 ]"
vcheck "nginx config parses"                         "nginx -t"
vcheck "app port 3000 not exposed to the internet"   "! ss -tln | grep -Eq '(0\.0\.0\.0|\[::\]|\*):3000 '"
vcheck "fail2ban sshd jail running"                  "fail2ban-client status sshd"
vcheck "health endpoint answers locally"             "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health)\" = 200 ]"
if [ "$TLS_READY" = true ]; then
  vcheck "HTTPS answers with a trusted certificate"  "curl -sS -o /dev/null --max-time 10 https://${DOMAIN}/api/health"
fi
[ "$VFAIL" -eq 0 ] || warn "Some checks failed — each line above names what to look at."
set -e

# ============================================================
# Done!
# ============================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Installation Complete!                                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}What was installed:${NC}"
echo -e "    - System updates + unattended security upgrades"
echo -e "    - 2GB swap file (vm.swappiness=10)"
echo -e "    - UFW firewall (SSH, HTTP, HTTPS)"
echo -e "    - Fail2ban (SSH protection)"
if [ "$HARDEN_SSH" = true ]; then
  echo -e "    - SSH hardened (root login + password auth disabled)"
fi
echo -e "    - Node.js $(node --version) + PM2 $(pm2 --version)"
echo -e "    - Nginx reverse proxy"
echo -e "    - Certbot + auto-renewal timer"
echo -e "    - PM2 log rotation (10M, 7 files)"
echo -e "    - System tuning (nofile 65535, somaxconn 65535)"
echo -e "    - Health check cron (every 5 min)"
if [ "$WITH_N8N" = true ]; then
  echo -e "    - n8n workflow automation (port 5678)"
fi
if [ "$WITH_CODEX" = true ]; then
  echo -e "    - Codex CLI (cross-model review: reviewer profile + /crossreview)"
fi
echo ""
echo -e "  ${CYAN}━━━ Next Steps ━━━${NC}"
echo ""
echo -e "  ${YELLOW}1. Generate your admin password hash (typed hidden, never in shell history):${NC}"
echo -e "     sudo bash ${APP_DIR}/deploy/make-admin-hash.sh"
echo ""
echo -e "  ${YELLOW}2. Edit .env — ADMIN_EMAIL, ADMIN_PASSWORD_HASH and your API keys:${NC}"
echo -e "     sudo nano ${APP_DIR}/.env"
echo -e "     ${BOLD}Get ADMIN_EMAIL right first time:${NC} the admin account is created ONCE, on the first"
echo -e "     start where both values are set. Changing them in .env later does not change the account."
echo -e "     (API_TOKEN and SESSION_SECRET were generated for you if they were blank.)"
echo ""
if [ "$TLS_READY" = true ]; then
  echo -e "  ${YELLOW}3. TLS:${NC} done — certificate issued, HTTPS vhost live, renewal via the certbot timer."
else
  echo -e "  ${YELLOW}3. TLS — NOT done yet${NC} (DNS did not point here, or certbot failed). Once ${DOMAIN}"
  echo -e "     resolves to this server (Cloudflare: 'DNS only' while issuing), run:"
  echo -e "     sudo certbot certonly --webroot -w /var/www/aios-acme -d ${DOMAIN}"
  # `| sudo tee`, not `sudo sed ... > file`: the redirect runs as the CALLER, so a non-root user
  # gets "Permission denied" on /etc/nginx even though sed itself ran under sudo.
  echo -e "     sudo sed 's/yourdomain\\\\.com/${DOMAIN}/g' ${APP_DIR}/deploy/nginx.conf | sudo tee /etc/nginx/sites-available/ai-os > /dev/null"
  echo -e "     sudo nginx -t && sudo systemctl reload nginx"
  echo -e "     Do NOT use 'certbot --nginx' here: it rewrites the vhost this script manages."
fi
echo ""
echo -e "  ${YELLOW}4. Restart with new config${NC} (-iu, not -u: plain sudo -u reaches an EMPTY pm2 daemon):"
echo -e "     sudo -iu ${APP_USER} pm2 restart ai-os --update-env"
echo ""
echo -e "  ${YELLOW}5. Verify the app picked it up:${NC}"
echo -e "     sudo -iu ${APP_USER} pm2 logs ai-os --lines 80 --nostream | grep -E 'Auth:|admin|AUTH'"
echo -e "     Expect 'Auth: enabled' and '[AUTH] Admin account seeded' — NOT 'No admin seeded'."
echo -e "     curl -s https://${DOMAIN}/api/health | jq ."
echo -e "     sudo -iu ${APP_USER} bash ${APP_DIR}/deploy/healthcheck.sh"
echo ""
if [ "$WITH_N8N" = true ]; then
  echo -e "  ${YELLOW}6. n8n Setup:${NC}"
  echo -e "     URL: https://${DOMAIN}/n8n/"
  echo -e "     Default credentials: admin / CHANGE_ME_IMMEDIATELY"
  echo -e "     Change password in PM2 ecosystem or set N8N_BASIC_AUTH_PASSWORD in .env"
  echo -e "     Manage: pm2 logs n8n | pm2 restart n8n"
  echo ""
fi
if [ "$WITH_CODEX" = true ]; then
  echo -e "  ${YELLOW}Codex Setup:${NC}"
  echo -e "     Add OPENAI_API_KEY to ${APP_DIR}/.env"
  echo -e "     Test: sudo -u ${APP_USER} bash -c 'cd ${APP_DIR} && OPENAI_API_KEY=sk-... codex exec --profile reviewer \"Reply OK\" < /dev/null'"
  echo -e "     Panels call it headlessly — stdin must be closed (< /dev/null) or codex exec hangs"
  echo ""
fi
echo -e "  ${CYAN}━━━ Useful Commands ━━━${NC}"
echo 'Generated-site builds need the non-Docker worker (install and verify before enabling):'
echo "     sudo bash ${APP_DIR}/deploy/hosting/install-build-worker.sh"
echo "     sudo -iu ${APP_USER} sh -c 'cd ${APP_DIR} && node tools/verify-build-worker.js'"
echo "     Then set AIOS_BUILD_BACKEND=bubblewrap in ${APP_DIR}/.env and restart PM2."
echo -e "     pm2 logs ai-os          # Live log stream"
echo -e "     pm2 monit               # CPU/RAM monitor"
echo -e "     pm2 restart ai-os       # Restart server"
echo -e "     pm2 status              # Process status"
echo -e "     journalctl -u nginx -f  # Nginx logs"
echo -e "     fail2ban-client status sshd  # Fail2ban status"
echo -e "     tail -f ${APP_DIR}/logs/healthcheck.log  # Health log"
echo ""
echo -e "  ${CYAN}━━━ Update from GitHub ━━━${NC}"
echo -e "     cd ${APP_DIR} && sudo -u ${APP_USER} git pull origin master"
echo -e "     sudo -u ${APP_USER} npm ci --omit=dev      # as ${APP_USER}, NEVER root (root-owned node_modules break the next ci)"
echo -e "     # confirm the install exited 0 BEFORE restarting — ci deletes node_modules first"
echo -e "     sudo -iu ${APP_USER} pm2 restart ai-os --update-env"
echo ""
