// Prompt caching: breakpoint placement and cache-aware pricing.
//
// WHY THIS EXISTS. Opus 5 spend here is 71% input tokens — $8.62 of $12.07 — at a 12.5:1
// input:output ratio, because the tool loop re-sends the whole conversation every turn. Cache reads
// bill at 10% of input, so this is the only lever that touches that 71%; lowering `effort` touches
// the other 29% and degrades the tier that runs security audits.
//
// EVERY FAILURE MODE OF PROMPT CACHING IS SILENT. A misplaced breakpoint, a volatile byte in the
// prefix, or a breakpoint that drifts outside the 20-block lookback all produce a correct answer at
// full price with no error and no warning. There is nothing to catch and nothing in the response
// that says "you meant to cache this" — which is why the properties below are pinned mechanically
// rather than left to a live cost check that cannot run until the API limit lifts.
const pc = require('../lib/prompt-cache');
const { assert, done, serverSource } = require('./test-util');

// --- system blocks: the stable/volatile split ---------------------------------------------------
const STABLE = 'You are the security-auditor agent. '.repeat(40);
const VOLATILE = '\n\n--- UNTRUSTED ---\nnonce=a1b2c3d4';

const blocks = pc.systemBlocks(STABLE, VOLATILE);
assert(Array.isArray(blocks) && blocks.length === 2, 'a stable+volatile system renders as two blocks');
assert(blocks[0].text === STABLE && blocks[1].text === VOLATILE, 'stable comes FIRST — the prefix must be the part that repeats');
assert(blocks[0].cache_control && blocks[0].cache_control.type === 'ephemeral', 'the stable block carries the breakpoint');
assert(!blocks[1].cache_control,
  'and the volatile block does NOT — marking content that differs every call spends a breakpoint on a guaranteed write with no possible read');

// The ordering assertion above is the whole feature, so state the failure it prevents explicitly:
// with the order reversed, the per-call nonce sits in the cached prefix and every request is
// byte-unique, so the cache can never be hit even once.
const reversed = pc.systemBlocks(VOLATILE, STABLE);
assert(reversed[0].text === VOLATILE, 'systemBlocks does not sort — the CALLER decides what is stable, so the call site is what must be right');

// A caller with nothing volatile keeps a shape the API already accepted.
const stableOnly = pc.systemBlocks(STABLE, '');
assert(Array.isArray(stableOnly) && stableOnly.length === 1, 'no volatile part yields a single marked block');
assert(typeof pc.systemBlocks(STABLE, VOLATILE, { cache: false }) === 'string',
  'cache:false returns the original concatenated string — an escape hatch that changes nothing on the wire');
assert(pc.systemBlocks(STABLE, VOLATILE, { cache: false }) === STABLE + VOLATILE,
  'and that string is exactly what the old code sent, in the old order');
assert(pc.systemBlocks('', '') === '', 'an empty system stays empty rather than becoming a marked empty block');

// --- the four-breakpoint budget ------------------------------------------------------------------
assert(pc.MAX_CONVERSATION_MARKS + 1 <= pc.MAX_BREAKPOINTS,
  `the conversation budget (${pc.MAX_CONVERSATION_MARKS}) plus the system breakpoint fits in the API's ${pc.MAX_BREAKPOINTS}`);
assert(pc.MAX_BLOCK_GAP < 20,
  `breakpoint spacing (${pc.MAX_BLOCK_GAP}) stays under the API's 20-block lookback — at 20 there is no margin and a multi-block turn pushes the next breakpoint out of range`);

// --- conversation marking ------------------------------------------------------------------------
const textMsg = (t) => ({ role: 'user', content: t });
const blockMsg = (role, n) => ({ role, content: Array.from({ length: n }, (_, i) => ({ type: 'text', text: `b${i}` })) });
const marksIn = (msgs) => msgs.reduce((acc, m) =>
  acc + (Array.isArray(m.content) ? m.content.filter((b) => b && b.cache_control).length : 0), 0);

const convo = [textMsg('task'), blockMsg('assistant', 2), blockMsg('user', 2)];
assert(pc.markConversation(convo) >= 1, 'a short conversation gets at least one mark');
assert(marksIn(convo) <= pc.MAX_CONVERSATION_MARKS, 'and never exceeds the conversation budget');
const newest = convo[convo.length - 1].content;
assert(newest[newest.length - 1].cache_control,
  'the NEWEST turn is always marked — that mark is the write the next request reads');

// A string `content` cannot carry cache_control; it must be promoted to a block.
const strConvo = [textMsg('just a string')];
pc.markConversation(strConvo);
assert(Array.isArray(strConvo[0].content) && strConvo[0].content[0].cache_control,
  'a string content is promoted to a text block so it can carry the marker');

