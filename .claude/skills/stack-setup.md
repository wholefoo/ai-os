---
name: stack-setup
description: Guided setup of the full AI Agentic OS stack — Hermes, Claude Code, Codex, Obsidian, Higgsfield, and supporting tools with validation checks.
category: general
estimated_time: 45min
---

# Stack Setup Skill

## Goal
Walk through the complete setup of the AI Agentic OS technology stack, validating each component is installed, configured, and connected. References the master blueprint in .magent/artifacts/docs/ai-agentic-os-stack-blueprint.md.

## Process
1. **Environment Check** — Verify Node.js, Python, Docker, Git installed
2. **CLI Installation** — Install Claude Code, Codex CLI, cc-switch
3. **Knowledge Layer** — Set up Obsidian vault, MCP server, ChromaDB
4. **Agent Framework** — Validate claude.md, agent definitions, skills, rules
5. **Execution Engines** — Configure Hermes, Higgsfield API, Playwright, n8n
6. **MCP Wiring** — Verify all MCP servers connect and respond
7. **Integration Test** — Run an end-to-end workflow across the full stack
8. **Security Audit** — Confirm sandboxing, permission scoping, secret management

## Parameters
- `phase`: all|foundation|knowledge|agents|engines|integration (default: all)
- `environment`: local|vps|cloud (default: local)

## Output
- `.magent/artifacts/docs/stack-setup-report-<timestamp>.md` — validation results
