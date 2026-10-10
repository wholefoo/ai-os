# Hermes-Dev Dev Platform — Design

Status: DRAFT for operator review · 2026-10-09 · Box: Hermes-Dev (`45.76.242.133`)

## 1. Goal

Make Hermes-Dev do, on its own box, what an operator + Claude Code session does today on this
project: **research → plan → approve → build → debug → test → ship**, flowing as one pipeline,
bounded only by predefined usage-credit limits, driven from a dev-platform UI and from Telegram.

Reference products (look, feel and ergonomics, not code):

- **Claude Desktop / Claude Code** — sessions sidebar, conversation-centred work, diff and
  terminal side panes, PR-aware.
- **Hermes Agent** (Nous Research) — one agent behind many channels (Telegram first), persistent
  memory, self-made skills, natural-language schedules, subagents.
- **Hermes One** — the desktop wrapper: guided setup, chat with slash commands, visible
  self-improvement.

### Operator decisions (2026-10-09) — settled

| Fork | Decision |
|---|---|
| UI foundation | **New dev-platform frontend on the existing backend.** Its own look, not the AI OS dashboard. Board, dispatcher and agents are reused. |
| Approval gates | **Approve the PLAN, then autonomous to PR.** A single human gate per mission. |
| Telegram | **Full control:** file, approve, query, receive. |
| Autonomy | **Reactive now, proactive later.** Phase 1 runs what the operator submits. Self-directed goal pursuit is a later phase, behind approval. |

### Fixed invariants (unchanged by this design)

- **PR-only.** Hermes-Dev never merges and never deploys. "Production" in this design means
  *ship-ready*: a PR plus release notes and a deploy checklist, handed to the operator. Merging and
  deploying stay human actions on GitHub and the prod box.
- **Confinement.** Code runs as `hermes-agent` through the root launcher. The runner verifies on a
  clean clone, and git pushes go to the fork only.
- **The credit limit is the binding constraint.** No path spends model or subscription credit
  outside the budget check (see §4, P0-1).

## 2. What exists and is reused

| Capability | Where | State |
|---|---|---|
| Durable task board + state machine | `lib/board/{db,repo}.js` | Production. Proven on the box. |
| Dispatcher service (claims, runs, logs) | `lib/board/{dispatcher,run-dispatcher}.js`, `ai-os-board-dispatcher.service` | Production. Proven on the box. |
| Confined coding runner (Claude Code headless, clean-clone verify, push to fork) | `deploy/coding-instance/hermes-task` | Production. Proven 2026-10-01 (`result=pushed`). |
| External task intake + idempotency | `POST /api/board/intake` (`dedupeKey`, `agent`-scope keys) | Production. |
| Approval policy + queue + executors | `lib/safety/approval.js`, `gateAction()` / `ACTION_EXECUTORS` / `/api/approvals*` in `server.js` | Production. |
| Cost ledger, budgets, hard cap | `costLedger`, `getCostSummary()`, `hardBudgetEnabled()` / `hardBudgetTrippedPeriod()`, `/api/costs/*` | Production for agent calls. **Board runs are not counted.** |
| Server-side research | `callPerplexity()` (sonar-pro), `lib/net/safe-fetch.js`, DataForSEO | Production. The Tavily and Firecrawl keys are stored but nothing calls them. |
| Live updates | `broadcast()` + WebSocket auth (`wsClientCanReceive`) | Production. |
| Telegram outbound | `sendTelegramMessage()` / `sendTelegramApproval()` | Send-only. **No inbound commands or buttons.** |

## 3. Architecture

```
            Telegram ──long-poll──┐                       ┌── Dev Platform UI (new SPA)
                                  ▼                       ▼
                         ┌──────────────────────────────────────┐
                         │  Mission API  (/api/dev/*)            │  ← new, in the app
                         │  missions · facets · approvals · $    │
                         └──────┬───────────┬───────────┬───────┘
                   research     │   plan    │   build    │  ship
              Perplexity/fetch  │  runner   │  board +   │  PR + notes
                                │  --plan   │  dispatcher│  + checklist
                                ▼           ▼            ▼
                         costLedger / hard cap (every facet charges here)
```

- **Mission**: the unit of work the operator submits ("add X", "research Y then build it",
  "fix the failing Z"). A mission owns an ordered set of **facets**: research, plan, approval,
  build, test, ship. It also owns one or more board tasks.
- **The board stays the execution spine.** Build and test are board tasks run by the existing
  dispatcher and runner. A mission is a parent above them.
