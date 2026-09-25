#!/usr/bin/env bash
# Exercise hermes-task against local fixtures: bare repos stand in for GitHub, a stub for claude.
set -u
RUNNER=${RUNNER:-"$(cd "$(dirname "$0")/.." && pwd)/hermes-task"}
HERE=$(cd "$(dirname "$0")" && pwd)
R=$(mktemp -d); export HT_HOME=$R/home; mkdir -p "$HT_HOME/.config/hermes-runner"
TOKEN="sk-ant-oat01-FIXTURE$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export HT_TOKEN_FILE=$HT_HOME/.config/hermes-runner/claude-oauth-token
printf '%s\n' "$TOKEN" > "$HT_TOKEN_FILE"; chmod 600 "$HT_TOKEN_FILE"
export HT_SKIP_MODE_CHECK=1          # Windows filesystems don't report POSIX modes
export HT_CLAUDE_BIN="$HERE/stub-claude" STUB_ENV_OUT=$R/stub-env HT_TEST_CMD="node test.js"

# upstream (stands in for wholefoo/ai-os), origin (the fork), base (the box's clone)
git init -q --bare -b master "$R/upstream.git"; git init -q --bare -b master "$R/origin.git"
git init -q -b master "$R/seed"; ( cd "$R/seed"
  git config user.email t@t; git config user.name t
  echo hello > hello.txt
  echo 'const s=require("fs").readFileSync("hello.txt","utf8");if(/BROKEN/.test(s)){console.error("broken");process.exit(1)}console.log("ok")' > test.js
  git add -A; git commit -qm seed; git push -q "$R/upstream.git" master; git push -q "$R/origin.git" master )
git clone -q "$R/origin.git" "$R/home/work/ai-os"
AIOS_KEY="sk-ant-api03-FIXTUREKEY$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf 'ANTHROPIC_API_KEY=%s\n' "$AIOS_KEY" > "$R/home/work/ai-os/.env"
export HT_UPSTREAM_URL=$R/upstream.git HT_ORIGIN_URL=$R/origin.git

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1"; }
run() { STUB_MODE=$1; shift; export STUB_MODE
        # Poison the environment: the runner must strip these before launching claude.
        OUT=$(ANTHROPIC_API_KEY="$AIOS_KEY" ANTHROPIC_AUTH_TOKEN=poison bash "$RUNNER" "$@" 2>&1); RC=$?; }
branches() { git -C "$R/origin.git" for-each-ref --format='%(refname:short)' refs/heads/ | grep -c '^hermes/' || true; }
no_secret_in_output() { if printf '%s' "$OUT" | grep -qF -- "$TOKEN" || printf '%s' "$OUT" | grep -qF -- "$AIOS_KEY"; then bad "$1: a secret value was PRINTED"; else ok "$1: no secret value printed"; fi; }

echo "happy path"
run good "Make hello say world"
[ $RC = 0 ] && ok "exit 0" || bad "exit $RC: $(printf '%s' "$OUT" | tail -3)"
printf '%s' "$OUT" | grep -q 'RESULT: pushed' && ok "status pushed" || bad "status not pushed"
[ "$(branches)" = 1 ] && ok "branch on the fork" || bad "branches on fork: $(branches)"
b=$(git -C "$R/origin.git" for-each-ref --format='%(refname:short)' refs/heads/hermes/ | head -1)
[ "$(git -C "$R/origin.git" show "$b:hello.txt")" = world ] && ok "commit carries the change" || bad "change missing"
git -C "$R/origin.git" log -1 --format=%s "$b" | grep -q 'Say world' && ok "agent's commit message used" || bad "commit message"
[ "$(git -C "$R/upstream.git" for-each-ref refs/heads/ | wc -l | tr -d ' ')" = 1 ] && ok "upstream untouched" || bad "upstream changed"
grep -qx 'api_key_set=' "$STUB_ENV_OUT" && ok "ANTHROPIC_API_KEY stripped before claude" || bad "API key REACHED claude"
grep -qx 'auth_token_set=' "$STUB_ENV_OUT" && ok "ANTHROPIC_AUTH_TOKEN stripped" || bad "auth token reached claude"
grep -qx "oauth_len=${#TOKEN}" "$STUB_ENV_OUT" && ok "OAuth token passed intact" || bad "oauth token wrong: $(grep oauth_len "$STUB_ENV_OUT")"
grep -qx 'scrub=1' "$STUB_ENV_OUT" && ok "subprocess env scrub on" || bad "scrub not set"
grep -q -- '--setting-sources user' "$STUB_ENV_OUT" && ok "repo hooks not loaded (--setting-sources user)" || bad "setting sources"
grep -q -- '--permission-prompts none' "$STUB_ENV_OUT" && ok "unattended: prompts denied" || bad "permission prompts"
no_secret_in_output happy

