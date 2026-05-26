#!/usr/bin/env bash
# AI OS Orchestration Lab — VPS Install Script
# Tested on: Ubuntu 22.04 / 24.04 LTS
# Usage: curl -sSL <raw-url> | sudo bash
# Or: sudo bash install-vps.sh

set -euo pipefail

DOMAIN="${1:-yourdomain.com}"
APP_DIR="/opt/ai-os"
APP_USER="aios"
NODE_VERSION="20"

echo "============================================"
echo "  AI OS Orchestration Lab — VPS Installer"
echo "  Domain: ${DOMAIN}"
echo "============================================"

# --- System Updates ---
echo "[1/9] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# --- Firewall ---
echo "[2/9] Configuring firewall (UFW)..."
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable
echo "  Firewall: SSH, HTTP, HTTPS allowed"

# --- Node.js ---
echo "[3/9] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node --version), npm: $(npm --version)"

# --- PM2 ---
echo "[4/9] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER} || true

# --- Nginx ---
echo "[5/9] Installing Nginx..."
apt-get install -y -qq nginx
systemctl enable nginx

# --- Certbot (Let's Encrypt) ---
echo "[6/9] Installing Certbot..."
apt-get install -y -qq certbot python3-certbot-nginx

# --- App User ---
echo "[7/9] Creating app user '${APP_USER}'..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${APP_USER}"
fi

# --- App Directory ---
echo "[8/9] Setting up app directory..."
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/.magent/state"
mkdir -p "${APP_DIR}/.magent/vault/raw"
mkdir -p "${APP_DIR}/.magent/vault/wiki"
mkdir -p "${APP_DIR}/.magent/vault/outputs"
mkdir -p "${APP_DIR}/.magent/artifacts"
mkdir -p "${APP_DIR}/logs"
chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"

# --- Nginx Config ---
echo "[9/9] Deploying Nginx config..."
if [ -f "${APP_DIR}/deploy/nginx.conf" ]; then
  # Replace placeholder domain
  sed "s/yourdomain\.com/${DOMAIN}/g" "${APP_DIR}/deploy/nginx.conf" > /etc/nginx/sites-available/ai-os
  ln -sf /etc/nginx/sites-available/ai-os /etc/nginx/sites-enabled/ai-os
  rm -f /etc/nginx/sites-enabled/default

  # Add rate limit zone to nginx.conf if not present
  if ! grep -q "zone=api" /etc/nginx/nginx.conf; then
    sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' /etc/nginx/nginx.conf
  fi

  nginx -t && systemctl reload nginx
  echo "  Nginx configured for ${DOMAIN}"
else
  echo "  WARNING: No nginx.conf found at ${APP_DIR}/deploy/nginx.conf"
  echo "  Copy your project files first, then re-run this step."
fi

echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Copy project files to ${APP_DIR}/"
echo "     rsync -avz --exclude node_modules --exclude .env ./ ${APP_USER}@your-vps:${APP_DIR}/"
echo ""
echo "  2. On the VPS, install deps and create .env:"
echo "     cd ${APP_DIR} && npm install --production"
echo "     cp .env.example .env && nano .env"
echo ""
echo "  3. Get TLS certificate:"
echo "     certbot --nginx -d ${DOMAIN}"
echo ""
echo "  4. Start with PM2:"
echo "     su - ${APP_USER}"
echo "     cd ${APP_DIR} && pm2 start ecosystem.config.js --env production"
echo "     pm2 save"
echo ""
echo "  5. Verify:"
echo "     curl -s https://${DOMAIN}/api/health | jq ."
echo ""
