# P3 conversion ledger — where every `## Process` step went

The design doc names the largest risk in P3 as **losing scar tissue**: a genuine mechanical constraint
buried in a procedure gets dropped as "procedure" and the bug it prevented comes back. The stated
mitigation is that conversion is line-by-line with an explicit destination for every step. This is
that record.

Destinations are one of:

- **criterion** — became a bullet under `## What good looks like`; it is now graded.
- **guardrail** — became a hard limit under `## Guardrails`.
- **contract** — a data shape or registry other code depends on; kept verbatim as its own section.
- **runner** — the step was orchestration the runner now does (fan-out, synthesis, verification).
- **params** — the step was intake; the `## Parameters` block already carried it.
- **dropped** — genuinely nothing but sequencing instructions to a model.

---

## The two defects the conversion exposed

Neither was visible from reading the code, and both had been live for the life of the feature.

**1. No skill's declared team ever resolved.** Skills named members in prose — `**Researcher**`,
`**Browser Agent**`, `**Safety agent**`, `**Grok Real-Time**` — while agent files are lowercase slugs.
`loadAgentPrompt` does an exact path lookup and `executeAgent` returns `Agent "X" not found` on a
miss, so *every step of all four skills that declared a team failed*. The other twenty declared none
and fell through to a literal `'writer'`, which means keyword research, technical crawl analysis and
security assessment all ran as the writer agent.

**2. Windows hid it.** `.claude/agents/Reviewer.md` resolves on a case-insensitive filesystem and does
not on the Linux VPS. So `verify-output` and `seo-audit` behaved differently in development and in
production. The validator checks the *slug shape* before the file lookup for exactly this reason —
the lookup alone cannot catch it on the machine where these files get written.

A third, smaller one: `tech-radar` wrote its steps as `### Step N` headings, which `parseSkillSteps`
did not match, so it silently took the "no steps" branch and ran its entire body as one writer call.

---

## Job conversions (19)

### seo-audit
| Step | Destination |
|---|---|
| 1. Intake | **params** — `url`, `audit_type`, `keywords`, `competitors` already existed |
| 2. Keyword Research | **criterion** (15–25 keywords, intent classified, sorted) + team `seo-keyword` |
| 3. On-Page SEO | **criterion** — 50–60 char titles, 150–160 char metas kept as the SERP truncation points they are |
| 4. Content Gap | **criterion** — <300 words thin, 12+ months stale, both kept as literal thresholds |
| 5. Technical SEO | **criterion** (pass/fail/warning, never silence) + team `seo-technical` |
| 6. Competitor Comparison | **criterion** (comparative and sourced) + team `seo-competitor` |
| 7. Compile Report | **runner** — synthesis |
| 8. Review & Deliver | **runner** — verification |
| Error handling: unreachable URL | **criterion** — first finding, audit continues |
| Error handling: no competitors | **dropped** — the agent decides how to find them |

### academic-paper
Steps 1–4 (topic analysis, literature search, outline, draft) → **criterion** (min_sources actually
retrieved; no single-source claim on contested ground) + team. Step 5 Review → **runner**
(`reviewer` is on the team). Step 6 Revise → **dropped**. Step 7 Finalize → **criterion** (style
consistent in text and reference list). Fabrication ban → **guardrail**.

### academic-reviewer
Steps 1–5 → **criterion** (every criticism cites a location; the three distinct citation failures).
Step 6 Verdict → **criterion** (exactly one of ACCEPT/REVISE/REJECT). "Never soften a verdict" →
**guardrail**, new — it was implied by the skill's purpose and stated nowhere.

### deep-research
Steps 1–4 → **criterion** (min_sources with the *reason* for each rating). Step 5 Synthesis →
**criterion** (conflict reported as conflict) + team `synthesis`. Steps 6–7 → **runner**.
"Never present a citing source as independent confirmation" → **guardrail**, new.

### research-brief
Step 1 Scope → **params**. Step 2 Gather → **criterion** (8 sources, under a year, older labelled).
Step 3 Synthesize → **criterion**. Step 4 Structure → **criterion** (3–5 sentence summary that
survives alone). Step 5 Quality Check → **runner** + **criterion** (single-source claims flagged).

### tech-radar
Step 1 Source Crawl → **dropped** (the source list was a starting point, not a constraint).
Step 2 Filter & Score → **criterion** (`min_relevance` against *this* stack). Step 3 Summarize →
**criterion**. Step 4 Generate Proposals → **contract** — the YAML block is an interface the
dashboard's apply flow reads, so it is kept verbatim under `## Proposal contract`; the security gate
and `apply_via` semantics became **criterion**; forward-only version checking became **criterion**.
Steps 5–7 (route, approve, apply) → **guardrail**: "Never apply anything."

