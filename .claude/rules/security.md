---
name: security
description: Security guardrails for all agents in the system.
---

# Security Rules

1. **No Secret Exposure**: Never read, log, or output API keys, passwords, or tokens. Reference them by environment variable name only.
2. **Sandboxed Execution**: All code execution happens in designated directories. Never run commands that modify system files.
3. **Permission Scoping**: Each agent only gets tools it needs. No agent gets blanket access.
4. **Output Boundaries**: Agents write only to `.magent/artifacts/`. No writes to repo root without explicit approval.
5. **Cost Controls**: Each sub-agent is capped at 50 tool calls per invocation. Orchestrator monitors total spend.
6. **No Runaway Loops**: If an agent fails the same step 3 times, escalate to orchestrator.
7. **Data Sensitivity**: PII and sensitive data are never written to logs or broadcast via WebSocket.
8. **Audit Trail**: Every action is logged with timestamp, agent, and outcome.
