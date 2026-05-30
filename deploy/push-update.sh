#!/usr/bin/env bash
# ============================================================
#  AI OS — Push Update to VPS
#  Run from your local machine to deploy latest code
#  Usage: bash deploy/push-update.sh user@your-vps-ip
# ============================================================

set -euo pipefail

VPS="${1:-}"
APP_DIR="/opt/ai-os"
APP_USER="aios"

if [ -z "$VPS" ]; then
  echo "Usage: bash deploy/push-update.sh root@your-vps-ip"
  echo "   or: bash deploy/push-update.sh root@123.45.67.89"
  exit 1
fi

echo "━━━ AI OS — Deploying to ${VPS} ━━━"

# Step 1: Push latest to GitHub
echo "[1/4] Pushing to GitHub..."
git push origin master

# Step 2: Pull on VPS
echo "[2/4] Pulling latest code on VPS..."
ssh "${VPS}" "cd ${APP_DIR} && sudo -u ${APP_USER} git pull origin master"

# Step 3: Install any new dependencies
echo "[3/4] Installing dependencies..."
ssh "${VPS}" "cd ${APP_DIR} && sudo -u ${APP_USER} npm install --production --quiet"

# Step 4: Restart PM2
echo "[4/4] Restarting AI OS..."
ssh "${VPS}" "sudo -u ${APP_USER} pm2 restart ai-os --update-env"

echo ""
echo "━━━ Deployment complete! ━━━"
echo "Verify: ssh ${VPS} 'curl -s http://localhost:3000/api/health | jq .'"