- **One approval system.** The plan gate is a new action type in the existing `gateAction` /
  `pendingApprovals` queue. Telegram and the UI are two front-ends to the same queue.
- **One budget system.** Every facet records spend to `costLedger`, and the dispatcher checks the
  cap before claiming a task.

### Gateway choice: native, not an embedded Hermes Agent

Running Hermes Agent itself on the box as the Telegram front would add a second agent runtime
(Python), a second memory store, second model billing and a second approval model, which its
public material documents only thinly. AI OS already has the approval queue, cost ledger and intake
API that the gateway has to respect. **Recommendation: build a small native Telegram gateway** and
borrow Hermes's *patterns*: slash commands, scheduled briefings, visible skills and memory. Keep
Hermes Agent as a possible later integration through the intake API. This is consistent with the
2026-09-27 decision: "adapt, don't port; the engine stays Claude Code".

## 4. Phases

Each phase ships as its own PR or PRs, is verified on the box, and is usable on its own.

### P0 — Safety and plumbing (prerequisite; invisible but load-bearing)

1. **Board spend counts against the cap.** When a board run finishes, push its `cost_usd` into
   `costLedger`, tagged `source=board, mission=<id>`. The dispatcher refuses to claim a task while
   `hardBudgetTrippedPeriod()` is true, and the card reads "blocked: budget". Note that the runner
   bills the operator's Claude subscription, so `est_cost` is notional. The real ceiling is the
   claude.ai usage cap plus `--max-budget-usd` per run. The platform-side cap is still needed so
   the dashboard, Telegram and the proactive phase all see a single number.
2. **Per-task runner parameters.** Add task columns `model`, `budget_usd` and `max_turns`
   (migration v3). The dispatcher passes them as `--model/--budget/--turns`, which the runner
   already supports.
3. **Runner `--plan` mode.** Read-only: `Read/Grep/Glob` and read-only Bash, with no
   Edit/Write/MultiEdit. It writes `.hermes/PLAN.md` (goal, files, steps, risks, test strategy,
   estimated cost) and does no commit or push. It reuses the confinement, launcher and leak scan.
4. **Board states for gating.** Add `awaiting_approval` to `TRANSITIONS`, and add `mission_id`
   linkage.
   *Revised during build (2026-10-09):* no `planning` board state. A plan is an ordinary board task
   with `mode=plan` that runs and finishes like any other. "Planning" is a **mission** state (P1),
   not a board state, so adding it here would duplicate it. Also found and fixed: the old hold,
   `start:false` → `queued`, did not hold. `promoteReady()` released every queued task whose
   dependencies were done, which is vacuously true when there are none, so any unrelated finish
   released it. Holds now use `awaiting_approval`, which only `approve()` (human-only on the route)
   leaves.

Exit: a plan-mode task produces `PLAN.md` on the box, and board spend appears in
`/api/costs/budget`. A tripped cap stops the dispatcher from claiming, proven by forcing a tiny
budget.

### P1 — Mission pipeline (backend)

- `lib/dev/` (new): `missions` table (`node:sqlite`, same store pattern), a mission state machine
  `research → plan → awaiting_approval → build → test → ship → done|failed|cancelled`, and a facet
  log.
- **Research facet:** an optional brief from Perplexity, plus `safeFetch` for operator-supplied
  URLs, saved to the mission and fed into the plan prompt. The cost is ledgered.
- **Plan facet:** a runner `--plan` board task against the real repo, producing `PLAN.md`.
- **Approval facet:** a new action type `dev_mission_plan` in `ACTION_RISK` (medium). The plan
  waits in `/api/approvals` until a human approves it.
- **Build/test facet:** on approval, the plan becomes one or more board tasks (sequenced with
  `dependsOn`). The existing runner loop of edit → full `npm test` → push to fork is the
  debug/test facet.
