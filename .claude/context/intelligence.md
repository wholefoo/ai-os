# Live intelligence and human-in-the-loop push

Read when: touching browser automation, real-time queries, or how the operator gets notified.

## Browser Agent (Playwright Automation)
Playwright-powered browser automation for web interaction tasks:
- **Task types**: navigate, extract, screenshot, form-fill, verify
- **Viewport options**: desktop (1920×1080), tablet (768×1024), mobile (375×812)
- **Wait strategies**: network idle, page load, selector visible
- **Safety**: Form submissions require HITL approval, never enters credentials, respects robots.txt
- **Rate limiting**: Max 1 request per 2 seconds, max 10 navigations per task
- **Artifacts**: Screenshots saved to `.magent/artifacts/screenshots/`, extracted data to `.magent/artifacts/extractions/`
- **Integration**: Works alongside Firecrawl (Firecrawl for data, browser-agent for interaction)

## Grok Real-Time Intelligence
Live intelligence engine powered by xAI's Grok model for time-sensitive queries:
- **Query types**: search (live web), trending (X/Twitter discourse), fact-check (cross-reference claims), monitor (ongoing watch)
- **Streaming**: Token-by-token response streaming via WebSocket to dashboard
- **Sources**: Each result includes cited sources with relevance scores and confidence ratings
- **Rate limiting**: 30 queries/hour with 5-minute cache deduplication
- **Cost tier**: "realtime" (Grok-3 at $5/M input, $15/M output), budgeted at 10% daily spend
- **Dashboard**: Live query console with streaming output, query history with expandable details, stats with rate limit tracking
- **Integration**: Complements scheduled social-intel sweeps with on-demand real-time queries

## Notification System (HITL Push)
Multi-channel notification system with escalation timeouts:
- **Dashboard** — Always-on, real-time via WebSocket
- **Telegram** — Bot integration via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
- **Slack** — Webhook integration via `SLACK_WEBHOOK_URL`
- **Escalation** — Unanswered critical notifications auto-escalate after configurable timeout (default: 1 hour)
