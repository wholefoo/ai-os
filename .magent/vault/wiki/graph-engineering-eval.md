# Graph engineering — evaluation against what AI OS already has

*Status: **EVALUATION, nothing built.** Written 2026-08-03 against `33d8a0d`, from "Graph
Engineering: Structural Evolution of AI Workflows" (Eisenberg/James material) supplied by the
operator, who asked how to incorporate it as a model for workflows in AI OS **and in this dev
platform**.*

*Read §1 before planning. The document does not describe something AI OS lacks — it names, and gives
a vocabulary for, an architecture this platform already half-built and then left **disconnected in
three places**. The work is composition, not capability.*

---

## §1 The verdict up front

The document's core claim is that work should be modelled as a graph — jobs (nodes), dependencies
(edges), shared state — rather than a sequential chat. Its flagship shape is the **Diamond Pattern**:
planner → parallel workers → skeptic → merger → human gate.

**Every one of those five nodes already exists in AI OS as a first-class concept:**

| Diamond node | What AI OS already has |
|---|---|
| Planner | the `orchestrator` agent; P5 `POST /api/outcomes` takes a stated outcome and names no agent |
| Parallel workers | `lib/orchestrator.js` `fanOutAndSynthesize()` |
| Skeptic | `adversarialVerify()` **plus** `.claude/rules/adversarial-verification.md` |
| Merger | the `synthesis` agent; the merge half of `fanOutAndSynthesize` |
| Human gate | `gateAction()` → `ACTION_RISK` → `ALWAYS_GATE` → the approvals queue |

Two of those are **stronger than the document's version**. Its skeptic is "a dedicated agent that
audits"; the repo's rule specifies isolation from the producer's reasoning, three *distinct* lenses
(correctness / completeness / consequence), a 2-of-3 ship vote, a cross-model Codex seat on
high-risk panels, a 2-round revision cap, and **a missing or errored verdict counts as `block`**.
That is a materially better design and must not be downgraded to match the document.

**So the useful question is not "should we adopt graph engineering". It is: why does a platform that
has every graph primitive still execute its pipelines as a straight line?**

---

## §2 The finding: AI OS declares a graph and executes a list

Three graph representations exist. **None of them is connected to the others.**

### 2.1 The edges are documentation

`.claude/pipelines/*.yaml` declares real dependency edges:

```yaml
  - id: synthesize
    depends_on: [research]
```

**`depends_on` is referenced by no JavaScript anywhere in the repo.** Verified 2026-08-03: zero hits
outside the YAML itself. The runner is a sequential loop over array order —

```js
for (let i = startIdx; i < run.stages.length; i++) {
```

— and it threads **every** prior stage's output forward regardless of what was declared:

```js
const prior = run.stages.slice(0, i).filter((s) => s.output)
```

Two consequences, and the second is the quieter one:

1. **No parallelism, no diamond, no join.** Independent stages wait on each other for nothing.
2. **State is "everything so far", not "what this node declared it needs".** The document is right
   that state should be the graph's currency; here it is an ever-growing context blob. A stage that
   declared `depends_on: [research]` still receives the outline, the draft and everything else.

This is the same defect class the corpus keeps producing: **a declaration that reads as enforcement
and enforces nothing** — the sibling of `social-post` in a tool list, of a `gates:` id that names no
action, and of the design linter that returned a canned array. `depends_on` looks like a DAG in
review and is inert at runtime.

### 2.2 The graph primitives have almost no consumers

`lib/orchestrator.js` implements seven patterns. Consumers outside that file:

| Pattern | Consumers |
|---|---|
| `fanOutAndSynthesize` | 2 real (`lib/intel-brief.js`, one server route) |
| `adversarialVerify` | 1 real (one server route) |
| `tournament` | **0** |
| `loopUntilDone` | **0** |
| `classifyAndAct` | **0** |
| `generateAndFilter` | **0** |
| `runSequential` | **0** |

Five of seven are unreachable from the product, which is why they all sit in `.fallowrc.json`'s
`ignoreExports` allowlist. The kernel is not wrong — it is *unwired*.

### 2.3 The knowledge graph is a visualisation, not a reasoning surface

The document's "ultimate synergy" is agent graph **plus** knowledge graph: the orchestrator knows how
work moves *and* how business facts relate. AI OS has `/api/knowledge-graph`, a `knowledge-graph`
agent, and `.magent/knowledge-graph.json` — but **no agent dispatch reads it**. It feeds a radial
diagram in the dashboard. The synergy the document describes is the one genuinely unbuilt idea here.

---

## §3 What to incorporate, ranked

### G1 — Make `depends_on` executable *(the keystone; everything else is cheaper after it)*

Topologically sort stages, run independent ones concurrently, and pass a stage **only its declared
inputs**. This single change converts every existing pipeline into a real graph and gives the Diamond
Pattern for free: `research-to-report` already declares a shape that would parallelise.

