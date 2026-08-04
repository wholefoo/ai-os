# Model fit 2026 — applying the Creator Hacks delta

*Status: **BLUEPRINT, nothing built.** Written 2026-08-03 against `14d24ca`, from
"Claude Code's Creator Hacks" (Boris Cherny material) supplied by the operator, who asked for it to
be applied **both in AI OS and globally** (`~/.claude`).*

*Read §1 before planning anything. Most of this document's source is already shipped — the value is
in the six-item delta in §3, not in redoing P0–P5 under a new name.*

---

## §1 The honest delta — most of this is done

The source document describes, in its own vocabulary, the architecture P0–P5 already built. Mapping
it against `agent-handbooks-design.md` before proposing work:

| Source document asks for | Status here |
|---|---|
| AI employee handbook, 5 components | **SHIPPED** — the five keys, all 68 agents, validated by `tools/test-handbooks.js` |
| Exact outcome, not procedure | **SHIPPED** — P3 retired the step-runner; skills are outcome briefs |
| Success criteria / "what good looks like" | **SHIPPED** — P1 criteria + `DONE WHEN`; P2 re-keyed verification to each agent's own |
| Guardrails / never-without-asking | **SHIPPED and enforced in code** — `gates:` → `ACTION_RISK` → `ALWAYS_GATE`, incl. `21e7b83` |
| Tools + shared business memory | **SHIPPED** — `tools:` (one vocabulary as of `14d24ca`) and `memory:` + the catalog |
| Five archetypes | **SHIPPED** — `archetype:`; P4 routes model effort on it |
| Sixth archetype (orchestrator / COO) | **SHIPPED** — the `orchestrator` agent; P5 `POST /api/outcomes` takes a stated outcome and names no agent |
| Verification loop / "build the checker first" | **SHIPPED** — `startVerification`, stakes (probe/standard/critical), criterion instrumentation |
| Cross-functional departments | **PARTIAL, deliberately** — `department:` is a taxonomy and is **not routable** (settled decision; a lead is not derivable). Outcomes route to the orchestrator. |
| One-sentence prompts on a timer | **PARTIAL** — `routine-runner`, the intel brief, scheduled tasks exist; the *Anthropic-style maintenance verbs* ("clean up dead code", "unify duplicated abstractions") are not wired |
| Claude Tag / Slack multiplayer orchestrator | **NOT BUILT** — out of scope below; noted in §7 |

**So the delta is not the architecture. It is six adjustments to how context is delivered to a model
that no longer needs to be told as much** — plus one method (§4) for deciding what to delete.

---

## §2 Measurements this plan is based on

Taken 2026-08-03, so a future reader can tell whether they still hold:

| Surface | Size |
|---|---|
| `.claude/claude.md` (AI OS project brain) | **250 lines, 34 `##` sections**, loaded every session |
| root `CLAUDE.md` (working discipline + invariants) | 43 lines |
| `.claude/rules/` | 327 lines across 7 files |
| `.claude/skills/` | 24 files, 1,517 lines |
| `.claude/agents/` | 68 files, 4,082 lines |
| `~/.claude/CLAUDE.md` | **does not exist** |
| `~/.claude` memory | 38 files, 1,225 lines, behind a **38-line index** |
| `~/.claude/commands/` | 3 (`autoresearch`, `handoff`, `review`) |

Two things fall straight out of this table:

- **AI OS's `.claude/claude.md` is the problem case.** It opens with a "Session Start (read these
  first)" router — good — and then inlines 34 feature sections anyway. Every session pays for the
  Media Production Pipeline and the 3D Production Studio whether or not it touches them.
- **The global setup is already close to right.** 1,225 lines of memory sit behind a 38-line index
  that loads per session. That IS progressive disclosure, built before the source document asked for
  it. The global work in §6 is therefore small.

---

## §3 The six new asks

### 3.1 Progressive disclosure — make `claude.md` a router *(highest value, lowest risk)*

**Ask:** don't stuff the primary file with everything; make it a router into departmental folders so
context loads only when needed.

**Here:** split `.claude/claude.md` into a ~40-line router plus `.claude/context/<area>.md` leaves.
The router keeps: mission, architecture in five lines, the non-negotiables, the file layout, and a
**table of which leaf to read for which kind of work**. The 25-ish feature sections become leaves.

