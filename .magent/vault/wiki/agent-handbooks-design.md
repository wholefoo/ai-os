# Agent Handbooks — from procedures to outcomes

*Status: **rev 2 — P0 IS BUILT.** Written 2026-08-01 against `fc51c18` (core) / `06450b7` (commercial).*

*Rev 2 folds in a second source document, "The Five Keys to Briefing Your AI Employee", which splits
rev 1's fourth component into two: **tools/files** and **shared business memory**. Rev 1's schema
covered keys 1–4 and had no slot for key 5 — the platform holds substantial shared memory (org
profile, canonical facts, the Knowledge & Records catalog, the vault) and no handbook declared which
of it an agent works from. `memory:` closes that, and `validate()` now reports per-key coverage so
progress is measured against the source document rather than a paraphrase of it.*

*What building P0 changed (§9): **three amendments, all found by running the validator**, none by
re-reading the design. The coverage report is what found them.*
1. *The design doc's own example named `content.publish` and `email.send`. **Neither exists** — the
   real ids are `web-studio.publish` and `email.sequence-send`. The validator caught its author on
   first run, and there is now a standing assertion that those two invented ids stay absent.*
2. *Key 3 read **0/68** across the corpus — not one agent declares a guardrail, though the platform
   has full gating. It also exposed a flaw in the reference: `architect` writes design docs and has
   nothing irreversible to gate, so demanding a guardrail would have produced exactly the decorative
   promise this schema prevents. Resolved by distinguishing **`gates: []` (a decision) from an absent
   key (an omission)** — the same explicit-empty discipline used by the reader allowlists.*
3. *The frontmatter parser had to learn trailing comments on list values, because the most valuable
   part of an empty `gates: []` is the comment explaining that the question was considered. Narrowly
   done — a scalar keeps every `#`, so a colour or a "#1" in a description survives.*

*Origin: the operator's direction after reading "Claude Code's Creator Hacks" (Boris Cherny's "delete
protocol"). The brief: agents should pursue **outcomes and goals**, not execute predefined skills,
because models are now capable enough to find the process themselves — and because a written
procedure rots every time the model improves, while a written standard does not.*

Locked decisions (operator, 2026-08-01): **archetypes are an orthogonal tag, not a replacement for
the 68 agents / 11 departments** · **the 24 skills are CONVERTED to outcome briefs, not deleted** ·
delete the procedure, keep the standards.

---

## 1. Executive summary

The platform is closer to this model than a reading of the source document suggests. Four of the
five handbook components already exist and are wired into the model call:

| Handbook component (source doc) | State | Where |
|---|---|---|
| 1. The exact outcome | **in place** | agent `.md` `ROLE`/`OBJECTIVE`, loaded as the system prompt by `loadAgentPrompt` inside `executeAgent` (`server.js:3662`) |
| 2. Success criteria | **partial — the real gap** | `.claude/rules/verification-rubrics.yaml`, but keyed by *skill category*; only **9 of 68** agents state a `DONE WHEN` |
| 3. Guardrails | **in place, stronger than proposed** | prompt `RULES`/`Gotchas` **plus** server-enforced `gateAction`/`ACTION_RISK` (`lib/safety/approval.js`) |
| 4. Tools + shared business memory | **in place** | `tools:` frontmatter, `.magent/vault`, org profile, Knowledge & Records |
| 5. The freedom to execute | **absent at one specific site** | `runSkillExecution` (`server.js`) |
| "Chief Orchestration Officer" | **in place** | `orchestrator` agent + the six patterns in `lib/orchestrator.js` |

So this is not a rebuild. It is **one deletion, one addition, and one re-keying**:

- **Delete** the step-runner: `runSkillExecution` parses a skill's `## Process` section and executes
  each step as its own agent call, threading outputs forward. The model is handed step 3 of 7 and
  never sees the goal. **18 of 24** skills have such a section. This is the only place in the
  platform that micromanages a model, and it is exactly what the source document argues against.
- **Add** success criteria to the agent corpus. Today **58 of 68** agents carry a `## Gotchas`
  section (what never to do) and **9** carry a `DONE WHEN` (what good looks like). That is a
  constraint library, not a handbook. This is the substantive work and it is purely additive.
- **Re-key** the verification rubrics from skill category to handbook, so "what does good look like"
  and "what gets checked" are the same sentence rather than two documents that drift.

## 2. Where the source document is wrong for this codebase

The document says to discard system prompts and instructions because models have outgrown them.
Applied literally here that deletes 58 `Gotchas` sections, and those are not procedure — they are
**scar tissue**. Each line encodes a failure someone paid for:

> *"Do not recommend libraries, services, or APIs without verifying they exist in the codebase's
> dependency files"* — `architect.md`

