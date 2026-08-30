// STaR — lib/reasoning/star.js: outcome-filtered rationale bootstrapping and the trace corpus.
//
// THREE PROPERTIES THIS FILE EXISTS TO HOLD, in descending order of how badly they fail silently:
//
// 1. RETRIEVED TRACES ARE FENCED AS UNTRUSTED DATA. A saved trace is model-generated text derived
//    from some earlier task's input, and this platform ingests scraped pages, imported sites and
//    uploaded documents. Replaying one into a later prompt is a STORED PROMPT-INJECTION path: poison
//    one run's input, get the payload filed as a "gold standard", and it is re-served to every
//    future task that looks similar. The only exported way to get traces near a model must be the
//    {label, text} envelope executeAgent fences — never a concatenable string.
//
// 2. THE DATASET CANNOT ESCAPE THE REPO, AND CANNOT TOUCH `.claude/agents/`. A filtered-rationale
//    corpus that could rewrite an agent's own handbook is a self-modifying agent with a friendly
//    name on it. The user's standing rule on this project is that nothing automated edits agent
//    definitions; this is that rule, enforced at the constructor.
//
// 3. ONLY OUTCOME-VERIFIED TRACES ARE SAVED, AND HINTED ONES ARE FLAGGED. Filtering by outcome is
//    the entire reason the kept set is better than the model's average output. A rationale written
//    by a model that was SHOWN the answer is weaker evidence than one written blind, so it carries
//    `rationalized: true` — dropping that flag would silently mix two qualities of example.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const star = require('../lib/reasoning/star');
const R = require('../lib/reasoning');

