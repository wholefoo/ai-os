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
const failedSuites = [];
for (const f of suites) {
  process.stdout.write(`\n=== ${f} ===\n`);
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  } catch {
    failedSuites.push(f);
  }
}
console.log(`\n${suites.length - failedSuites.length}/${suites.length} suites passed`);
if (failedSuites.length) {
  console.error(`FAILED SUITES: ${failedSuites.join(', ')}`);
  process.exit(1);
}
