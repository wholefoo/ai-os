---
name: public-cost-endpoints
description: The safety posture required of any anonymous-reachable endpoint that spends money per request. Covers the free audit, the AI helpdesk, and the generated-site chat widget.
---

# Public Cost-Bearing Endpoints

Most of this platform sits behind `requireAdmin` / `requireClientOrAdmin` / `requireCloneAccess`.
A small number of routes are deliberately reachable by **anyone on the internet, with no account**,
and each request makes a **paid** call (agent tokens, DataForSEO). Those two properties together —
anonymous *and* billable — are what this file governs. Generic limits live in
`.claude/context/hardening.md`; this is the extra layer that path earns.

The posture below is not aspirational. It is already implemented three times, and the second and
third instances each say in their own comments that they are copying the first:

| Route | Where | Note |
|---|---|---|
| `POST /api/seo/free-audit` | `server.js` | the origin of the pattern |
| `POST /api/support/contact` | `server.js` | *"Mirrors the free-audit public pattern"* |
| `POST /api/web-studio/sites/:id/chat` | `server.js` | mirrors `/api/support/contact`, **plus** a per-site cap |

Three copies and no written rule is how a fourth gets built without one. That is why this file exists.

## The invariants

1. **Hard caps are computed BEFORE the expensive call.** This is the load-bearing one. A cap checked
   after the agent runs is a log line, not a control. Every instance above counts the last 24h and
   returns 429 before it spends anything.
2. **Two independent hard caps: global/day and per-IP/day.** The global one bounds the blast radius
   of a single bad day; the per-IP one bounds one actor. Neither substitutes for the other. Limits
   are read from env/settings with a default — never hard-code them here, read them at the call site.
3. **Soft deterrents are never the only defence, and are labelled as such.** The free audit's
   one-per-email-per-month check is marked *spoofable* in-line, precisely so nobody later mistakes
   it for the cost control. Email is attacker-supplied; IP and the global counter are not.
4. **Fabricated output is flagged honestly.** When DataForSEO is unconfigured, the free audit sets
   `audit.estimated = true` and the public GET surfaces it. A public funnel that captures a real
   email must never present demo numbers as authoritative.
5. **Public reads disclose a subset, not the record.** The public GET returns scores and summary —
   not the internal audit object.
6. **Anonymous traffic gets its own limiter bucket.** The chat widget deliberately does *not* reuse
   `heavyLimiter`: that bucket is shared with authenticated operator routes, so a visitor behind the
   same corporate NAT or CDN edge could rate-limit an operator out of their own dashboard.
7. **Visitor text is fenced as UNTRUSTED** before it reaches a model (prompt-injection defence), and
   IP is retained only to serve the cap — not as general analytics.

## The assumption underneath all of it: ONE process

Every cap above counts an **in-memory array** — `freeAuditLog`, `contactTickets`, `wsChatLog` — each
loaded once by `loadState` at boot and written back by `saveState`, which serialises the whole array
and atomically replaces the file. That is correct for exactly one process and quietly wrong for two.

Run N workers and each holds its own copy, refreshed only at startup:

- **The caps multiply.** A worker counts its own requests, not the platform's. A 50/day global
  ceiling becomes 50 *per worker*. The check still runs before the expensive call, exactly as
  invariant 1 requires — and is still wrong, which is the point worth internalising: the ordering
  guarantee is real and it is not the whole guarantee.
- **Captured leads and tickets are lost.** `saveState` overwrites; it does not merge. Two workers
  appending to the same file means last-writer-wins, and the loser's rows are gone. The symptom is a
  quiet undercount in the CRM, not an error.

Today this holds because `ecosystem.config.js` pins `instances: 1`. Note what that single line is
doing: it is the enforcement of this invariant, and — because PM2 switches to cluster mode the moment
`instances` is set at all — it is simultaneously the reason production reports `exec mode:
cluster_mode` while running one worker. So the app is already *in* the mode where scaling is a
one-number change, and nothing in the code would complain.

**Before ever raising `instances` above 1, these counters have to move to shared storage** (the CRM
sqlite is already there, or Redis). Until then, treat `instances: 1` as load-bearing configuration
rather than a default nobody chose. `tools/test-public-cost-caps.js` boots a single server and
therefore cannot catch this; it verifies the ordering, not the arithmetic under concurrency.

## Adding a new one

Assume the answer is no. If a feature can live behind auth, put it behind auth.

