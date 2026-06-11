#!/usr/bin/env bash
# ============================================================
#  AI OS — Add n8n workflow automation to an existing VPS instance
#  Usage: sudo bash deploy/add-n8n.sh yourdomain.com
# ============================================================

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/ai-os"
APP_USER="aios"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[XX]${NC} $1"; exit 1; }

[ -z "$DOMAIN" ] && err "Usage: sudo bash deploy/add-n8n.sh yourdomain.com"
[ "$EUID" -ne 0 ] && err "Run as root: sudo bash deploy/add-n8n.sh ${DOMAIN}"
[ -d "$APP_DIR" ] || err "${APP_DIR} not found — is AI OS installed?"

# 1. Install n8n
log "Installing n8n (this can take a few minutes)..."
npm install -g n8n --quiet
log "n8n installed: $(n8n --version 2>/dev/null || echo 'installed')"

# 2. Generate a random basic-auth password instead of a CHANGE_ME placeholder
N8N_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20)

# 3. PM2 process
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
      N8N_BASIC_AUTH_PASSWORD: '${N8N_PASS}',
      GENERIC_TIMEZONE: 'UTC',
      N8N_USER_FOLDER: '/home/${APP_USER}/.n8n'
    },
    cwd: '/home/${APP_USER}',
    max_memory_restart: '512M',
    autorestart: true,
    min_uptime: 5000,
    max_restarts: 10,
    restart_delay: 5000
  }]
};
N8NECOSYSTEM

sudo -u ${APP_USER} pm2 start /tmp/n8n-ecosystem.config.js 2>/dev/null || \
  sudo -u ${APP_USER} pm2 restart n8n --update-env 2>/dev/null || true
sudo -u ${APP_USER} pm2 save
rm -f /tmp/n8n-ecosystem.config.js
log "n8n running on port 5678 via PM2"

# 4. Nginx reverse proxy at /n8n/
NGINX_SITE="/etc/nginx/sites-available/ai-os"
if [ -f "$NGINX_SITE" ] && ! grep -q 'location /n8n/' "$NGINX_SITE"; then
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
' "$NGINX_SITE"
  nginx -t && systemctl reload nginx
  log "Nginx: /n8n/ reverse proxy added and reloaded"
elif grep -q 'location /n8n/' "$NGINX_SITE" 2>/dev/null; then
  log "Nginx: /n8n/ block already present — skipped"
else
  warn "Nginx site ${NGINX_SITE} not found — add the /n8n/ proxy manually (see HOSTING.md)"
fi

echo ""
log "Done. n8n is at: https://${DOMAIN}/n8n/"
echo -e "  ${YELLOW}Login:${NC}    admin"
echo -e "  ${YELLOW}Password:${NC} ${N8N_PASS}"
echo -e "  (generated randomly — save it now; also recoverable via: pm2 env \$(pm2 id n8n))"
echo ""
echo -e "  Wire AI OS: set N8N_WEBHOOK_BASE=http://localhost:5678 in ${APP_DIR}/.env"
echo -e "  Auto-research overnight loop: see auto-research/README.md for the Schedule Trigger recipe"