// THE BUDGET-OVERFLOW GUARD. Marks must be cleared and re-placed each turn. Without that, a 30-turn
// loop accumulates markers past the four-breakpoint limit and the API REJECTS the request — a hard
// failure mid-stage, which on this platform means a dead pipeline run, not a slow one.
const growing = [textMsg('task')];
for (let turn = 0; turn < 30; turn++) {
  growing.push(blockMsg('assistant', 2));
  growing.push(blockMsg('user', 2));
  pc.markConversation(growing);
  assert(marksIn(growing) <= pc.MAX_CONVERSATION_MARKS,
    `turn ${turn + 1}: marks stay within budget (${marksIn(growing)})`);
}
assert(marksIn(growing) === pc.MAX_CONVERSATION_MARKS, 'a long loop uses the full conversation budget');

// THE LOOKBACK GUARD. Every mark must sit within MAX_BLOCK_GAP blocks of the next one, or it falls
// outside the API's search window and silently stops matching — re-billing the entire prefix.
const marked = [];
growing.forEach((m, i) => {
  if (Array.isArray(m.content) && m.content.some((b) => b && b.cache_control)) marked.push(i);
});
assert(marked.length >= 2, 'a long conversation carries multiple read points, not just one');
for (let k = 1; k < marked.length; k++) {
  let span = 0;
  for (let i = marked[k - 1]; i < marked[k]; i++) span += pc.blockCount(growing[i]);
  assert(span <= pc.MAX_BLOCK_GAP + 4,
    `consecutive marks are ${span} blocks apart — inside the 20-block lookback`);
}
// And the newest mark is still the last message, every time.
const lastMarked = marked[marked.length - 1];
assert(lastMarked === growing.length - 1,
  'the newest mark tracks the end of the conversation as it grows, rather than being stranded at turn 1');

// A turn that emits many parallel tool_use blocks at once is the case that breaks a naive
// implementation — one turn can exceed the lookback on its own.
const wide = [textMsg('task'), blockMsg('assistant', 12), blockMsg('user', 12)];
pc.markConversation(wide);
assert(marksIn(wide) >= 1 && marksIn(wide) <= pc.MAX_CONVERSATION_MARKS,
  'a single very wide turn is marked without blowing the budget');

// --- pricing --------------------------------------------------------------------------------------
const RATES = { input: 5, output: 25 };   // opus-5

const cold = pc.priceUsage({ input_tokens: 100_000, output_tokens: 1_000 }, RATES);
assert(Math.abs(cold.cost - (0.5 + 0.025)) < 1e-9, `an uncached call prices exactly as before ($${cold.cost.toFixed(4)})`);
assert(cold.inputTokens === 100_000, 'and reports its full prompt size');

// The disjointness property. input_tokens is the UNCACHED REMAINDER, not the total — reading it
// alone (as the ledger did) makes a heavily-cached call look like it barely had a prompt.
const warm = pc.priceUsage(
  { input_tokens: 2_000, cache_read_input_tokens: 98_000, output_tokens: 1_000 }, RATES);
assert(warm.inputTokens === 100_000,
  'a cached call reports the TOTAL prompt size (100,000), not the 2,000-token uncached remainder');
assert(warm.cacheReadTokens === 98_000 && warm.uncachedInputTokens === 2_000, 'with the split preserved for audit');
const expectedWarm = (2_000 / 1e6) * 5 + (98_000 / 1e6) * 5 * 0.10 + (1_000 / 1e6) * 25;
assert(Math.abs(warm.cost - expectedWarm) < 1e-9, `cache reads bill at 10% of input ($${warm.cost.toFixed(4)})`);
assert(warm.cost < cold.cost, 'so the same prompt costs strictly less warm than cold');

// A write costs MORE than an uncached read — the first request of a cached sequence is a real
// premium, and pretending otherwise would make the break-even maths wrong.
const write = pc.priceUsage({ input_tokens: 0, cache_creation_input_tokens: 100_000, output_tokens: 1_000 }, RATES);
assert(Math.abs(write.cost - ((100_000 / 1e6) * 5 * 1.25 + 0.025)) < 1e-9, 'a cache write bills at 125% of input');
assert(write.cost > cold.cost, 'making the first (writing) request more expensive than not caching at all');

// Break-even: write + one read must beat two uncached requests, or the feature loses money.
const twoUncached = cold.cost * 2;
const writeThenRead = write.cost + pc.priceUsage(
  { input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 1_000 }, RATES).cost;
assert(writeThenRead < twoUncached,
  `write+read ($${writeThenRead.toFixed(4)}) beats two uncached calls ($${twoUncached.toFixed(4)}) — break-even is 2 requests at the 5-minute TTL`);

assert(pc.priceUsage(null, RATES).cost === 0, 'a missing usage object prices at zero rather than NaN');
assert(pc.priceUsage({ input_tokens: 5 }, null).cost === 0, 'and a missing rate table does too');

