// tools/intel-brief-compare.js is a deliverable — the operator runs it to measure the experiment —
// and this repo's rule (see the demo-reasoning incident) is that any tools/ script someone will run
// needs a test-*.js that runs it. `report` is the free path; `run` spends money and is not exercised.
const { execFileSync } = require('child_process');
const path = require('path');
const { assert, done } = require('./test-util');

const out = execFileSync(process.execPath, [path.join(__dirname, 'intel-brief-compare.js'), 'report'], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert(/COMPILED\s*:/.test(out) && /BASELINE\s*:/.test(out), 'report prints both ledger groups');
assert(/LATEST COMPILED STATEMENT/.test(out) && /LATEST BASELINE STATEMENT/.test(out), 'and a section for each latest statement');
assert(!/Bearer|API_TOKEN=|sk-ant/.test(out), 'nothing it prints looks like a credential — the token is read in-process and never echoed');

let usage = '';
try { execFileSync(process.execPath, [path.join(__dirname, 'intel-brief-compare.js'), 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { usage = String(e.stderr || ''); }
assert(/usage:/.test(usage), 'an unknown command prints usage and exits non-zero rather than doing anything');

const src = require('fs').readFileSync(path.join(__dirname, 'intel-brief-compare.js'), 'utf8');
assert(/Authorization: `Bearer \$\{tok\}`/.test(src) && !/execSync|spawn|curl/.test(src),
  'the trigger uses fetch() with the token in-process — no shell, no curl, so it never reaches argv or a process list');
assert(/task: def.hermes/.test(src), 'the trigger sends task (the route 400s without it) — first live attempt failed exactly this way');
done();
