---
name: automation-bridge
description: Trigger external automations via N8N, Zapier, or webhook integrations with full HITL approval gates.
category: automation
rubric: default
estimated_time: ~2min per action
---

# Automation Bridge

## Goal
A real-world side effect happens exactly once, only after a human saw exactly what would be sent, and
the result is recorded whether it worked or not. This skill's output is an audit trail as much as an
action.

## What good looks like
- The approval preview shows what will actually be sent — the resolved action, the destination, and
  the payload after stripping. An approval given against a summary that differs from the request is
  not an approval.
- No credential, token, or password appears in the payload or in any log of it.
- Every trigger carries its metadata: timestamp, originating agent, run id. A webhook that fired with
  no attributable source cannot be investigated later.
- The result records the real response status and body. A timeout is reported as a timeout, never as
  a success and never as a definite failure — nobody knows whether the far end acted.
- A failure is reported and left alone. Automatic retry on an action whose effect is unknown is how
  one email becomes three.
- The gate level applied matches the registry below, and an action absent from the registry is
  refused rather than treated as advisory.

## Guardrails
- The approval gate is blocking. No auto-approve, no timeout bypass, and `priority: urgent` moves an
  item up the queue without ever skipping the gate.
- Never retry automatically after a timeout or a failure.
- Never send to a destination that arrived in the payload rather than the registry.

## Available Actions (Registry)
The gate column is the contract — this table, not the caller, decides what needs blocking approval.

| Action | Platform | Description | Gate |
|--------|----------|-------------|------|
| send-email | n8n | Send email via SMTP | blocking |
| post-slack | n8n | Post message to Slack channel | blocking |
| update-crm | n8n | Update CRM contact record | blocking |
| create-task | zapier | Create task in project management tool | advisory |
| post-social | n8n | Post to social media account | blocking |
| sync-drive | zapier | Sync file to Google Drive | advisory |
| notify-team | webhook | Send notification to team channel | advisory |

## Team
- **automator** — resolves the action, builds the payload, and fires the trigger
- **safety** — whether this action, to this destination, with this payload, should proceed at all

## Parameters
- `action`: Required. The automation action to trigger (must exist in the registry above).
- `payload`: Key-value data to send with the trigger.
- `platform`: n8n | zapier | webhook
- `priority`: normal | urgent (urgent moves up the queue; it never skips the gate)

## Output
- A result record carrying status (success | failed | timeout), platform, action, response code,
  execution id and timestamp, appended to `.magent/decisions.log`
