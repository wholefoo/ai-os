// Web Studio builds on OpenAI GPT-6 Astra at reasoning_effort 'low' (operator decision 2026-09-07).
//
// Pinned here: the model id and effort actually sent to OpenAI, the PRICE (asserted as values, not
// as "a rate exists" — a missing rung does not error, it silently re-bills at the opus-5-high
// fallback and would under-report this model by half), that the OpenAI CONSULTANT is unchanged, that
// a missing key degrades to Anthropic instead of failing every build, and that the route's three
// model choices each map to a known string.
'use strict';
const assert = require('assert/strict');
const vm = require('vm');
const path = require('path');
const { serverSource } = require('./test-util');

const src = serverSource();
const noop = () => {};
let pass = 0;
const ok = (label) => { console.log('ok  : ' + label); pass++; };

function slice(from, to) {
  const a = src.indexOf(from);
  assert(a >= 0, `anchor not found: ${from}`);
  const b = src.indexOf(to, a);
  assert(b > a, `end anchor not found: ${to}`);
  return src.slice(a, b);
}

// --- price, by VALUE ---------------------------------------------------------------------------
const rates = slice('const COST_RATES = {', '\n};');
for (const rung of ['low', 'medium', 'high', 'xhigh', 'max']) {
  const row = new RegExp(`'gpt-6-astra-${rung}':\\s*\\{ input: 10\\.00, output: 50\\.00 \\}`);
  assert(row.test(rates), `gpt-6-astra-${rung} is priced $10/$50 — a missing rung re-bills at the opus fallback`);
}
ok('all five Astra effort rungs are priced $10/$50 — no rung can miss the table');
assert(/'gpt-5\.6-terra':\s*\{ input: 2\.50,\s*output: 15\.00 \}/.test(rates),
  'the existing OpenAI consultant rate is untouched');
ok('gpt-5.6-terra pricing is unchanged');

// --- the ledger string the branch writes must be one of the priced keys -------------------------
assert(/const ASTRA_MODEL = 'gpt-6-astra';/.test(src) && /const ASTRA_EFFORT = 'low';/.test(src),
  'the model id and effort are named constants');
assert(/model = `\$\{ASTRA_MODEL\}-\$\{ASTRA_EFFORT\}`;/.test(src),
  "the ledger string is `${ASTRA_MODEL}-${ASTRA_EFFORT}` — i.e. exactly the priced key 'gpt-6-astra-low'");
ok('the ledger model string resolves to a priced COST_RATES key');

