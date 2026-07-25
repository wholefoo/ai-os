# AI Business Clone

A per-client replica of a specific business owner's voice, expertise, and judgement, used to draft
work in their name.

## A clone is not an agent

This is the distinction the whole subsystem is built around. Get it wrong and the design stops
making sense.

**An agent is function-first.** `seo-technical` exists because technical SEO auditing is a job the
software performs. Its personality — Herald, the Communications Director, and the rest — is applied
so the output reads like something a person wrote rather than a machine. Swap the personality out
and the agent still does the same job. The function is the substance; the character is delivery.

**A clone is person-first.** There is no fixed job. What the clone knows, what it refuses to say,
and how it weighs a trade-off *are* the product. The tasks it happens to perform — a support reply
today, a post tomorrow — are interchangeable. The "personality" is not a presentation layer over a
capability; it is the capability.

Three consequences that are already load-bearing in the code:

1. **A clone never gets a file in `.claude/agents/`.** That directory is a catalogue of functions
   the software provides. A clone is a record of a particular person that happens to be executable.
   It is also the registry the platform's agent count is derived from, so writing clones into it
   would corrupt a published number — but that is the smaller reason.

2. **`executeAgent(..., { systemOverride })` exists because of this.** Passing the persona as
   `context` appends it to the named agent's own prompt, which produced "Herald, currently
   impersonating Dana" — the function-first identity kept reasserting itself underneath. A clone
   cannot be a personality layered onto an agent, because that is the wrong way round.

3. **`business-clone` is a routing key, not an agent name.** It appears in `EFFORT_ROUTING` in
   `server.js` purely so the subsystem picks a model tier deliberately instead of inheriting one by
   borrowing an unrelated agent's name.

The distinction should survive into the UI and the docs. You do not *configure* a clone, you
interview one. It does not have *capabilities*, it has expertise and limits. If it ever appears in
the dashboard's Agents section, this whole idea dies on contact with the interface.

## Modules

| File | Role |
|---|---|
| `persona.js` | The five-dimension schema (identity, voice, expertise, decisionStyle, boundaries), normalisation with enforced caps, completeness scoring, and red-line checking against output. |
| `store.js` | Clone records, client-scoped. Every read path filters by `clientId`; there is deliberately no unscoped list. |
| `interview.js` | Builds the persona through conversation. Separate ASK and EXTRACT prompts; additive merge that cannot lose earlier answers. |
| `compile.js` | Persona object → system prompt. Deterministic, so the prompt is diffable and fingerprintable. |
| `drafts.js` | Drafting replies to customer messages, with an inbound screen that runs before any paid call. |

All five are pure: no model calls, no I/O, no clock dependence beyond timestamps. `server.js` owns
`executeAgent`, persistence, and the routes.

## Rules that are not negotiable without a deliberate decision

- **Draft-only.** The clone produces text; a human sends it. Nothing in this subsystem sends
  anything to anyone. Changing that is a product and liability decision, not a refactor.
- **Persona is data, not prose.** It must stay reviewable field by field, diffable for the
  evolution loop, and enforceable in code. A prose blob satisfies none of those.
- **Boundaries are enforced twice.** Compiled into the prompt *and* checked against the output.
  Instructions reduce the odds of a violation; they do not eliminate it.
- **Customer text is untrusted.** It goes through `executeAgent`'s fencing envelope, never into the
  task body.
- **Admin gets no cross-client view.** Reading someone's clone means reading how they think and
  what they refuse to say. That is a conversation to have with a customer, not a default.
- **Evolution proposes, the owner disposes.** The clone never silently rewrites its own persona.

## Verification

`tools/test-business-clone*.js` cover the pure logic and run in CI.

`tools/verify-clone-live.js` covers what unit tests structurally cannot — route registration, the
middleware chain, real HTTP shapes, and the model-backed paths. It needs a running instance and is
excluded from CI by its `verify-` prefix.

```bash
node tools/verify-clone-live.js               # free routes only
node tools/verify-clone-live.js --with-model  # adds real, paid model calls
```