const mock = (script, seen = []) => ({
  runAgent: async (agent, task) => {
    seen.push({ agent, task });
    const r = script[agent];
    if (r === undefined) return { ok: false, error: `no mock for ${agent}` };
    const content = typeof r === 'function' ? r(task) : r;
    if (content === null) return { ok: false, error: 'simulated provider failure' };
    return { ok: true, content, model: 'mock', inputTokens: 10, outputTokens: 10 };
  },
  broadcast: () => {}, log: () => {},
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-'));

(async () => {
  // =============================================================================================
  //  1. CONTAINMENT — where the dataset may and may not live
  // =============================================================================================
  {
    const forbidden = ['.claude/agents/coder.md', '.claude/settings.json', '.git/hooks/pre-commit', 'commercial/x.jsonl', 'node_modules/x.jsonl'];
    for (const f of forbidden) {
      let threw = false;
      try { star.createTraceStore({ root: tmp, file: f }); } catch { threw = true; }
      assert(threw, `a dataset path under "${f}" is REFUSED — nothing automated may write there, and .claude/agents/ least of all`);
    }
    let escaped = false;
    try { star.createTraceStore({ root: tmp, file: '../../escape.jsonl' }); } catch { escaped = true; }
    assert(escaped, 'a traversal out of the repo root is refused by the shared assertContained from lib/self-improve/plan-store.js — one containment implementation, not two');

    assert(star.FORBIDDEN_DATASET_PREFIXES.includes('.claude/'),
      'the .claude/ prefix is denied as a CATEGORY, not as a list of the handbook files that exist today — an enumerated denylist loses to the one path nobody listed');

    const okStore = star.createTraceStore({ root: tmp, file: star.DEFAULT_DATASET });
    assert(okStore.relPath === '.magent/reasoning/star_dataset.jsonl', `the default corpus path is allowed (${okStore.relPath})`);

    // The corpus records the text of real tasks, so it must not be repository content.
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert(gitignore.includes('.magent/reasoning/'),
      'and the default corpus directory is GITIGNORED — a trace holds the text of real work, which is not something to commit');

    // The corpus deliberately does NOT live in .magent/state/, which the shared containment denies.
    let deniedState = false;
    try { star.createTraceStore({ root: tmp, file: '.magent/state/x.jsonl' }); } catch { deniedState = true; }
    assert(deniedState,
      '.magent/state/ is refused by the SHARED containment (lib/self-improve/plan-store.js denies it so a self-improve plan cannot rewrite runtime state) — reusing that guard imported its policy, and the corpus moved rather than the guard weakening');
  }

  // =============================================================================================
  //  2. THE OUTCOME FILTER — what gets into the corpus at all
  // =============================================================================================
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds1.jsonl' });

    assert(store.save({ task: 't', steps: ['a'], verified: false }).saved === false,
      'an UNVERIFIED trace is refused — filtering by outcome is the entire value of the corpus, so an unfiltered write is not a lenient version of STaR, it is the absence of it');
    assert(/not outcome-verified/.test(store.save({ task: 't', steps: ['a'], verified: false }).reason), '...and the refusal says why');
    assert(store.save({ task: 't', steps: [], verified: true }).saved === false, 'a verified trace with no steps is refused — there is no rationale in it to learn from');
    assert(store.save({ steps: ['a'], verified: true }).saved === false, 'a trace with no task is refused');

    const good = store.save({ task: 'sum a list', steps: ['add them up'], answer: '6', verified: true, verifier: 'ground-truth' });
    assert(good.saved === true, 'a verified trace with steps and an answer is saved');
    assert(store.size === 1 && fs.existsSync(store.path), 'and it reaches the JSONL file on disk');

    const line = JSON.parse(fs.readFileSync(store.path, 'utf8').trim());
    assert(line.task === 'sum a list' && line.answer === '6' && line.verified === true && line.rationalized === false,
      'the serialised record carries task, steps, answer, and BOTH flags — the shape an offline fine-tune would actually consume');
  }
  {
    // A corrupt line must not destroy the corpus.
    const f = path.join(tmp, 'ds2.jsonl');
    fs.writeFileSync(f, `${JSON.stringify({ task: 'good one', steps: ['s'], answer: 'a', verified: true })}\n{ this is not json\n${JSON.stringify({ task: 'good two', steps: ['s'], answer: 'a', verified: true })}\n`);
    const store = star.createTraceStore({ root: tmp, file: 'ds2.jsonl' });
    assert(store.size === 2, `one malformed line is skipped and the other ${store.size} records survive — a corpus is append-only history, and one bad append must not erase it`);
  }
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds3.jsonl', readOnly: true });
    assert(store.save({ task: 't', steps: ['a'], verified: true }).saved === false, 'a read-only store refuses writes');
    assert(!fs.existsSync(path.join(tmp, 'ds3.jsonl')), '...and creates no file');
  }

  // =============================================================================================
  //  3. BOOTSTRAPPING — solve blind, then rationalize, and never confuse the two
  // =============================================================================================
  {
    const r = await star.bootstrapExample({ task: 'what is 2+2', answer: '4' },
      mock({ coder: '1. add two and two\nANSWER: 4' }), {});
    assert(r.ok === true && r.rationalized === false, 'an example solved blind is a clean success');
    assert(r.steps.length === 1 && r.answer === '4', `the rationale and answer are extracted (${JSON.stringify(r.steps)} → ${r.answer})`);
  }
  {
    let n = 0;
    const seen = [];
    const r = await star.bootstrapExample({ task: 'hard one', answer: '42' }, mock({
      coder: () => (++n === 1 ? '1. guessing\nANSWER: 7' : '1. reasoned properly\nANSWER: 42'),
    }, seen), { allowRationalization: true });

    assert(r.ok === true && r.rationalized === true,
      'a failure that succeeds once given the answer is a RATIONALIZED success — the paper\'s second phase');
    assert(/HINT — the correct answer is: 42/.test(seen[1].task), 'the second call really was given the answer as a hint');
    assert(/does not actually support that answer, say so/.test(seen[1].task),
      'and the hint prompt explicitly invites the model to refuse rather than invent a justification — handing over the answer invites post-hoc reasoning, and this is the one cheap guard against it');
  }
  {
    // The rationalized attempt must face the SAME check, not a softer one.
    const r = await star.bootstrapExample({ task: 'hard', answer: '42' },
      mock({ coder: '1. still wrong\nANSWER: 9' }), { allowRationalization: true });
    assert(r.ok === false && /still failed the check/.test(r.reason),
      'a rationalized attempt that STILL gets the wrong answer is rejected — being shown the answer is not itself a pass');
  }
  {
    const r = await star.bootstrapExample({ task: 'x', answer: '1' }, mock({ coder: '1. nope\nANSWER: 2' }), { allowRationalization: false });
    assert(r.ok === false && /rationalization disabled/.test(r.reason), 'with rationalization off, a failure is simply a failure');
  }
  {
    // A custom ground-truth check (an execution check, a test run) replaces string matching.
    const r = await star.bootstrapExample({ task: 'return an even number' },
      mock({ coder: '1. pick 8\nANSWER: 8' }),
      { check: (a) => ({ ok: Number(a) % 2 === 0, verifier: 'parity-check' }) });
    assert(r.ok === true && r.verifier === 'parity-check',
      'an injected ground-truth check drives the filter, so "verified" can mean a test run rather than an exact match');
  }
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds4.jsonl' });
    const out = await star.bootstrap(
      [{ task: 'a', answer: '1' }, { task: 'b', answer: '2' }, { task: 'c', answer: '3' }],
      mock({ coder: (t) => (/task:\s*a/i.test(t) ? '1. r\nANSWER: 1' : /task:\s*b/i.test(t) ? '1. r\nANSWER: WRONG' : '1. r\nANSWER: 3') }),
      { store, now: '2026-08-30T00:00:00Z' });

    assert(out.solved === 2 && out.failed === 1, `two solved blind, one failed (${out.solved}/${out.failed}) — the filter kept what worked and dropped what did not`);
    assert(out.saved === 2 && store.size === 2, 'exactly the survivors reached the corpus');
    assert(store.all().every((t) => t.savedAt === '2026-08-30T00:00:00Z'),
      'the timestamp is INJECTED by the caller — this module owns no clock, so a resumed or replayed run is reproducible');
  }

  // =============================================================================================
  //  4. RETRIEVAL AND FENCING — the security property
  // =============================================================================================
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds5.jsonl' });
    store.save({ task: 'how to parse a CSV file in node', steps: ['split on newlines'], answer: 'use a parser', verified: true });
    store.save({ task: 'deploy nginx with TLS on ubuntu', steps: ['run certbot'], answer: 'certbot', verified: true });
    store.save({ task: 'how to parse a CSV file in python', steps: ['import csv'], answer: 'csv module', verified: true, rationalized: true });

    const hits = store.retrieve('parse a CSV file in node quickly');
    assert(hits.length === 1 && /node/.test(hits[0].task),
      `retrieval ranks by similarity and drops the unrelated nginx trace (got ${hits.length}: ${hits.map((h) => h.task).join(' | ')})`);
    assert(!hits.some((h) => h.rationalized),
      'HINTED rationales are excluded from retrieval by default — weaker evidence should not become a worked example unless a caller asks for it');
    assert(store.retrieve('parse a CSV file', { includeRationalized: true }).length === 2, '...and can be asked for explicitly');
    assert(store.retrieve('entirely unrelated topic about gardening').length === 0, 'a task with nothing similar retrieves nothing rather than the least-bad match');
  }
  {
    const block = star.fewShotBlock([{ task: 'T', steps: ['one', 'two'], answer: 'A' }]);
    assert(block && typeof block.label === 'string' && typeof block.text === 'string',
      'fewShotBlock returns the {label, text} shape executeAgent fences as UNTRUSTED — not a prompt string');
    assert(/EXAMPLE 1/.test(block.text) && /one/.test(block.text) && /ANSWER: A/.test(block.text), 'the exemplar carries task, reasoning and answer');
    assert(star.fewShotBlock([]) === null, 'no traces means NULL, so the caller passes no untrusted block at all rather than an empty envelope');

    const store = star.createTraceStore({ root: tmp, file: 'ds6.jsonl' });
    store.save({ task: 'parse a CSV in node', steps: ['x'], answer: 'y', verified: true });
    const opts = R.fewShotOptions(store, 'parse a CSV in node');
    assert(opts.untrusted && opts.untrusted.label && opts.untrusted.text,
      'THE ONLY EXPORTED PATH FROM THE CORPUS TO A PROMPT PRODUCES `untrusted` — the fencing is the API, so a caller cannot accidentally concatenate a stored trace into an instruction');
    assert(Object.keys(R.fewShotOptions(null, 't')).length === 0, 'no store means no options, not an empty untrusted block');
    assert(Object.keys(R.fewShotOptions(store, 'a totally unrelated gardening question')).length === 0, 'and no relevant traces means no options either');

    // The whole-module guarantee: nothing exported hands back raw replayable trace text.
    const exportsReturningStrings = Object.keys(star).filter((k) => typeof star[k] === 'function' && /fewshot|exemplar|prompt/i.test(k));
    assert(exportsReturningStrings.length === 1 && exportsReturningStrings[0] === 'fewShotBlock',
      `exactly one export moves traces toward a prompt, and it is the fenced one (${JSON.stringify(exportsReturningStrings)})`);
  }
  {
    assert(star.similarity('the quick brown fox', 'the quick brown fox') === 1, 'identical tasks score 1');
    assert(star.similarity('abc def ghi', 'xyz uvw rst') === 0, 'disjoint tasks score 0');
    assert(star.similarity('', 'anything') === 0, 'an empty task scores 0 rather than dividing by zero');
    assert(star.similarity('Why did the nightly export stop producing files?', 'Why does the API return 403 after midnight?') === 0,
      'two unrelated questions that share only STOPWORDS score 0 — without the stopword filter "why" and "the" alone cleared the retrieval threshold, and tools/demo-reasoning.js really did offer a 403 exemplar to a disk-space question');
    assert(star.similarity('parse a CSV file in node', 'parse a CSV file in python') > 0.4, '...while genuinely related tasks still rank high on content words');
  }

  // =============================================================================================
  //  5. THE COMPOSITION — deliberate() only files a genuinely clean trace
  // =============================================================================================
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds7.jsonl' });
    const r = await R.deliberate('solve it', mock({
      architect: (t) => (/Propose exactly/.test(t) ? '1. approach one\n2. approach two' : '1. do the thing'),
      reviewer: (t) => (/Score how promising/.test(t) ? 'SCORE: 0.6\nNOTE: ok' : 'STATUS: CORRECT\nSCORE: 0.95'),
      coder: 'sound reasoning',
    }), { store, maxDepth: 1, breadth: 2, now: 'T' });

    assert(r.ok === true, 'the composed run succeeded');
    assert(r.meta.search && r.meta.steps && r.meta.star, 'and reports each phase separately, so a reader can see which one did the work');
    assert(r.meta.star.saved === true && store.size === 1, 'a clean composed trace IS filed to the corpus');
    assert(r.budget.calls > 5, `deliberation really costs many calls (${r.budget.calls}) — the result carries the meter reading rather than letting the cost be invisible`);
  }
  {
    const store = star.createTraceStore({ root: tmp, file: 'ds8.jsonl' });
    const r = await R.deliberate('solve it', mock({
      architect: (t) => (/Propose exactly/.test(t) ? '1. approach one' : '1. do the thing'),
      reviewer: (t) => (/Score how promising/.test(t) ? 'SCORE: 0.6' : 'the verifier is confused and says nothing parseable'),
      coder: 'reasoning',
      writer: 'lesson',
    }), { store, maxDepth: 1, breadth: 2, repair: false, now: 'T' });

    assert(r.ok === false, 'a run whose steps never verified is not ok');
    assert(store.size === 0 && r.meta.star.saved === false,
      `NOTHING was filed (${r.meta.star.reason}) — traceIsClean treats an UNVERIFIED step as disqualifying, so a trace with a hole in it never becomes a "gold standard" exemplar that future runs learn from`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})();