If it genuinely must be public and billable: implement all seven invariants above, then register the
path in **both** places — they are separate lists and missing either one fails differently:

- `authMiddleware`'s `publicPaths` (and the explicit branches under it) in `server.js` — the
  **runtime** gate. `app.use('/api/', authMiddleware)` 401s every `/api/*` route once `API_TOKEN` is
  set. Miss this and the route works perfectly in dev and 401s every anonymous visitor **in
  production only**. That has already happened once: the free-audit lead magnet 401'd for everyone,
  and the symptom was a silent zero in the CRM, not an error anyone saw.
- `PUBLIC_ROUTES` in `tools/seclint.js` — the **lint** gate. Keep that list tight.

Then add a test asserting the cap **refuses** — assert on the 429 and on nothing being spent, not on
a counter's value. `tools/test-public-cost-caps.js` already does this for the three routes above;
extend it rather than starting a new suite, and copy its constraints, which are not optional:

- Seed state so the FIRST request is already over the cap. A test that spends its way up to the
  ceiling is billing real money to check that it doesn't.
- Boot with `AIOS_STATE_SUBDIR` so you are not seeding the operator's live leads and tickets. Note
  what this does **not** isolate: `crm.sqlite` lives at `.magent/crm.sqlite`, outside `STATE_DIR`, so
  no assertion may let a lead-capturing request complete.
- Run with `DEMO_MODE=false`. Under `DEMO_MODE` the server seeds the cost ledger at boot when it is
  empty, so "the ledger is empty" proves nothing.
- Neutralise credentials with a **non-empty** sentinel. Setting a key to `''` does not disable it —
  dotenv treats empty as absent and refills it from `.env`. That mistake made an earlier draft of
  that suite issue a real billed model call while its comment claimed no key was configured.

## What CI enforces, and what it still cannot

Two gates now exist. Be precise about which claim each one supports.

**You cannot add an anonymous mutating route silently.** seclint's `route-no-auth` reads the whole
middleware chain and requires a real auth guard — a rate limiter does not count — or an explicit
`PUBLIC_ROUTES` entry. So a new public endpoint fails CI until someone consciously allowlists it, and
that edit is the review checkpoint where this file applies. (It was not always so: the rule used to
match only a handler placed directly after the path string, so any middleware satisfied it. Tightening
it found five routes that were public at runtime and missing from the allowlist — including the site
chat widget, which was calling a paid model for anonymous visitors while tripping nothing.)

**The three existing paid routes are pinned.** `tools/test-public-cost-caps.js` boots the real server
and proves each refuses before spending. Because it runs with `API_TOKEN` set — putting
`authMiddleware` on its production branch — it also proves all three are genuinely in the runtime
public allowlist. Removing one from `publicPaths`, or moving a cap check below the paid call, fails CI.

**What neither gate checks: whether a NEW public route has caps at all.** seclint verifies that
someone made a deliberate decision; it does not verify they made a good one. Nothing statically
detects that a handler spends money, so an allowlisted route with no cap passes both gates. That is
the remaining hole, and it is a review hole by design — closing it would mean teaching a linter to
recognise a paid call, which is a maintained list of function names and therefore stale the first
time someone adds a provider.

So: CI stops the silent case. For the deliberate one, the allowlist edit is where a human must apply
the invariants above and extend the cap suite. Treat an untested new entry in `PUBLIC_ROUTES` as an
incomplete change.

One known false-positive shape: auth guards are recognised by name (`require*`, plus `a2aAuth`). A new
guard named unconventionally will be flagged despite being correct. Rename it or extend the rule —
do not reach for a suppression, and do not add it to `PUBLIC_ROUTES`, which would claim the route is
public when it is not.

## Anti-patterns

- Never add a paid call to one of these handlers without checking it against the existing caps —
  the caps bound *requests*, so a handler that grows from one paid call to three triples the cost
  of an unchanged cap.
- Never widen a cap to fix a complaining user. The cap is a spend ceiling, not a UX knob.
- Never merge a public handler's construction logic with its authenticated sibling's just because
  they look alike (e.g. the free-audit and prospect audit records). The duplication is the boundary.
- Never log or broadcast the visitor's email/IP beyond what the cap and CRM capture require.
- Never raise `instances` above 1 while the caps count in-memory arrays — see the single-process
  section above. It is a one-line change that multiplies every spend ceiling and silently drops
  captured leads, and no test or linter in this repo will object.
