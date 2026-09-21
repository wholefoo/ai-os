#!/usr/bin/env bash
# Print a bcrypt hash for ADMIN_PASSWORD_HASH in .env.
#
#   sudo bash /opt/ai-os/deploy/make-admin-hash.sh
#
# Why a script instead of the one-liner the docs used to show
# (node -e "require('bcryptjs').hash('YOUR_PASSWORD',12)..."):
#   * the one-liner put the plaintext password in shell history and in `ps` for everyone on the box;
#   * `require('bcryptjs')` resolves from the CURRENT directory, so run from ~ it failed with
#     "Cannot find module 'bcryptjs'" — this script always resolves it from the app;
#   * the password is typed twice, hidden, and handed to node through the environment, never argv.
#
# Paste the output line into .env as ADMIN_PASSWORD_HASH=<hash>, then restart. The admin account is
# created ONCE, on the first start where ADMIN_EMAIL and ADMIN_PASSWORD_HASH are both set; changing
# them in .env afterwards does not change an account that already exists.
set -euo pipefail

APP_DIR=${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
BCRYPT="$APP_DIR/node_modules/bcryptjs"
[ -d "$BCRYPT" ] || { echo "bcryptjs not found under $APP_DIR/node_modules — run npm ci first" >&2; exit 1; }
command -v node >/dev/null || { echo "node not on PATH (with nvm, run this as the user whose shell loads it)" >&2; exit 1; }

read -r -s -p "Admin password: " PW1; echo
read -r -s -p "Again: " PW2; echo
[ "$PW1" = "$PW2" ] || { echo "passwords do not match" >&2; exit 1; }
[ "${#PW1}" -ge 12 ] || { echo "use at least 12 characters" >&2; exit 1; }

HASH=$(AIOS_PW="$PW1" BCRYPT="$BCRYPT" node -e 'require(process.env.BCRYPT).hash(process.env.AIOS_PW, 12).then(h => process.stdout.write(h))')
unset PW1 PW2

# bcrypt hashes contain `$`. dotenv reads them literally, but a hash pasted into a shell `export`,
# a double-quoted string, or a tool that expands variables would be mangled — keep it on its own
# line in .env exactly as printed, unquoted.
printf '\nADMIN_PASSWORD_HASH=%s\n\n' "$HASH"
