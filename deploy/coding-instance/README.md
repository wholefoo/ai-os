# Unattended coding instance

A separate AI OS instance for an agent (Hermes `dev-project` mode, Self-Improve) to code on overnight
and open **pull requests** — never to merge or deploy.

## Why a separate box

Do **not** run this on the server that hosts production or customer sites. That server holds the
live sites, the sudo hosting bridge and certbot; an agent with a shell there has a path to all of it,
and the ordinary mistakes (`npm` run as root, an install chained to a restart) become outages. A
small second VPS gives isolation by construction.

**Specs:** 4 GB RAM / 2 vCPU / 40 GB SSD, Debian 13 on KVM. RAM is the binding constraint:
`npm ci` peaks near 1 GB and a Web Studio (Astro) build wants 1–2 GB. The agent spends most of its
time waiting on API calls, so extra cores buy little.

## What is here

| File | What it does |
|---|---|
| `provision.sh` | One-shot, idempotent root provisioner: packages, 2 GB swap, ufw, fail2ban, an unprivileged `hermes` user, Node 24 via nvm, the clone, a guarded `.env` template, the systemd unit. Ends in 18 checks. |
| `ai-os-hermes.service` | systemd unit template (the provisioner fills in the paths). |
| `verify.sh` | Read-only re-run of the checks; every failure prints its fix. |
| `add-https.sh` | Optional: nginx + Let's Encrypt in front of the dashboard at a hostname you choose. |

```bash
# Copied from Windows? strip CRs first:  sed -i 's/\r$//' *.sh *.service
bash provision.sh                     # both files in the same directory
nano /home/hermes/work/ai-os/.env     # see "Before it runs unattended"
systemctl enable --now ai-os-hermes
DOMAIN=hermes.example.com bash add-https.sh   # optional; refuses while .env auth is blank
```

## Phase 1: Claude Code as the coding engine

