// Shared micro-harness for the tools/test-*.js suites: streaming ok/FAIL lines, non-zero exit
// on any failure, no framework. Keep it tiny — these run standalone via `node tools/test-x.js`.
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };
const done = () => console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
module.exports = { assert, done };
