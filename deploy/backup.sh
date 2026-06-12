#!/usr/bin/env bash
# ============================================================
#  AI OS — Nightly on-box backup
#  Archives all irreplaceable state to a directory OUTSIDE the
#  app tree so provider snapshots / weekly backups cover it and
#  a bad deploy can't take the backups down with it.
#
#  What's backed up:
#    /opt/ai-os/.magent     — live platform state, vault, artifacts
#    /opt/ai-os/.env        — API keys and secrets
#    /home/aios/.n8n        — n8n workflows, credentials, database
#
#  Usage:
#    sudo bash deploy/backup.sh            # run one backup now
#    sudo bash deploy/backup.sh --install  # also add the 3:30am cron entry
#    sudo bash deploy/backup.sh --list     # show existing backups
#
#  Restore (example):
#    sudo tar -xzf /var/backups/ai-os/daily-YYYY-MM-DD.tar.gz -C /
#    sudo -u aios pm2 restart ai-os n8n --update-env
#
#  Retention: 7 daily + 4 weekly (Sundays promote to weekly-).
# ============================================================

set -euo pipefail

APP_DIR="/opt/ai-os"
APP_USER="aios"
BACKUP_DIR="/var/backups/ai-os"
LOG="${APP_DIR}/logs/backup.log"
KEEP_DAILY=7
KEEP_WEEKLY=4

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; echo "$(date -Is) [OK] $1" >> "$LOG" 2>/dev/null || true; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; echo "$(date -Is) [!!] $1" >> "$LOG" 2>/dev/null || true; }
err()  { echo -e "${RED}[XX]${NC} $1"; echo "$(date -Is) [XX] $1" >> "$LOG" 2>/dev/null || true; exit 1; }

[ "$EUID" -ne 0 ] && err "Run as root: sudo bash deploy/backup.sh"

if [ "${1:-}" = "--list" ]; then
  ls -lh "$BACKUP_DIR" 2>/dev/null || echo "No backups yet (${BACKUP_DIR} empty)"
  exit 0
fi

# Backup dir: root-only — the archives contain .env secrets
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
mkdir -p "$(dirname "$LOG")"

STAMP=$(date +%F)
DAILY="${BACKUP_DIR}/daily-${STAMP}.tar.gz"

# Build the archive with absolute paths so restore is a single tar -C /
TARGETS=()
[ -d "${APP_DIR}/.magent" ]   && TARGETS+=("${APP_DIR}/.magent")
[ -f "${APP_DIR}/.env" ]      && TARGETS+=("${APP_DIR}/.env")
[ -d "/home/${APP_USER}/.n8n" ] && TARGETS+=("/home/${APP_USER}/.n8n")
[ ${#TARGETS[@]} -eq 0 ] && err "Nothing to back up — is AI OS installed at ${APP_DIR}?"

tar -czf "$DAILY" --absolute-names "${TARGETS[@]}" 2>/dev/null || \
  tar -czf "$DAILY" -P "${TARGETS[@]}"
SIZE=$(du -h "$DAILY" | cut -f1)
log "Backup written: ${DAILY} (${SIZE}) — $(echo "${TARGETS[@]}" | tr ' ' ',')"

# Sunday: promote today's archive to the weekly set
if [ "$(date +%u)" = "7" ]; then
  cp "$DAILY" "${BACKUP_DIR}/weekly-${STAMP}.tar.gz"
  log "Promoted to weekly-${STAMP}.tar.gz"
fi

# Rotation. The `|| true` is REQUIRED: with `set -e`/`pipefail`, an empty glob
# (e.g. no weekly-*.tar.gz on a fresh box) makes `ls` exit non-zero and would
# otherwise abort the whole script before the cron install below.
ls -1t "${BACKUP_DIR}"/daily-*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f || true
ls -1t "${BACKUP_DIR}"/weekly-*.tar.gz 2>/dev/null | tail -n +$((KEEP_WEEKLY + 1)) | xargs -r rm -f || true
COUNT=$(ls -1 "${BACKUP_DIR}" 2>/dev/null | wc -l)
log "Rotation done — ${COUNT} archive(s) retained (${KEEP_DAILY} daily + ${KEEP_WEEKLY} weekly max)"

# Freshness sanity: warn if the archive is implausibly small (state loss upstream?)
MIN_BYTES=10240
[ "$(stat -c%s "$DAILY")" -lt "$MIN_BYTES" ] && warn "Backup is under 10KB — verify state directories are intact"

# Optional cron install
if [ "${1:-}" = "--install" ]; then
  if ! command -v crontab >/dev/null 2>&1; then
    warn "cron is not installed on this host — nightly schedule NOT set up."
    echo "    Install cron, then re-run this with --install:"
    echo "      sudo apt-get update && sudo apt-get install -y cron && sudo systemctl enable --now cron"
    echo "      sudo bash ${APP_DIR}/deploy/backup.sh --install"
  else
    CRON_LINE="30 3 * * * /bin/bash ${APP_DIR}/deploy/backup.sh >> ${APP_DIR}/logs/backup.log 2>&1"
    # `|| true` guards the case where root has no existing crontab (crontab -l exits non-zero).
    ( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' || true; echo "$CRON_LINE" ) | crontab -
    log "Cron installed (root): nightly at 3:30am"
  fi
fi

echo ""
log "Done. Restore: sudo tar -xzf ${BACKUP_DIR}/daily-<date>.tar.gz -P -C / && sudo -u ${APP_USER} pm2 restart ai-os n8n --update-env"
