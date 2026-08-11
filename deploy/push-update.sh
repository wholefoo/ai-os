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
echo "[1/7] Pushing to GitHub..."
git push origin master

# Step 2: Pull on VPS
echo "[2/7] Pulling latest core on VPS..."
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
echo "[3/7] Pulling commercial modules (skipped if Community)..."
ssh "${VPS}" "if [ -d ${APP_DIR}/commercial/.git ]; then cd ${APP_DIR}/commercial && sudo -u ${APP_USER} git pull origin master; else echo 'no commercial/ mount — Community tier, skipping'; fi"

# Step 4: Install dependencies EXACTLY as pinned, then PROVE the tree is complete.
#
# npm ci, not npm install — ci is reproducible and fails loudly when the lockfile is stale, while
# npm install silently re-resolves semver ranges on every deploy. That reasoning still holds and is
# why `ci` stays the primary path.
#
# BUT `npm ci` DELETES node_modules BEFORE REBUILDING, and on 2026-08-11 the rebuild did not
# complete. The deploy went on to restart pm2 against a PARTIAL tree, server.js died at require(),
# and the main site was down ~40 minutes. `exceljs` was missing on one attempt and `adm-zip` on the
# next. Nothing noticed, because a half-built node_modules looks exactly like a healthy one until
# something requires the file that is not there — and we never established why the install failed,
# so its exit code alone cannot be trusted to tell us.
#
# So: install, then CHECK THE RESULT. If the tree is incomplete this ABORTS HERE, before the
# restart — `set -euo pipefail` turns the non-zero ssh into an abort, so steps 5-7 never run and the
# ALREADY-RUNNING PROCESS KEEPS SERVING on the tree it already has. That is the whole point: a
# failed install must be a stalled deploy, not an outage.
#
# It does NOT auto-repair, deliberately. `npm install --omit=dev` is what recovered the box that
# day, and it is what check-deps-installed.js tells the operator to run — but it stays a HUMAN
# step. `npm install` can silently rewrite package-lock.json when it finds drift, where `npm ci`
# errors; keeping it out of the automated path is the reproducibility rule this repo already
# encodes (tools/test-deploy-determinism.js asserts no non-global `npm install` survives in these
# scripts, and it caught an earlier version of this very change). Stopping the deploy is the fix
# for the outage; auto-repairing was convenience beyond the requirement, at the cost of a guard.
echo "[4/7] Installing dependencies (npm ci — exact lockfile versions)..."
ssh "${VPS}" "set -e
  cd ${APP_DIR}
  sudo -u ${APP_USER} npm ci --omit=dev --quiet || echo '  npm ci reported failure — the completeness check below is what decides'
  sudo -u ${APP_USER} node tools/check-deps-installed.js"

# Step 5: Install the root-owned hosting scripts.
#
# ANOTHER SILENT-DRIFT GAP, same shape as the commercial-pull one above and found the same way — by
# it going wrong. install-vps.sh (:426-446) installs the three privilege-boundary scripts to
# /usr/local/sbin, and nobody re-runs the installer for a routine deploy. So a fix to
# deploy/hosting/*.sh landed in the repo and NEVER reached the binary that actually runs: on
# 2026-08-10 a re-render used the stale generator, regenerated the OLD config, and reported `ok`.
# Nothing failed. The fix simply had no effect, which is indistinguishable from a fix that did not
# work.
#
# SECURITY INVARIANT: root:root 755, NOT writable by APP_USER — otherwise the sudoers grant becomes
# a root escalation. `install` enforces owner and mode on every deploy, so a hand-chmod drifts back.
# The sudoers file is validated as a STAGED copy before being moved into place; a malformed
# /etc/sudoers.d entry can lock the box out of sudo entirely.
echo "[5/7] Installing hosting scripts (root-owned privilege boundary)..."
ssh "${VPS}" "set -e
  if [ -d ${APP_DIR}/deploy/hosting ]; then
    sudo install -o root -g root -m 755 ${APP_DIR}/deploy/hosting/site-vhost.sh  /usr/local/sbin/aios-site-vhost
    sudo install -o root -g root -m 755 ${APP_DIR}/deploy/hosting/site-cert.sh   /usr/local/sbin/aios-site-cert
    sudo install -o root -g root -m 755 ${APP_DIR}/deploy/hosting/site-remove.sh /usr/local/sbin/aios-site-remove
    sudo install -o root -g root -m 440 ${APP_DIR}/deploy/hosting/aios-hosting.sudoers /etc/sudoers.d/aios-hosting.tmp
    if sudo visudo -cf /etc/sudoers.d/aios-hosting.tmp >/dev/null 2>&1; then
      sudo mv -f /etc/sudoers.d/aios-hosting.tmp /etc/sudoers.d/aios-hosting
      echo '  hosting scripts + sudoers installed'
    else
      sudo rm -f /etc/sudoers.d/aios-hosting.tmp
      echo '  WARNING: aios-hosting.sudoers failed visudo -c — NOT installed' >&2
    fi
  else
    echo '  no deploy/hosting — skipping'
  fi"

# Step 6: Audit the LIVE nginx config. Report only — never overwritten.
#
# Deliberately NOT a copy of deploy/nginx.conf. The live file is legitimately not the template:
# install-vps.sh seds the domain in (:353) and conditionally appends an n8n block (:364-381), and it
# accumulates local hardening besides. On 2026-08-10 the live vhost was 124 diff lines from the
# template. Copying that over on every deploy would destroy real configuration; a textual diff would
# differ every time and be ignored within a week.
#
# So this checks the PROPERTY that actually broke instead. nginx drops the inherited add_header set
# in any block that declares one of its own, which left /css/, /js/ and /docs/ serving no nosniff
# while the config read as if it were global. `nginx -t` cannot see that — it is valid config.
#
# Non-fatal on purpose: a header regression must not block shipping an unrelated hotfix. It is loud
# instead, and `|| true` is what keeps a report-only step from failing the deploy under `set -e`.
echo "[6/7] Auditing live nginx security headers (report only)..."
ssh "${VPS}" "sudo cat /etc/nginx/sites-available/ai-os 2>/dev/null | sudo -u ${APP_USER} node ${APP_DIR}/tools/check-nginx-headers.js" || true

# Step 7: Restart PM2
#
# `sudo -iu`, NOT `sudo -u`. pm2 locates its daemon via \$HOME, and plain `sudo -u` leaves HOME as
# the CALLING user's (root's) unless sudoers sets always_set_home — so pm2 reads /root/.pm2, finds an
# empty registry, and reports "Process or Namespace not found" as though the app name were wrong.
# `-iu` runs a login shell and sets HOME correctly. Same trap as running pm2 as root outright, which
# has already cost a diagnostic round trip on this box.
echo "[7/7] Restarting AI OS..."
ssh "${VPS}" "sudo -iu ${APP_USER} pm2 restart ai-os --update-env"

echo ""
echo "━━━ Deployment complete! ━━━"
echo "Verify: ssh ${VPS} 'curl -s http://localhost:3000/api/health | jq .'"
