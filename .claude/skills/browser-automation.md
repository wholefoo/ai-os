---
name: browser-automation
description: Playwright-powered browser tasks — navigate, interact, screenshot, and extract data from web pages.
category: intelligence
rubric: default
estimated_time: 5min
---

# Browser Automation

## Goal
The requested page state is reached and the requested evidence comes back — the extracted data, the
screenshot, or a clear statement of what stopped it. A run that ends with neither is a failure even
if nothing threw.

## What good looks like
- Extracted data comes from the live page in this run. A value that could have been produced without
  loading the page is not an extraction.
- A screenshot shows the page in the requested viewport, after the requested wait condition was
  actually met — not a half-rendered page captured on a timer.
- A selector that matches nothing is reported as "not found" with the selector quoted. An empty result
  presented as an empty page is the failure mode that makes this skill untrustworthy.
- Redirects, interstitials, consent walls and login gates are reported, because they change what the
  captured page actually is.
- The browser is closed and its artifacts saved whether the task succeeded or failed.

## Guardrails
- Every form submission requires human approval first. No exceptions for "it is just a search box".
- Never enter a password, API key, card number, or any credential into any field.
- Respect robots.txt.
- No more than one request every two seconds against a single host.

## Team
- **browser-agent** — drives the page and captures the evidence

## Parameters
- `url`: Required. Target URL to navigate to.
- `task_type`: navigate | extract | screenshot | form-fill | verify (default: navigate)
- `selector`: Optional CSS selector for targeted extraction or interaction.
- `viewport`: desktop | tablet | mobile (default: desktop)
- `wait_for`: load | networkidle | selector (default: networkidle)

## Output
- `.magent/artifacts/screenshots/<timestamp>.png` — captures
- `.magent/artifacts/extractions/<timestamp>.json` — extracted data
