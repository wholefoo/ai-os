#!/usr/bin/env bash
# Turn the Coding Board dispatcher ON for this Hermes-Dev instance.
#
#   sudo bash enable-board-dispatcher.sh          # enable, restart, verify
#   sudo bash enable-board-dispatcher.sh --off     # disable again (restart, verify)
#
# What this does — and, deliberately, does NOT do:
#   * It only writes four HERMES_BOARD_* lines into the app's .env and restarts the service. The
#     board code is already on master; this is the switch, not an install.
#   * It adds NO sudoers rule. On this box the AI OS app RUNS AS `hermes` (provision.sh: HERMES_USER,
#     the systemd unit's User=), and `hermes` already owns the runner and holds the one scoped sudoers
#     rule it needs (hermes -> hermes-agent-launch, from install-agent-user.sh). So the in-process
#     dispatcher runs `hermes-task` DIRECTLY, as itself. Granting the web app the right to run code as
#     another user would be a strictly wider privilege than the design calls for — so this refuses to
#     run anywhere the app user is not `hermes` (e.g. a production box where it is `aios`) rather than
#     silently minting that grant.
#   * It does NOT run any install/build before the restart (npm ci and a restart chained together took
#     a live box down for 40 minutes once — an env edit is not that, and this keeps it that way).
#
# Idempotent: re-run it to change concurrency/poll, or with --off to disable. Every write to .env is
# preceded by a timestamped backup.
set -euo pipefail

SERVICE=${SERVICE:-ai-os-hermes}
EXPECT_USER=${EXPECT_USER:-hermes}
RUNNER=${RUNNER:-/usr/local/bin/hermes-task}
LAUNCHER_SUDOERS=${LAUNCHER_SUDOERS:-/etc/sudoers.d/hermes-agent}
CONCURRENCY=${HERMES_BOARD_CONCURRENCY:-1}
POLL_MS=${HERMES_BOARD_POLL_MS:-5000}
MODE=on
[ "${1:-}" = "--off" ] && MODE=off

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight ---
[ "$(id -u)" -eq 0 ] || die "run as root"
systemctl cat "$SERVICE" >/dev/null 2>&1 || die "no systemd unit '$SERVICE' — run provision.sh first"

APP_USER=$(systemctl show -p User --value "$SERVICE" 2>/dev/null)
APP_DIR=$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null)
[ -n "$APP_DIR" ] || die "could not read WorkingDirectory from $SERVICE"
ENV_FILE="$APP_DIR/.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found — fill in the app .env first"

# The core safety check: the dispatcher runs the runner AS the app user, so the app user MUST be the
# runner user. If it is anything else, wiring this here would need a privilege grant this script
# refuses to make — stop and say so.
[ "$APP_USER" = "$EXPECT_USER" ] || die "the app runs as '$APP_USER', not '$EXPECT_USER'. The board dispatcher runs $RUNNER as the app user, which only works when the app user IS the runner user. This box is not wired that way; not enabling."

if [ "$MODE" = on ]; then
  [ -x "$RUNNER" ] || die "$RUNNER not found or not executable — run install-claude-code.sh first"
  # hermes reaches the confined agent only through the launcher sudoers rule; without it the runner
  # can start but every task fails at bubblewrap. Fail loudly now, not per-task later.
  [ -f "$LAUNCHER_SUDOERS" ] || die "$LAUNCHER_SUDOERS missing — run install-agent-user.sh (the hermes -> hermes-agent-launch rule the runner needs)"
  sudo -n -l -U "$APP_USER" 2>/dev/null | grep -q 'hermes-agent-launch' \
    || die "$APP_USER has no NOPASSWD rule for hermes-agent-launch — run install-agent-user.sh"
fi

# ------------------------------------------------------------------ edit .env ---
BACKUP="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
log "backed up $ENV_FILE -> $BACKUP"

# Drop any existing HERMES_BOARD_* / HERMES_RUNNER_CMD lines, then append the desired set. grep -v
# (not sed -i in place) so a value containing regex-special characters can never corrupt a neighbour,
# and so re-running never leaves duplicate keys (dotenv takes the LAST — duplicates are a silent trap).
TMP="$ENV_FILE.tmp.$$"
grep -vE '^(HERMES_BOARD_DISPATCH|HERMES_RUNNER_CMD|HERMES_BOARD_CONCURRENCY|HERMES_BOARD_POLL_MS)=' "$ENV_FILE" > "$TMP" || true

if [ "$MODE" = on ]; then
  {
    echo "# Coding Board dispatcher (enable-board-dispatcher.sh)"
    echo "HERMES_BOARD_DISPATCH=1"
    echo "HERMES_RUNNER_CMD=$RUNNER"
    echo "HERMES_BOARD_CONCURRENCY=$CONCURRENCY"
    echo "HERMES_BOARD_POLL_MS=$POLL_MS"
  } >> "$TMP"
else
  echo "HERMES_BOARD_DISPATCH=0" >> "$TMP"
fi

# Preserve ownership/mode, then move into place.
chown --reference="$ENV_FILE" "$TMP" 2>/dev/null || true
chmod --reference="$ENV_FILE" "$TMP" 2>/dev/null || true
mv -f "$TMP" "$ENV_FILE"
log ".env updated (dispatcher $MODE)"

# ------------------------------------------------------------------- restart ---
log "restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "$SERVICE did not come back up — restored config is in $BACKUP"; }

# ------------------------------------------------------------------- verify ----
log "verifying"
if [ "$MODE" = on ]; then
  if journalctl -u "$SERVICE" --since '30 seconds ago' --no-pager 2>/dev/null | grep -q '\[board\] dispatcher started'; then
    echo "  ok   the dispatcher logged that it started"
  else
    echo "  WARN could not see '[board] dispatcher started' in the last 30s of logs — check: journalctl -u $SERVICE | grep board"
  fi
  cat <<NEXT

Enabled. The board now claims ready tasks and runs them through $RUNNER (concurrency $CONCURRENCY).
  * File a task from the dashboard (Coding Board -> + New Task) or via POST /api/board/intake.
  * Watch it: journalctl -u $SERVICE -f | grep -i board
  * Turn it off again:  sudo bash enable-board-dispatcher.sh --off
NEXT
else
  echo "  ok   dispatcher disabled; the board still records and serves, it just does not run tasks."
fi
