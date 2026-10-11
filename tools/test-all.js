// Run every tools/test-*.js suite; exit non-zero if any fails. Wired into CI and `npm test`
// so the regression suites (analytics, okf, leads, sections, funnel-dynamic, ...) actually
// gate merges — new suites are picked up automatically by the filename convention.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-util.js' && f !== 'test-all.js').sort();
// Collect the NAMES of failing suites, not just a count. The count alone cost hours on a box where
// one suite failed only in the runner's clean-clone context (not locally, not in CI) — with no way to
// tell which. Printing the names makes a failure diagnosable from the single log line it leaves.
//
// A per-suite TIMEOUT, because a suite that never finishes must fail rather than stall the run. There
// are two ways a suite can hang:
//   - its awaited promise never settles and nothing else is alive: Node exits 0 mid-suite. Suites
//     catch that themselves via test-util's requireFinish().
//   - something keeps the event loop alive (an open server, socket or timer): the process never
//     exits. Without this timeout CI waits out its job limit (hours) and never names the suite.
// The slowest suites take about a minute, so 10 minutes is
// generous. TEST_SUITE_TIMEOUT_MS overrides it.
const SUITE_TIMEOUT_MS = Number(process.env.TEST_SUITE_TIMEOUT_MS) || 10 * 60 * 1000;
const failedSuites = [];
for (const f of suites) {
  process.stdout.write(`\n=== ${f} ===\n`);
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (e) {
    const timedOut = e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL');
    if (timedOut) console.error(`FAIL: ${f} did not finish within ${Math.round(SUITE_TIMEOUT_MS / 1000)}s — killed (something kept it alive)`);
    failedSuites.push(timedOut ? `${f} (timed out)` : f);
  }
}
console.log(`\n${suites.length - failedSuites.length}/${suites.length} suites passed`);
if (failedSuites.length) {
  console.error(`FAILED SUITES: ${failedSuites.join(', ')}`);
  process.exit(1);
}
