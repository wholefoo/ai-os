#!/usr/bin/env bash
# Run as root on the PM2 VPS. No Docker daemon/socket or extra sudo privileges for AI OS.
set -euo pipefail
APP_USER="${APP_USER:-aios}"
[[ "$EUID" -eq 0 ]] || { echo 'Run this installer with sudo.' >&2; exit 1; }
id "$APP_USER" >/dev/null
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || { echo 'The worker requires cgroup v2.' >&2; exit 1; }
apt-get update
apt-get install -y bubblewrap util-linux
[[ -x /usr/bin/node ]] || { echo 'Install Node 24 at /usr/bin/node first.' >&2; exit 1; }
# Only operator-selected dependencies are installed. Tenant package scripts never run here.
[[ ! -L /opt/aios-build-runtime ]] || { echo 'Runtime directory must not be a symlink.' >&2; exit 1; }
install -d -o root -g root -m 755 /opt/aios-build-runtime
cd /opt/aios-build-runtime
[[ ! -L package.json && ! -L node_modules ]] || { echo 'Unsafe runtime path.' >&2; exit 1; }
if [[ ! -f package.json ]]; then
  printf '%s\n' '{"name":"aios-build-runtime","private":true,"dependencies":{"astro":"4.16.0","@astrojs/tailwind":"5.1.0","tailwindcss":"3.4.0"}}' > package.json
fi
if [[ -f package-lock.json ]]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi
chown -R root:root /opt/aios-build-runtime
chmod -R go-w /opt/aios-build-runtime
loginctl enable-linger "$APP_USER"
worker_uid="$(id -u "$APP_USER")"
systemctl start "user@${worker_uid}.service"
library_args=()
[[ ! -e /lib64 ]] || library_args=(--ro-bind /lib64 /lib64)
sudo -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/${worker_uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${worker_uid}/bus" \
  /usr/bin/systemd-run --user --quiet --pipe --wait --collect --property=MemoryMax=768M --property=MemorySwapMax=0 --property=TasksMax=128 \
  /usr/bin/bwrap --unshare-all --die-with-parent --new-session --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  "${library_args[@]}" -- /bin/true
echo 'Worker installed. Set AIOS_BUILD_BACKEND=bubblewrap in AI OS .env and restart PM2 with --update-env.'
echo 'Then run tools/verify-build-worker.js as the application user before accepting generated-site jobs.'
