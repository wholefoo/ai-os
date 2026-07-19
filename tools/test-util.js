// Shared micro-harness for the tools/test-*.js suites: streaming ok/FAIL lines, non-zero exit
// on any failure, no framework. Keep it tiny — these run standalone via `node tools/test-x.js`.
const fs = require('fs');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };
const done = () => console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
// For suites that mkdtempSync a scratch dir: remove it, then report. Shared because three suites
// ended with the identical two-line rmSync+done() pattern.
const cleanupAndFinish = (dir) => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); done(); };
module.exports = { assert, done, cleanupAndFinish };
