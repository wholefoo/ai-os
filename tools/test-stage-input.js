// Stage-input assembly: what a pipeline stage actually SEES of its upstream stages.
//
// THE BUG THIS PINS, measured on production run-1785910485579 (2026-08-05):
// runPipelineStage built each stage's prompt with `String(s.output).slice(0, 4000)` — a silent,
// head-only cut. `compile-report` emitted 7302 chars; `human-review` received 4000 and lost §4-§8,
// 45% of the report INCLUDING the conclusion. It then reported "the report is truncated, §4 absent"
// as a DEFECT OF THE COMPILE STAGE. The artifact was complete; the harness had cut it. A review gate
// graded a truncated copy of the work and blamed the wrong component.
//
// Two properties matter, and the second is the one that made the failure expensive:
//   1. Real stage outputs must arrive WHOLE.
//   2. When something must be cut, the cut must be VISIBLE and must PRESERVE THE END. A head-only
//      slice throws away exactly where a report puts its verdict, and an unmarked cut is
//      indistinguishable from "the upstream report simply ended here".
const graph = require('../lib/pipeline-graph');
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const clip = graph.clipStageOutput;

assert(typeof clip === 'function', 'lib/pipeline-graph exports clipStageOutput — the assembly rule lives in a module so it can be tested, not inline in a template literal');

// --- 1. real outputs arrive whole -------------------------------------------------------------------
// Every stage output observed on the failing production run, largest first. All must survive intact.
for (const [label, n] of [['compile-report', 7302], ['code-scan', 4669], ['dependencies', 3798], ['architecture', 3540]]) {
  const body = 'x'.repeat(n);
  assert(clip(body) === body, `a ${n}-char ${label} output passes through byte-identical — this is the size that was being cut`);
}
assert(!/omitted/.test(clip('x'.repeat(7302))), '...with no truncation marker, because nothing was truncated');

const CAP = graph.STAGE_INPUT_MAX_CHARS;
assert(CAP >= 20000, `the per-stage input budget is generous (${CAP}) — input tokens do NOT come out of max_tokens (that caps OUTPUT), so the only costs of a wide window are billing and context, both cheap against a 1M window`);
assert(clip('y'.repeat(CAP)) === 'y'.repeat(CAP), 'an output exactly at the cap is untouched — the boundary is inclusive');
assert(graph.STAGE_INPUT_TAIL_CHARS >= 4000,
  `the preserved tail is substantial (${graph.STAGE_INPUT_TAIL_CHARS}) — "keep the end" is a hollow guarantee if only a few hundred characters of it survive, because a verdict plus its reasoning does not fit in that`);
assert(graph.STAGE_INPUT_TAIL_CHARS < CAP,
  'and the tail is smaller than the whole budget, or the head would be squeezed out entirely');

// --- 2. an over-cap output is cut VISIBLY and keeps its END ------------------------------------------
const head = 'HEAD-SENTINEL';
const tail = 'VERDICT-SENTINEL';           // stands in for the conclusion a head-only slice destroys
const huge = head + 'z'.repeat(CAP * 2) + tail;
const out = clip(huge);

assert(out.startsWith(head), 'the head survives');
assert(out.endsWith(tail), 'THE TAIL SURVIVES — the old slice(0,4000) kept only the head, discarding exactly where a report states its verdict');
assert(out.length < huge.length, 'and the result is genuinely shorter than the input');
assert(out.length <= CAP + 400, `bounded by the cap plus the marker (got ${out.length} for cap ${CAP})`);

assert(/omitted/i.test(out), 'the cut is ANNOUNCED, not silent');
assert(/\d{3,}/.test(out.match(/\[[^\]]*omitted[^\]]*\]/i)[0]), '...and states HOW MUCH was dropped, so the reader can judge what it is missing');
assert(/middle/i.test(out), '...and that the gap is in the MIDDLE — without this an agent reads the tail as a continuation of the head and concludes the document ended early, which is the exact misreading that produced the false defect report');

// --- 3. the regression instance, end to end ----------------------------------------------------------
// Reconstructed shape of the report that broke: 8 sections, the last carrying the reference list.
const report = ['# Security Sweep — Consolidated Report']
  .concat(Array.from({ length: 8 }, (_, i) => `## ${i + 1}. Section ${i + 1}\n` + 'body '.repeat(300)))
  .join('\n\n');
const seen = clip(report);
assert(report.length > 7000, `the fixture is realistically large (${report.length} chars)`);
assert(seen.includes('## 8.'), 'section 8 reaches the downstream stage — under the old 4000-char slice it did not, and human-review declared it "absent" as a defect of the compiler');
assert(seen.includes('## 4.'), 'and so does section 4, the one named in the production failure');

// --- 4. degenerate inputs ----------------------------------------------------------------------------
assert(clip('') === '', 'empty output is empty, not a marker');
assert(clip(null) === '', 'a null output does not throw — filter(s => s.output) should prevent it, but the runner must not depend on that');
assert(clip(undefined) === '', 'nor does undefined');

// --- 5. the runner actually uses it ------------------------------------------------------------------
// The module can be perfect while runPipelineStage keeps its inline slice.
assert(!/String\(s\.output\)\.slice\(0,\s*4000\)/.test(src),
  'the raw 4000-char slice is GONE from server.js — not merely superseded');
assert(/pipelineGraph\.clipStageOutput\(s\.output\)/.test(src),
  'and the prompt assembly calls clipStageOutput instead');

console.log(`  info: per-stage input budget ${CAP} chars; every output size seen on the failing run passes through whole`);
done();