// --- what actually reaches OpenAI ---------------------------------------------------------------
(async () => {
  const captured = [];
  function ctx(extra) {
    return vm.createContext({
      console, Date, Math, JSON, Set, Map, URL, path, Promise,
      require, process: { env: {} }, logActivity: noop, broadcast: noop, appendLog: noop,
      saveState: () => true, scheduleAutoSave: noop, sendNotification: noop,
      AGENT_MAX_TOKENS_CEILING: 32000,
      getAgentEffort: () => ({ tier: 'strategic', model: 'test' }),
      hardBudgetTrippedPeriod: () => null,
      loadAgentPrompt: async () => 'base',
      fenceUntrusted: () => ({ blocks: '', guard: '' }),
      acquireAgentSlot: async () => {}, releaseAgentSlot: noop,
      CONSULTANT_PROVIDER: {},
      costRateFor: () => ({ input: 10, output: 50 }),
      promptCache: { priceUsage: () => ({ cost: 1, inputTokens: 1, outputTokens: 1 }) },
      costLedger: [], uuidv4: () => 'id',
      resolveAnthropicModel: () => ({ apiModel: 'claude-opus-5', effort: 'xhigh', modelString: 'opus-5-xhigh' }),
      anthropicLedgerString: (m, e) => `${m}-${e}`,
      OVERRIDABLE_ANTHROPIC_MODELS: new Set(['claude-fable-5']),
      ASTRA_MODEL: 'gpt-6-astra', ASTRA_EFFORT: 'low', _warnedAstraFallback: false,
      callOpenAI: async (system, task, maxTokens, opts) => { captured.push(opts); return { content: 'ok' }; },
      callAnthropic: async () => { captured.push({ anthropic: true }); return { content: 'ok' }; },
      buildMcpToolset: () => ({ tools: [], map: {} }),
      buildRepoToolset: () => ({ tools: [], names: new Set() }),
      ...extra,
    });
  }
  function loadExecuteAgent(c) {
    const start = src.search(/async function executeAgent\(/);
    assert(start >= 0);
    vm.runInContext(src.slice(start, src.indexOf('\n}\n', start) + 3), c);
    return c;
  }

  // WITH a key -> OpenAI, carrying the model and the effort.
  let c = ctx({ settings: { ai: { openai_api_key: 'synthetic' } } });
  loadExecuteAgent(c);
  let r = await c.executeAgent('web-studio-lead', 'build a site', { modelOverride: 'gpt-6-astra' });
  assert.equal(r.ok, true);
  assert.equal(captured.length, 1);
  // Field-by-field, not deepEqual: the opts object is built INSIDE the vm realm, so its prototype is
  // a different Object and a strict deep compare fails on identical values.
  assert.equal(captured[0].model, 'gpt-6-astra', `model sent to OpenAI: ${JSON.stringify(captured[0])}`);
  assert.equal(captured[0].reasoningEffort, 'low', `effort sent to OpenAI: ${JSON.stringify(captured[0])}`);
  assert.equal(c.costLedger[0].model, 'gpt-6-astra-low', 'the ledger row names the priced key');
  ok('with an OpenAI key, a Web Studio build calls OpenAI with gpt-6-astra + reasoning_effort low');

  // WITHOUT a key -> falls through to Anthropic rather than failing the build.
  captured.length = 0;
  c = ctx({ settings: { ai: { openai_api_key: '' } } });
  loadExecuteAgent(c);
  r = await c.executeAgent('web-studio-lead', 'build a site', { modelOverride: 'gpt-6-astra' });
  assert.equal(r.ok, true, 'a missing key must not fail the build');
  assert.equal(captured.length, 1, 'exactly one provider call');
  assert.equal(captured[0].anthropic, true, 'it fell through to Anthropic');
  assert.equal(c.costLedger[0].model, 'opus-5-xhigh', 'and ledgers the model it ACTUALLY used');
  ok('without an OpenAI key it degrades to Anthropic and ledgers the model actually used');

  // --- reasoning_effort is only sent when asked for -------------------------------------------
  const openai = slice('async function callOpenAI(', '\n}');
  assert(/opts\.model \|\| 'gpt-5\.6-terra'/.test(openai), 'the consultant default model is unchanged');
  assert(/extraBody: opts\.reasoningEffort \? \{ reasoning_effort: opts\.reasoningEffort \} : null/.test(openai),
    'reasoning_effort is omitted entirely unless a caller asks — gpt-5.6-terra would reject the field');
  ok('callOpenAI sends reasoning_effort only when requested; the consultant path is untouched');

  // --- the route's three choices ----------------------------------------------------------------
  assert(/const modelOverride = model === 'fable' \? FABLE_MODEL : model === 'claude' \? null : ASTRA_MODEL;/.test(src),
    "the create route maps 'fable' -> Fable 5, 'claude' -> default routing, anything else -> Astra");
  assert(/buildModel: modelOverride === FABLE_MODEL \? 'Fable 5' : modelOverride === ASTRA_MODEL \? 'GPT-6 Astra \(low\)' : null/.test(src),
    'the stored build label distinguishes all three, so the UI cannot claim Fable for an Astra build');
  ok("the route defaults to Astra, keeps 'fable', and 'claude' opts back out");

  console.log(`\nALL TESTS PASSED\n${pass} assertions`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
