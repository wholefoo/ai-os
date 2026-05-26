---
name: notebooklm-connect
description: Connect to a Google NotebookLM notebook — sync sources, query for insights, and pull synthesized knowledge back into the AI OS.
category: research
estimated_time: 10min
---

# NotebookLM Connect Skill

## Goal
Bridge the AI OS with a Google NotebookLM notebook to leverage its multi-source synthesis, citation engine, and audio overview capabilities. Push local research artifacts as sources and pull structured insights back.

## Process
1. **Authenticate**
   - Open NotebookLM at https://notebooklm.google.com via browser automation
   - Use existing Google SSO session (human confirms auth if needed)
   - Navigate to the target notebook by name or ID

2. **Sync Sources → NotebookLM**
   - Scan `.magent/artifacts/research/` for new or updated briefs
   - Scan `.magent/artifacts/docs/` for relevant documents
   - Upload selected files as notebook sources (PDF, TXT, MD converted to supported format)
   - Log which sources were synced in `.magent/decisions.log`

3. **Query Notebook**
   - Submit structured questions from the handoff file
   - Collect NotebookLM's synthesized responses with inline citations
   - Capture source grounding references (which uploaded doc supports each claim)

4. **Pull Insights Back**
   - Parse NotebookLM responses into structured markdown
   - Map citations back to original AI OS artifact paths
   - Write output to `.magent/artifacts/research/notebooklm-<query-slug>.md`

5. **Generate Audio Overview (Optional)**
   - Trigger NotebookLM's Audio Overview feature for the notebook
   - Download or link the generated audio summary
   - Log audio asset path in artifacts

6. **Verify & Close**
   - Reviewer agent validates citation accuracy against local sources
   - Flag any NotebookLM insights that lack grounding in uploaded docs
   - Append sync summary to decisions.log

## Parameters
- `notebook_name`: Required. Name of the target NotebookLM notebook.
- `notebook_url`: Optional. Direct URL to the notebook (skips search).
- `query`: Required. The question or topic to research via NotebookLM.
- `sources`: Optional. Array of local file paths to upload. Default: auto-detect from artifacts.
- `sync_direction`: push|pull|both (default: both)
- `generate_audio`: true|false (default: false)

## Agents Involved
- **Researcher**: Prepares questions and processes returned insights
- **Writer**: Formats NotebookLM outputs into AI OS artifact structure
- **Reviewer**: Validates citation grounding

## Error Handling
- If Google auth session expired → pause and prompt human to re-authenticate
- If notebook not found → list available notebooks and ask user to select
- If upload fails → retry once, then log failure and continue with existing sources
- If NotebookLM rate-limits → back off 60s, retry up to 3 times

## Output
- `.magent/artifacts/research/notebooklm-<query-slug>.md` — structured insights
- `.magent/artifacts/research/notebooklm-sources-manifest.md` — sync log of what was pushed/pulled
- `.magent/artifacts/docs/notebooklm-audio-<timestamp>.md` — audio overview link (if requested)

## Security Notes
- Google credentials are never stored or logged — relies on active browser session
- Uploaded documents are subject to Google's NotebookLM data policies
- Sensitive/PII documents require explicit human approval before upload
