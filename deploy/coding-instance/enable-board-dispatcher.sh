#!/usr/bin/env bash
# Enable/disable the Coding Board dispatcher as its OWN systemd service, separate from the web app.
#
#   sudo bash enable-board-dispatcher.sh          # install + enable + start ai-os-board-dispatcher
#   sudo bash enable-board-dispatcher.sh --off     # stop + disable it
#
# WHY a separate service (not the in-app pump): the web app unit (ai-os-hermes) is hardened with
# NoNewPrivileges=yes and RestrictSUIDSGID=yes. Those block exactly the two things the runner must do —
# `sudo -n hermes-agent-launch` (drop to the confined agent) and `chmod` the setgid task directories —
# and they cannot be dropped for a single child process. Rather than weaken the PUBLIC web app, the
# pump runs as its own unhardened `hermes` service (ai-os-board-dispatcher.service) sharing board.sqlite
# over WAL. The app keeps its hardening, keeps serving the board API, and HERMES_BOARD_DISPATCH is
# forced 0 in the app .env so it never also runs the in-process pump (that would double-claim tasks).
#
# Isolation is unchanged: the pump still runs as `hermes`, still reaches root only through the one
# scoped sudoers rule (hermes -> hermes-agent-launch), and the agent is still the confined hermes-agent
# in bubblewrap. This script refuses to run where the app user is not `hermes`.
set -euo pipefail

APP_SERVICE=${APP_SERVICE:-ai-os-hermes}
DISP_SERVICE=${DISP_SERVICE:-ai-os-board-dispatcher}
EXPECT_USER=${EXPECT_USER:-hermes}
RUNNER=${RUNNER:-/usr/local/bin/hermes-task}
LAUNCHER_SUDOERS=${LAUNCHER_SUDOERS:-/etc/sudoers.d/hermes-agent}
CONCURRENCY=${HERMES_BOARD_CONCURRENCY:-1}
POLL_MS=${HERMES_BOARD_POLL_MS:-5000}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNIT_SRC=$SCRIPT_DIR/ai-os-board-dispatcher.service
UNIT_DST=/etc/systemd/system/$DISP_SERVICE.service
MODE=on
[ "${1:-}" = "--off" ] && MODE=off

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

# Rewrite the HERMES_BOARD_* / HERMES_RUNNER_CMD block in the app .env. Backup first; drop the old keys
# (grep -v, never sed -i, so a regex-special value can't corrupt a neighbour and re-runs don't leave
# duplicate keys — dotenv takes the LAST, a silent trap); force DISPATCH=0 so the APP never runs the
# in-process pump. $1 = "config" (write runner settings too) or "off" (just DISPATCH=0).
write_env() {
  local backup tmp
  backup="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_FILE" "$backup"
  log "backed up $ENV_FILE -> $backup"
  tmp="$ENV_FILE.tmp.$$"
  grep -vE '^(HERMES_BOARD_DISPATCH|HERMES_RUNNER_CMD|HERMES_BOARD_CONCURRENCY|HERMES_BOARD_POLL_MS)=' "$ENV_FILE" > "$tmp" || true
  {
    echo "# Coding Board dispatcher (enable-board-dispatcher.sh) — pump runs as $DISP_SERVICE, NOT in-app"
    echo "HERMES_BOARD_DISPATCH=0"
    if [ "$1" = config ]; then
      echo "HERMES_RUNNER_CMD=$RUNNER"
      echo "HERMES_BOARD_CONCURRENCY=$CONCURRENCY"
      echo "HERMES_BOARD_POLL_MS=$POLL_MS"
    fi
  } >> "$tmp"
  chown --reference="$ENV_FILE" "$tmp" 2>/dev/null || true
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$ENV_FILE"
}

