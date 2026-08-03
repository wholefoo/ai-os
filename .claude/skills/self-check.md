---
name: self-check
description: The pre-commit static gate for this repo — run node --check on every changed JS file and seclint --ci to 0 errors, mirroring the CI "Lint & Boot Check" job, before you commit (and push). Read engineering-workflow.md for the full ritual.
category: engineering
estimated_time: 1-2min
kind: reference   # the pre-commit static gate Claude Code runs in-session before committing
---

# Self-Check Skill (pre-commit static gate)

## Goal
Catch the two most common avoidable breaks — JS syntax errors and security-lint regressions — *before* they reach a commit, reproducing locally the checks that CI's **Lint & Boot Check** job will run anyway. This repo has **no unit-test suite**; this static gate plus a boot-verify (see `engineering-workflow.md`) is the verification story. Keep the tree at **0 seclint errors**.

## When to run
Before **every** commit that touches JavaScript (`server.js`, `dashboard/js/*.js`, `lib/**`, `commercial/**`). For CSS/HTML-only changes, the syntax step does not apply — a static review is enough; don't boot a server that proves nothing.

## Process

### 1. List the changed JS files
From the repo root (`D:/My Web Sites/AI OS Orchestration Lab/ai-os`), on the current branch (`master`):

```bash
# working-tree + staged JS changes (Git-Bash)
git diff --name-only --cached --diff-filter=ACM -- '*.js' '*.mjs'
git diff --name-only --diff-filter=ACM -- '*.js' '*.mjs'
```

To review everything on the branch versus the remote base instead:

```bash
git diff --name-only origin/master...HEAD -- '*.js' '*.mjs'
```

### 2. Syntax-check each changed file — `node --check`
`node --check <file>` parses without executing; a non-zero exit is a syntax error you must fix. CI runs exactly `node --check server.js`, so at minimum that must pass; extend it to every changed file:

```bash
# fail loudly on the first bad file (Git-Bash)
for f in $(git diff --name-only --cached --diff-filter=ACM -- '*.js' '*.mjs'; \
           git diff --name-only --diff-filter=ACM -- '*.js' '*.mjs'); do
  node --check "$f" || { echo "SYNTAX ERROR: $f"; break; }
done
```

Syntax errors here are the #1 avoidable break — never commit past a failing `node --check`.

### 3. Security lint — `node tools/seclint.js --ci` → must be **0 errors**
seclint is a deterministic, zero-token, no-network pattern linter. Run the CI form, which scans the default file set (`server.js`, `lib/**`, `dashboard/js/**`) and **exits 1 if any ERROR is found** (WARN never fails):

```bash
node tools/seclint.js --ci
```

To scan just specific files while iterating, pass them as bare arguments (no `--ci`):

```bash
node tools/seclint.js server.js lib/foo.js
```

There are **only** these invocations: bare `[file ...]`, `--ci`, and `--hook` (the PostToolUse hook form that reads `{tool_input:{file_path}}` from stdin). There is no `--fix`, `--json`, or auto-repair — fix findings by hand.

**The ERROR rules that gate CI:**
- `route-no-auth` — a mutating route (`app.post/put/delete('/api/…', (req…)`) with no middleware before the handler. Add `requireAdmin` / `requireClientOrAdmin`, or add the route to the `PUBLIC_ROUTES` allowlist in `tools/seclint.js` if it is genuinely public.
- `path-traversal` — `path.join(...)` built from `req.params/query/body` without a `path.basename()` guard.
- `shell-injection` — `execSync`/`exec` with an interpolated template string. Use `execFile()`/`spawn()` with an argument array.
- `jsonld-breakout` — `set:html={JSON.stringify(...)}` without escaping the embedded `<` (which lets a hostile string close the `</script>` — generated-site XSS).

**WARN (advisory, does not fail CI):**
- `innerhtml-unescaped` — `.innerHTML` assigned a template literal whose `${…}` isn't wrapped in `escapeHtml()`/`esc()`. Fix these anyway when you can.

**Suppressing a genuine false positive:** put a trailing comment on the offending line — `// seclint-ok: <one-line reason>` — or use `// seclint-disable-line` / `// seclint-disable-next-line`. Never a blanket disable; always a specific reason.

seclint also runs automatically as a **PostToolUse hook** (`node tools/seclint.js --hook`) on every Edit/Write and as the CI **"Security lint"** step, so a regression will surface even if you skip the manual run — but run it yourself so you fix it before committing, not after.

### 4. (Awareness) What else CI will run
The **Lint & Boot Check** job also runs, after the two steps above:
- `npx fallow dead-code` — a NEW unused export fails the build (intentional exports are whitelisted in `.fallowrc.json` `ignoreExports`).
- `npx fallow dupes` — duplication check.
- a commercial-fallback `node -e` check (Community core must load `lib/commercial-stub`, tier `community`).
- a boot smoke test: `DEMO_MODE=true PORT=3333 node server.js` then `GET /api/health` must return a `status`.

The separate **Security Audit** job runs `npm audit --audit-level=high` (continue-on-error) and a committed-secret grep.

If your change touches exports or could duplicate code, run `npx fallow dead-code` and `npx fallow dupes` locally too so CI doesn't surprise you.

### 5. Boot-verify only when the server serves the change
If the change is observable via the running server, prove it locally before committing (see `engineering-workflow.md`):

```bash
DEMO_MODE=true PORT=<free-port> node server.js   # run in background; PORT avoids clashing with 3000
```

- `GET /api/health` and `/api/auth/login` are public. **Most `/api/*` routes require `Authorization: Bearer <API_TOKEN>`** (`.env` sets `API_TOKEN`) — an unauthenticated curl returning `{"error":"Unauthorized…"}` is expected, not a bug.
- Verify actual behavior (traversal → 401/400 with no file written; bad input → 400; normal call → 200), then stop the server.
- **Stop the test server by PORT with the PowerShell tool** — `pkill -f "server.js"` does NOT kill Node on this win32 box:
  ```powershell
  Get-NetTCPConnection -LocalPort <port> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```

## Commit AND push — two separate steps
- `git commit` does **not** publish. **Also `git push origin master` in the same turn** unless the user said to hold. End commit messages with the `Co-Authored-By:` trailer.
- On push, a branch-protection note like `"Lint & Boot Check" is expected` means the status check hasn't *run yet* — not a failure.
- **Two repos:** changes under `commercial/` (cloned into `./commercial/`, gitignored here) need a **second commit + push in the `ai-os-commercial` repo** — pushing `ai-os` does not carry them.

## Exit criteria
Do not commit until:
1. `node --check` passes on every changed `.js`/`.mjs`.
2. `node tools/seclint.js --ci` reports **0 error(s)** (WARNs allowed; suppress only genuine false positives with a reasoned `// seclint-ok:`).
3. Any server-observable change has been boot-verified and the test server stopped.
