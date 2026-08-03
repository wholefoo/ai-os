// Shared micro-harness for the tools/test-*.js suites: streaming ok/FAIL lines, non-zero exit
// on any failure, no framework. Keep it tiny — these run standalone via `node tools/test-x.js`.
const fs = require('fs');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };
const done = () => console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
// For suites that mkdtempSync a scratch dir: remove it, then report. Shared because three suites
// ended with the identical two-line rmSync+done() pattern.
const cleanupAndFinish = (dir) => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); done(); };

// server.js as text, for the suites that assert a route is actually wired the way its module expects.
//
// CRLF is normalised HERE, once, because several of those assertions match a MULTI-LINE literal. This
// repo checks out with CRLF on Windows, so a pattern like `'executeAgent(\n    skill.agent,'` stops
// matching the moment git rewrites the file — which any branch checkout does. That failure reads
// exactly like a code regression and is not one. Same discipline as lib/handbooks/schema.js split():
// normalise at the boundary where the text is read, so nothing downstream has to think about it.
const serverSource = () =>
  fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n?/g, '\n');

module.exports = { assert, done, cleanupAndFinish, serverSource };