**Verify:** the check is not "it looks shorter". It is `/context` (or a token count of a cold
session) **before and after**, plus a task from each of three areas run cold to confirm the router
actually routes. Target: router ≤ 50 lines, no leaf > 60.

**Risk:** a leaf nobody routes to is worse than an inline section — it rots unread. Mitigate by
making the router table exhaustive and asserting in a test that every file in `.claude/context/` is
named by it (same shape as the `gates:` → `ACTION_RISK` check: a pointer that names nothing is the
defect class this repo keeps finding).

> **SHIPPED 2026-08-03. Router 71 lines + 6 leaves (223), from 250 inline; `tools/test-context-router.js`.**
>
> **The ≤ 50 target above was wrong and the budget shipped at 80.** That number was estimated before
> the content was laid out. The honest floor is session-start maps + mission + architecture + the 10
> non-negotiables + an 18-line file layout + the routing table, which lands near 70 — so hitting 50
> would have meant deleting something load-bearing to satisfy a number I had guessed. Budget set at
> 80: enough headroom for a route row or two, still loud when the router regrows into a manual.
> **Recorded rather than quietly adjusted**, because a target silently moved to match the result is
> not a target.
>
> The suite guards three failure modes and each was proven to go red before being trusted: the
> router regrowing past budget, a leaf nobody routes to (checked in both directions), and — the
> expensive one — **content vanishing in the move**, asserted on 16 load-bearing VALUES rather than
> a line count, since a relocation loss is invisible in a diff of 250 deletions against 210
> insertions across seven files.

### 3.2 Let the model use judgment — trim rigid rules *(highest value, highest risk)*

**Ask:** newer models are held back by over-specific constraints; trim strict prompts.

**Here this is already an open question with a name.** `agent-handbooks-design.md` §9 item 14 records
the unresolved tension: after conversion, **six of `scout`'s eight Gotchas restate a criterion** —
same content, negative mood, both paid for on every call. It was deliberately NOT resolved on
aesthetics, pending data.

**The data mechanism already exists and is nearly ready.** `criterion-stats.js` +
`GET /api/verify/criteria` name deletion candidates once 8 verification runs accumulate (currently
`runs: 2` locally; the VPS tally started at 0 on 2026-08-03). This ask is therefore not "start
trimming" — it is **finish the measurement that was built for exactly this decision, then trim what
never fires.**

**Two caveats that must survive into execution:**
- Every criterion graded so far has been on `researcher` alone. A deletion call off single-agent data
  generalises from one role. Get breadth before cutting.
- `tools/test-handbooks.js` asserts `architect`'s Gotchas survived conversion, because **the whole
  risk of this migration is scar tissue being discarded as "procedure."** The CRLF gotcha, the
  backtick gotcha, the pm2-as-root gotcha each cost real hours and read like noise to anyone who
  hasn't been bitten. Trim restated criteria; keep incident-derived Gotchas unless the data says the
  criterion covers them.

**Verify:** trim in one batch, then re-run the verification corpus and compare verdict distribution
before/after. If quality is unchanged and tokens drop, keep; if verdicts degrade, revert the batch.
That is the source document's own empiricism applied to our own prompts.

### 3.3 Simplify tool descriptions — stop duplicating instructions

**Ask:** older models needed rules repeated in both the system prompt and each tool description;
newer ones don't.

**Here:** the duplication is between `.claude/rules/` (327 lines) and agent bodies —
**14 of 68 agents restate cost-routing material and 13 restate security material.** The rules files
are the canonical statement; the agent copies are the drift risk (and are paid for on every call
that agent makes).

**Proposed:** rules stay canonical and get referenced, not copied. An agent body may state a
*standard* that happens to touch security; it should not restate the rule. Concretely: audit those
27 restatements, delete the ones that add nothing, and keep the ones carrying an agent-specific
consequence.

**Verify:** body-line delta per agent, plus the existing budget gate (`MAX_BODY_LINES`), plus a spot
re-run of those agents to confirm behaviour is unchanged.