echo "billed to the API key"
run apikey "Make hello say world"
[ $RC != 0 ] && printf '%s' "$OUT" | grep -q 'RESULT: unsafe' && ok "refused (unsafe)" || bad "not refused: rc=$RC"
[ "$(branches)" = 1 ] && ok "nothing pushed" || bad "pushed anyway"

echo "token leaked into the transcript"
run leak "Make hello say world"
printf '%s' "$OUT" | grep -q 'token_in_logs=1' && ok "leak counted" || bad "leak not detected"
printf '%s' "$OUT" | grep -q 'RESULT: unsafe' && ok "refused (unsafe)" || bad "not refused"
[ "$(branches)" = 1 ] && ok "nothing pushed" || bad "pushed anyway"
no_secret_in_output leak

echo "tests red"
run redtests "Break it"
printf '%s' "$OUT" | grep -q 'RESULT: tests_failed' && ok "tests_failed" || bad "status: $(printf '%s' "$OUT" | grep RESULT)"
[ "$(branches)" = 1 ] && ok "nothing pushed" || bad "pushed anyway"

echo "no changes"
run nochange "Do nothing"
[ $RC = 2 ] && ok "exit 2" || bad "exit $RC"

echo "probe"
run probe_good --probe
printf '%s' "$OUT" | grep -q '^PROBE: PASS' && ok "PASS when every step attempted and blocked" || bad "$(printf '%s' "$OUT" | grep -A12 'PROBE RESULTS')"
[ ! -e "$HT_HOME/.config/hermes-runner/probe-canary" ] && ok "canary cleaned up" || bad "canary left behind"
run probe_refuse --probe
printf '%s' "$OUT" | grep -q '^PROBE: INCONCLUSIVE' && ok "INCONCLUSIVE when the model declines" || bad "refusal not caught: $(printf '%s' "$OUT" | grep PROBE:)"
run probe_leak --probe
printf '%s' "$OUT" | grep -q '^PROBE: FAIL' && ok "FAIL when the canary leaks" || bad "canary leak not caught"

echo "auth check"
run auth --auth-check
printf '%s' "$OUT" | grep -q 'AUTH CHECK: PASS' && ok "PASS" || bad "$OUT"
run apikey --auth-check
printf '%s' "$OUT" | grep -q 'AUTH CHECK: FAIL' && ok "FAIL when billed to an API key" || bad "not caught"

echo "guards"
mkdir "$HT_HOME/.hermes-task.lock"; echo $$ > "$HT_HOME/.hermes-task.lock/pid"
run good "x"; printf '%s' "$OUT" | grep -q 'another task is running' && ok "one task at a time" || bad "lock ignored"
echo 999999 > "$HT_HOME/.hermes-task.lock/pid"
run nochange "x"; [ $RC = 2 ] && ok "stale lock reclaimed" || bad "stale lock blocked: $RC"
mv "$HT_TOKEN_FILE" "$HT_TOKEN_FILE.x"; run good "x"
printf '%s' "$OUT" | grep -q 'no token' && ok "refuses without a token" || bad "ran without token"
mv "$HT_TOKEN_FILE.x" "$HT_TOKEN_FILE"

echo; echo "passed=$pass failed=$fail"
rm -rf "$R"
[ $fail = 0 ]
