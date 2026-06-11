---
description: Cross-model review of staged changes (read-only)
allowed-tools: Bash(git diff:*), Read, Grep, Glob
argument-hint: [optional focus area]
model: claude-opus-4-8
---
Staged changes to review:

!`git diff --staged`

Review only the diff above. For each issue:
- severity: blocker | should-fix | nit
- location: file:line
- problem: one line
- fix: concrete suggestion

Check correctness, edge cases, error handling, and test coverage. Don't
restate what the code does. Don't edit files — this is review only.
End with a one-line verdict: SHIP or REVISE.

Focus area (if any): $ARGUMENTS