> **SHIPPED 2026-08-03 — and the premise above was WRONG, which changed the whole phase.**
>
> **"27 restatements" was a keyword proxy, not a measurement.** It came from grepping the *stem* of
> each rule filename (`cost-routing` → `cost`, `security` → `securit`) across agent files, which
> counts coincidence. Auditing the actual canonical claims found close to zero: Economy-tier ban 0,
> skeptic-panel 0, `seclint` 0, `node --check` 0, `DEMO_MODE` 0, tool-call cap 1, budget threshold 1.
> P1's handbook conversion had already removed this duplication — "the orchestrator compressed
> 98 → 73 lines while GAINING 9 criteria" was exactly that. **There was nothing to delete from agent
> bodies, and deleting the 20 `.magent/artifacts/` mentions would have been wrong: that is each
> agent's own output boundary, not a restatement of a rule.**
>
> **The real duplication was INSIDE `.claude/rules/`, and both instances had drifted into FALSEHOOD:**
>
> - **"This repo has no unit-test suite"** — asserted in `testing.md`, `engineering-workflow.md` AND
>   `.claude/skills/self-check.md`, with 55 suite files gating CI as "Regression suites". Not merely
>   stale: `testing.md` went on to instruct agents *"Do not claim 'tests pass' — there are none to
>   run."* The corpus was telling agents not to run the thing that would have caught the corpus.
> - **`cost-routing.md`'s model/price table** — "a single model, `claude-opus-4-8`, flat $5/$25",
>   while `runtime.md` and `engineering-workflow.md` both correctly described `balanced` mode routing
>   professional and scout work to **Sonnet 5** at different rates. Three copies, and the stale one
>   was the file an agent reads *when deciding where to send work*.
>
> **Both fixed by deleting the copy and pointing at one canonical home — not by syncing.** Syncing
> three copies is how it broke. `cost-routing.md` keeps what it uniquely owns (the routing decision
> matrix) and now links to `runtime.md` for model and price.
>
> `tools/test-rules-canon.js` pins the properties that allowed the drift, each proven red first: a
> guidance file denying the suite exists, a price table returning to `cost-routing.md`, and — the
> category case — **any** guidance file smuggling in a per-million rate. That last assertion was
> itself first written as an enumerated list (`consultant-anthropic.md` + `runtime.md`) and failed
> against the other six provider consultants, which own their own providers' pricing legitimately.
> An enumerated guard losing to the members nobody listed, caught this time by running it red before
> trusting it.
>
> **Left alone, deliberately:** `karpathy-guidelines.md` §1–4 compress to the router's
> non-negotiables #7–10. That is a summary-to-detail relationship — progressive disclosure working
> as intended — not the drift-prone kind, because neither states a fact that can go stale.

### 3.4 Design interfaces rather than examples

**Ask:** give a brand book / design interface (HTML with palettes, fonts, voice) rather than specific
examples that constrain the exploration space.

**Here there is a live broken reference to fix first.** The `design-system` agent's handbook says it
manages **`DESIGN.md` tokens** — and **there is no `DESIGN.md` anywhere in the repo** (verified
2026-08-03). That is the same defect class as `social-post`: an agent pointing at something that does
not exist. Building the design interface *is* the fix.

**Proposed:** author `DESIGN.md`'s successor as a **self-contained HTML brand book** — palette,
type scale, spacing grid, voice, component states — which doubles as 3.6's richer reference. Point
`design-system`, `vibe-designer`, `web-builder` and `content-writer` at it.

**Verify:** the WCAG design-lint gate `web-builder` already runs is the checker; a generated site
should pass it against tokens read from the brand book rather than from prose.

### 3.5 Rely on automatic memory

**Ask:** stop forcing explicit memory hotkeys; the system saves what's relevant.

**Here: already true and working.** 38 memory files, actively maintained, with an index that loads
per session. **No work proposed.** The one adjustment worth making is a hygiene pass — several
memories now carry resolved items (the `/handoff` trial, the branch question) and were updated in
place today, which is the right pattern. Left as standing practice, not a project.

### 3.6 Richer references over plain markdown

**Ask:** move from markdown specs toward richer references (HTML artifacts) that a human can actually
look at, since the model parses them equally well.

**Here:** the natural first targets are the artefacts a *human* reviews, not the ones a model reads:
the brand book (3.4), the criterion-overlap report (currently JSON behind an admin endpoint), and the
verification verdict summary. Pipeline runs already auto-export `.docx`, so the appetite is proven.

