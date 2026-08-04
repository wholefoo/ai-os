---
name: testing
description: How verification actually works in this repo — the regression suites, the static gate, and boot-and-exercise.
---

# Verification Rules

This repo **has a regression suite**: `tools/test-*.js`, all of them run by `node tools/test-all.js`,
which is a CI step ("Regression suites") and the real `npm test`. Claim "tests pass" only after
running it, and quote the count. Verification is that suite **plus** the static gate **plus**, where
a change is observable through the running server, booting it and exercising the change. The
mechanics live in `.claude/rules/engineering-workflow.md`; this file is the standard those must meet.

> This file and `engineering-workflow.md` both asserted "this repo has **no unit-test suite**" until
> 2026-08-03, by which point there were 55 suite files gating CI. Two copies of one claim drifted
> together, and the claim actively told agents not to run the thing that would have caught them.
> Facts about the repo belong in ONE file; the others link.

1. **Suites and static gate (required before commit)**: `node tools/test-all.js` — every suite must
   pass. Then `node --check` every changed `.js`, and `node tools/seclint.js --ci` must report
   **0 errors**, alongside the PostToolUse seclint hook. No JS change ships without all three green.
2. **Prove behavior, don't assert it**: if a change is observable via the running server, boot it
   (`DEMO_MODE=true PORT=<free> node server.js`) and curl the actual routes to confirm the new
   behavior AND that you didn't break the happy path (a 200 on a normal call). Report the real
   status codes / output — never "should work."
3. **Isolation & determinism**: verification must not depend on live third-party APIs. Use
   `DEMO_MODE=true`; drive deterministic inputs. `Date.now()`/`Math.random()` make a check
   non-reproducible — avoid relying on them in a verification.
4. **Adversarial where it matters**: for security/correctness fixes, test the *failure* path
   explicitly (e.g. traversal → 401/400 with no file written; non-numeric input → 400), not just
   the success path. See `.claude/rules/adversarial-verification.md`.
5. **Fast & self-contained**: a verification run should complete in seconds and clean up after
   itself (stop the test server — kill by port via the PowerShell tool, `pkill` does not work here).
6. **CI gate**: nothing reaches `master`/production without CI green. Match it locally before
   pushing — `.github/workflows/ci.yml` runs the regression suites, seclint, the boot check, and
   fallow dead-code/dupes.
7. **A new feature with a testable seam gets a suite**: `tools/test-<feature>.js` using
   `require('./test-util')` for `assert`/`done`, registered in `.fallowrc.json` `entry`. Tests may be
   after-the-fact (no TDD requirement here), but they must be deterministic and isolated.
8. **Prove a new guard goes RED before trusting it.** Break the thing it protects, watch it fail by
   name, restore. A guard only ever run against valid input is an untested guard — and assert on a
   VALUE, not only a count: a parser once truncated every criterion at its first line while every
   gate stayed green.
