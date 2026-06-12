#!/usr/bin/env bash
# ============================================================
#  AI OS Virtual Corporate HQ — Complete VPS Setup Script
#  Tested on: Ubuntu 22.04 / 24.04 LTS (Hostinger KVM 2+)
#  Usage: sudo bash install-vps.sh yourdomain.com [--with-n8n] [--with-codex] [--harden-ssh]
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
NODE_VERSION="20"
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
apt-get install -y -qq curl wget git build-essential unzip jq software-properties-common cron
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
apt-get install -y -qq fail2ban

cat > /etc/fail2ban/jail.local <<'F2BCFG'
[DEFAULT]
bantime  = 600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 5
bantime  = 600
F2BCFG

systemctl enable fail2ban
systemctl restart fail2ban
log "Fail2ban active — SSH: 5 retries, 10-min ban"

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

  # Backup sshd_config before modifying
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%Y%m%d%H%M%S)

  # Disable root login
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  # Disable password authentication
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  # Disable empty passwords
  sed -i 's/^#\?PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config
  # Use protocol 2 only
  if ! grep -q '^Protocol 2' /etc/ssh/sshd_config; then
    echo 'Protocol 2' >> /etc/ssh/sshd_config
  fi
  # Limit auth attempts
  sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config

  sshd -t && systemctl reload sshd
  log "SSH hardened: root login disabled, password auth disabled"
  warn "VERIFY you can still log in from another terminal NOW"
else
  log "SSH hardening skipped (pass --harden-ssh to enable)"
fi

# ============================================================
step "[7/${TOTAL_STEPS}] Node.js ${NODE_VERSION}"
# ============================================================
if command -v node &>/dev/null; then
  CURRENT_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$CURRENT_NODE" -ge "$NODE_VERSION" ]; then
    log "Node.js already installed: $(node --version)"
  else
    warn "Node.js $(node --version) found, upgrading to v${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
  fi
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
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

# Install dependencies
cd "${APP_DIR}"
sudo -u ${APP_USER} npm install --production --quiet
log "Dependencies installed"

# ============================================================
step "[13/${TOTAL_STEPS}] Nginx Configuration"
# ============================================================
# Replace domain placeholder
sed "s/yourdomain\.com/${DOMAIN}/g" "${APP_DIR}/deploy/nginx.conf" > /etc/nginx/sites-available/ai-os
ln -sf /etc/nginx/sites-available/ai-os /etc/nginx/sites-enabled/ai-os
rm -f /etc/nginx/sites-enabled/default

# Add rate limit zone to nginx.conf if not present
if ! grep -q "zone=api" /etc/nginx/nginx.conf; then
  sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' /etc/nginx/nginx.conf
fi

# n8n reverse proxy block (injected if --with-n8n)
if [ "$WITH_N8N" = true ]; then
  if ! grep -q 'location /n8n/' /etc/nginx/sites-available/ai-os; then
    # Insert n8n location block before the final closing brace of the HTTPS server
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
' /etc/nginx/sites-available/ai-os
    log "Nginx: n8n reverse proxy block added at /n8n/"
  fi
fi

nginx -t && systemctl reload nginx
log "Nginx configured for ${DOMAIN}"

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
echo -e "  ${YELLOW}1. Edit your .env file with API keys:${NC}"
echo -e "     sudo nano ${APP_DIR}/.env"
echo ""
echo -e "  ${YELLOW}2. Generate your admin password hash:${NC}"
echo -e "     node -e \"require('bcryptjs').hash('YOUR_PASSWORD',12).then(console.log)\""
echo -e "     Then paste the hash into .env as ADMIN_PASSWORD_HASH"
echo ""
echo -e "  ${YELLOW}3. Get TLS certificate:${NC}"
echo -e "     sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo -e "  ${YELLOW}4. Restart with new config:${NC}"
echo -e "     sudo -u ${APP_USER} pm2 restart ai-os --update-env"
echo ""
echo -e "  ${YELLOW}5. Verify health:${NC}"
echo -e "     curl -s https://${DOMAIN}/api/health | jq ."
echo -e "     sudo -u ${APP_USER} bash ${APP_DIR}/deploy/healthcheck.sh"
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
echo -e "     sudo -u ${APP_USER} npm install --production"
echo -e "     sudo -u ${APP_USER} pm2 restart ai-os --update-env"
echo ""