**Not a target:** `agent-handbooks-design.md` and this file. They are read by models mid-task and
diffed in review; markdown in git is the right format and HTML would be a downgrade.

---

## §4 The method: ablate before you delete

The source document supplies a testing method as well as a target state, and it is the part most
likely to be skipped: **`CLAUDE_CODE_SIMPLE=1`**, an ablation switch that strips built-in system
prompts so the raw model can be measured. Anthropic reportedly uses it to decide whether a prompt
earns its place.

**VERIFIED 2026-08-03, and it is not what the source document implies.** `CLAUDE_CODE_SIMPLE=1` is
real, but the documented interface is the **`claude --bare`** flag, and its scope is far wider than
"strips system prompts". Straight from `claude --help`:

> Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches,
> keychain reads, and **CLAUDE.md auto-discovery**. Sets `CLAUDE_CODE_SIMPLE=1`. Anthropic auth is
> strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are never
> read). Skills still resolve via `/skill-name`.

**Three consequences, and the second one matters most:**

1. It is an **all-or-nothing harness ablation**, not a prompt ablation. A difference observed under
   `--bare` cannot be attributed to any particular file — hooks, LSP and auto-memory went too.
2. **It disables CLAUDE.md auto-discovery entirely**, so it *cannot* answer "does this section earn
   its place". It removes every section at once, plus memory. Using it to justify a targeted
   deletion would be measuring one thing and concluding another.
3. It needs `ANTHROPIC_API_KEY` in the environment — OAuth and keychain are not read. Neither
   `~/.claude/settings.json` nor `ai-os/.claude/settings.json` carries a key today, so a `--bare`
   run needs one supplied deliberately.

**So `--bare` answers "is the harness helping at all?" and nothing finer.** For §3.2 and §3.3, which
are per-section decisions, the method is the manual A/B in the numbered list below — remove one
candidate, re-measure the same thing, keep the deletion only if quality held. That was always the
fallback; it is now the primary.

**Why it matters here:** §3.2 and §3.3 both propose deleting text that *looks* useful. The honest
order of operations for every deletion in this blueprint is:

1. Measure the current behaviour (verdict distribution, token count, or a concrete task outcome).
2. Remove the candidate text.
3. Re-measure the *same* thing.
4. Keep the deletion only if quality held.

That is this repo's existing discipline — prove the guard goes red, assert on values not counts —
pointed at prose instead of code.

---

## §5 The carve-out — what must NOT be trimmed

The source document's core argument is "modern models outgrow instructions, so delete them." **That
argument does not reach enforced boundaries, and applying it there would reverse a decision this
codebase has re-learned repeatedly.**

Settled and not up for relitigation:
- **"Prose guardrails are suggestions to a model."** `gates:` must name a real `ACTION_RISK` id.
- **`memory:` and `tools:` are declarations, not grants** — enforcement lives in code, at use time.
- **`21e7b83`** exists precisely because three agents' destructive-op boundary was *only* prose.
- Root `CLAUDE.md` states it outright: never propose weakening `.claude/agents/*.md` safety language,
  `lib/self-improve/*`, or `lib/safety/approval.js`.

**The distinction to hold:** the doc is right that *procedural scaffolding* is dead weight — steps,
restated criteria, duplicated rules. It says nothing about *code-enforced limits*, which are not
instructions to a model at all. A boundary a model can talk itself past was never a boundary; that is
the opposite failure to the one this document is warning about, and this repo has hit it more often.

Anything in §3 that touches a safety surface stops and asks.

---

## §6 Phased plan

Each phase is independently shippable and independently revertible. Phases 1–3 are AI OS; phase 4 is
global; phase 5 depends on data that does not exist yet.

| # | Phase | Scope | Blocked by |
|---|---|---|---|
| 1 | **Router split** (§3.1) | `.claude/claude.md` → router + `.claude/context/` leaves; test asserting every leaf is routed to | — |
| 2 | **De-duplicate rules** (§3.3) | audit the 27 agent restatements of `rules/` material; delete what adds nothing | — |
| 3 | **Brand book** (§3.4 + §3.6) | author the HTML design interface; fix the dangling `DESIGN.md` reference in `design-system` | — |
| 4 | **Global** (§6.1) | see below | — |
| 5 | **Evidence-based trim** (§3.2) | delete criteria/Gotchas the data shows never fire | **8+ verification runs across more than one agent** |

