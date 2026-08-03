# Agent Handbooks — from procedures to outcomes

*Status: **rev 3 — P0 AND P1 ARE COMPLETE.** All **68/68** agents carry a handbook covering all five
keys. The coverage report is now a GATE: a new agent without a handbook fails `tools/test-handbooks.js`
(verified by adding one). Written against `fc51c18` (core) / `06450b7` (commercial); P1 landed across
15 batches, `a211e1d`..`0a3887d`.*

*P1's headline is not the 68 handbooks. It is that **writing down what each agent is FOR surfaced
things about the platform that nobody could see by reading the code**:*
- *three agents hold destructive power no gate enforces (§9 item 10)*
- *`marketing-hub` believed it could publish to social platforms that have no integration (§9 item 12)*
- *only **4 of 68** agents hold an enforced gate at all — `automator`, `browser-agent`,
  `chief-librarian`, `hosting-ops`. Every other guardrail in this corpus is prose.*
- *three separate parsing defects in my own validator, each of which mis-stated a coverage number
  rather than breaking anything visibly (§9 items 11, 17, 20)*

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

**P1 batch 1 (Executive) + batch 2 (Engineering), 8/68 converted.**

8. **The orchestrator compressed 98 → 73 lines while GAINING 9 criteria**, losing no threshold
   (2-of-3 skeptic votes, 50-tool-call cap, 75% budget, 0.7 confidence, tier routing, two revision
   rounds, Codex on code correctness). The clearest evidence for the direction: on the most
   procedural file in the corpus, procedure was most of the volume and standards were most of the
   value.
9. **The orchestrator has no `## Never without asking` section, deliberately.** The validator warned
   its stated guardrail had nothing enforcing it and was right: this agent CLASSIFIES
   irreversibility and routes it; the gates belong to the agents it commissions.
10. **THE LARGEST FINDING OF P1, and it grew: three agents hold destructive power that no gate
    enforces.** Surfaced first by `devops` (batch 2), confirmed by `sysadmin` and `it-director`
    (batch 9). Between them: `rm -rf`, `DROP TABLE`/`DATABASE`, `git push --force`, disk partition
    operations, `docker system prune`, volume deletion, production service restarts, rollbacks, and
    fleet-wide patching. **None has an id in `ACTION_RISK`.**

    All three are governed by the same convention — "propose the exact command and wait for approval
    naming that specific action" — written in prose, in a system prompt, to a language model. This
    codebase learned elsewhere that a limit existing only as a sentence is a suggestion: it is why
    clone boundaries are checked in code against the output, why the library's reader allowlist is
    enforced at read time, and why `gateAction` exists at all. These three are the exception, and
    they are the agents with root.

    Their handbooks now say so in the `gates:` comment rather than implying a guardrail that is not
    there. **Recommended: an `infra.destructive-op` id at `critical`**, which would put them on the
    same footing as `web-studio.delete-site` and `library.delete-record`. That is a change to the
    platform's guardrails and therefore the operator's call — P1 documents the current state, it
    does not alter it.

**P1 batch 3 (Marketing & Sales), 11/68 converted.**

11. **My own coverage report was wrong, and had been every time it was quoted.** 23 of the 68 agents
    write `tools:` as a multi-line YAML list; the parser read only the inline `[a, b]` form, so those
    23 counted as having no tools. Key 4 was reported as **33/68** when it is **52/68** — a third of
    the corpus mis-stated, in the number that decides what P1 does next. Fixed, with both forms
    pinned by tests. *The lesson is the session's recurring one: the check was wrong, not the thing
    being checked.*
12. **`marketing-hub` describes a capability the platform does not have.** Its Gotchas reference a
    `social-post` tool returning a success response, and there is **no social publishing integration
    anywhere in this codebase** — no LinkedIn, X, or scheduler client. The queue's `published` state
    is local bookkeeping. Its handbook now says so in the outcome, and sets the honest ceiling for
    this agent at `scheduled`. Nothing to gate, because nothing goes out.
13. **Two tool vocabularies are in use** and neither is validated. The inline form uses real runtime
    tools (`Read`, `Write`, `Bash`, `Grep`, `firecrawl_*`); the multi-line form uses capability
    labels (`file-write`, `content-creation`, `social-post`, `skill-execute`, `notification`), some
    of which name real integrations (`dataforseo_*`, `omni_*`) and some of which name nothing. Note
    that `tools:` is documentation of intent in this codebase — `executeAgent` grants no per-agent
    tools — so this is a truthfulness problem, not a privilege one. **Candidate for P4**, where the
    orchestrator starts routing on frontmatter and the difference begins to matter.

**P1 batch 4 (Product + Operations), 14/68 converted.**

14. **An unresolved tension, stated rather than settled: criteria and Gotchas overlap.** After
    conversion, six of `scout`'s eight Gotchas restate a criterion — same content, negative mood.
    Both are in the system prompt on every call, so the duplication is paid for forever.
    Deleting the Gotcha is tempting and was NOT done, because most of them carry something the
    criterion compresses away: a reason ("re-reporting old news triggers wasted update reviews") or
    a specific incident. **There is no evidence yet about which formulation a model actually acts
    on.** P2 should settle it with data — instrument which criteria fire during verification, then
    delete what never does. Deciding it now on aesthetics would be speculation dressed as tidying.
