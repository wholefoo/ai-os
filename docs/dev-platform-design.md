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
