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
echo "[2/5] Pulling latest core on VPS..."
ssh "${VPS}" "cd ${APP_DIR} && sudo -u ${APP_USER} git pull origin master"

# Step 3: Pull the PRIVATE commercial repo too.
#
# This step did not exist until 2026-07-29, and its absence was a silent, compounding bug: the
# open-core split means a licensed instance runs TWO repos, but only the core was ever pulled here.
# The commercial checkout on the VPS had been frozen since 19 July — four commits behind, including
# clone-limit changes and an Enterprise-support removal — and nothing reported it, because a stale
# commercial module does not error. It just serves last month's behaviour.
#
# Only install-vps.sh pulled it, and nobody re-runs the installer for a routine deploy.
#
# Guarded on the directory existing, so Community installs (which have no commercial/ mount) skip it
# silently rather than failing. Run as APP_USER, matching install-vps.sh — a root pull here leaves
# root-owned objects in a tree the app user has to write to later.
echo "[3/5] Pulling commercial modules (skipped if Community)..."
ssh "${VPS}" "if [ -d ${APP_DIR}/commercial/.git ]; then cd ${APP_DIR}/commercial && sudo -u ${APP_USER} git pull origin master; else echo 'no commercial/ mount — Community tier, skipping'; fi"

# Step 4: Install dependencies EXACTLY as pinned
# npm ci, not npm install — see the matching comment in install-vps.sh. ci is reproducible and fails
# loudly when the lockfile is stale; npm install silently re-resolves semver ranges on every deploy.
echo "[4/5] Installing dependencies (npm ci — exact lockfile versions)..."
ssh "${VPS}" "cd ${APP_DIR} && sudo -u ${APP_USER} npm ci --omit=dev --quiet"

# Step 5: Restart PM2
#
# pm2 runs as APP_USER (systemd unit pm2-aios.service), so this MUST go through sudo -u: root has its
# own empty pm2 registry and `pm2 restart ai-os` as root fails with "Process or Namespace not found"
# while looking like a name problem.
echo "[5/5] Restarting AI OS..."
ssh "${VPS}" "sudo -u ${APP_USER} pm2 restart ai-os --update-env"

echo ""
echo "━━━ Deployment complete! ━━━"
echo "Verify: ssh ${VPS} 'curl -s http://localhost:3000/api/health | jq .'"
