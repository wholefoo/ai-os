---
name: adversarial-verification
description: Protocol for skeptic-panel verification of deliverables before they ship. Counters the bias of agents grading their own work too highly.
---

# Adversarial Verification Protocol

Agents systematically over-grade their own output. This protocol replaces single-pass self-review with independent skeptic agents whose explicit goal is to **refute** the deliverable. A deliverable ships only if it survives the panel.

## When to Trigger

| Deliverable risk | Panel size | Examples |
|------------------|-----------|----------|
| **High** — client-facing, irreversible, or money/legal | 3 skeptics, distinct lenses | SEO audit reports, published content, contracts, deploy plans, pricing changes |
| **Medium** — internal but load-bearing | 1 skeptic | Architecture specs, research briefs, data transformations |
| **Low** — drafts, intermediate artifacts | none (rubric self-check only) | Scratch notes, brainstorm lists, intake summaries |

The Orchestrator classifies risk when dispatching the task and records it in the Plan Artifact. When ambiguous, classify UP.

## How to Run a Panel

1. **Isolate.** Each skeptic gets a fresh context: the deliverable, the original task spec, and the relevant rubric from `verification-rubrics.yaml` — never the producing agent's reasoning, drafts, or conversation history. Reading the producer's rationale contaminates the verdict.
2. **Assign distinct lenses.** Identical skeptics find identical problems. For a 3-panel, assign one lens each:
   - **Correctness** — are the claims, numbers, and citations actually true? Spot-check by re-deriving or re-fetching.
   - **Completeness** — does it cover the full task spec? What was silently dropped or scoped down?
   - **Consequence** — what breaks if this ships? Edge cases, audience misread, legal/brand exposure.
3. **Instruct refutation, not review.** The skeptic's prompt must state: "Your goal is to refute this deliverable. Find the strongest reasons it should NOT ship. If uncertain whether a flaw is real, treat it as real and report it." A skeptic that returns "looks good" without naming what it checked has failed its task.
4. **Verdict by majority.** Each skeptic returns `ship` or `block` plus findings scored against the rubric. High-risk: 2 of 3 must vote `ship`. Any `block` vote's findings go back to the producing agent for revision — the deliverable re-enters the panel after revision (fresh skeptic contexts, same lenses).
5. **Cap the loop.** Maximum 2 revision rounds. If a deliverable fails its third panel, escalate to the human with the accumulated findings — do not keep iterating, and do not ship it anyway.

## Routing

- Skeptic roles map to existing agents: **reviewer** (correctness lens), **qa** (completeness lens), **safety** or **security-auditor** (consequence lens, depending on domain).
- Skeptic runs are Strategic-tier work (`cost-routing.md`) — never route verification to the Economy tier, and never to the same model instance that produced the deliverable when an alternative tier is available.
- Log every panel verdict with findings to `.magent/decisions.log`.

## Cross-Model Skeptic (Codex)

Same-model skeptics share blind spots with the producer. On **high-risk panels, one seat goes to Codex** (OpenAI) when the Codex CLI is available — typically the correctness lens for code deliverables.

- Headless invocation (stdin MUST be closed or `codex exec` hangs):
  - Windows/PowerShell: `cmd /c 'codex exec --profile reviewer "PROMPT" < NUL 2>&1'`
  - Linux/VPS: `codex exec --profile reviewer "PROMPT" < /dev/null 2>&1`
- The `reviewer` profile (`~/.codex/reviewer.config.toml`) enforces read-only sandbox and `approval_policy = "never"` — Codex cannot modify files or stall on prompts.
- For staged-diff reviews, use the `/crossreview` prompt (`~/.codex/prompts/crossreview.md`); it returns severity-tagged findings and a SHIP/REVISE verdict that maps directly to the panel's `ship`/`block` vote.
- If the Codex CLI is missing or errors, fall back to a Claude skeptic seat — a missing verdict is still a `block`, never a silent `ship`.

## Anti-Patterns (Never Do)

- Never let the producing agent pick its own panel, summarize the deliverable for the panel, or rebut findings inside the panel's context.
- Never run skeptics sequentially with shared context — later skeptics anchor on earlier verdicts. Run them in parallel, isolated.
- Never soften the refute instruction to "provide feedback" — politeness re-introduces the rubber-stamp bias this protocol exists to remove.
- Never count a skipped or errored skeptic as a `ship` vote. A missing verdict is a `block`.
- Never ship on deadline pressure by skipping the panel. If time is short, shrink the deliverable, not the verification.
