// tools/test-run-history-durable.js
// ============================================================
//  THE LIST AND THE DETAIL MUST AGREE. Every run the list offers must be openable.
//
//  `GET /api/pipelines/runs` merges live runs with archived ones read from `.magent/runs/`, marking
//  the archived ones `fromTrail`. `GET /api/pipelines/runs/:id` read ONLY the in-memory Map. So
//  after any restart the UI listed runs and every one of them 404'd on click.
//
//  NOT COSMETIC: two of the three runs on this machine were `awaiting_approval` — work parked at a
//  HUMAN GATE that could not be opened in order to approve it. A gate you cannot reach never clears.
//
//  WHY THIS TEST BOOTS THE SERVER. The bug was in a ROUTE, not in the trail module. `readManifest`
//  and `listRuns` both worked perfectly the whole time — a module-level test would have passed
//  while the feature was broken. The invariant only exists where the two endpoints meet, so the
//  test has to go through HTTP.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const trail = require('../lib/pipeline-trail.js');

let pass = 0;
const ok = (label) => { console.log(`ok  : ${label}`); pass++; };

// AUTHENTICATE PROPERLY rather than trying to disable auth. server.js opens the API only when
// there is NO API_TOKEN, but dotenv runs INSIDE server.js and re-populates it from .env — deleting
// the var before require() does not survive. Setting it first does: dotenv will not override an
// existing value. So the test supplies its own token and sends it, exercising the real auth path.
process.env.API_TOKEN = 'test-token-run-history';
const PORT = 3391;
process.env.PORT = String(PORT);

const get = (p) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { Authorization: 'Bearer test-token-run-history' } }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j }); });
  }).on('error', () => resolve({ status: 0, body: null }));
});

(async () => {
  // A trail written by the real module, so the fixture cannot drift from the writer's format.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runhist-'));
  const run = { id: 'run-fixture-1', pipeline: 'security-sweep', status: 'awaiting_approval', startedAt: new Date(0).toISOString(), params: {} };
  trail.writeStage(tmp, run, { id: 'architecture', agent: 'security-auditor', output: 'stub output' }, 1);
  trail.writeManifest(tmp, run, []);
  assert.ok(trail.readManifest(tmp, run.id), 'fixture trail must be readable by the module itself');
  ok('a run trail written by the real module reads back');

  require('../server.js');
  await new Promise((r) => setTimeout(r, 6000));

  const list = await get('/api/pipelines/runs');
  assert.strictEqual(list.status, 200, 'the runs list must respond');
  ok(`the list responds (${(list.body || []).length} run(s))`);

  // THE INVARIANT. Anything the list offers must open.
  const unopenable = [];
  for (const r of list.body || []) {
    const one = await get('/api/pipelines/runs/' + encodeURIComponent(r.id));
    if (one.status !== 200) unopenable.push(`${r.id} -> HTTP ${one.status} (${one.body && one.body.error})`);
  }
  assert.deepStrictEqual(unopenable, [],
    'every listed run must be openable — the list reads the trail, so the detail must too:\n  ' + unopenable.join('\n  '));
  ok('EVERY listed run is openable — list and detail agree');

  // A run that genuinely does not exist must still 404, or the fallback is hiding real errors.
  const missing = await get('/api/pipelines/runs/run-definitely-not-here');
  assert.strictEqual(missing.status, 404, 'an unknown run id must still 404');
  ok('an unknown run id still 404s — the fallback did not swallow real misses');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nALL TESTS PASSED\n${pass} assertions`);
  process.exit(0);
})();