- **Verify:** a pipeline with two independent stages must show overlapping start/end timestamps in
  the run record, and a stage's prompt must NOT contain a non-declared stage's output. Assert on the
  prompt, not on wall-clock — timing alone is a flaky check.
- **Guard:** a `depends_on` naming an unknown stage id, or a cycle, must fail the pipeline at load
  time, not at run time. Same shape as `gates:` → `ACTION_RISK`.
- **Risk, and it is the real one:** parallelism multiplies concurrent spend. A 3-way split at
  Strategic tier is 3 simultaneous Opus calls. This needs a concurrency cap and a budget pre-check
  in the runner, or the first diamond quietly triples a run's cost. `.claude/rules/cost-routing.md`
  already owns the routing matrix; the cap belongs with the runner.

### G2 — Wire the kernel into the runner

Give a stage a `pattern:` so the YAML can reach the primitives that already exist:

```yaml
  - id: gather
    pattern: fan-out          # -> fanOutAndSynthesize
    workers: [researcher, seo-competitor, social-intel]
  - id: audit
    pattern: skeptic          # -> adversarialVerify, per .claude/rules/adversarial-verification.md
    subject: gather
```

Five dead patterns become reachable, and the diamond is expressible declaratively instead of only in
bespoke server routes.

### G3 — Skeptic as a node type, not a bespoke route

`adversarialVerify` is currently reachable from one route. The repo's own rule says high-risk
deliverables get a 3-lens panel — but a pipeline cannot ask for one. Making it a stage type is the
smallest change that puts the platform's best-designed quality mechanism where work actually flows.

### G4 — Run-scoped artifact directory

The document's "file-based paper trail" (`plan.md`, `skeptic.md`, `recommendation.md` under a Run ID)
is stronger than what exists: today a stage's output lives inside the run record. `.magent/runs/<runId>/<stageId>.md`
would make runs diffable, reviewable and reusable — and it is the substrate G5 and the criterion
instrumentation both want.

### G5 — Knowledge graph → agent context *(the one genuinely new idea; do it last)*

Let a dispatched agent query the knowledge graph for entities relevant to its task. This is the
document's synergy claim and the only part with no counterpart in the platform. It is also the least
proven: it changes what agents *know*, so it needs the verification instrumentation to be producing
data first. **Blocked behind the same evidence phase 5 is blocked on.**

---

## §4 The dev platform half

The operator asked about "this dev platform" as well. Different answer: **the graph engine is already
here and is being used at roughly 5% of its range.**

Claude Code's `Workflow` tool *is* graph engineering — `pipeline()` runs items through stages with no
barrier between them, `parallel()` is an explicit join, `phase()` groups nodes, and the documented
patterns (adversarial verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic)
are the document's diamond and then some. Sub-agents are the nodes; the script is the edge set.

Notable convergence: `lib/orchestrator.js`'s seven patterns and the Workflow tool's documented
patterns are near-identical in shape. Whoever wrote the kernel was solving the same problem.

**The constraint is deliberate, not technical.** Workflow is opt-in per session (the "ultracode"
keyword or an explicit ask) because it can spawn dozens of agents and spend accordingly. So for the
dev platform the recommendation is *not* "adopt graph engineering" — it is:

- Reach for `Workflow` on the work that actually justifies fan-out: **corpus-wide audits** (all 68
  handbooks against a new rule), **migrations** (the kind of sweep that produced `14d24ca`), and
  **multi-lens review** before a risky merge. Today those run as one long serial session.
- Keep single-threaded work single-threaded. Most of what was shipped today — a gate, a router split,
  a linter — was correctly serial, and a graph would have added coordination cost for nothing.

---

## §5 What NOT to take from the document

- **Do not build a new graph engine.** Three graph representations already exist (pipeline YAML, the
  orchestrator kernel, the Workflow tool). A fourth would be the duplication-drift failure this
  codebase spent a whole phase removing. G1 and G2 connect what is there.
- **Do not downgrade the skeptic.** The document's version is a single auditing agent; the repo's
  rule is stricter in five specific ways (§1). Adopt the vocabulary, keep the rule.
- **Skip the maturity ladder.** The document's beginner → intermediate → advanced staging (manual
  chat lanes → file repos → orchestration frameworks) describes a journey AI OS finished.
- **Treat "self-improving memory" as already-in-progress, not new.** `criterion-stats.js` is exactly
  the document's compounding-memory idea, and it is blocked on evidence, not on design.

---

## §6 Suggested order

**G1 → G2 → G3 → G4**, then reassess G5 against whatever the verification data says.

G1 is the keystone and is also the honest one: until `depends_on` executes, every pipeline in the
repo is a graph on paper and a queue in practice — and the YAML will keep reading like a DAG to
everyone who opens it.