# ------------------------------------------------------------------ preflight ---
[ "$(id -u)" -eq 0 ] || die "run as root"
systemctl cat "$APP_SERVICE" >/dev/null 2>&1 || die "no systemd unit '$APP_SERVICE' — run provision.sh first"
APP_USER=$(systemctl show -p User --value "$APP_SERVICE")
APP_DIR=$(systemctl show -p WorkingDirectory --value "$APP_SERVICE")
[ -n "$APP_DIR" ] || die "could not read WorkingDirectory from $APP_SERVICE"
ENV_FILE="$APP_DIR/.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found — fill in the app .env first"
[ "$APP_USER" = "$EXPECT_USER" ] || die "the app runs as '$APP_USER', not '$EXPECT_USER' — this box is not wired for the coding runner; not enabling."

# ------------------------------------------------------------------ --off -------
if [ "$MODE" = off ]; then
  systemctl disable --now "$DISP_SERVICE" 2>/dev/null || true
  write_env off
  log "restarting $APP_SERVICE (in-process pump stays off)"
  systemctl restart "$APP_SERVICE"
  echo "  ok   $DISP_SERVICE stopped + disabled; the board still records and serves."
  exit 0
fi

# ------------------------------------------------------------------ on: checks --
[ -x "$RUNNER" ] || die "$RUNNER not found or not executable — run install-claude-code.sh first"
[ -f "$LAUNCHER_SUDOERS" ] || die "$LAUNCHER_SUDOERS missing — run install-agent-user.sh (the hermes -> hermes-agent-launch rule the runner needs)"
sudo -n -l -U "$APP_USER" 2>/dev/null | grep -q 'hermes-agent-launch' \
  || die "$APP_USER has no NOPASSWD rule for hermes-agent-launch — run install-agent-user.sh"
[ -f "$UNIT_SRC" ] || die "$UNIT_SRC not found next to this script"

# The node the app runs (first entry of its unit PATH), so the dispatcher uses the same one.
NODE_BIN=$(systemctl show "$APP_SERVICE" -p Environment --value | tr ' ' '\n' | sed -n 's/^PATH=//p' | cut -d: -f1)
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN/node" ]; then NODE_BIN=$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)"); fi
[ -x "$NODE_BIN/node" ] || die "could not find node (checked $APP_SERVICE PATH and \$PATH)"

# ------------------------------------------------------------------ app .env ----
# Runner config for the dispatcher service (it reads the same .env), and the in-process pump forced off.
write_env config
log "restarting $APP_SERVICE so its in-process pump is off (the separate service is the only pump)"
systemctl restart "$APP_SERVICE"

# ------------------------------------------------------ install dispatcher unit -
log "installing $DISP_SERVICE (User=$APP_USER, node=$NODE_BIN, app=$APP_DIR)"
sed -e "s|@HERMES_USER@|$APP_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" "$UNIT_SRC" > "$UNIT_DST"
chmod 644 "$UNIT_DST"
systemctl daemon-reload
START=$(date '+%Y-%m-%d %H:%M:%S')
systemctl enable --now "$DISP_SERVICE"
sleep 2
systemctl is-active --quiet "$DISP_SERVICE" || { journalctl -u "$DISP_SERVICE" -n 30 --no-pager; die "$DISP_SERVICE did not start — see the log above"; }

# ------------------------------------------------------------------- verify -----
log "verifying"
seen=""
for _ in $(seq 1 20); do
  if journalctl -u "$DISP_SERVICE" --since "$START" --no-pager 2>/dev/null | grep -q '\[board-dispatcher\] started'; then seen=started; break; fi
  sleep 2
done
if [ "$seen" = started ]; then echo "  ok   $DISP_SERVICE logged that it started"; else
  echo "  WARN did not see '[board-dispatcher] started' within ~40s. Check: journalctl -u $DISP_SERVICE -n 40"
fi

cat <<NEXT

Enabled. The dispatcher runs as its own service ($DISP_SERVICE) and claims ready tasks, running each
through $RUNNER (concurrency $CONCURRENCY). The web app keeps its hardening and just serves the board.
  * File a task from the dashboard (Coding Board -> + New Task) or via POST /api/board/intake.
  * Watch it:            journalctl -u $DISP_SERVICE -f
  * A run's full output: $APP_DIR/.magent/board-logs/<taskId>.log
  * Turn it off again:   sudo bash enable-board-dispatcher.sh --off
NEXT
