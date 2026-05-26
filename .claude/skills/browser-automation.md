---
name: browser-automation
description: Playwright-powered browser tasks — navigate, interact, screenshot, and extract data from web pages.
category: intelligence
estimated_time: 5min
---

# Browser Automation Skill

## Goal
Execute browser-based tasks using Playwright for navigation, interaction, screenshots, and data extraction from live web pages.

## Process
1. **Parse Task** — Determine task type (navigate, extract, screenshot, form-fill, verify) and target URL
2. **Launch Browser** — Start headless Chromium instance with appropriate viewport and user agent
3. **Navigate** — Load target URL, wait for network idle, handle redirects
4. **Execute Actions** — Perform task-specific actions (click, type, scroll, wait)
5. **Capture Output** — Extract data, take screenshots, or collect results
6. **Cleanup** — Close browser, save artifacts, report results

## Parameters
- `url`: Required. Target URL to navigate to.
- `task_type`: navigate | extract | screenshot | form-fill | verify (default: navigate)
- `selector`: Optional CSS selector for targeted extraction or interaction.
- `viewport`: desktop | tablet | mobile (default: desktop)
- `wait_for`: load | networkidle | selector (default: networkidle)

## Agents Used
- **Browser Agent** (Sonnet) — Primary execution agent for all browser tasks

## Output
Screenshots: `.magent/artifacts/screenshots/<timestamp>.png`
Extracted data: `.magent/artifacts/extractions/<timestamp>.json`

## Safety
- All form submissions require HITL approval
- Never enter passwords, API keys, or payment info
- Respect robots.txt
- Rate limit: max 1 request per 2 seconds