- **Ship facet:** collect the branches, generate the PR description and release notes plus a
  deploy checklist (drawn from the repo's own runbooks), and post a compare/PR link. **Nothing
  merges.**
- API: `POST /api/dev/missions`, `GET /api/dev/missions[/:id]`,
  `POST /api/dev/missions/:id/{cancel,retry}`. Writes go through `broadcast('dev_update')`.

Exit: a mission submitted by API on the box moves through research, plan, approval in the existing
queue, build and test, and ends with a PR link. Every step's cost appears in the ledger.

*As built (2026-10-10), with the deviations stated:*
- **Storage.** Missions live in `board.sqlite` (migration v4: `missions`, `mission_events`), not in
  a separate store. A mission and the tasks it creates then share one WAL and one backup unit.
- **Engine.** `lib/dev/engine.js` is a reconciler that runs in the app every 10s. It runs only
  where `HERMES_DEV_MISSIONS=1`, and the routes return 503 everywhere else. Every step is
  idempotent, so restarts and deploys need no recovery code. One mission failing never stops the
  others. Two concurrency rules come from bugs found during the build:
  - Research runs in the background and is never awaited inside a tick. A slow provider call would
    otherwise freeze every mission.
  - An overlapping `tick()` returns the running tick's promise.
- **Research.** `lib/dev/research.js` goes through `executeAgent('consultant-perplexity', …,
  {systemOverride})`, which already enforces the hard cap, records the cost and fences untrusted
  text. Operator URLs are fetched with `safeFetch` (at most 3, size- and time-capped) and passed as
  untrusted data. A tripped cap holds the mission in `researching`, recorded once. Any other
  research failure plans without the research.
- **Approval.** The action is `dev.mission-plan`, classed `high`. It is also in `ALWAYS_GATE`,
  because in `auto` mode the policy alone would let a `high` action through. Rejection has no hook
  in the approvals API, so the reconciler watches the approval's status. Cancelling withdraws the
  pending approval.
- **Build.** *Revised:* each attempt is **one** build task that carries the full approved plan, not
  several tasks linked by `dependsOn`. Splitting a plan into tasks is left for a later phase, and
  one run per attempt keeps the runner's whole-suite check meaningful.
- **Debug.** One automatic retry, given the last 6 KB of the failing test output, for
  `tests_failed`, `agent_error`, `timeout` and `interrupted` only. `unsafe`, `push_failed`,
  `dispatch_error` and `no_changes` go straight to a human. An operator retry rebuilds against the
  approved plan without a new approval. A retry before approval re-plans and asks again.
- **Budget.** Each mission has a budget (default `HERMES_MISSION_BUDGET_USD`=10). Each task gets
  `min(per-kind cap, what is left)`: plan $2 / 40 turns, build $5 / 80 turns. When the budget is
  spent, no further task is filed and the reason is stated.
- **Ship.** `lib/dev/ship.js` builds the package deterministically: the builder's summary, a PR
  link prefilled with a title and description, and a deploy checklist derived from
  `changed-files.txt`. The runner now writes that file from the commit. The checklist encodes this
  repo's own deploy rules (`npm ci` as the app user and never chained to the restart, reinstall the
  runner, `daemon-reload`, pull from upstream).

### P2 — Dev Platform UI (new frontend, own design)

- A separate SPA (`devstudio/`) served at its own path or subdomain (e.g. `dev.` on the box's
  domain) behind the existing session auth. It does not reuse the AI OS dashboard's IA or styling.
- **Layout (Claude Desktop-like):** a left sidebar with missions and sessions (search, status
  dots), a centre mission timeline (a conversation-style feed of facets, each expandable), and a
  right pane switching between **Plan**, **Diff**, **Logs** (board-logs / runner-tests),
  **Research** and **PR**. A top bar shows the credits meter (period spend against cap), a new
  mission button and a command palette with slash commands (`/new`, `/research`, `/status`,
  `/budget`).
- **Plan review:** rendered `PLAN.md`, estimated cost, and Approve / Request changes / Reject.
  These map onto the same `/api/approvals` routes.
- Live over the existing WebSocket. Dark, dense, monospace-accented dev aesthetic, built on its
  own token set.
- Verified by screenshot on the box (existence is not usability).

### P3 — Telegram gateway (two-way)

- `lib/dev/telegram-gateway.js` plus its own small service, `ai-os-telegram.service`, using
  Bot API `getUpdates` long-poll. This needs no public webhook, and the box already reaches
  api.telegram.org outbound.
- **Commands:** `/new <goal>`, `/research <topic>`, `/missions`, `/status <id>`, `/plan <id>`,
  `/logs <id>`, `/budget`, `/cancel <id>`, `/help`. Free text is treated as a draft mission.
- **Plan approval by inline keyboard** (Approve / Changes / Reject). It reaches the same approval
  executor as the UI.
- **Notifications:** facet transitions, approval requests, PR ready, budget at 75% and 100%,
  failures with a log excerpt.
- **Safety for reversing "Telegram can't approve":**
  - Commands and approvals are accepted only from an **allowlisted `chat_id` + `user_id`**
    (env-configured). Everything else is ignored and logged.
  - `callback_data` carries an **HMAC-signed, single-use, expiring** approval token, so a replayed
    or forged button does nothing.
  - Telegram may approve **only `dev_mission_plan`** on **Hermes-Dev**, where the worst outcome is
    a PR on a fork. The prod box keeps refusing Telegram approvals (it is a separate deployment),
    and no other action type becomes Telegram-approvable.
  - The bot token lives in `.env` (0600) and is never echoed or logged.

