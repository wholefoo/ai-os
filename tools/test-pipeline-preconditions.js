// Input-presence precondition: refuse a pipeline whose REQUIRED parameters were never supplied,
// before any stage is commissioned.
//
// WHY THIS EXISTS. Every pipeline in .claude/pipelines/ already declares its required inputs:
//
//     parameters:
//       target:
//         required: true          <-- written when the file was authored, read by NOTHING
//
// So `POST /api/pipelines/security-sweep/execute` with `{}` dispatched the whole graph. On
// production that happened twice (run-1785910485579, run-1785991955968): three security-auditor
// stages each independently rediscovered that no target existed, a fourth compiled their identical
// blockers into a report, and a fifth escalated it — ~$0.31 and five Opus calls to learn one fact
// that was checkable for free. The run's own gate wrote the fix as a recommendation:
// "Input presence should be validated once at dispatch, before any stage is commissioned."
//
// This is the same defect class as `depends_on` before G1 and `gates:` before the approval work: a
// declaration that READS as enforcement while enforcing nothing. The fix is not new vocabulary —
// it is making the vocabulary that already exists executable.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const graph = require('../lib/pipeline-graph');
const { assert, done, serverSource } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const src = serverSource();
const missing = graph.missingRequiredParams;

assert(typeof missing === 'function', 'lib/pipeline-graph exports missingRequiredParams');

// --- the real corpus: every shipped pipeline is refused when dispatched empty -----------------------
// Written against the actual files rather than a fixture, because the point is that these specific
// pipelines were dispatchable with nothing and burned real money doing it.
const dir = path.join(ROOT, '.claude', 'pipelines');
const defs = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')));
assert(defs.length >= 3, `the pipeline corpus is present (${defs.length} definitions)`);

for (const def of defs) {
  const req = Object.entries((def && def.parameters) || {}).filter(([, s]) => s && s.required === true);
  if (!req.length) continue;
  const gaps = missing(def, {});
  assert(gaps.length === req.length,
    `"${def.name}" dispatched with {} reports all ${req.length} of its required parameter(s) missing — this is the call that used to run the whole graph`);
  const supplied = Object.fromEntries(req.map(([n]) => [n, 'something']));
  assert(missing(def, supplied).length === 0, `..."${def.name}" with them supplied is not blocked`);
}

const sweep = defs.find((d) => d.name === 'security-sweep');
assert(sweep, 'security-sweep is in the corpus');
assert(missing(sweep, {})[0].name === 'target', 'security-sweep names `target` as the missing input');
assert(/repository|url|path/i.test(missing(sweep, {})[0].description || ''),
  '...and carries the YAML `description` through, so the refusal tells the operator WHAT to supply rather than only which key is absent');

// --- value semantics: the falsy trap ----------------------------------------------------------------
// A supplied 0 or false IS a supplied value. A naive `if (!params[name])` treats both as missing and
// refuses a correctly-formed dispatch — a guard that blocks valid work is worse than none.
const fixture = { name: 'f', parameters: { n: { required: true }, b: { required: true } } };
assert(missing(fixture, { n: 0, b: false }).length === 0,
  'zero and false count as SUPPLIED — the `!value` shortcut would reject a legitimate dispatch');
assert(missing(fixture, { n: 1, b: true }).length === 0, 'and so do truthy values');
assert(missing(fixture, {}).length === 2, 'while genuinely absent values are both reported, not just the first');

const blank = { name: 'b', parameters: { t: { required: true } } };
assert(missing(blank, { t: '' }).length === 1, 'an empty string is missing — it satisfies presence but not intent');
assert(missing(blank, { t: '   ' }).length === 1, 'so is whitespace');
assert(missing(blank, { t: 'x' }).length === 0, 'a real string passes');

// --- optional and absent declarations ----------------------------------------------------------------
const optional = { name: 'o', parameters: { a: { required: false }, b: { default: 'x' }, c: {} } };
assert(missing(optional, {}).length === 0, 'parameters that are not `required: true` are never blocking');
assert(missing({ name: 'none' }, {}).length === 0,
  'a pipeline with NO parameters block is unaffected — absence of a declaration means no precondition, exactly as absence of depends_on means sequential');
assert(missing(null, null).length === 0, 'a null definition does not throw');

// --- wiring: the refusal happens in executePipeline, not only in the route ----------------------------
// Enforcing in the route would leave any future caller (a schedule, Hermes) dispatching unchecked.
// This repo has lost to enumerated/positional guards before; the guard goes where every caller passes.
// Delimit the real function body rather than guessing a character window — a comment edit must not
// be able to break this assertion, which is what a fixed-width slice would do.
const fnStart = src.indexOf('function executePipeline');
assert(fnStart > 0, 'executePipeline is present in server.js');
const after = src.indexOf('\nfunction ', fnStart + 1);
const body = src.slice(fnStart, after > 0 ? after : src.length);

assert(body.includes('missingRequiredParams'),
  'executePipeline itself applies the precondition, so a future caller (a schedule, Hermes) cannot route around it');
assert(/blocked:\s*true/.test(body), '...returning a distinct blocked result rather than a run');
assert(/run\.blocked/.test(src) && /status\(400\)/.test(src),
  'and the execute route translates that into a 400 rather than a 404 or a phantom run');

// The run must NOT be created: a blocked dispatch that leaves a run record reproduces the
// "completed run for work that never happened" trap the security-sweep gate warned about.
const iCheck = body.indexOf('missingRequiredParams');
const iRegister = body.indexOf('pipelineRuns.set');
assert(iRegister > 0, 'executePipeline registers the run via pipelineRuns.set (the ordering anchor)');
assert(iCheck < iRegister,
  'the check runs BEFORE the run is registered — refusing afterwards would still leave a record of a run that never ran');

console.log('  info: ' + defs.length + ' pipelines checked; every required parameter declaration is now executable');
done();