| File | What it does |
|---|---|
| `install-claude-code.sh` | Root. Installs Claude Code **as `hermes`**, the sandbox policy and the runner, then verifies ownership. |
| `claude-policy.json` | Installed root-owned as `/etc/claude-code/managed-settings.json` (highest precedence, not editable by the agent). Sandbox on with no unsandboxed fallback; the token folder, `~/.ssh`, `~/work` (AI OS's `.env` and state) and shell history unreadable — denied by location, because hiding all of `~/` and re-opening the workspace read-only stopped the sandbox from starting at all; network limited to `registry.npmjs.org`; web tools off; `git push` denied. Bash is explicitly **allowed**: the credential scrub turns off the sandbox's own auto-approval, and without the rule every ordinary command — `npm test` included — is refused in an unattended run. The scrub also forces every command into the sandbox, so the sandbox stays the boundary. |
| `hermes-task` | Installed root-owned at `/usr/local/bin`. Clones a fresh task workspace, runs Claude Code, **re-runs the tests itself**, commits, pushes a branch to the fork. |
| `test/` | Fixture harness; `tools/test-hermes-task.js` runs it in `npm test`. |

It runs on the operator's **Claude subscription**: `claude setup-token` on a desktop, then the token
saved at `~hermes/.config/hermes-runner/claude-oauth-token`, mode 600. Save it with hidden input and
**whitespace stripped** — `setup-token` prints one long line, the terminal wraps it, and a copy can
keep the break as a space (the first real token arrived that way and failed with a bare 401):

```bash
sudo -iu hermes bash -c 'umask 077; read -rs -p "Paste token, then Enter: " T && printf "%s\n" "$T" | tr -d "[:space:]" > ~/.config/hermes-runner/claude-oauth-token && printf "\n" >> ~/.config/hermes-runner/claude-oauth-token && unset T && echo saved'
```

The runner and installer both refuse a token file containing whitespace. Order of work:

```bash
bash install-claude-code.sh                       # as root
sudo -iu hermes hermes-task --auth-check          # which credential? must PASS
sudo -iu hermes hermes-task --probe               # can the agent reach what it shouldn't? must PASS
sudo -iu hermes hermes-task "A small, safe task"  # a real run -> RESULT: pushed
```

What every run proves rather than assumes:

- **The subscription is what gets billed.** `ANTHROPIC_API_KEY` outranks the OAuth token and is used
  without prompting in `-p` mode — and this box's AI OS `.env` has one. The runner unsets it, a
  second guard inside the launch refuses if it is still present, and the init event's
  `apiKeySource` must not be `ANTHROPIC_API_KEY`.
- **The agent cannot see its credential.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips it from
  every command the agent runs (and isolates their PID namespace from `/proc`); the token is passed
  with `export`, never on a command line. The token and the AI OS key must appear **0** times in
  the transcript, stderr, and changed files — only counts are printed, never values.
- **The tests really pass.** The agent is told to run `npm test`; the runner runs it again itself,
  outside the agent's control, and only that result decides whether anything is pushed.
- **The repo's own `.claude/` hooks do not run.** They were written for a developer desktop;
  `--setting-sources user` keeps them out of unattended runs.

`--probe` is only a PASS if every step was demonstrably **attempted** and blocked, and a positive
control was read back. A model that quietly declines a step produces INCONCLUSIVE, not PASS: a
boundary nobody tried has not been proven.

Limits per task: `--budget` (default $5, an estimate — on a subscription it bounds work, not a
bill), `--turns` (80), `--timeout` (45m), `--model` (sonnet; pass `opus` for hard tasks). One task at
a time. The usage-credit cap in claude.ai is **account-wide** — it bounds the operator's own overflow
use too, and tasks share the plan's allowance, so prefer off-hours runs.

## Deliberate choices — don't "fix" them back

- **`AIOS_HARD_BUDGET=true`** in the `.env` template. It is off by default in the app, which is
  right for a supervised instance and wrong for an unattended one: it is what stops a runaway night.
- **`AIOS_AUTOMATION_MODE=supervised`**, not `auto`: irreversible actions keep their approval gate
  when nobody is awake to see them.
- **`AGENT_MAX_CONCURRENCY=3`** (the default 8 is sized for a bigger machine).
- **A separate state dir** (`AIOS_STATE_SUBDIR`) and **separate credentials**: its own Anthropic key
  with its own spend cap. Never copy production's `.env`.
- **No `RuntimeMaxSec`** in the unit: a wall clock there restarts the *server*. The per-task ceiling
  is `AGENT_CALL_MAX_TOTAL_MS`.
- **Modest systemd hardening.** `ProtectSystem=strict`, `PrivateUsers` and `RestrictNamespaces`
  break bubblewrap and the build path. The isolation that matters is the unprivileged user and the
  absent production credentials.
- **The provisioner never touches `/etc/ssh`.** fail2ban carries SSH protection (journal backend —
  Debian 13 has no `/var/log/auth.log`). Add keys and harden by hand if you want to; see the
  lockout notes below first.
- **Only the public `ai-os` repo is cloned.** A private repo on an agent's box raises the stakes of
  everything below.

## Before it runs unattended: GitHub branch protection

The agent's token must be able to push **branches** and open **PRs**, and must **not** be able to
push to or merge into your default branch. Check what your repo actually enforces — do not assume:

```bash
gh api repos/<owner>/<repo>/branches/<default>/protection
```

Two settings decide it, and the default for both is the unsafe one:

1. **`required_pull_request_reviews`** — if absent, anything with write access can push straight to
   the default branch whenever the required checks pass.
2. **`enforce_admins`** — if `false`, **admins bypass every rule**. A fine-grained PAT carries the
   rights of the account that minted it, so a token you mint as an admin bypasses the lot, even with
   reviews required. A setup that *looks* protected and stops nothing.

Two honest ways out:

- **Machine account (recommended).** A second GitHub account added as a collaborator with **Write,
  not Admin**. Protection genuinely applies to it; you keep admin bypass for your own merges.
- **Your own token + `enforce_admins: true`.** Simpler, but it binds you too: every change you make
  goes through a PR from then on.

Mint the token as a **fine-grained PAT** on that one repository with *Contents* and *Pull requests*
read/write, *Metadata* read — and **nothing else**. In particular no *Workflows* (it could edit the
CI that gates its own PRs) and no *Administration*. Give it an expiry and diary the renewal: an
expired token is a stopped agent, which is the right way to fail.

Then protect the default branch (run once, as an admin, from your own machine):

```bash
gh api -X PUT repos/<owner>/<repo>/branches/<default>/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["<your required CI checks>"] },
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "enforce_admins": false,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

`dismiss_stale_reviews` matters: without it an agent can collect your approval on a clean diff and
then append commits. List **every** CI check you rely on in `contexts` — a check that runs but is
not required does not gate anything. (Use `"enforce_admins": true` if you chose the second option.)

### Prove it blocks — don't skip this

From the coding box, as the agent's user, with its token in place:

```bash
cd ~/work/ai-os && git checkout -b protection-probe && git commit --allow-empty -m probe && git push -u origin protection-probe   # must SUCCEED
git push origin HEAD:<default>                                                                                                  # must be REJECTED
git push origin --delete protection-probe && git checkout <default> && git branch -D protection-probe
```

If the second push succeeds, the guard is not in place.

## Things that went wrong on the first real run (and are now handled)

| Symptom | Cause |
|---|---|
| `npm warn EBADENGINE`, then runtime failures | Node below 24. npm only *warns* on an engines mismatch. The provisioner now installs 24 and asserts it. |
| Output stops at `==> Verifying`, no checks shown | An assignment from a failing pipeline under `set -euo pipefail` exits silently. The verify block now runs with `set +e`. |
| `node: not found` from `bash -lc`, systemd or cron | Debian's `~/.bashrc` returns early for non-interactive shells and nvm loads after that. The node path is resolved *inside* the nvm session and used absolutely. |
| `systemd-analyze verify` reports a fatal error but the service runs | Given a bare unit name it searches the **current directory first** and validated the un-substituted template. Always pass the absolute path. |
| Locked out after "hardening" SSH | Password auth disabled with no working key; a pasted key **fingerprint** passed a "file is non-empty" check. Prove a key with `ssh-keygen -l -f`, and from a second terminal, before disabling passwords. |
| FileZilla will not connect | Needs protocol **SFTP** (port 21 is closed) and its own key setup; working `ssh` does not imply working FileZilla. `scp` needs no setup. |
| Login does nothing on `http://` | The session cookie is `Secure` in production. Use `add-https.sh` or an SSH tunnel: `ssh -N -L 3000:127.0.0.1:3000 root@<box>`. |
