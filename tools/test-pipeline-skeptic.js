// tools/test-pipeline-skeptic.js
// ============================================================
//  The SHIPPED pipelines' skeptic stages — adoption, not machinery.
//
//  `lib/pipeline-patterns.js` has had a working `skeptic` verb for a long time, with its own tests.
//  It was used by ZERO pipelines. A capability nothing invokes is indistinguishable from one that
//  does not exist, so this suite asserts the pipelines actually USE it, and with the semantics that
//  were chosen deliberately:
//
//    on_refute: gate   — a refuted draft/report is CONTESTED, not garbage. That is exactly the case
//                        a human should see. `fail` is right for a security sweep; `gate` is right
//                        for content, and silently discarding contested work is the failure mode
//                        this guards against.
//    n: 3              — three INDEPENDENT verifiers. One reviewer giving one opinion is not the
//                        same evidence as a panel that tried to refute and could not.
//
//  It also DRIVES the stage with a mock runner, because config that validates is not config that
//  behaves — the whole lesson of this codebase.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runPattern, validatePatternStage } = require('./../lib/pipeline-patterns.js');

const DIR = path.join(__dirname, '..', '.claude', 'pipelines');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const load = (f) => yaml.load(fs.readFileSync(path.join(DIR, f + '.yaml'), 'utf8'));
const WITH_SKEPTIC = ['research-to-report', 'content-pipeline', 'repurpose-video'];

// Stages whose output is CUSTOMER-FACING must gate `blocking`, never `advisory`. The docx is
// explicit: "any customer-facing or revenue-facing output is strictly saved in draft mode until you
// personally review and approve it." `repurpose-video` drafts promotional emails, so an advisory
// gate — which lets work through on a nod — would break that promise.
const CUSTOMER_FACING = { 'repurpose-video': 'package' };

ok('the content pipelines each declare a skeptic stage', () => {
  for (const name of WITH_SKEPTIC) {
    const s = load(name).stages.find((x) => x.pattern === 'skeptic');
    assert.ok(s, `${name}.yaml has no \`pattern: skeptic\` stage — the checker was removed`);
  }
});

ok('each skeptic GATES rather than fails, and runs a panel of at least 3', () => {
  for (const name of WITH_SKEPTIC) {
    const s = load(name).stages.find((x) => x.pattern === 'skeptic');
    assert.strictEqual(s.on_refute, 'gate',
      `${name}: on_refute must be "gate" — contested work goes to a human, it is not discarded`);
    assert.ok(Number(s.n) >= 3, `${name}: n must be >= 3; a panel of one is just a second opinion`);
  }
});

ok('the skeptic runs BEFORE the human gate, on work that already exists', () => {
  for (const name of WITH_SKEPTIC) {
    const p = load(name);
    const idx = (id) => p.stages.findIndex((x) => x.id === id);
    const sk = p.stages.find((x) => x.pattern === 'skeptic');
    assert.ok(sk.depends_on && sk.depends_on.length,
      `${name}: a skeptic with no depends_on has nothing to refute`);
    const gated = p.stages.filter((x) => x.gate);
    for (const g of gated) {
      assert.ok(idx(sk.id) < idx(g.id),
        `${name}: the skeptic must run before the "${g.id}" gate — a human should not be asked first`);
    }
  }
});

ok('customer-facing output gates BLOCKING, not advisory (draft mode until a human approves)', () => {
  for (const [name, stageId] of Object.entries(CUSTOMER_FACING)) {
    const s = load(name).stages.find((x) => x.id === stageId);
    assert.ok(s, `${name}.yaml has no "${stageId}" stage`);
    assert.strictEqual(s.gate, 'blocking',
      `${name}/${stageId} produces customer-facing output — gate must be "blocking", not "${s.gate}". `
      + 'Advisory lets promotional copy through on a nod.');
  }
});

ok('a playbook does not claim an automatic trigger the runner cannot honour', () => {
  // `trigger:` is decorative today — nothing dispatches a pipeline on an event. A playbook
  // advertising `trigger: video_published` would be a promise the system silently breaks.
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yaml'))) {
    const t = load(f.replace('.yaml', '')).trigger;
    assert.ok(!t || t === 'manual' || t === 'schedule',
      `${f}: trigger "${t}" is not honoured by the runner — only "manual" is real today`);
  }
});

ok('every shipped pattern stage passes the loader validation', () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yaml'))) {
    for (const s of (yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8')).stages || [])) {
      const errs = validatePatternStage(s) || [];
      assert.deepStrictEqual(errs, [], `${f} stage "${s.id}": ${errs.join('; ')}`);
    }
  }
});

// --- BEHAVIOUR, driven from the real YAML. -----------------------------------------------------
const drive = async (stage, verdict) => {
  const calls = [];
  const deps = { runAgent: async (agent) => {
    calls.push(agent);
    return verdict === 'silent' ? { ok: false, error: 'no answer' } : { ok: true, content: `${verdict} — reason.` };
  } };
  const r = await runPattern(stage, { task: 't', subject: 'The report claims X.' }, deps);
  return { r, calls };
};

(async () => {
  const stage = load('research-to-report').stages.find((x) => x.pattern === 'skeptic');

  {
    const { r, calls } = await drive(stage, 'SOUND');
    assert.strictEqual(r.ok, true, 'an unrefuted panel must pass');
    assert.strictEqual(calls.length, 3, 'n:3 must mean three dispatches');
    console.log('ok  : an unrefuted panel passes, and n:3 means three REAL dispatches'); pass++;
  }
  {
    const { r } = await drive(stage, 'REFUTED');
    assert.strictEqual(r.ok, true, 'on_refute:gate must not fail the run');
    assert.strictEqual(r.verdict, 'gated', 'a refuted panel must be GATED to a human, not discarded');
    console.log('ok  : a refuted panel is GATED to a human, not failed or discarded'); pass++;
  }
  {
    // The missing-verdict rule: silence is never consent.
    const { r } = await drive(stage, 'silent');
    assert.strictEqual(r.ok, false, 'a panel nobody answered is a BLOCK, not a pass');
    console.log('ok  : a panel nobody answered BLOCKS — silence is not a pass'); pass++;
  }

  console.log(`\nALL TESTS PASSED\n${pass} assertions`);
})();
