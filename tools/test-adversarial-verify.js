// adversarialVerify is three-valued: refuted / sound / inconclusive. SOC 2 gap item 19 (PI1.3).
//
// The first version was fail-open in three distinct ways, each of which read as "not refuted" to
// every caller. Each is pinned below as the exact input that used to pass, so a regression to any
// of them fails by name:
//   1. partial panel — two of three skeptics error, the survivor says SOUND, the panel says sound;
//   2. empty panel — all three error, `.refuted` is false, callers checking only that let it through;
//   3. a reply with no verdict — empty, or truncated before its first line — counted as SOUND
//      because the test was "does not contain REFUTED".
const { assert, done, serverSource, readRepoFile } = require('./test-util');
const k = require('../lib/orchestrator');
const p = require('../lib/pipeline-patterns');

// A scripted runner: `replies` is consumed in order, one per skeptic call. Each entry is a string
// (an ok reply), an Error (a failed call), or an object to return verbatim.
const runner = (replies) => {
  const q = [...replies];
  return { runAgent: async () => { const r = q.shift(); if (r instanceof Error) return { ok: false, error: r.message }; if (typeof r === 'string') return { ok: true, content: r }; return r; }, log: () => {} };
};
const verify = (replies, opts = {}) => k.adversarialVerify('the claim', runner(replies), { n: replies.length, ...opts });

(async () => {
  // --- the healthy shapes still work ------------------------------------------------------------
  let r = await verify(['SOUND — fine', 'SOUND — fine', 'SOUND — fine']);
  assert(r.sound && !r.refuted && !r.inconclusive && r.answered === 3, '3/3 SOUND → sound');
  r = await verify(['REFUTED — stale', 'REFUTED — stale', 'SOUND — ok']);
  assert(r.refuted && !r.sound && !r.inconclusive && r.refuteCount === 2, '2/3 REFUTED → refuted (strict majority)');
  r = await verify(['REFUTED — stale', 'SOUND — ok', 'SOUND — ok']);
  assert(r.sound && r.refuteCount === 1, '1/3 REFUTED → sound (a lone refuter does not carry the panel)');

  // --- 1. partial panel: THE regression --------------------------------------------------------------
  r = await verify([new Error('boom'), new Error('boom'), 'SOUND — fine']);
  assert(r.inconclusive === true && r.sound === false && r.refuted === false,
    `two errors + one SOUND is INCONCLUSIVE, not sound — one voice cannot carry a three-seat panel (answered ${r.answered}, quorum ${r.quorum})`);
  assert(r.errored === 2 && r.answered === 1 && r.quorum === 2, 'the counts are reported: errored 2, answered 1, quorum 2');
  r = await verify([new Error('boom'), 'SOUND — fine', 'SOUND — fine']);
  assert(r.sound && !r.inconclusive, 'one error + two SOUND meets quorum → sound (degrades gracefully, does not block on a single failure)');

  // --- 2. empty panel ----------------------------------------------------------------------------------
  r = await verify([new Error('a'), new Error('b'), new Error('c')]);
  assert(r.inconclusive && !r.sound && !r.refuted && r.answered === 0, 'all-errored is inconclusive with an explicit flag, not a silent "not refuted"');

  // --- 3. no verdict in the reply ------------------------------------------------------------------------
  r = await verify(['', '', '']);
  assert(r.inconclusive && r.unparsed === 3 && r.answered === 0, 'three EMPTY ok-replies are three non-answers, not three SOUND votes');
  r = await verify([{ ok: true, content: '', truncated: true, stopReason: 'max_tokens' }, 'SOUND — ok', 'SOUND — ok']);
  assert(r.verdicts[0].answered === false && /truncated/.test(r.verdicts[0].reason) && r.sound,
    'a reply cut off before its verdict is a non-answer with the truncation named; the other two carry the panel');
  r = await verify(['I looked carefully and found nothing wrong.', 'SOUND', 'SOUND']);
  assert(r.verdicts[0].answered === false && r.unparsed === 1, 'prose with no REFUTED/SOUND token is not a vote either way');
  r = await verify(['SOUND — although a stricter reader might say REFUTED on tone', 'SOUND', 'SOUND']);
  assert(r.verdicts[0].verdict === 'SOUND' && r.sound, 'the FIRST-LINE verdict wins over a later mention of the other word (the prompt asks for line one)');
  r = await verify(['REFUTED — the total is wrong', 'REFUTED — same', 'sound']);
  assert(r.verdicts[2].verdict === 'SOUND' && r.refuted, 'verdict words are case-insensitive; the tally is still 2/3 refuted');

  // --- quorum is configurable and bounded ----------------------------------------------------------
  r = await verify([new Error('x'), new Error('y'), 'SOUND'], { quorum: 1 });
  assert(r.sound && r.quorum === 1, 'quorum: 1 lets a single answer decide when a caller asks for that explicitly');
  r = await verify(['SOUND'], { n: 1 });
  assert(r.sound && r.quorum === 1, 'n=1 has quorum 1 — a one-seat panel is not inconclusive by construction');
  r = await verify(['SOUND', 'SOUND'], { quorum: 9 });
  assert(r.quorum === 2 && r.sound, 'quorum is clamped to n');

  // --- the pipeline skeptic stage blocks on inconclusive --------------------------------------------------
  const deps = { runAgent: (() => { const q = [new Error('e'), new Error('e'), 'SOUND — ok']; return async () => { const x = q.shift(); return x instanceof Error ? { ok: false, error: x.message } : { ok: true, content: x }; }; })(), log: () => {}, broadcast: () => {} };
  const stage = await p.runPattern({ id: 'audit', pattern: 'skeptic', depends_on: ['d'], n: 3 }, { subject: 'c' }, deps);
  assert(stage.ok === false && stage.verdict === 'inconclusive' && /Inconclusive: 1 of 3/.test(stage.output),
    'the skeptic STAGE blocks on an inconclusive panel and says why in its output');
  assert(/NO VERDICT/.test(stage.output), 'non-answers are labelled NO VERDICT in the panel transcript, not SOUND');

  // --- server.js: the rubric verdict honours inconclusive, and the panel no longer caps tokens ----------
  const src = serverSource();
  const block = src.slice(src.indexOf('orchestrator.adversarialVerify('), src.indexOf('return { results, aggregateScore, verdict, strictness, adversarial }'));
  assert(/\(adversarial\.refuted \|\| adversarial\.inconclusive\) && verdict === 'pass'\) verdict = 'review'/.test(block), 'a clean pass is downgraded to review when the panel is refuted OR inconclusive');
  assert(!/maxTokens: 500/.test(block), 'the 500-token cap on skeptic calls is gone');
  assert(/adversarial = \{ error: e\.message/.test(block), 'a thrown panel is disclosed on the result as inconclusive, not swallowed into null');
  const kernel = readRepoFile('lib/orchestrator.js');
  assert(!/agentOpts \|\| \{ maxTokens: 600 \}/.test(kernel), 'the kernel default 600-token cap is gone too');

  done();
})();