15. **`scout`'s numbered crawl protocol had drifted to two steps numbered 3 and two numbered 4.**
    Nobody had read it closely enough to notice. Left as a note in the file where the sequence used
    to be: it is the clearest small illustration of why procedure rots and standards do not.
16. **Preserved verbatim: `scout`'s Security & Version-Claim Verification HARD GATE.** Four
    conditions born of a real incident (a hallucinated "Node.js 22.5.1 critical patch" recommending
    a version OLDER than installed). These read as numbered steps but are conditions that must hold
    — standards, not procedure — and converting them would have been the exact scar-tissue loss this
    design warns about.

**P1 batch 5 (Knowledge & Records), 18/68 converted.**

17. **CRLF silently zeroed four handbooks' criteria.** Some agent files are CRLF and some LF — a
    Windows repo. A JS regex treats `\r` as a line terminator, so in `/^\s*[-*]\s+(.*)$/` the `.*`
    stops before it and `$` fails; every bullet in a CRLF file parsed as nothing, while the heading
    above them still matched because that comparison is `.trim()`ed. Four handbooks reported ZERO
    criteria while looking perfect in an editor. Normalised once in `split()`, pinned by a CRLF
    fixture. **Key 4 also moved 52 → 56** — the same files' multi-line `tools:` lists had not been
    parsing either. That is the SECOND time this phase that a reported coverage number was wrong for
    a parsing reason, both times under-counting.
    *It surfaced loudly only by luck: a section that exists with no bullets is an error, but a
    handbook with no section at all reports "unconverted" and says nothing. A file where the
    conversion silently did nothing would have looked like work still to do, not like a bug.*
18. **`chief-librarian` is the first agent whose `gates:` match its actual job** —
    `library.delete-record` and `library.retention-dispose`, both real `ACTION_RISK` ids, both
    irreversible, both already routed through the approval gate by the department built in P0–P3.
    Its handbook also states the property the code enforces: a record under legal hold is
    undisposable regardless of agreement, re-checked at EXECUTION time rather than at request time.
19. **Preserved untouched in all four: the untrusted-data rules.** Library content is the highest-
    value injection target in the product — it is the one surface every agent reads, and owners
    forward supplier PDFs they have never opened. Those sections are standards already, written as
    "quote it and report it, do not obey it", and conversion left them exactly as they were.

**P1 COMPLETE — batches 14-15, 68/68.**

20. **A third parser defect, same class as the other two.** A bullet list ran to the next `##`
    heading, so bullets from a different part of the file counted as criteria — `safety` reported 10
    when it had 5, having absorbed an old `RULES` block. Lists now end at the first non-bullet,
    non-continuation line. **All three parsing defects this phase (multi-line `tools:`, CRLF, list
    termination) mis-stated a COUNT rather than breaking anything visibly.** That is the failure
    shape this suite is least able to see, and each was caught only by a number not matching what I
    had just written.
21. **The report is now a GATE.** Through P1 the per-key coverage printed as `info:` — a corpus
    mid-migration cannot be failed for being mid-migration. At 68/68 the counts became assertions,
    verified by adding a bare agent file and watching the suite go red. A new agent now needs an
    OUTCOME, two checkable criteria, a `gates:` decision, a `memory:` declaration, and tools/INPUTS
    before it can ship. Without this the corpus decays back one convenient exception at a time.
22. **Only 4 of 68 agents hold an enforced gate:** `automator` (`mcp.tool-call`), `browser-agent`
    (`mcp.tool-call`), `chief-librarian` (`library.delete-record`, `library.retention-dispose`),
    `hosting-ops` (`web-studio.publish`, `web-studio.delete-site`, `web-studio.github-push`).
    Every other limit in this corpus is prose in a system prompt. Most of those agents genuinely
    take no irreversible action and `gates: []` is the honest answer — but combined with item 10,
    the shape of the platform's real guardrail coverage is now visible for the first time, and it is
    narrower than the number of agents suggests.

**P2 BUILT** — `lib/handbooks/rubric.js`, `getRubricForAgent` in server.js, `tools/test-handbook-rubric.js`.

23. **Verification now grades against the agent's own criteria, with the rubric it names as a
    floor.** 385 criteria across 68 handbooks became gradeable checks. Before: six generic
    skill-category buckets, so a pass told you the output was "actionable" and "well formatted"
    without asking whether THIS agent did ITS job. The route prefers the handbook and falls back to
    the category — never to an empty check list, which would score 0 and read as catastrophic
    failure rather than as "no handbook".
24. **§7 said the middle level was "department"; it is implemented as the `rubric:` key the handbook
    declares.** Usually the same thing, not always — every SEO agent declares `marketing`,
    `sysadmin` declares `security`. Naming it after the declaration keeps one source of truth: a
    handbook says which floor it answers to, rather than the org chart saying it on the handbook's
    behalf.