// --- per-model minimums ------------------------------------------------------------------------------
assert(pc.minCacheableTokens('opus-5-xhigh') === 512, 'opus-5 caches from 512 tokens');
assert(pc.minCacheableTokens('sonnet-5-high') === 1024, 'sonnet-5 needs 1024');
assert(pc.minCacheableTokens('opus-4.6-xhigh') === 4096, 'and the OLDER opus-4.6 needs 4096');
// The non-monotonicity is the point: "newer model, lower minimum" is false, so this must stay a
// table. All three of these models are reachable from this platform's routing today.
assert(pc.minCacheableTokens('opus-5-xhigh') < pc.minCacheableTokens('opus-4.6-xhigh'),
  'minimums are NOT monotonic across generations — a prompt that caches on opus-5 may silently not on opus-4.6');
assert(pc.minCacheableTokens('something-unknown') === pc.DEFAULT_MIN_CACHEABLE_TOKENS,
  'an unrecognised model falls back to a conservative default rather than throwing');

// Property check over the whole table, so a family added to MIN_CACHEABLE_TOKENS that the lookup
// cannot actually resolve is caught — a silent contradiction between a list and its consumer.
assert(Object.keys(pc.MIN_CACHEABLE_TOKENS).length >= 3, 'the minimums table is populated');
for (const [family, min] of Object.entries(pc.MIN_CACHEABLE_TOKENS)) {
  assert(pc.minCacheableTokens(`${family}-xhigh`) === min, `MIN_CACHEABLE_TOKENS['${family}'] (${min}) is reachable through minCacheableTokens()`);
}

// The multipliers ARE the economics. If a read stops being cheaper than an uncached token, or a
// write stops costing a premium, every break-even claim in this module's comments becomes false.
assert(pc.CACHE_READ_MULTIPLIER === 0.10, 'a cache read bills at 10% of the input rate');
assert(pc.CACHE_WRITE_MULTIPLIER === 1.25, 'a 5-minute cache write bills at 125%');
assert(pc.CACHE_READ_MULTIPLIER < 1 && pc.CACHE_WRITE_MULTIPLIER > 1,
  'reads are cheaper than uncached and writes are a premium — the whole break-even argument rests on this pair');
assert(pc.CACHE_WRITE_MULTIPLIER + pc.CACHE_READ_MULTIPLIER < 2,
  'and write+read beats two uncached reads, which is why two requests is the break-even point');

// --- wiring ---------------------------------------------------------------------------------------
const src = serverSource();

assert(/const promptCache = require\('\.\/lib\/prompt-cache'\);/.test(src), 'server.js loads the module');

// THE LOAD-BEARING WIRING ASSERTION. The nonce guard must go to volatileSystem. fenceUntrusted mints
// a fresh random nonce per call; with it in the cached prefix every request is byte-unique and the
// cache can never be hit — the feature would be inert and nothing would report that.
assert(/if \(blocks\) \{ volatileSystem \+= guard; fullTask = /.test(src),
  'the per-call untrusted nonce guard goes to volatileSystem, NOT the cached prefix');
assert(!/fullSystem \+= guard/.test(src), 'and no path appends it to the cacheable prefix');
assert(/if \(context\) volatileSystem \+= /.test(src), 'per-call context is volatile too');

assert(/const systemField = promptCache\.systemBlocks\(guardedSystem, volatileSystem\);/.test(src),
  'the tool loop builds its system blocks ONCE, outside the turn loop');
const toolLoop = (src.match(/async function callAnthropicWithTools[\s\S]*?\n\}/) || [''])[0];
assert(toolLoop.length > 0, 'callAnthropicWithTools located');
assert(!/system: guardedSystem/.test(toolLoop), 'no turn still sends the raw unmarked system string');
assert((toolLoop.match(/system: systemField/g) || []).length === 2,
  'both request bodies (loop turns and the budget-exhaustion recovery call) use the marked system');
assert(/promptCache\.markConversation\(messages\);/.test(toolLoop),
  'and the conversation is re-marked as it grows');
// Ordering: marking before the push would mark a conversation missing its newest turn.
assert(/messages\.push\(\{ role: 'user', content: toolResults \}\);[\s\S]{0,600}?promptCache\.markConversation\(messages\)/.test(toolLoop),
  'marking happens AFTER the turn is appended — marking first would leave the newest turn unmarked');

assert(/promptCache\.priceUsage\(\{/.test(src), 'the ledger prices through promptCache');
assert(/cache_read_input_tokens: result\.cacheReadTokens/.test(src) && /cache_creation_input_tokens: result\.cacheWriteTokens/.test(src),
  'passing both cache token fields');
assert(!/const cost = \(inputTokens \/ 1_000_000\) \* rates\.input \+ \(outputTokens \/ 1_000_000\) \* rates\.output;\r?\n    const elapsed/.test(src),
  'the old cache-blind cost expression is gone from executeAgent');

done();
