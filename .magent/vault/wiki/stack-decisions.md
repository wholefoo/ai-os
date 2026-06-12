---
type: wiki
tags: [architecture, decisions]
created: 2026-05-17
updated: 2026-05-24
---

# Stack Architecture Decisions

## Engine Selection
- **Primary**: Claude Code (Opus 4.8 across xhigh/high/low effort tiers) — chosen for native tool use, agentic reliability
- **Economy**: DeepSeek Tui (V4) — cost-optimized bulk processing at ~10% the cost
- **Decision date**: 2026-05-23
- **Rationale**: 4-tier routing maximizes quality-per-dollar

## Dashboard Framework
- **Choice**: Vanilla HTML/CSS/JS + WebSocket
- **Rejected**: React (overhead), Next.js (SSR unnecessary for local tool)
- **Decision date**: 2026-05-17
- **Rationale**: Zero build step, instant reload, minimal dependencies

## Memory Architecture
- **Choice**: File-based `.magent/` directory with vault subfolder
- **Rejected**: SQLite (over-engineering), ChromaDB (deferred to Phase 2)
- **Decision date**: 2026-05-24
- **Rationale**: Git-friendly, human-readable, agent-accessible via Read/Write tools
