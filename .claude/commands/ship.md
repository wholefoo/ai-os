# /ship — verify, commit, push, confirm CI

Run the full pre-ship loop for this repo. Do the steps in order; stop and report on the first failure instead of pushing anything red.

1. **Syntax**: `node --check` every touched .js file (always include `server.js` if it changed).
2. **Suites**: `node tools/test-all.js` — every `tools/test-*.js` must pass. If you added a feature with a testable seam and no suite covers it, write `tools/test-<feature>.js` first (use `require('./test-util')` for assert/done; register the file in `.fallowrc.json` `entry`).
3. **Gates**: `npx fallow dead-code && npx fallow dupes && node tools/seclint.js --ci` — all must be clean. New intentional module-internal exports go in `.fallowrc.json` `ignoreExports`; never suppress a seclint ERROR.
4. **Boot smoke**: `PORT=34xx timeout 18 node server.js` → grep "running at". If the change is previewable, actually exercise the affected flow.
5. **Dashboard changes**: bump the touched script's `?v=` cache-bust in `dashboard/app.html`.
5b. **Public surface changed?** If the feature is user-visible (a new capability, tool, or tier change), update `README.md`, the landing `featureList` JSON-LD in `dashboard/index.html`, AND the manifest in `tools/check-copy-drift.js` in the SAME commit — the drift check gates CI. Keep canonical numbers (57 agents / 10 depts / 6 models / 4 tiers / pricing) untouched unless the auto-research facts are updated first.
6. **Commit**: one commit per coherent feature. Message: `type(scope): imperative summary` + a body explaining WHY and any verification evidence (what was tested live vs. only unit-tested). End with the Co-Authored-By line for the current model.
7. **Push + CI**: `git push origin master`, then `sleep 25 && gh run list --branch master --limit 1` — confirm `completed success` for the "Lint & Boot Check" required status. Never leave a push unconfirmed.
8. **Two repos**: if `commercial/` changed, it is a SEPARATE repo — commit and push it separately (no CI gate there).
9. **Report**: state the commit hash, what was verified live vs. deferred, and any VPS rollout steps the operator still needs (`git pull` as aios + `sudo -iu aios pm2 restart ai-os`; nginx edits need `nginx -t && systemctl reload nginx`).