A smarter model does not make that instruction obsolete; it makes it cheaper to obey. The
distinction the document blurs, and which the operator's framing ("criteria and standards for
agents, not skills") gets right:

**A procedure says which button to press next. A standard says what good looks like and what is out
of bounds. Only the first one rots when the model improves.**

Everything below deletes procedures and keeps — indeed multiplies — standards.

## 3. The handbook schema

A handbook **is** the agent's `.md` file. No new file type, no second registry: the agent corpus is
already loaded as the system prompt, already counted in product canon, and already the thing the
orchestrator dispatches to. Introducing a parallel "handbook" artifact would create exactly the
drift this design exists to remove.

```markdown
---
name: seo-content
description: <one line — used for routing, unchanged>
model: claude-opus-4-8
effort: xhigh
tools: [Read, Write, Grep]
department: marketing
archetype: [grower, maintainer]        # NEW — orthogonal, see §5
gates: [content.publish, email.send]   # NEW — real action ids, see §4
rubric: marketing                      # NEW — explicit, replaces category inference
---

ROLE: ...                    # who this is
OUTCOME: ...                 # THE GOAL, stated as an end state, not a task list
INPUTS: ...                  # where to look
OUTPUTS: ...                 # what lands where

## What good looks like        # NEW — the gap being filled
- Every claim carries a source or is labelled an assumption.
- Meta description is 120–160 characters.
- A beginner can act on it without asking a follow-up question.

## Never without asking        # guardrails, in the doc's own words
- Publishing anything to a live surface  → gated as `content.publish`
- Sending to a real recipient            → gated as `email.send`

## Gotchas                     # KEPT — hard-won failures, unchanged
- ...

DONE WHEN: ...               # the completion test, checkable by another agent
```

Three rules govern the new sections.

**Criteria must be checkable by another agent, not by a human reading prose.** "Well written" is not
a criterion. "Every claim carries a source or is labelled an assumption" is — a verifier can hold the
output against it and return pass/fail with an example. This is what makes the automated verification
loop the source document calls for actually run.

**Criteria state the end, never the route.** "Research competitors, then compare, then write" is a
procedure wearing a criterion's clothes. "The comparison names at least three competitors and cites
where each claim came from" is the same intent with the method left to the model.

**Guardrails name a real gate or they are decorative.** See §4.

## 4. Guardrails must map to enforced action ids

The source document's guardrails are prompt text: *tell the AI to check before publishing.* This
codebase already learned that a limit which exists only as a sentence in a prompt is a suggestion to
a language model — it is why `boundaries` in the Business Clone are checked **in code** against the
output as well as stated in the prompt, and why irreversible actions run through `gateAction`.

So a handbook's `## Never without asking` section is **not the enforcement**. It is the human-readable
face of `ACTION_RISK`, and the `gates:` frontmatter is the machine-readable link. A validator (P0)
asserts every id in `gates:` exists in the approval registry, so a handbook cannot promise a guardrail
the server does not enforce, and cannot silently lose one when an action is renamed.

This inverts the usual failure: rather than trusting prose, the prose is *checked against* the code.

## 5. Archetypes as an orthogonal tag

The source document proposes five archetypes — prototyper, builder, sweeper, grower, maintainer — as
the structure for workflows. The platform already has 68 agents across 11 departments.

These are different axes and neither replaces the other. A department says **who** (marketing, legal,
engineering); an archetype says **what mode of work** (is this a fast disposable probe, a durable
build, a cleanup sweep, a growth loop, or ongoing upkeep?). `seo-content` is a marketing agent that
operates as a *grower* on a campaign and a *maintainer* on an existing corpus.

Collapsing 68 agents into 5 archetypes would discard the departmental structure the product is sold
on, and the org chart every public surface documents. Adding archetype as a tag costs one frontmatter
line and gives the orchestrator a second routing dimension it does not have today: *this is a sweep,
so prefer cheap models, high parallelism, and no gates* versus *this is a build, so prefer xhigh
effort and a review pass.*

**Archetype drives cost/effort/verification defaults, not identity.**

## 6. Skills: converted, not deleted

24 skills; 18 carry a `## Process`. Their step lists are frequently a decent statement of *what good
looks like* written in the wrong mood — "check title tags are 50–60 chars" is a criterion phrased as
an instruction.

