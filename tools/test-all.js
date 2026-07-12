// Run every tools/test-*.js suite; exit non-zero if any fails. Wired into CI and `npm test`
// so the regression suites (analytics, okf, leads, sections, funnel-dynamic, ...) actually
// gate merges — new suites are picked up automatically by the filename convention.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-util.js' && f !== 'test-all.js').sort();
let failed = 0;
for (const f of suites) {
  process.stdout.write(`\n=== ${f} ===\n`);
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
if (failed) process.exit(1);
