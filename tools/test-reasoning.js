// The reasoning framework's core: the budget meter, the typed models, CoT+PRM verified steps, and
// the Reflexion loop. (Tree-of-Thoughts is tools/test-reasoning-tot.js; STaR is
// tools/test-reasoning-star.js — those two carry properties worth isolating.)
//
// WHAT THIS FILE EXISTS TO CATCH. Every pattern in lib/reasoning turns one agent call into many,
// and each of them has a failure mode that LOOKS LIKE SUCCESS:
//   - a verifier that cannot answer, read as approval;
//   - a step whose ACTION runs even though the step was rejected;
//   - a "reflexion" loop that retries without carrying the critique — a blind coin flip in costume;
//   - a loop that ignores the budget and quietly bills for 40 calls.
// Each of those is asserted here directly, on VALUES rather than counts (the repo's standing rule),
// through the REAL engines driven by a mock runAgent. No assertion in this file spends a token.

const { assert, done } = require('./test-util');
const R = require('../lib/reasoning');
const { createBudget, guardedCall } = require('../lib/reasoning/budget');
const M = require('../lib/reasoning/models');
const steps = require('../lib/reasoning/steps');
const tot = require('../lib/reasoning/tot');
const reflexion = require('../lib/reasoning/reflexion');
const { createContextManager, SEGMENTS, EVICTION_ORDER } = require('../lib/reasoning/context');

/** A mock runner. `script` maps agent -> string | (task) => string. `seen` records every call. */
const mock = (script, seen = []) => ({
  runAgent: async (agent, task, opts) => {
    seen.push({ agent, task, opts });
    const r = script[agent];
    if (r === undefined) return { ok: false, error: `no mock for ${agent}` };
    const content = typeof r === 'function' ? r(task, seen.filter((s) => s.agent === agent).length - 1) : r;
    if (content === null) return { ok: false, error: 'simulated provider failure' };
    return { ok: true, content, model: 'mock', inputTokens: 100, outputTokens: 50 };
  },
  broadcast: () => {}, log: () => {},
});