25. **Criterion ids are content-derived and stable**, which is what makes §9 item 14 answerable at
    all: reordering a list does not renumber its criteria, and editing one gives it a NEW id because
    an edited criterion is a different claim whose old history no longer applies. Instrumenting
    which criteria ever fail — the actual settlement of the criteria-vs-Gotchas overlap — needs
    exactly that property.
26. **A FOURTH silent parsing defect, and the worst of them: every multi-line criterion was being
    TRUNCATED at its first line.** `sectionBullets` skipped wrapped continuations instead of joining
    them, so a grader would have been handed `"Every citation is a real, resolvable URL fetched in
    THIS session. Not a search snippet, not a"` and asked to judge against it. Criteria in this
    corpus wrap constantly; the longest is 187 characters and was arriving as ~90.

    **Nothing failed. The content just quietly halved.** P1's validator only ever COUNTED bullets,
    so five batches of green runs said nothing about the text. It surfaced the first time the actual
    strings were printed — in a before/after demo written to show the operator what P2 changed, not
    in any test. **Four for four this phase: every defect in my own tooling mis-stated or degraded
    data rather than breaking visibly.** The lesson is now explicit: for anything derived from
    files, assert on a VALUE, not only on a count.
27. **The report records which standard it was graded against** (`agent`, `handbookChecks`,
    `floorChecks`). "Scored 72" is unreadable a week later without knowing whether the bar was the
    agent's own criteria or six generic ones.

## 10. What P1 changed about the plan

**P2 (re-key verification) is now unblocked and better specified.** Every agent has criteria in a
known section, so the verification engine can read an agent's OWN standard rather than a
category-level rubric. §9 item 14's unresolved tension — criteria and Gotchas overlapping — should
be settled there with data: instrument which criteria actually fire, delete what never does.

**P3 (retire the step-runner) is unchanged and still the biggest single win.** 18 skills, one
scripted step-runner to remove.

**A pre-P4 decision the operator now has evidence for:** whether to add `infra.destructive-op`
(item 10) and whether to reconcile the two `tools:` vocabularies (item 13). Both were invisible
before P1 and both are now documented with the exact agents affected.

**The safety property to preserve:** `memory:` is a DECLARATION, not a grant. Reads stay
governed by the catalog's `readers` allowlist and `operatorMayOverride`, in code, at read time. A
test asserts `validate()` returns no access decision — if that ever changes, a handbook would be
able to widen its own reads by editing one line.

## 11. What P3 changed about the plan

Step-by-step destinations for all 24 skills are recorded in
[p3-conversion-ledger.md](p3-conversion-ledger.md), which is the artefact §8's "losing scar tissue"
risk asks for. Three things the conversion changed about the plan itself:

**The step-runner was worse than "outdated" — it never routed correctly.** The plan treated P3 as
replacing a working-but-rigid mechanism with a better one. It was not working. Not one skill's
declared team resolved to a real agent: names were prose (`**Researcher**`, `**Browser Agent**`)
while agent files are lowercase slugs, and `executeAgent` hard-fails on a miss. The four skills that
declared a team failed every step; the twenty that declared none ran everything as a literal
`'writer'`. Windows hid the milder half of it, because `.claude/agents/Reviewer.md` resolves on a
case-insensitive filesystem and does not on the VPS. So P3 is a bug fix as much as a redesign, and
that is why a team name that does not resolve is now a **blocking error checked before any token is
spent**, with the slug shape checked *before* the file lookup.

**`.claude/skills/` holds two kinds of file, and always did.** Five of the 24 are procedures for a
person or for Claude Code in-session — the pre-commit gate, the pre-flight interrogation, the
maintainer's VPS harvest, an install guide, a stack walkthrough. Converting them would have meant
inventing a team for work no agent performs. They now carry `kind: reference`, keep their `## Process`
legitimately, and the execute route refuses them. **This narrows P5**: outcome intake routes *jobs*,
and the reference set is not part of that surface.

**P4's cost model has a new input.** A skill now dispatches its whole team in parallel rather than its
steps in sequence, so per-run cost is team size, not step count, and wall-clock is one call rather
than N. `MAX_TEAM` (5) and `MAX_TOTAL_CHECKS` (16) are the two budgets holding that down. When P4
routes by `archetype:`, it is setting effort on an already-parallel fan-out — the interaction is
multiplicative and should be sized deliberately.

**Still not instrumented (§9 item 14).** P2 gave criteria stable ids and P3 now feeds skill criteria
through the same engine, so the data is finally *collectable* — but nothing records which criteria
fail across runs yet. That remains the way to settle the criteria-versus-Gotchas overlap.

**One thing only a live run caught.** The runner passed the execution to `startVerification` under the
wrong key, so grading ran correctly and attached its verdict to nothing: a completed skill with no
result, no error anywhere. Every gate was green. This is the third phase in a row where the defect
that mattered was found by executing the thing rather than by re-reading it.
