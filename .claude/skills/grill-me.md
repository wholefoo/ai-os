---
name: grill-me
description: Pre-flight alignment interrogation that runs BEFORE any implementation begins. Use when a mission, feature request, or task brief arrives and coding has not started; do NOT use mid-implementation (scope questions then go to the orchestrator) or for trivial single-file fixes with an unambiguous spec.
category: planning
estimated_time: 5-15min
agents: [orchestrator, architect]
---

# Grill Me — Pre-Flight Alignment Interrogation

## Goal

Eliminate misalignment before it becomes code. The most expensive bugs are built to spec — the wrong spec. This skill interrogates the requester until the requirements survive scrutiny, then produces an Approved Brief that implementation agents treat as the contract.

**No implementation work may begin until the brief is approved.** A grilling that ends in "close enough, let's start" has failed.

## Process

Work through the five rounds in order. Ask only questions whose answers would change what gets built — skip rounds that are genuinely already answered by the request.

### Round 1 — Outcome
- What does success look like, concretely? ("Working" is not an answer — what does the user see/do differently?)
- Who uses this, and what do they do today instead?
- If only 20% of this shipped, which 20% must it be?

### Round 2 — Scope Edges
- What is explicitly OUT of scope? (Force at least one exclusion — "nothing" means scope isn't understood.)
- Does this change existing behavior anyone depends on? Which?
- One-off or permanent? Prototype-grade or production-grade?

### Round 3 — Constraints
- What can't change? (APIs, schemas, URLs, pricing, branding, licenses)
- Budget ceilings: tokens, API spend, time, dependencies allowed?
- Which tier handles this per `cost-routing.md`, and is that consistent with the quality bar?

### Round 4 — Failure Modes
- What's the worst thing this could do if it works incorrectly? (data loss, wrong customer-facing claim, broken deploy)
- What existing behavior could it silently break? How would we notice?
- Is any step irreversible? (Those need explicit human approval per orchestrator protocol.)

### Round 5 — Verification
- How will we PROVE it works — what command, test, or observable behavior?
- What deliverable risk tier is this (`adversarial-verification.md`), and who sits on the panel?
- What would make us roll it back after shipping?

## Exit Criteria

Proceed only when ALL of these hold:
1. Every Round 1-5 question is answered or explicitly deferred **by the human** (the skill may not defer questions on its own)
2. At least one scope exclusion is recorded
3. The verification method is executable, not aspirational ("run X, expect Y")
4. Contradictions between answers have been surfaced and resolved

If three rounds of follow-up fail to resolve a contradiction, stop and escalate — do not paper over it with an assumption.

## Output

Write the Approved Brief to `.magent/plans/brief-<slug>.md`:

```markdown
# Approved Brief: <title>
Approved: <date> | Risk tier: low|medium|high | Engine tier: <cost-routing tier>

## Outcome — what success looks like
## In scope / Out of scope
## Constraints (cannot change)
## Failure modes + mitigations
## Verification — exact commands/behaviors that prove completion
## Open assumptions (each labeled [assumption], approved by human)
```

The orchestrator references this brief in its Plan Artifact; the reviewer checks deliverables against it.

## Gotchas

- Do not ask questions the request already answers — re-asking signals the grilling is theater and trains the human to give shallow answers.
- Do not accept "use your judgment" as an answer to a Round 3 or Round 4 question — convert it into a concrete default, state it back, and get explicit confirmation.
- Never start "just the obvious part" of implementation while questions are pending — partial starts anchor the design before alignment exists.
- Do not let the brief restate the request in fancier words — every section must contain information that was NOT in the original ask, or the grilling extracted nothing.
- Record answers verbatim where wording matters (pricing, legal, customer-facing copy) — paraphrasing is where misalignment re-enters.
- A brief with zero `[assumption]` labels on a non-trivial task is a red flag — it means assumptions were silently absorbed instead of surfaced.