*As built (2026-10-10), with the deviations stated:*
- **In the app, not a separate service.** *Revised.* Approvals live in the app's memory
  (`pendingApprovals`, `executeApprovedAction`), and the approve route is human-only. A separate
  process could only approve through a privileged back door. `lib/dev/telegram.js` runs in the app
  next to the mission engine, opt-in via `HERMES_TELEGRAM_GATEWAY=1`, and approves through the same
  `executeApprovedAction` as the dashboard.
- **A dedicated bot for Hermes-Dev.** Telegram allows one `getUpdates` poller per bot, so sharing
  the production instance's bot would make the two boxes take each other's messages. Setup:
  `deploy/coding-instance/telegram-whoami.js` prints the user and chat ids to allowlist, and warns
  if the bot has a webhook.
- **Buttons.** *Revised:* buttons carry unguessable, single-use, expiring **server-side nonces**,
  not HMAC tokens. Button data is capped at 64 bytes, and a used nonce is dead even inside its
  expiry, which a stateless signature can't guarantee. Pressing one button of a pair kills the
  other. A nonce is also bound to the chat it was sent to and to its mission.
- **Approve / Reject only.** *Revised:* instead of a "Changes" button, `/revise <id> <feedback>`
  rejects the waiting plan and starts a new mission carrying the goal, the feedback and the previous
  plan. A rejected mission stays final, so the P1 state machine is unchanged.
- **Commands:** `/new [$N]`, `/research [$N]`, `/missions`, `/status`, `/plan`, `/ship`, `/logs`
  (credentials redacted), `/budget`, `/cancel`, `/retry`, `/revise`, `/help`. Mission ids accept a
  unique prefix of 4 or more characters. Free text is never turned into a mission on its own: the
  gateway asks, and only the button press starts it.
- **Replay safety.** The update offset is saved *before* each update is handled, so a crash loses a
  command rather than running it twice. A duplicate `update_id` is ignored. A command older than
  15 minutes (a backlog after downtime) is not acted on.
- **Allowlist.** Both the user and the chat must be allowlisted. Strangers get silence (each is
  logged once by id). The gateway refuses to start with an empty allowlist. Only `dev.mission-plan`
  is approvable from Telegram, enforced in the gateway and again in the server adapter.
- **Notifications.** Plan ready (the plan plus buttons, with its own nonces per chat), building,
  retrying, done (a short PR link), failed (the reason plus `/retry`), rejected, cancelled, and
  budget alerts at 75% and 100% (each once per period per day). The generic "approval required"
  ping is skipped for `dev.mission-plan` while the gateway runs, because the gateway's message
  replaces it. Every other high or critical approval still goes through `sendNotification`.
- **One reject path.** `rejectPendingApproval()` is now shared by the dashboard route, the
  mission-cancel withdrawal and Telegram.

### P4 — Proactive mode (later, behind approval)

- Standing **production goals** plus a **credit budget per period**. A scheduler proposes the next
  mission toward a goal (research-backed). Proposals land as `awaiting_approval` and are **never
  auto-started**. The budget cap governs the volume of proposals and execution.
- Hermes-style learning loop: per-repo memory of what worked, and reusable "skills" (runbooks the
  agent writes after solving recurring problems), surfaced and editable in the UI.
- Scheduled briefings to Telegram (daily mission digest, spend, what is blocked).

## 5. Risks and open questions

- **Subscription vs. ledger mismatch.** Runner spend is notional (subscription), but research uses
  API keys and is real money. Two meters may be needed in the credits bar. Proposal: show both,
  and make the cap binding on API spend plus a configurable notional cap on runner usage.
- **Full-suite verify is heavy for small changes.** It burned turns on trivial tasks before. P1
  should let a plan declare a scoped `TEST_CMD`, with the full suite still required before ship.
- **Leak-scan over-sensitivity.** `private_key_markers` fires on repo fixtures. Fix this before
  higher throughput turns it into noise.
- **Box capacity.** 4 GB / 2 vCPU with dispatcher concurrency 1. Fine for P0–P3. P4 may need a
  bigger box or a queue-depth policy.
- **Open (operator):** a subdomain or a path for the UI? Which Telegram account/chat is
  allowlisted? Default per-mission and per-period budgets?
