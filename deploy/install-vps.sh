#!/usr/bin/env bash
# ============================================================
#  AI OS Virtual Corporate HQ — VPS Installation Script
#  Tested on: Ubuntu 22.04 / 24.04 LTS (Hostinger KVM 2+)
#  Usage: sudo bash install-vps.sh yourdomain.com
# ============================================================

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/ai-os"
APP_USER="aios"
NODE_VERSION="20"
REPO_URL="https://github.com/wholefoo/ai-os.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}━━━ ${1} ━━━${NC}"; }

# --- Pre-flight checks ---
if [ -z "$DOMAIN" ]; then
  err "Usage: sudo bash install-vps.sh yourdomain.com"
fi

if [ "$EUID" -ne 0 ]; then
  err "This script must be run as root - use sudo"
fi

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  AI OS Virtual Corporate HQ — VPS Installer${NC}"
echo -e "${CYAN}  Domain: ${DOMAIN}${NC}"
echo -e "${CYAN}  Target: ${APP_DIR}${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo ""

# ============================================================
step "[1/10] System Updates"
# ============================================================
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git build-essential unzip jq
log "System packages updated"

# ============================================================
step "[2/10] Firewall - UFW"
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
step "[3/10] Node.js ${NODE_VERSION}"
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
step "[4/10] PM2 Process Manager"
# ============================================================
npm install -g pm2 --quiet
log "PM2 installed: $(pm2 --version)"

# ============================================================
step "[5/10] Nginx"
# ============================================================
apt-get install -y -qq nginx
systemctl enable nginx
log "Nginx installed and enabled"

# ============================================================
step "[6/10] Certbot - Lets Encrypt"
# ============================================================
apt-get install -y -qq certbot python3-certbot-nginx
log "Certbot installed"

# ============================================================
step "[7/10] App User & Directory"
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
chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"
log "App directory ready: ${APP_DIR}"

# ============================================================
step "[8/10] Clone / Update Repository"
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
step "[9/10] Nginx Configuration"
# ============================================================
# Replace domain placeholder
sed "s/yourdomain\.com/${DOMAIN}/g" "${APP_DIR}/deploy/nginx.conf" > /etc/nginx/sites-available/ai-os
ln -sf /etc/nginx/sites-available/ai-os /etc/nginx/sites-enabled/ai-os
rm -f /etc/nginx/sites-enabled/default

# Add rate limit zone to nginx.conf if not present
if ! grep -q "zone=api" /etc/nginx/nginx.conf; then
  sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' /etc/nginx/nginx.conf
fi

nginx -t && systemctl reload nginx
log "Nginx configured for ${DOMAIN}"

# ============================================================
step "[10/10] Environment & PM2"
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

# Set up PM2 startup
pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER} 2>/dev/null || true

# Start the app (or restart if already running)
cd "${APP_DIR}"
sudo -u ${APP_USER} pm2 start ecosystem.config.js --env production 2>/dev/null || \
  sudo -u ${APP_USER} pm2 restart ai-os --update-env 2>/dev/null || true
sudo -u ${APP_USER} pm2 save
log "PM2 started and saved"

# ============================================================
# Done!
# ============================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Installation Complete!                         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
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
echo -e "  ${YELLOW}5. Verify:${NC}"
echo -e "     curl -s https://${DOMAIN}/api/health | jq ."
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "     pm2 logs ai-os          # Live log stream"
echo -e "     pm2 monit               # CPU/RAM monitor"
echo -e "     pm2 restart ai-os       # Restart server"
echo -e "     pm2 status              # Process status"
echo -e "     journalctl -u nginx -f  # Nginx logs"
echo ""
echo -e "  ${CYAN}Update from GitHub:${NC}"
echo -e "     cd ${APP_DIR} && git pull && npm install --production"
echo -e "     pm2 restart ai-os"
echo ""