Conversion, per skill:
- `## Goal` → the outcome brief's `OUTCOME`
- `## Process` steps → **rewritten as criteria** in `What good looks like`, dropping sequencing
- anything genuinely procedural and still true (an API's required call order, a file format) → moves
  to the owning agent's `## Gotchas`, which is where non-negotiable mechanics belong
- the file itself becomes an **outcome brief**: goal + criteria + guardrails, no steps

The step-runner (`runSkillExecution`) retires. `POST /api/skills/:name/execute` keeps its URL and its
UI, but the body changes: instead of N sequential agent calls, it dispatches **one** call carrying the
outcome and its criteria, then a verification pass that scores the result against those same criteria
and can send it back once. Fewer calls, lower cost, and the model can find a better route than the
one written in 2026.

## 7. Phases

**P0 — schema, exemplar, validator.** Define the frontmatter additions; convert **one** agent
end-to-end as the reference (`architect` — it has the richest existing Gotchas and a real DONE WHEN);
write `tools/test-handbooks.js` asserting: every `gates:` id exists in `ACTION_RISK`; every `rubric:`
key exists in the rubric file; every `archetype:` is one of the five; a handbook with a
`What good looks like` section has at least two checkable criteria. *DoD: the validator fails on a
deliberately broken handbook.*

**P1 — criteria for the corpus.** Add `What good looks like` + `DONE WHEN` to the remaining 67
agents, batched by department (11 batches). Purely additive; nothing is deleted. *DoD: validator
green across all 68; no agent left with zero criteria.*

**P2 — re-key verification.** Rubrics move from 6 skill categories to handbook-scoped, with
inheritance `default → department → agent`. The verification engine reads the agent's own criteria
first and the rubric as the floor. *DoD: a verification run cites the specific criterion it failed.*

**P3 — retire the step-runner.** Convert 18 skills to outcome briefs; replace `runSkillExecution`
with dispatch + verify. *DoD: an SEO audit produces an equal-or-better artifact in fewer model calls;
the old step-by-step path is gone, not merely unused.*

**P4 — archetype routing.** Orchestrator reads `archetype:` to set effort, parallelism and whether a
review pass is required. *DoD: a `sweeper` task and a `builder` task with identical text route to
different models and different verification depth.*

**P5 — outcome intake.** A first-class outcome object (goal, criteria, guardrails, budget, deadline)
that the orchestrator receives and routes to a department — the source document's "give the job to
your COO" surface. *DoD: an operator states an outcome in the dashboard and never names an agent.*

## 8. Risks

**Criteria inflation.** 68 agents × N criteria is a corpus that can rot exactly like the skills it
replaces. Mitigation: criteria must be checkable, and a criterion nothing has ever failed is a
candidate for deletion at review time. Track which criteria actually fire.

**Prompt bloat and cost.** The handbook is in the system prompt of **every** call that agent makes.
Longer handbooks raise the per-call cost of everything, forever — the same budget argument as
`persona.js` CAPS. Mitigation: cap handbook length in the validator (a hard line count), and treat
the cap as a budget, not a limit.

**Losing scar tissue.** The largest risk in P3: a genuine mechanical constraint buried in a `Process`
step gets dropped as "procedure" and the bug it prevented returns. Mitigation: conversion is
line-by-line with an explicit destination for each step (criterion, gotcha, or deliberately dropped),
recorded per skill.

**Verification circularity.** An agent grading itself against its own criteria will pass. The
verifier must be a different agent with the criteria and the artifact but not the author's reasoning
— which is what `reviewer` already does and why it is read-only with veto power.

## 9. Divergences found while building

**P0 (built).** `lib/handbooks/schema.js` · `.claude/agents/architect.md` (reference conversion) ·
`tools/test-handbooks.js` · `ACTION_RISK` exported frozen from `lib/safety/approval.js`.

1. **`ACTION_RISK` had to be exported.** `decide()` cannot answer "does this id exist" — an unknown
   type classifies as `medium`, so a typo'd gate reads as a real guardrail. Exported frozen: it is a
   registry, not a scratchpad, and a caller mutating it would re-band a live action with no commit
   to point at.
2. **The design doc's example gate ids were fictional** (§ rev 2 note 1).
3. **Key 3 was 0/68**, and the reference agent legitimately has nothing to gate (§ rev 2 note 2).
   `gates: []` is now a recorded decision.
4. **Inline comments on list values** (§ rev 2 note 3).
5. **The five keys are now reported per handbook**, not just "converted / not converted".
   "Converted" turned out too coarse to plan P1 with: the corpus is **31/68 on key 4** (tools/files)
   and **1/68 on keys 1, 2, 3 and 5**. P1's real shape is therefore criteria + memory + an explicit
   gates decision for 67 agents, with tools mostly already present.
6. **The procedural-criterion check warns, never blocks.** It reads wording, not meaning, so it must
   not be able to fail a build on a false positive. The reviewer remains the real check.
7. **`MEMORY_SOURCES` imports `catalog.VALID_STORES`** rather than restating the store names, so a
   store renamed in the catalog cannot leave a stale vocabulary in the schema.

**The safety property to preserve in P1+:** `memory:` is a DECLARATION, not a grant. Reads stay
governed by the catalog's `readers` allowlist and `operatorMayOverride`, in code, at read time. A
test asserts `validate()` returns no access decision — if that ever changes, a handbook would be
able to widen its own reads by editing one line.
