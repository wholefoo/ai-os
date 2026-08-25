# AI OS Orchestration Lab — Project Brain

**This file is a ROUTER, not a manual.** It carries only what every session needs. Everything else
lives in `.claude/context/` and is read when the work calls for it. Keep it that way: a section
added here is paid for on every session forever. See `.magent/vault/wiki/model-fit-2026-design.md`.

## Session Start (read these first)
1. **`.claude/SKILL-MAP.md`** — capability inventory: all agents, skills, and pipelines. Consult before assuming a capability is missing or building one that already exists.
2. **`.magent/vault/wiki/vault-map.md`** — memory table of contents. Consult before searching the vault blind or re-deriving stored knowledge.
3. **`.claude/rules/engineering-workflow.md`** — how we actually ship: pre-commit self-check (`node --check` + `node tools/seclint.js --ci` must be 0/0), commit **and** push, local boot-verify, the deploy ritual, and Windows/PowerShell reality. Read before editing `server.js` or dashboard JS.

The first two maps are auto-generated (`npm run maps`) and refreshed by the server's session-context hook. Regenerate after adding/removing agents, skills, pipelines, or vault files.

> **Note:** this guidance (and `.claude/rules/`) only auto-loads when the session's working directory is this project (`.../ai-os`). If you launched from elsewhere (e.g. `~/.claude`), read these explicitly.

## Where to read next

| If the work touches… | Read |
|---|---|
| model choice, effort tiers, cost, MCP servers | `.claude/context/runtime.md` |
| skill launch, pipelines, verification/rubrics | `.claude/context/execution.md` |
| a specific feature's API, agent, or skill | `.claude/context/capabilities.md` |
| browser automation, real-time queries, notifications | `.claude/context/intelligence.md` |
| agent tone/persona, project overrides, the vault | `.claude/context/identity-memory.md` |
| auth, headers, rate limits, state, deploy | `.claude/context/hardening.md` |
| a public route that costs money per request | `.claude/rules/public-cost-endpoints.md` |
| security invariants, ship loop, conventions | root `CLAUDE.md` |
| agent handbooks, criteria, gates, archetypes | `.magent/vault/wiki/agent-handbooks-design.md` |

## Mission
This is a multi-agentic AI Operating System that orchestrates specialized sub-agents to execute complex workflows autonomously. The system bridges the gap between technical AI tools and user accessibility through a visual dashboard.

## Architecture
- **Orchestrator**: Master agent that interviews users, writes specs, spawns sub-agents, routes tasks, and reviews outputs.
- **Agent Factory**: Deterministic generator that converts role specs into concrete agent files.
- **Worker Team**: Ephemeral specialized sub-agents that execute domain work.
- **Shared Memory**: `.magent/` directory acts as the team blackboard.

## Non-Negotiable Rules
1. Never write outside `.magent/artifacts/` until explicitly approved.
2. Every factual claim requires a citation or `[assumption]` label.
3. Planning mode is default — always plan before executing.
4. Irreversible actions require human confirmation.
5. All decisions append to `.magent/decisions.log`.
6. API keys and secrets are referenced by name, never read directly.
7. Think before coding — state assumptions, surface tradeoffs, ask if unclear.
8. Simplicity first — minimum code that solves the problem, nothing speculative.
9. Surgical changes — touch only what you must, match existing style.
10. Goal-driven execution — define success criteria, verify each step.

## File Layout
```
.claude/agents/     → Agent role definitions
.claude/skills/     → Procedural skill files
.claude/rules/      → Guardrails and constraints
.claude/context/    → Routed reference material (this file points into it)
.claude/identity/   → Soul, User, Personality files
.claude/pipelines/  → Declarative skill chain definitions
.claude/projects/   → Per-project context overrides (YAML)
.claude/config/     → Automation registry, platform configs
.magent/            → Shared memory / team blackboard
.magent/vault/raw/  → Unprocessed intake data
.magent/vault/wiki/ → Synthesized knowledge base
.magent/vault/outputs/ → Final deliverables
.magent/artifacts/  → All agent outputs land here
.magent/state/      → Persisted runtime state (JSON)
.magent/plans/      → Execution plans awaiting approval
.magent/handoffs/   → Inter-agent task handoffs
dashboard/          → Web UI source
deploy/             → Nginx config, VPS install script
```
