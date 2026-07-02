---
name: testing
description: How verification actually works in this repo — static self-check + boot-and-exercise, not a unit-test suite.
---

# Verification Rules

This repo has **no unit-test suite** and is not TDD. Do not claim "tests pass" — there are none to
run. Verification is static self-check plus booting the real server and exercising the change. The
mechanics live in `.claude/rules/engineering-workflow.md`; this file is the standard those must meet.

1. **Static gate first (required before commit)**: `node --check` every changed `.js`, and
   `node tools/seclint.js --ci` must report **0 errors**. This is the real CI gate, alongside the
   PostToolUse seclint hook. No JS change ships without both green.
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
6. **CI gate**: nothing reaches `master`/production without the static gate green. Match the CI in
   `.github/workflows/ci.yml` (seclint + boot check + fallow dead-code/dupes) locally before pushing.
7. **If you genuinely add automated tests**, they may be after-the-fact here (there is no TDD
   requirement), but they must be deterministic, isolated, and wired into CI to count.