### security-audit
Steps 1–6 → **criterion** (every finding names a location and the attacker's gain; unexamined
components listed). Step 7 Report Compilation → **runner** + **criterion** (severity justified against
*this* deployment). "Never modify the target", "never test out of scope", "never print a live secret"
→ **guardrail**, all three new.

### verify-output
Step 1 Load Rubric → **runner**. Steps 2–4 → **criterion** (evidence per check; the failing criterion
in its own words). Step 5 Gate Decision → **criterion** (thresholds exactly) + **guardrail** (never
auto-approve a REVIEW/FAIL; never let an author grade itself).

### browser-automation
Steps 1–5 → **criterion** (a selector matching nothing is "not found", not an empty page; consent
walls reported). Step 6 Cleanup → **criterion** (closed on failure too). The existing `## Safety`
block → **guardrail** unchanged, including the 1-request-per-2-seconds limit.

### grok-search
Steps 1, 3–5 → **criterion** (source URL and date; found vs inferred). Step 2 Check Cache and the
rate limit → **guardrail** (30/hour, 5-minute dedupe). Step 6 Cache → **dropped** (implementation).

### content-creation
Steps 1–4 → **criterion** (3+ real sources or say so; length within ~10%; keywords where they read
naturally). Step 5 Finalize → **runner**. Error handling (<3 sources → escalate) → **criterion**.
"Never publish or post" → **guardrail**, new and important: this skill produces a draft.

### lead-enrichment
Steps 1–3 → **criterion** (not-found stays empty; every score cites its ICP criterion; invalid rows
reported with identity). Step 4 Output → **criterion** (score distribution reported — if everything
scores 8 the criteria are not discriminating). "Never guess an email pattern and present it as found"
and "never auto-enroll in a sequence" → **guardrail**, both new.

### design-system
Steps 1–7 → **criterion** (AA with the measured ratio; dark mode complete; token and component lists
must close). Step 8 Review & Deliver → **runner**. Error handling → **criterion** / **guardrail**.

### automation-bridge
Steps 1–2 → **criterion** (preview shows what will actually be sent; no credential in payload or log).
Step 3 HITL Gate → **guardrail** (blocking; `urgent` moves up the queue and never skips it).
Steps 4–5 → **criterion** (timeout reported as timeout — neither success nor definite failure) +
**guardrail** (never retry automatically). The action registry table → **contract**, kept verbatim.

### social-listening
Steps 1–4 → **criterion** (permalink, author, real metrics; dedupe against Tech Radar). Step 5
Synthesis → **criterion** (credible low-engagement signals surfaced separately — an engagement filter
alone drops the earliest signal). Step 6 Route → **runner**. "Read-only" → **guardrail**, new.

### notebooklm-connect
Steps 1–4 → **criterion** (every insight names its grounding document; citations map to real local
paths). Step 5 Audio → **params**. Step 6 Verify → **runner**. The `## Security Notes` block →
**guardrail** (PII needs approval; uploads leave the system permanently).

### design-lint · knowledge-categorize · media-produce
These three used a different frontmatter shape (`agent:` plus a YAML `parameters:` block) and had no
`## Process`. Their prose lists became **criterion**; the `agent:` key became the one-member
`## Team`; YAML parameters became `## Parameters` bullets so the corpus has one vocabulary.

---

## References (5) — not converted, and why

These are procedures for a **person** or for Claude Code in-session. There is no agent to hand them
to, and inventing a team for them would be exactly the kind of false claim this direction deletes.
They carry `kind: reference`, keep their `## Process`, and the execute route refuses them.

| File | Why |
|---|---|
| `self-check` | the pre-commit static gate Claude Code runs before committing |
| `grill-me` | interrogates the requester — needs a dialogue, not a one-shot dispatch |
| `ingest-vps-proposals` | maintainer ritual requiring SSH from the operator's own machine |
| `stack-setup` | installs software on the operator's machine; no agent can do it |
| `firecrawl` | a tool install-and-usage guide |

---

## What the runner does now

One brief per member, dispatched in **parallel**, then synthesis, then verification against the
brief's own criteria layered over the lead agent's handbook rubric.

`seo-audit` is the DoD case: **8 sequential steps → 5 parallel members plus one synthesis.** Fewer
calls, and five of the six run concurrently.

`lib/orchestrator.js`'s `runSequential` lost its last caller here. It is kept in the kernel — a real
pipeline, where stage N needs stage N-1's output, is a shape this platform will want again — but
nothing exercises it today, so treat it as untested when you next reach for it.