(async () => {
  // =============================================================================================
  //  BUDGET — the meter every engine calls through
  // =============================================================================================
  {
    const b = createBudget({ maxCalls: 2 });
    const seen = [];
    const d = mock({ coder: 'hello' }, seen);

    const a = await guardedCall(d, b, 'coder', 't');
    const c = await guardedCall(d, b, 'coder', 't');
    const third = await guardedCall(d, b, 'coder', 't');

    assert(a.ok && c.ok, 'a budget of 2 permits exactly two calls');
    assert(third.ok === false && third.budgetExhausted === true,
      'the third call is refused as budget-exhausted rather than silently made');
    assert(seen.length === 2, `the refused call never reached the runner (runner saw ${seen.length})`);
    assert(b.snapshot().inputTokens === 200 && b.snapshot().outputTokens === 100,
      'tokens ACCUMULATE across calls — server.js executeAgent bills one result object, so a multi-call loop that did not accumulate would under-report its own spend');
    assert(/call budget exhausted \(2\/2 calls\)/.test(b.snapshot().stoppedBy),
      `the snapshot says WHY it stopped, in numbers: "${b.snapshot().stoppedBy}"`);
  }
  {
    const b = createBudget({ maxCalls: 5, maxTokens: 200 });
    const d = mock({ coder: 'x' });
    await guardedCall(d, b, 'coder', 't');           // 150 tokens
    const second = await guardedCall(d, b, 'coder', 't');
    assert(second.ok && b.snapshot().totalTokens === 300, 'the token cap is checked BEFORE a call, so the call that crosses it still completes');
    const third = await guardedCall(d, b, 'coder', 't');
    assert(third.budgetExhausted === true && /token budget exhausted \(300\/200/.test(b.snapshot().stoppedBy),
      'a token ceiling stops the run independently of the call ceiling');
  }
  {
    const b = createBudget({ maxCalls: 9999 });
    assert(b.snapshot().maxCalls === 60, 'maxCalls is clamped to the MAX_CALLS_CEILING — a caller cannot raise the hard ceiling, only lower it');
  }
  {
    const b = createBudget({ maxCalls: 3 });
    const d = { runAgent: async () => { throw new Error('provider exploded'); } };
    const r = await guardedCall(d, b, 'coder', 't');
    assert(r.ok === false && /provider exploded/.test(r.error),
      'a THROWN provider error becomes data, not an exception — inside a tree search a throw would lose every node already expanded');
    assert(b.snapshot().calls === 1 && b.snapshot().failed === 1, 'and it is still metered: a failed call cost money');
  }

  // =============================================================================================
  //  MODELS — the three-valued verdict, and what counts as a clean trace
  // =============================================================================================
  {
    const amb = M.makeVerification({ status: 'AMBIGUOUS', score: 0.9 });
    assert(amb.verified === false && amb.unverified === true,
      'AMBIGUOUS is NOT verified even at score 0.9 — a two-valued verifier has to guess on steps it cannot judge, and guessing "pass" is how an unverified step gets laundered into a verified trace');
    assert(M.makeVerification({ status: 'NONSENSE' }).status === 'AMBIGUOUS',
      'an unrecognised status degrades to AMBIGUOUS, never to CORRECT');
    assert(M.makeVerification({ score: 5 }).score === 1 && M.makeVerification({ score: -2 }).score === 0,
      'scores are clamped into [0,1] by the factory, so no call site has to remember to check');

    const t = M.makeTrace({ task: 'x' });
    M.addStep(t, M.makeStep({ index: 0, rationale: 'a' }), M.makeVerification({ status: 'CORRECT', score: 1 }));
    M.addStep(t, M.makeStep({ index: 1, rationale: 'b' }), M.makeVerification({ status: 'AMBIGUOUS' }));
    const clean = M.traceIsClean(t);
    assert(clean.clean === false && clean.unverifiedCount === 1 && clean.incorrectCount === 0,
      'a trace containing one UNVERIFIED step is not clean — and the two failure shapes are counted separately, so "wrong" and "unknown" never blur');
    assert(M.traceIsClean(M.makeTrace({ task: 'x' })).clean === false,
      'a trace with NO steps is not clean either — vacuous success is the failure this repo keeps rediscovering');
  }
  {
    // cumulative = MEAN along the path, not sum (a sum would reward depth for its own sake).
    const root = M.makeNode({ id: 'r', depth: 0, score: 0.8 });
    const kid = M.makeNode({ id: 'k', parentId: 'r', depth: 1, score: 0.4, parentCumulative: root.cumulative });
    assert(kid.cumulative === 0.6, `path mean of 0.8 then 0.4 is 0.6, got ${kid.cumulative} — a sum (1.2) would let a long mediocre path outrank a short excellent one`);
  }
  {
    // A corrupted parent link must not hang the walk.
    const byId = new Map();
    const a = M.makeNode({ id: 'a', parentId: 'b', depth: 1 });
    const b = M.makeNode({ id: 'b', parentId: 'a', depth: 1 });
    byId.set('a', a); byId.set('b', b);
    const path = M.pathTo(a, byId);
    assert(path.length === 2, `a parent-link cycle terminates instead of hanging (walked ${path.length} nodes)`);
  }

  // =============================================================================================
  //  PARSING — the verdict readers, where "unreadable" must never mean "fine"
  // =============================================================================================
  {
    assert(steps.parseVerdict('').status === 'AMBIGUOUS', 'an EMPTY verifier reply is AMBIGUOUS, never CORRECT');
    assert(steps.parseVerdict('the vibes are good here').status === 'AMBIGUOUS', 'unparseable prose is AMBIGUOUS');
    assert(steps.parseVerdict('STATUS: CORRECT\nSCORE: 0.9').verified === true, 'a well-formed pass parses as CORRECT');
    assert(steps.parseVerdict('STATUS: CORRECT\nSCORE: 0.2').status === 'AMBIGUOUS',
      'CORRECT with a score BELOW the pass floor is downgraded to AMBIGUOUS — fluency is not evidence');
    assert(steps.parseVerdict('SCORE: 85').score === 0.85, 'a 0-100 score is normalised to 0-1');
    assert(steps.parseVerdict('SCORE: 0.9\nSTATUS: INCORRECT').status === 'INCORRECT',
      'an explicit INCORRECT beats a high score — the classification is the verdict, the score is confidence in it');
    assert(steps.parseVerdict('STATUS: CORRECT\nSCORE: 0.9\nFEEDBACK: watch the null case').feedback === 'watch the null case',
      'feedback is extracted so a rejected step can be revised against a specific objection');
  }
  {
    const parsed = steps.parseSteps('1. first\n   continued here\n2. second\n- third');
    assert(parsed.length === 3, `a WRAPPED step does not become a phantom extra step (got ${parsed.length}: ${JSON.stringify(parsed)})`);
    assert(parsed[0] === 'first continued here', 'the continuation line is joined onto its own step');
    assert(steps.parseSteps('just prose, no numbering').length === 1,
      'a model that ignored the format still yields one usable step rather than zero');

    const st = steps.parseStepText('Check the config first.\nACTION: read config.json', 3);
    assert(st.rationale === 'Check the config first.' && st.action === 'read config.json',
      'reasoning tokens and execution tokens land in DIFFERENT fields — that separation is what lets the verifier grade the thought before the action can run');
    assert(steps.parseStepText('no action here').action === null, 'a step with no ACTION line has a null action, not an empty string to accidentally execute');
  }

  // =============================================================================================
  //  VERIFIERS — rule, model, and the chain that prefers the free one
  // =============================================================================================
  {
    const abstain = steps.ruleVerifier(() => null, { name: 'abstainer' });
    assert((await abstain(M.makeStep({}), {})) === null,
      'a rule that does not apply ABSTAINS (null) — a rule which cannot judge a step must not be able to fail it');

    const thrower = steps.ruleVerifier(() => { throw new Error('bad regex'); }, { name: 'thrower' });
    const tv = await thrower(M.makeStep({}), {});
    assert(tv.status === 'AMBIGUOUS' && /checker threw/.test(tv.feedback),
      'a rule checker that THROWS yields AMBIGUOUS with the reason — it does not crash the run and does not pass the step');

    const seen = [];
    const chain = steps.chainVerifiers([steps.ruleVerifier(() => false, { name: 'cheap' }), steps.modelVerifier({ agent: 'reviewer' })]);
    const v = await chain(M.makeStep({ rationale: 'x' }), { task: 't', deps: mock({ reviewer: 'STATUS: CORRECT\nSCORE: 1' }, seen), budget: createBudget({ maxCalls: 5 }) });
    assert(v.status === 'INCORRECT' && v.verifier === 'cheap', 'the FIRST non-abstaining verifier wins the chain');
    assert(seen.length === 0, 'and because the cheap deterministic rule answered, the model was never called — every step a rule settles is a call not spent');

    const empty = await steps.chainVerifiers([])(M.makeStep({}), {});
    assert(empty.status === 'AMBIGUOUS', 'a chain where everything abstained is AMBIGUOUS — nobody approved anything');
  }
  {
    // A verifier whose model call fails has NOT approved the step.
    const v = await steps.modelVerifier({ agent: 'reviewer' })(
      M.makeStep({ rationale: 'x' }),
      { task: 't', deps: mock({ reviewer: null }), budget: createBudget({ maxCalls: 3 }) });
    assert(v.status === 'AMBIGUOUS' && v.score === 0 && /verifier unavailable/.test(v.feedback),
      'an UNAVAILABLE verifier produces AMBIGUOUS at score 0 — a missing verdict is a block, never a silent ship');
  }

  // =============================================================================================
  //  VERIFIED STEPS — the PRM gate, and the ordering that is the whole safety argument
  // =============================================================================================
  {
    const ran = [];
    const r = await steps.runVerifiedSteps('build it', mock({
      architect: '1. do A\n2. do B',
      coder: (t) => (/do A/.test(t) ? 'Reasoned about A.\nACTION: touch a.txt' : 'Reasoned about B.\nACTION: touch b.txt'),
      // A fails, B would pass — but the run halts at A, so B never happens.
      reviewer: (t) => (/do A|about A/.test(t) ? 'STATUS: INCORRECT\nSCORE: 0.1\nFEEDBACK: A is wrong' : 'STATUS: CORRECT\nSCORE: 0.95'),
    }), { onFail: 'halt', maxRevisions: 0, executeAction: async (a) => { ran.push(a); return { ok: true }; } });

    assert(r.ok === false, 'a run whose first step fails verification is not ok');
    assert(r.haltedAt === 0 && r.trace.outcome === 'halted', `it halted AT the failing step (index ${r.haltedAt}), rather than carrying on`);
    assert(ran.length === 0,
      `NO ACTION RAN (ran: ${JSON.stringify(ran)}) — the rejected step's action was dropped, not executed-then-regretted. This ordering is the entire safety value of process supervision.`);
    assert(r.trace.steps[0].metadata.actionResult === 'dropped — step did not verify',
      'and the trace SAYS the action was dropped, so a reader can tell "never ran" from "ran and failed"');
    assert(r.trace.steps.length === 1, 'the second step was never attempted after the halt');
  }
  {
    const ran = [];
    const r = await steps.runVerifiedSteps('build it', mock({
      architect: '1. do A\n2. do B',
      coder: 'Sound reasoning.\nACTION: touch x.txt',
      reviewer: 'STATUS: CORRECT\nSCORE: 0.95',
    }), { executeAction: async (a) => { ran.push(a); return { ok: true, output: 'created' }; } });

    assert(r.ok === true && r.trace.outcome === 'solved', 'a fully verified run is solved');
    assert(ran.length === 2 && ran[0] === 'touch x.txt', `both verified actions ran (${JSON.stringify(ran)})`);
    assert(r.trace.steps[0].metadata.actionResult === 'ok' && r.trace.steps[0].metadata.actionOutput === 'created',
      'the action result and its output are recorded on the step');
    assert(M.traceIsClean(r.trace).clean === true, 'and the finished trace is clean, which is what makes it eligible for the STaR corpus');
  }
  {
    // onFail:'revise' must carry the critique INTO the retry, or it is a blind retry.
    const seen = [];
    let call = 0;
    const r = await steps.runVerifiedSteps('build it', mock({
      architect: '1. only step',
      coder: 'attempt',
      reviewer: () => (++call === 1 ? 'STATUS: INCORRECT\nSCORE: 0.1\nFEEDBACK: you ignored the null case' : 'STATUS: CORRECT\nSCORE: 0.9'),
    }, seen), { onFail: 'revise', maxRevisions: 1 });

    assert(r.ok === true && r.revisions === 1, `the step was revised once and then passed (revisions=${r.revisions})`);
    const retryPrompt = seen.filter((s) => s.agent === 'coder')[1].task;
    assert(/you ignored the null case/.test(retryPrompt),
      'THE CRITIQUE IS IN THE RETRY PROMPT — without it this is the same coin flip twice, which is the exact failure lib/outcomes/intake.js already named');
  }
  {
    const r = await steps.runVerifiedSteps('t', mock({ architect: '1. a\n2. b', coder: 'x', reviewer: 'STATUS: INCORRECT\nSCORE: 0' }), { onFail: 'continue', maxRevisions: 0 });
    assert(r.trace.steps.length === 2 && r.ok === false,
      "onFail:'continue' keeps going through failing steps but the run is still not ok — the trace records two failures rather than hiding them");
  }
  {
    const r = await steps.runVerifiedSteps('t', mock({ architect: null }), {});
    assert(r.ok === false && /decomposition/.test(r.trace.meta.error), 'a failed decomposition halts with a stated reason rather than running zero steps and reporting success');
  }
  {
    const r = await steps.runVerifiedSteps('t', mock({ architect: '1. a\n2. b\n3. c', coder: 'x', reviewer: 'STATUS: CORRECT\nSCORE: 1' }), { budget: createBudget({ maxCalls: 3 }) });
    assert(r.trace.outcome === 'exhausted', `a run that runs out of budget reports outcome "exhausted" (got "${r.trace.outcome}") — which is NOT the same as failing, and a caller must be able to tell them apart`);
    assert(r.ok === false, 'and an exhausted run is still not a success');
  }

  // =============================================================================================
  //  REFLEXION — episodic memory, and the loop that must not be a blind retry
  // =============================================================================================
  {
    const mem = reflexion.createEpisodicMemory({ maxLessons: 2 });
    mem.add('always check the null case');
    mem.add('Always Check   The Null Case');
    assert(mem.size === 1, 'a near-identical lesson is de-duplicated — two copies of one lesson read as emphasis and make the model over-correct on it');
    assert(mem.all()[0].repeats === 1, 'but the repeat is COUNTED, so a recurring mistake is visible rather than discarded');
    mem.add('b'); mem.add('c');
    assert(mem.size === 2 && !mem.format().includes('null case'),
      'the buffer is capped and evicts oldest-first — an unbounded critique buffer is how a reflexion loop becomes a context-bloat machine');
    assert(reflexion.createEpisodicMemory().format() === '', 'an empty memory formats to the EMPTY STRING, so nothing is injected when there is nothing to say');
  }
  {
    assert(reflexion.parseEvaluation('').passed === false, 'an unreadable evaluation is a FAIL, never a pass');
    assert(reflexion.parseEvaluation('VERDICT: PASS\nSCORE: 0.9').passed === true, 'a well-formed pass parses');
    assert(reflexion.parseEvaluation('VERDICT: PASS\nSCORE: 0.2').passed === false,
      'PASS with a score below the floor is a FAIL — the score is the tiebreak against a confidently-worded verdict');
  }
  {
    const seen = [];
    let n = 0;
    // A DISTINCT reflector agent, not the actor. Using 'coder' for both made the mock answer the
    // reflect prompt with an actor reply, and the lesson silently became the text of the first
    // attempt — which still produced a passing loop. The three roles are separate in the engine, so
    // they must be separate in the fixture, or the test cannot see them blur.
    const r = await reflexion.reflexionLoop('write the thing', mock({
      coder: (t) => (/LESSONS FROM YOUR PREVIOUS/.test(t) ? 'second, corrected attempt' : 'first attempt'),
      reviewer: () => (++n === 1 ? 'VERDICT: FAIL\nSCORE: 0.2\nCRITIQUE: it drops the error path' : 'VERDICT: PASS\nSCORE: 0.9\nCRITIQUE: fine'),
      writer: 'Handle the error path explicitly before returning.',
    }, seen), { maxAttempts: 3, reflector: 'writer' });

    assert(r.ok === true && r.attempts === 2, `it passed on the second attempt (attempts=${r.attempts})`);
    assert(r.output === 'second, corrected attempt', 'the RETURNED output is the passing attempt, not the first one');
    assert(r.lessons.length === 1 && r.lessons[0] === 'Handle the error path explicitly before returning.',
      `the banked lesson is the REFLECTOR's transferable instruction, not the actor's output (${JSON.stringify(r.lessons)})`);

    const secondActorPrompt = seen.filter((s) => s.agent === 'coder')[1].task;
    assert(/LESSONS FROM YOUR PREVIOUS ATTEMPTS/.test(secondActorPrompt),
      'THE SECOND ATTEMPT CARRIES THE EPISODIC BLOCK — this is the difference between Reflexion and a retry loop, and without this assertion the two are indistinguishable from the outside');
    assert(/Handle the error path explicitly/.test(secondActorPrompt),
      '...and the block contains the actual lesson distilled from the failed attempt');
    assert(r.trace.verifications[0].status === 'INCORRECT' && r.trace.verifications[1].status === 'CORRECT',
      'the trace records the per-attempt verdicts, so the history is inspectable rather than just the final answer');
  }
  {
    // Nothing passes: the loop must return the BEST attempt, not the most recent one.
    let n = 0;
    const scores = [0.3, 0.8, 0.1];
    const r = await reflexion.reflexionLoop('t', mock({
      coder: () => `attempt-${n}`,
      reviewer: () => `VERDICT: FAIL\nSCORE: ${scores[n++] ?? 0}\nCRITIQUE: no`,
    }), { maxAttempts: 3, reflector: 'coder' });

    assert(r.ok === false && r.attempts === 3, 'three attempts, none passing');
    assert(r.output === 'attempt-1',
      `the best-scoring attempt (0.8, index 1) is returned, not the last one (0.1) — got "${r.output}". The final attempt is not automatically the best, and silently returning it throws away work the evaluator rated higher.`);
  }
  {
    // The evaluator is the gate: if IT fails, nothing was approved.
    const r = await reflexion.reflexionLoop('t', mock({ coder: 'looks great', reviewer: null }), { maxAttempts: 1 });
    assert(r.ok === false && /evaluator unavailable/.test(r.evaluation.critique),
      'an unavailable EVALUATOR fails the attempt — an unreachable gate approves nothing, even though the actor produced output');
  }
  {
    // A failed reflector must not cost us the failure itself.
    const r = await reflexion.reflexionLoop('t', mock({
      coder: 'attempt', reviewer: 'VERDICT: FAIL\nSCORE: 0.1\nCRITIQUE: the real problem is X', writer: null,
    }), { maxAttempts: 1, reflector: 'writer' });
    assert(r.lessons.length === 1 && /the real problem is X/.test(r.lessons[0]),
      "when the REFLECTOR is unavailable the evaluator's critique is banked as the lesson — degraded, not lost");
  }
  {
    const r = await reflexion.reflexionLoop('t', mock({ coder: 'x', reviewer: 'VERDICT: FAIL\nSCORE: 0.1\nCRITIQUE: no' }), { maxAttempts: 6, budget: createBudget({ maxCalls: 4 }) });
    assert(r.exhausted === true && r.trace.outcome === 'exhausted',
      'the loop STOPS when the budget dies rather than grinding out attempts it cannot pay for, and says so');
  }

  // =============================================================================================
  //  CONTEXT MANAGER — the four segments, the eviction order, and the invariant
  // =============================================================================================
  {
    assert(SEGMENTS.length === 4, 'four segments: instructions, longterm, episodic, scratchpad');
    assert(!EVICTION_ORDER.includes('instructions'),
      'INSTRUCTIONS IS ABSENT FROM THE EVICTION ORDER BY DESIGN — the segment holding "never do X without asking" must not be the one that silently disappears under memory pressure');
    assert(EVICTION_ORDER[0] === 'scratchpad', 'the volatile working set is dropped first');
  }
  {
    const cm = createContextManager({ maxTokens: 600 });
    cm.setInstructions('RULES: never delete without asking. '.repeat(10));
    for (let i = 0; i < 40; i++) cm.note(`scratch note number ${i} with some filler text to take up room`);
    for (let i = 0; i < 10; i++) cm.recall(`prior finding ${i} with filler`);

    const before = cm.usage().total;
    const out = cm.assemble();
    assert(before > 600, `the manager was genuinely over budget before assembly (${before} > 600) — otherwise this test proves nothing`);
    assert(/never delete without asking/.test(out.system),
      'THE RULES SURVIVED EVICTION. This is the invariant the whole file is for: a context-budget optimisation that can drop the safety rules is a safety regression no test would catch, because the run still succeeds.');
    assert(out.stats.evicted.scratchpad > 0, `scratchpad entries were evicted first (${out.stats.evicted.scratchpad} of them)`);
    assert(out.stats.evicted.scratchpad >= out.stats.evicted.episodic,
      'and scratchpad was hit at least as hard as episodic, matching the declared order');
  }
  {
    const cm = createContextManager({ maxTokens: 500 });
    cm.setInstructions('x'.repeat(8000));   // instructions alone blow the entire budget
    const out = cm.assemble();
    assert(out.overBudget === true && out.fits === false,
      'when the budget CANNOT be met with instructions intact, assemble() reports overBudget and lets the caller decide — it never quietly trims the rules to fit');
    assert(out.system.length === 8000, 'and the instructions are returned whole, not truncated');
  }
  {
    const cm = createContextManager({ maxTokens: 4000 });
    cm.setInstructions('RULES').remember('decided to use sqlite').recall('lesson one').note('working note');
    const out = cm.assemble();
    assert(out.system === 'RULES',
      'ONLY instructions land in the cacheable prefix — server.js:4048 warns that getting this split backwards is "a guaranteed cache miss on every request, reported by nothing"');
    assert(/decided to use sqlite/.test(out.volatile) && /lesson one/.test(out.volatile) && /working note/.test(out.volatile),
      'everything that changes between calls lands in the volatile block');
    assert(!/decided to use sqlite/.test(out.system), 'and no volatile content leaks into the prefix');

    cm.clearScratchpad();
    assert(!/working note/.test(cm.assemble().volatile), 'clearScratchpad() discards the working set at a step boundary — that is what makes it volatile');
    assert(/decided to use sqlite/.test(cm.assemble().volatile), '...while long-term memory survives the step boundary');
  }
  {
    const cm = createContextManager({ maxTokens: 8000 });
    for (let i = 0; i < 6; i++) cm.remember(`Investigated option ${i} at length, weighing throughput against operational cost, and recorded the reasoning in full detail here.`);
    const b = createBudget({ maxCalls: 2 });
    const r = await cm.compress(mock({ synthesis: 'Chose sqlite; ruled out mongo; API is rate limited.' }), b);
    assert(r.compressed === true && r.saved > 0, `compression replaced six notes with one summary and saved ${r.saved} estimated tokens`);
    assert(/Chose sqlite/.test(cm.assemble().volatile), 'the rolling summary is what remains');

    // A summariser that returns MORE than it replaced must be refused, not celebrated.
    const cm3 = createContextManager({ maxTokens: 8000 });
    cm3.remember('short a').remember('short b');
    const r3 = await cm3.compress(mock({ synthesis: 'An extremely verbose restatement that is very much longer than the two short notes it claims to be compressing, at considerable length.' }), createBudget({ maxCalls: 2 }));
    assert(r3.compressed === false && /not smaller/.test(r3.reason),
      `a summary bigger than its input is REFUSED (${r3.reason}) — otherwise we pay for a call, lose the detail, and end up with a larger context, reported as a success`);
    assert(cm3.usage().per.longterm.entries === 2, '...and the originals are kept');

    const cm2 = createContextManager({ maxTokens: 4000 });
    cm2.remember('a').remember('b');
    const r2 = await cm2.compress(mock({ synthesis: null }), createBudget({ maxCalls: 2 }));
    assert(r2.compressed === false && cm2.usage().per.longterm.entries === 2,
      'a FAILED compression leaves the originals in place — losing history to a broken summariser would be worse than staying over budget');
  }

  // =============================================================================================
  //  THE FRAMEWORK ENTRY POINT
  // =============================================================================================
  {
    assert(R.MODES.join(',') === 'direct,steps,reflexion,tot,deliberate', `the five modes are reachable by name (${R.MODES.join(', ')})`);
    const r = await R.reason('hello', mock({ coder: 'hi there' }), { mode: 'direct' });
    assert(r.ok && r.output === 'hi there' && r.budget.calls === 1, 'direct mode is exactly one call — the baseline every other mode is measured against');

    const unknown = await R.reason('hello', mock({ coder: 'hi' }), { mode: 'telepathy' });
    assert(unknown.mode === 'direct', 'an unknown mode falls back to direct rather than throwing mid-pipeline');
  }
  {
    const r = await R.reason('build', mock({
      architect: '1. a', coder: 'reasoning', reviewer: 'STATUS: CORRECT\nSCORE: 0.9',
    }), { mode: 'steps' });
    assert(r.ok && /1\. reasoning/.test(r.output) && r.trace.outcome === 'solved', 'steps mode returns a rendered trace as its output');
    assert(r.budget.calls === 3, `and reports its REAL cost: ${r.budget.calls} calls for a 1-step task (decompose + act + verify), not the 1 a caller might assume`);
  }

  // =============================================================================================
  //  REGRESSIONS FROM THE FIRST LIVE RUN (2026-09-02) — real model output, not invented fixtures
  // =============================================================================================
  // tools/verify-reasoning-live.js made 9 real calls and 2 of 7 formats failed. Both failures were
  // invisible to every mock in this file, because a mock only ever sends what its author already
  // expected. These fixtures are the ACTUAL bytes the model sent.
  {
    // 1. THE PARSER WAS TOO STRICT. Asked for numbered steps, Opus replied in markdown-bold with an
    //    em-dash. The old pattern matched nothing, fell through to the "unstructured prose" branch,
    //    and returned the whole reply as ONE step — a three-step plan silently became one step.
    const REAL = '**Step 1 — Establish the actual code path of the nightly export job** (trigger → write → exit).\n'
      + '**Step 2 — Confirm whether the write path is reachable** by checking volume state.\n'
      + '**Step 3 — Reproduce with a forced run** and compare output.';
    const parsed = steps.parseSteps(REAL);
    assert(parsed.length === 3, `markdown-bold "**Step N — ..." parses as ${parsed.length} steps (must be 3) — this exact string collapsed to 1 in production`);
    assert(/Establish the actual code path/.test(parsed[0]) && !/^\*\*/.test(parsed[0]), `the marker is stripped, leaving the step text: "${parsed[0].slice(0, 50)}"`);
    assert(!/\*\*\s*$/.test(parsed[0]),
      `and the CLOSING ** is stripped too ("...${parsed[0].slice(-22)}") — a dangling emphasis marker would ride into every downstream prompt and into saved STaR traces`);
    assert(M.parseList('## 3) heading form', 5)[0] === 'heading form', 'markdown headings around a number are handled as well');

    // The tolerance is shared, so ToT gets it too — that is the point of one parseList.
    assert(tot.parseThoughts('**Thought 1 — alpha**\n**Thought 2 — beta**', 5).length === 2,
      'tot.parseThoughts accepts the same shapes — one shared definition means the two engines cannot drift apart in what they accept');

    // Still not loose enough to turn prose into a list.
    assert(steps.parseSteps('The job writes to /export and the volume is full.').length === 1,
      'ordinary prose is still ONE step, not several — widening tolerance must not make sentences into steps');
    assert(steps.parseSteps('1. alpha\n2. beta').length === 2, 'plain numbering still works');
    assert(steps.parseSteps('- alpha\n- beta').length === 2, 'plain bullets still work');
    assert(steps.parseSteps('* alpha\n* beta').length === 2, 'single-asterisk bullets still work — and are not confused with ** emphasis');
  }
  {
    // 2. THE EMPTY RESPONSE. `reviewer` runs at effort: xhigh; the PRM verifier gave it maxTokens
    //    400; adaptive thinking is charged against the same ceiling, so the answer came back "".
    //    That became an AMBIGUOUS verdict — indistinguishable from "answered but unreadable", which
    //    is a completely different problem with a completely different fix. FOURTH occurrence of
    //    this failure shape in this project; every previous one presented as a plausible success.
    const b = createBudget({ maxCalls: 3 });
    const r = await guardedCall(mock({ reviewer: '' }), b, 'reviewer', 'judge this');
    assert(r.ok === false && r.emptyResponse === true,
      'an EMPTY but "successful" reply is converted to a failure — it is not a success in any sense a caller cares about');
    assert(/maxTokens was too small/.test(r.error),
      `the error names the LIKELY CAUSE, because "unparseable verdict" points at the wrong fix: "${r.error.slice(0, 60)}..."`);
    assert(b.snapshot().calls === 1, 'and it is still metered — an empty reply cost money');

    const ws = await guardedCall(mock({ reviewer: '   \n  ' }), createBudget({ maxCalls: 2 }), 'reviewer', 't');
    assert(ws.emptyResponse === true, 'whitespace-only counts as empty — a reply of three spaces is not an answer');

    // It must reach the caller as a NAMED unavailability, not a silent AMBIGUOUS.
    const v = await steps.modelVerifier({ agent: 'reviewer' })(
      M.makeStep({ rationale: 'x' }), { task: 't', deps: mock({ reviewer: '' }), budget: createBudget({ maxCalls: 3 }) });
    assert(v.status === 'AMBIGUOUS' && /EMPTY response/.test(v.feedback),
      'the PRM gate still refuses the step (fail-safe intact) but now SAYS the verifier came back empty, instead of implying the model wrote something unreadable');
  }
  {
    // The headroom itself. These are the numbers that were wrong; assert them so a future
    // "tidy up the magic numbers" pass cannot quietly put a 400 back.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'reasoning', 'steps.js'), 'utf8');
    const m = src.match(/modelVerifier\(\{[^}]*maxTokens = (\d+)/);
    assert(m && Number(m[1]) >= 1500,
      `the PRM verifier's default maxTokens is >= 1500 (found ${m && m[1]}) — at 400 an xhigh reviewer's adaptive thinking consumed the entire budget and returned nothing`);
  }

  // =============================================================================================
  //  THE DEMO IS A DELIVERABLE, SO IT IS TESTED
  // =============================================================================================
  // tools/test-all.js only discovers `test-*.js`, so tools/demo-reasoning.js runs in NO gate. It
  // shipped once already claiming to show eviction under memory pressure while evicting nothing:
  // 30 working notes came to ~612 tokens against a 700-token cap, so the window was never full and
  // "the safety rules survived" was vacuously true. The demo is how a reader understands this
  // subsystem, so a demo that quietly demonstrates nothing is a documentation defect — and the only
  // thing that catches it is asserting on what it PRINTS.
  {
    const { execFileSync } = require('child_process');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [require('path').join(__dirname, 'demo-reasoning.js')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = e.status || 1;
    }
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    assert(code === 0, `the demo exits 0 (got ${code})`);
    assert(/backtracks:\s*1\b/.test(plain), 'the demo really backtracks once, rather than narrating that it does');
    assert(/← DROPPED/.test(plain) && /grep suppress_empty/.test(plain),
      "the demo SHOWS the hallucinated step's action being dropped — the claim and the printed evidence must be the same thing");

    const over = plain.match(/before:\s*~(\d+) tokens against a (\d+)-token window/);
    assert(over && Number(over[1]) > Number(over[2]),
      `the demo's context section is GENUINELY over budget (${over && over[1]} vs ${over && over[2]}) — a demonstration that cannot fail demonstrates nothing`);
    const eviction = plain.match(/evicted:\s*scratchpad (\d+)/);
    assert(eviction && Number(eviction[1]) > 0, `...and really evicts (${eviction && eviction[1]} scratchpad entries)`);
    assert(/instructions kept:\s*YES/.test(plain) && !/INVARIANT VIOLATED/.test(plain),
      'and the safety rules survive that real pressure — which is the whole point of the section');
    assert(/Nothing was spent/.test(plain), 'the demo completes to its own final line, so nothing above it threw silently');
  }

  done();
})();
