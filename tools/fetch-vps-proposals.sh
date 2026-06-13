#!/usr/bin/env bash
# ============================================================
#  Maintainer tool — pull VPS self-improvement proposals down for review.
#
#  The VPS self-improvement engine generates enhancement proposals (and may
#  auto-apply some as LOCAL-only commits) but never pushes them — they die on
#  the box. This stages them here so the /ingest-vps-proposals skill can
#  adversarially vet each one and merge the real ones upstream into the package.
#
#  Transport is SSH/scp only — the VPS gets ZERO repo access; the air-gap that
#  keeps dashboard-initiated code off the remote stays closed.
#
#  Usage:
#    bash tools/fetch-vps-proposals.sh root@<vps-host>
#
#  Stages into  .magent/vps-proposals/<timestamp>/  (gitignored):
#    - pending_approvals.json   the self-improvement proposal queue
#    - <sha>.patch              any locally-applied self-improvement commits
#    - applied-commits.txt      their shas (empty if none)
# ============================================================

set -euo pipefail

VPS="${1:?Usage: bash tools/fetch-vps-proposals.sh root@<vps-host>}"
APP_DIR="/opt/ai-os"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="${REPO_ROOT}/.magent/vps-proposals/${STAMP}"
mkdir -p "$STAGE"

echo "→ Pulling self-improvement proposal queue from ${VPS}:${APP_DIR} ..."
if scp -q "${VPS}:${APP_DIR}/.magent/state/pending_approvals.json" "${STAGE}/pending_approvals.json" 2>/dev/null; then
  COUNT="$(grep -o '"id"' "${STAGE}/pending_approvals.json" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  pulled pending_approvals.json (~${COUNT} proposal[s])"
else
  echo "  (no pending_approvals.json on the box — self-improvement queue is empty)"
  echo "[]" > "${STAGE}/pending_approvals.json"
fi

echo "→ Capturing any locally-applied self-improvement commits ahead of origin ..."
ssh "$VPS" "cd ${APP_DIR} && git fetch -q origin master 2>/dev/null && git log --reverse --pretty='%H' origin/master..HEAD -i --grep='self-improvement' 2>/dev/null" \
  > "${STAGE}/applied-commits.txt" 2>/dev/null || true

if [ -s "${STAGE}/applied-commits.txt" ]; then
  N=0
  while read -r SHA; do
    [ -n "$SHA" ] || continue
    if ssh "$VPS" "cd ${APP_DIR} && git format-patch -1 --stdout ${SHA}" > "${STAGE}/${SHA:0:12}.patch" 2>/dev/null; then
      N=$((N + 1))
    fi
  done < "${STAGE}/applied-commits.txt"
  echo "  captured ${N} applied-commit patch(es) — review these as already-mutated changes"
else
  echo "  (no locally-applied self-improvement commits — box is in sync with origin)"
fi

echo ""
echo "✓ Staged in: ${STAGE}"
echo "  Next: run the /ingest-vps-proposals skill to adversarially review and merge keepers."
