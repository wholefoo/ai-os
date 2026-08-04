# Identity, project context, and the memory vault

Read when: touching agent tone or persona, per-project overrides, or stored knowledge.

## Identity Layer (The "Soul")
Three-file identity stack that shapes all agent behavior:
- **`soul.md`** — Immutable guardrails: transparency, human sovereignty, evidence-based reasoning, privacy, cost consciousness
- **`user.md`** — Operator preferences: communication style (direct, technical), decision patterns (cost-focused, incremental), workflow preferences
- **`personality.md`** — Agent persona definitions: orchestrator voice, dashboard persona, inter-agent communication style, naming conventions
- Context inheritance: identity files are loaded before any agent interaction

## Context Inheritance (Project Contexts)
Parent-child configuration system that shapes agent behavior per project:
- **Global identity**: `.claude/identity/` files define baseline tone, rules, and persona
- **Project overrides**: `.claude/projects/*.yaml` files override tone, audience, domain terms, and rules per project
- **Context resolution**: Merges global identity + active project overrides at runtime — project settings win on conflict
- **Active context**: One project context is active at a time; agents inherit its overrides automatically
- **Domain terms**: Per-project glossary that agents reference for consistent terminology
- **Dashboard view**: Active context bar, project cards with override tags, resolved context preview grid

## Memory Vault (Persistent Knowledge System)
The vault prevents "context rot" by maintaining a structured, searchable knowledge store:
- **`.magent/vault/raw/`** — Unprocessed intake: meeting notes, web clippings, data dumps
- **`.magent/vault/wiki/`** — Synthesized knowledge: processed reports, decision records, agent roster
- **`.magent/vault/outputs/`** — Final deliverables: compiled reports, published documents
- **Session-start hooks**: Auto-load the most recent decisions and relevant wiki entries
- **Semantic search**: Full-text search across all vault files via `/api/vault/search`

> An agent's `memory:` frontmatter DECLARES which of this it works from. It does not grant access —
> reads are governed by the catalog's `readers` allowlist, in code, at read time.
