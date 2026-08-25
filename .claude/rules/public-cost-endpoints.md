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
a counter's value.

## Known gap in the gate — do not rely on seclint here

seclint R1 (`route-no-auth`) fires only when the handler follows the path string *directly*. **Any**
middleware satisfies it, and a rate limiter is not auth. Verified: `app.post('/api/x', heavyLimiter,
async (req, res) =>` passes R1 and needs no `PUBLIC_ROUTES` entry. `/api/web-studio/sites/:id/chat`
is live today under exactly that shape and is not in the allowlist.

So a new anonymous, cost-bearing route can ship tripping **no gate at all**. Until R1 distinguishes
auth middleware from a limiter, this file is the control — which means review, not CI, is what
catches it.

## Anti-patterns

- Never add a paid call to one of these handlers without checking it against the existing caps —
  the caps bound *requests*, so a handler that grows from one paid call to three triples the cost
  of an unchanged cap.
- Never widen a cap to fix a complaining user. The cap is a spend ceiling, not a UX knob.
- Never merge a public handler's construction logic with its authenticated sibling's just because
  they look alike (e.g. the free-audit and prospect audit records). The duplication is the boundary.
- Never log or broadcast the visitor's email/IP beyond what the cap and CRM capture require.
