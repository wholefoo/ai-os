---
name: ingest-vps-proposals
description: Maintainer bridge — pull self-improvement proposals off the live VPS instance, adversarially vet each one, and merge only the real, correct ones upstream into this package as attributed commits. Use to harvest enhancements the VPS self-improvement engine generated (it commits them locally and never pushes them). This is operator/maintainer tooling, NOT a customer feature.
category: maintainer
estimated_time: 10-20min
---

# Ingest VPS Self-Improvement Proposals

## Goal
The VPS self-improvement engine generates enhancement proposals — and may auto-apply some as
**local-only commits** — but it has no `git push`, so they never leave the box. This skill brings
them down, runs each through adversarial review, and merges the real, correct ones into this
canonical repo as proper attributed commits that ship to every deployment.

**Mental model: the VPS is a junior dev opening PRs; this skill is the senior reviewer.** That
engine can produce slop — it once generated a fabricated "Node 22.5.1 critical CVE." Nothing
merges without clearing the gate below, and nothing is ever blind-applied.

## Inputs
- VPS host (e.g. `root@<vps-ip>`). Ask the user if not already known this session.
- Merge gate: **always ask** before merging each accepted proposal (do not batch-merge silently).

## Process

### 1. Fetch (SSH/scp — air-gap stays closed)
```
bash tools/fetch-vps-proposals.sh root@<vps-host>
```
Stages `pending_approvals.json` + any locally-applied self-improvement commits (as `*.patch`)
into `.magent/vps-proposals/<timestamp>/` (gitignored). **Zero proposals is a valid, complete
outcome** — report "nothing to ingest" and stop; never manufacture work.

### 2. Dedupe
Read `.magent/vps-proposals/ingested.json` (create `[]` if absent). Skip any proposal `id`
already processed (accepted or rejected). Review only fresh ones.

### 3. Adversarial review — the gate (per proposal)
Produce a verdict with reasoning for each fresh proposal. Apply EVERY check; any failure caps the
verdict at REJECT or DEFER:

- **Not hallucinated.** Any version / security / CVE claim must cite a real CVE **and** a vendor
  advisory you fetch *this run* — reuse the Security & Version-Claim Verification gate in
  `.claude/agents/scout.md`. "Patches a vulnerability" with no CVE and no fetched advisory is dropped.
- **Real & current.** WebFetch/Firecrawl-verify that any referenced API, library, model, or feature
  actually exists and behaves as claimed. Never trust a claim from training memory.
- **Correct against THIS master.** The VPS may be a stale fork. Check the proposal's target files
  against the *current* repo: is the change still needed, already done (e.g. the "integrate
  Firecrawl MCP" proposal was already integrated), or would it now conflict?
- **In scope for the package.** A shippable product enhancement, not VPS-instance-specific config or
  one-off tuning. Reject instance-specific items.
- **Not slop.** Vague ("consider adopting X"), duplicate, or low-value proposals are rejected with a
  one-line reason.

Verdict ∈ **ACCEPT | REJECT | DEFER**. Optional second opinion: run ACCEPT candidates past the Codex
cross-model seat (`/code-review` / the crossreview prompt) for verification diversity before merge.

### 4. Present & gate
Show the user a verdict table — every proposal, its verdict, and the reasoning. For each ACCEPT, ask
for explicit approval before merging. Never silently batch-merge.

### 5. Merge (user-approved ACCEPTs only)
- **Re-implement cleanly against current master** — do NOT blind-apply the VPS patch. The VPS may be
  a stale fork; use its diff/description as the spec and write the change correctly here, matching the
  surrounding code.
- Run the normal quality bar (adversarial verification / tests as applicable).
- Commit with attribution:
  `Upstream from VPS self-improvement: <title>` and a body noting the source proposal id + verdict.
- Push to origin (normal flow — this is the canonical repo).

### 6. Record
Append every processed proposal to `.magent/vps-proposals/ingested.json`:
`{ id, title, verdict, reason, commit, date }`. Stops re-review next run; gives an audit trail.

Optional (v2): mark the proposal resolved on the VPS via `PUT /api/platform/proposals/:id` so the
dashboard stops listing it as pending.

## Output
- Merged enhancements pushed to origin, each attributed to its source proposal.
- A verdict summary to the user (accepted / rejected / deferred, with reasons).
- Updated `.magent/vps-proposals/ingested.json` ledger.

## Guardrails
- Never blind-apply a VPS patch — always re-implement against current master.
- Never merge a security/version proposal without a real CVE + a fetched vendor advisory.
- Never push without per-item user approval.
- Zero proposals, or all-slop, is a valid, complete run — report it honestly.
- This bridge is the controlled, reviewed channel that keeps the VPS→remote path closed: the VPS
  never pushes; improvements only flow upstream *through* this review.