Recommended order: **1 → 4 → 2 → 3 → 5.** Phase 1 is the biggest measurable win and touches no agent
semantics; phase 4 is small and makes every future session cheaper; 2 and 3 are corpus work; 5 must
wait for evidence and is the one that can silently destroy scar tissue.

### 6.1 The global half (`~/.claude`)

Smaller than expected, because the memory system already implements progressive disclosure.

- **Add a `~/.claude/CLAUDE.md` router — but keep it genuinely small (≤ 30 lines).** There is none
  today; the operator's cross-project working discipline currently lives in AI OS's root `CLAUDE.md`
  (43 lines) and therefore **does not load in sessions started from `~/.claude`** — which is how this
  session started, and is a known recurring trap. The router should carry only what is true across
  every project (verification posture, irreversible-action posture, commit≠push) and point at
  per-project files for the rest.

  > **SHIPPED 2026-08-03 — `~/.claude/CLAUDE.md`, 26 lines.** Postures only: verification-by-breaking,
  > the adversarial self-review pass, and the three standing postures. Two deliberate exclusions,
  > both checked rather than assumed:
  >
  > - **Nothing that restates a memory.** Five of the 38 memories are cross-project discipline
  >   (`assert-on-values-not-counts`, `boundary-guard-enumeration`, `live-system-facts-have-an-age`,
  >   `ui-existence-is-not-usability`, `engineering-workflow-mechanics`). Verified zero keyword
  >   overlap. **The division to keep: this file is postures, memory is what went wrong and when.**
  > - **Nothing AI-OS-specific.** The codebase invariants stay in the repo.
  >
  > **Accepted duplication, with a reason:** ai-os's root `CLAUDE.md` keeps its own discipline copy
  > even though the global now covers it. `wholefoo/ai-os` is a PUBLIC repo — stripping the
  > discipline would leave an external contributor without it, since they do not have this machine's
  > `~/.claude`. ~24 lines loaded twice in ai-os sessions is the right trade against a degraded
  > public repo. Also noted: `~/.claude/fable-handover.md` and `ai-os/docs/fable-handover.md` are
  > **byte-identical** (117 lines) — same trade, already being made.
  >
  > **NOT YET VERIFIED:** that a newly created `~/.claude/CLAUDE.md` actually loads. It is read at
  > session start, so this session cannot see its own. **The check is the next session's context —
  > confirm it appears before relying on it.** Unlike the AI OS router, this file has no test
  > guarding it: `~/.claude` is not a git repo and has no suite.
- **Do not migrate memories into it.** The index-plus-files pattern is already the recommended
  architecture; folding 1,225 lines into a always-loaded file would be a straight regression.
- **Port the maintenance-verb loops** (§1's last gap): `/loop` and the scheduling skills exist, so
  the one-sentence cron prompts ("clean up dead code", "unify duplicated abstractions") are a
  configuration task, not a build. Start with one, on a real repo, and read the first three runs
  before adding a second.
- **Confirm the ablation switch** (§4) once, globally, since it is a harness feature rather than a
  project one.

---

## §7 Out of scope, and why

- **Claude Tag / Slack multiplayer orchestrator.** The source document's most ambitious item — an
  orchestrator living in 10–15 Slack channels as a proactive bot. AI OS has the orchestrator and has
  connector infrastructure, but this is a product decision with a real surface area (a bot posting
  into shared human channels is outward-facing by definition, and everything outward-facing here is
  gated). Not a context-optimization task; should be decided on its own merits.
- **Deleting `claude.md` outright** ("delete, don't trim"). Rejected as stated. The file contains
  code-enforced invariants and incident-derived conventions, not scaffolding. §3.1 relocates it;
  §3.2 trims it on evidence. Wholesale deletion would discard exactly the material §5 protects.
- **Routing on `department:`.** The source document assumes departments are the routing unit. Settled
  here that they are not: `escalates_to` covers 27 of 68 and 5 of 11 departments yield no lead.
  Revisiting this is a corpus decision, not a context one.
