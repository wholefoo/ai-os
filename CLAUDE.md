# Working discipline

Distilled working-discipline guidance for agent sessions in this repo. Full essay: `docs/fable-handover.md`.

## Verification: check by breaking, not by re-reading
- Re-derive, don't re-read. Verify from a different direction than you produced: run the code, trace a concrete input by hand, compute the result backward. A check that couldn't possibly fail is not a check.
- Chase the concrete instance. Never assert "handles the edge cases" — name the input and the line that handles it. If you can't produce the demonstrating instance (or the violating one), you're pattern-matching, not verifying.
- Spend verification budget at boundaries: empty inputs, first/last iterations, zero/negative/huge values, seams between components, moments state changes hands. The happy-path middle almost always works.
- Distrust fluency. Reasoning that flows without friction, round numbers, code that compiles on the first mental pass — these deserve more scrutiny, not less.
- When evidence contradicts expectation, the evidence is usually right. Treat the surprise as the most informative thing seen all day and rebuild the model around it; don't explain it away.
- Keep known / inferred / assumed in separate buckets and say which is which. Never present plausibility with the confidence of a completed check.

## Self-review: adversarial pass before handing anything over
- Reread the original request after finishing, and check the output against it clause by clause. Watch for the quietly dropped constraint ("without changing the API", "in the existing style") that fell out mid-task.
- Find the claim you're hoping nobody presses on — that hope is a signal. Shore it up or flag it explicitly; never ship it silently.
- "Would I bet on this?" Claims you merely wrote down either get verified or get a confidence label before delivery.
- Name what you did NOT do — didn't test, didn't check, couldn't reach. Two sentences that turn hidden traps into the reader's checklist.
- Last-paragraph check: if the response ends with a promise ("next, I'll…") or a question you could answer yourself, you stopped early — go do that work and end on a delivered thing.

## Postures
- Look before you conclude: inspect the actual file/error/data before theorizing about what's probably there.
- Irreversible beats urgent: before deleting, overwriting, or publishing, read the thing you're about to destroy — confidence bar goes up an order of magnitude.
- Question vs. work order: "why is X slow?" wants diagnosis (uninvited fixes are scope violations); "make X fast" wants the fix (stopping at diagnosis is underdelivery).

# Codebase invariants & conventions

Enforced patterns learned from shipped incidents/reviews. Violating one is a defect even if tests pass.

## Security invariants
- **Client isolation is read-side**: every site/audit read routes through `wsOwns`/`wsFindSite` (404 cross-tenant, never 403). `saveState` writes whole shared arrays — there is no write-side fence.
- **`CLIENT_API_ALLOW` is deny-by-default**: add a prefix ONLY after that surface is owner-scoped. `/api/reports`, knowledge-graph, predictions, plugins stay operator-only.
- **WebSocket pushes are role-scoped**: `broadcast()` filters non-admin sockets through `wsClientCanReceive` (owner-matched allowlist). A new broadcast event reaches clients ONLY if you add it there — default is admin-only, keep it that way for anything with cross-tenant data (leads, CRM, other sites).
- **Public endpoints** (`publicPaths` allowlist in the auth gate) need: a dedicated rate limiter, input length caps, and — for form targets — a honeypot that fake-succeeds. Redirects never trust Referer beyond the site's own domain or the platform host.
- **Untrusted external text** (scraped sites, imported content, model answers) goes through `executeAgent`'s `untrusted` fencing, never string-concatenated into prompts.
- Never propose weakening `.claude/agents/*.md` safety language, `lib/self-improve/*`, or `lib/safety/approval.js` gates.

## Conventions
- **Ship loop**: see `.claude/commands/ship.md` (`/ship`). Tests: `tools/test-<feature>.js` using `require('./test-util')`; register in `.fallowrc.json` `entry`; `tools/test-all.js` runs everything (CI-gated).
- **Web Studio emitters are deterministic + zero-token** (JSON-LD, llms.txt, OKF, sitemap, funnel wiring, dynamic pages): built from the plan object, never left to the model. Link wiring that matters (affiliate/checkout) is applied post-plan (`applyAffiliateLink`/`applyFunnel`) and re-applied on render.
- **Dashboard**: per-view scoped `<style>` inside the view div; loaders map in app.js `switchView`; SSE via `handleWsMessage` dispatch; bump the script's `?v=` cache-bust on EVERY dashboard js change; client role sees only `CLIENT_VIEWS`.
- **State**: bounded JSON via `loadState`/`saveState` (atomic); unbounded rows go to node:sqlite (`lib/crm/db.js` pattern — WAL, migrations array, `.magent/*.sqlite` gitignored incl. -wal/-shm).
- **Canonical product facts** (agent counts, pricing) live in the auto-research loop + product canon — fix numbers THERE first or the self-optimizing loop reverts your copy (see `auto-research/instructions.md`, `score.js`, `seed/`).
- **Deploy configs** in `deploy/` are the canonical source for everything hand-managed on the VPS (nginx templates, log format, n8n PM2 config). Ops procedures + incident patterns: `docs/RUNBOOK-vps.md`.
