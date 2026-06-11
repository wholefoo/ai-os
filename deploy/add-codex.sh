#!/usr/bin/env bash
# ============================================================
#  AI OS — Add Codex CLI to an existing VPS instance
#  Cross-model verification engine for adversarial review panels
#  Usage: sudo bash deploy/add-codex.sh
#  Requires: OPENAI_API_KEY in /opt/ai-os/.env (script verifies)
# ============================================================

set -euo pipefail

APP_DIR="/opt/ai-os"
APP_USER="aios"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[XX]${NC} $1"; exit 1; }

[ "$EUID" -ne 0 ] && err "Run as root: sudo bash deploy/add-codex.sh"
[ -d "$APP_DIR" ] || err "${APP_DIR} not found — is AI OS installed?"

# 1. Install the CLI
npm install -g @openai/codex
log "Codex CLI installed: $(codex --version 2>/dev/null || echo 'installed')"

# 2. Config: API-key auth (no browser on a server) + trust the app dir
CODEX_HOME="/home/${APP_USER}/.codex"
mkdir -p "${CODEX_HOME}/prompts"

cat > "${CODEX_HOME}/config.toml" <<CODEXCONF
preferred_auth_method = "apikey"

[projects.'${APP_DIR}']
trust_level = "trusted"
CODEXCONF

# 3. Reviewer profile: read-only sandbox, never prompts — safe for headless panel calls.
#    NOTE: profiles live in separate <name>.config.toml files, not [profiles.*] tables.
cat > "${CODEX_HOME}/reviewer.config.toml" <<REVIEWERCONF
model = "gpt-5.5"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
approval_policy = "never"
REVIEWERCONF

# 4. /crossreview prompt — staged-diff review with SHIP/REVISE verdict
cat > "${CODEX_HOME}/prompts/crossreview.md" <<'CROSSREVIEW'
---
description: Cross-model review of staged changes (read-only)
argument-hint: [optional focus area]
---
Review the staged changes only. Run `git diff --staged` to see them.

For each issue, report:
- severity: blocker | should-fix | nit
- location: file:line
- problem: what's wrong (one line)
- fix: a concrete suggested change

Check correctness, edge cases, error handling, and whether existing tests
cover the change. Don't restate what the code does. Do not edit any files.
End with a one-line verdict: SHIP or REVISE.

If arguments are provided, focus the review on: $ARGUMENTS
CROSSREVIEW

chown -R ${APP_USER}:${APP_USER} "${CODEX_HOME}"
log "Codex configured: reviewer profile + /crossreview prompt + trusted ${APP_DIR}"

# 5. Verify end to end if the key is available
if grep -q '^OPENAI_API_KEY=.\+' "${APP_DIR}/.env" 2>/dev/null; then
  log "OPENAI_API_KEY found in .env — running headless bridge test (~30s)..."
  OPENAI_KEY=$(grep '^OPENAI_API_KEY=' "${APP_DIR}/.env" | cut -d= -f2-)
  set +e
  RESULT=$(cd "${APP_DIR}" && sudo -u ${APP_USER} OPENAI_API_KEY="${OPENAI_KEY}" \
    timeout 120 codex exec --profile reviewer "Reply with exactly: CODEX-BRIDGE-OK" < /dev/null 2>&1 | tail -1)
  set -e
  if echo "${RESULT}" | grep -q 'CODEX-BRIDGE-OK'; then
    log "Bridge test PASSED — cross-model panels are live on this instance"
  else
    warn "Bridge test did not return the expected marker. Last output: ${RESULT}"
    warn "Check the key is valid and has API access (platform.openai.com)"
  fi
else
  warn "OPENAI_API_KEY not set in ${APP_DIR}/.env — add it, then test with:"
  echo "  cd ${APP_DIR} && sudo -u ${APP_USER} OPENAI_API_KEY=sk-... codex exec --profile reviewer \"Reply OK\" < /dev/null"
fi

echo ""
log "Done. Panels invoke: codex exec --profile reviewer \"...\" < /dev/null  (stdin MUST be closed)"
