---
name: automation-bridge
description: Trigger external automations via N8N, Zapier, or webhook integrations with full HITL approval gates.
category: automation
estimated_time: ~2min per action
agents: [automator, orchestrator]
---

# Automation Bridge

Connect AI OS agent outputs to real-world actions through external automation platforms.

## Parameters
- **action**: The automation action to trigger (from the action registry)
- **payload**: Key-value data to send with the trigger
- **platform**: Target platform (n8n, zapier, webhook)
- **priority**: normal | urgent (urgent skips queue, still requires approval)

## Steps

1. **Resolve Action**
   - Look up `action` in the automation registry
   - Validate platform is configured and reachable
   - Verify all required payload fields are present

2. **Build Payload**
   - Assemble the webhook payload from provided parameters
   - Strip any sensitive fields (API keys, tokens, passwords)
   - Add metadata: timestamp, source agent, run ID

3. **HITL Approval Gate**
   - Submit to human approval with full payload preview
   - Display: action name, platform, destination, payload summary
   - BLOCKING gate — no auto-approve, no timeout bypass

4. **Execute Trigger**
   - POST payload to the webhook URL
   - Set timeout based on platform (N8N: 30s, Zapier: 15s, webhook: 10s)
   - Capture response status and body

5. **Report Result**
   - Log success/failure to decisions.log
   - Broadcast status via WebSocket
   - If failed: report error details, do NOT retry automatically

## Available Actions (Registry)

| Action | Platform | Description | Gate |
|--------|----------|-------------|------|
| send-email | n8n | Send email via SMTP | blocking |
| post-slack | n8n | Post message to Slack channel | blocking |
| update-crm | n8n | Update CRM contact record | blocking |
| create-task | zapier | Create task in project management tool | advisory |
| post-social | n8n | Post to social media account | blocking |
| sync-drive | zapier | Sync file to Google Drive | advisory |
| notify-team | webhook | Send notification to team channel | advisory |

## Output
```yaml
status: success | failed | timeout
platform: n8n
action: send-email
response_code: 200
execution_id: n8n-exec-12345
timestamp: 2026-05-24T10:30:00Z
```
