---
name: engineering-workflow
description: The proven, repo-specific mechanics for changing this codebase — pre-commit self-check, commit-AND-push, local boot-verify, the deploy ritual, seclint, and Windows/PowerShell reality. Read this before editing server.js / dashboard JS.
---

# Engineering Workflow (how we actually ship here)

Verification here is the **regression suites** (`node tools/test-all.js`) plus a static self-check
plus, where it applies, booting the real server and exercising routes. These are the mechanics that
keep changes correct and cheap. (Architecture map: `.claude/claude.md` routes to `.claude/context/`;
this file is process only. The verification STANDARD is `.claude/rules/testing.md`.)

## Pre-commit self-check (the real CI gate)
Before every commit that touches JS:
0. `node tools/test-all.js` — every `tools/test-*.js` suite must pass. A feature with a testable seam gets its own suite, registered in `.fallowrc.json` `entry`.
1. `node --check <file>` on each changed `.js` (server.js, dashboard/js/*.js, lib/**). Syntax errors here are the #1 avoidable break.
2. `node tools/seclint.js --ci` → **must be 0 errors**. seclint's ERROR rules: `route-no-auth` (mutating `/api` route with no auth middleware), `path-traversal` (`path.join` from `req.*` without `path.basename`), `shell-injection` (`exec`/`execSync` with an interpolated string), `jsonld-breakout` (generated-site `set:html={JSON.stringify(...)}` not escaping `<`→`<`). WARN-only: `innerhtml-unescaped`. (WARN never fails CI; keep ERRORs at 0.)
   - A genuine false positive gets a `// seclint-ok: <one-line reason>` on that line — never a blanket disable.
   - seclint also runs as a **PostToolUse hook** (`node tools/seclint.js --hook`) on every Edit/Write, and as a **CI gate** ("Security lint"). Keep the tree at **0/0**.
3. For CSS/HTML-only or lib changes the preview can't exercise, static check is enough — don't boot a server that proves nothing.

## Commit AND push — they are two steps
- `git commit` does **not** publish. **Always `git push origin master` in the same turn** unless the user said to hold. (The operator has repeatedly had to ask "did you push?" — don't make them.)
- End commit messages with the `Co-Authored-By:` trailer.
- Branch protection reports `Bypassed rule violations … "Lint & Boot Check" is expected` on push — that's the status check not having *run yet*, not a failure. Fine for these pushes.
- **Two repos:** the public core is `wholefoo/ai-os`; private commercial code lives in `ai-os-commercial`, cloned into `./commercial/` (gitignored here). A change under `commercial/` needs a **second commit+push in that repo** — pushing `ai-os` does not carry it. See memory `open-core-repo-split`.

## Local boot-verify (for anything the server serves)
When a change is observable via the running server, prove it:
```
DEMO_MODE=true PORT=<free-port> node server.js   # background; PORT avoids clashing with 3000
```
- `GET /api/health` and `/api/auth/login` are public. **Most `/api/*` routes require `Authorization: Bearer <API_TOKEN>`** because `.env` sets `API_TOKEN` — an unauth curl returns `{"error":"Unauthorized..."}`, which is expected, not a bug.
- Verify the actual behavior (e.g. traversal → 401/400 and no file written; a bad input → 400; a normal call → 200), then stop the server.
- The `preview_start`/`preview_*` tools (launch.json → `ai-os-dashboard`, port 3000) are the richer path for UI changes.

## Windows / shell reality (this is a win32 box)
- The **Bash tool is Git-Bash**; the **PowerShell tool is pwsh**. Each needs its own syntax.
- `pkill -f "server.js"` does **NOT** kill the Node process here (exit 127 / no match). To stop a test server, kill by port with the **PowerShell tool**:
  ```
  Get-NetTCPConnection -LocalPort <port> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```
- Prefer absolute paths; `cd` inside a compound Bash command can trigger a permission prompt.

## Deploy (operator runs on the VPS; you provide the command)
```
sudo -u aios git -C /opt/ai-os pull origin master && sudo -u aios pm2 restart ai-os --update-env
```
- **Cloudflare sits in front.** Front-end changes (`/app` assets are content-hash fingerprinted) need a **CF purge** (or purge the specific hashed `app.js`/`web-studio.js`/`security.js` + affected HTML) to reach browsers. **Server-route-only changes don't need a purge.** See memory `cloudflare-in-front`.
- If `commercial/` changed, the VPS needs **both** repos pulled.

## Model routing (don't hardcode "Opus")
Agent `.md` frontmatter says `claude-opus-5`, but the effective model is chosen at run time by
`resolveAnthropicModel()` from `settings.ai.reasoning_mode` (`balanced` default = Opus for the
strategic tier, **Sonnet 5** for professional/scout). Any UI/ledger surface that shows "the model"
must derive it from the routing, not the frontmatter. See memory `product-canon-and-content`.
