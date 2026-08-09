// Anthropic prompt-cache placement and pricing.
//
// WHY. Opus 5 spend on this platform is 71% INPUT tokens — 1.72M in vs 138K out across 38 stage
// dispatches, a 12.5:1 ratio. That ratio is the tool loop: with up to PIPELINE_STAGE_TOOL_ITERS
// turns, every turn re-sends the entire conversation so far, so the same system prompt and the same
// accumulated tool results are billed at full input rate ten, twenty, thirty times over. Cache reads
// bill at 10% of the input rate, so this is the only lever that touches the 71%. Lowering `effort`
// touches the other 29% and costs quality on the tier that runs security audits.
//
// THREE CONSTRAINTS SHAPE EVERYTHING BELOW. They are not tunables:
//
//   1. PREFIX MATCH. The cache key is the exact bytes up to each breakpoint, rendered in the order
//      tools -> system -> messages. One changed byte anywhere in the prefix invalidates everything
//      after it. This is why the stable/volatile split below exists and why it is load-bearing.
//   2. FOUR BREAKPOINTS MAX per request. Budgeted here as 1 system + 3 conversation.
//   3. TWENTY-BLOCK LOOKBACK. Each breakpoint searches backwards at most 20 content blocks for a
//      prior cache entry. A single tool-loop turn that emits several parallel tool_use blocks plus
//      their tool_results can exceed that on its own — and when it does the next request finds
//      nothing and silently re-pays for the whole prefix. No error, no warning, just a bill.
//      MAX_BLOCK_GAP exists solely to keep every breakpoint inside that window.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: gate on token counts. The minimums below are
// documentation for the caller, not a precondition — a prefix under the minimum simply does not
// cache, with no error, and the marker costs nothing. Refusing to mark would mean predicting a token
// count client-side, which is exactly the kind of estimate this repo has been burned by before.

// Minimum cacheable prefix, per model family. NOT MONOTONIC ACROSS GENERATIONS — opus-5 is 512
// while the OLDER opus-4.6 is 4096, so "newer model, same or lower minimum" is false and cannot be
// used as a shortcut. A prefix between two of these values caches on one live model and silently
// does not on another, which is why this is a table rather than a constant.
const MIN_CACHEABLE_TOKENS = {
  'opus-5': 512,
  'opus-4.8': 1024,
  'sonnet-5': 1024,
  'opus-4.7': 2048,
  'opus-4.6': 4096,
  'haiku-4.5': 4096,
};
const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;

/** Minimum cacheable prefix for a ledger model string like `opus-5-xhigh`. */
function minCacheableTokens(modelString) {
  const s = String(modelString || '');
  for (const [family, min] of Object.entries(MIN_CACHEABLE_TOKENS)) {
    if (s.startsWith(family)) return min;
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS;
}

// Cache-read tokens bill at 10% of the base input rate; a 5-minute cache WRITE bills at 125%.
// (A 1-hour TTL write is 200% — not used here; see TTL note on systemBlocks.)
const CACHE_READ_MULTIPLIER = 0.10;
const CACHE_WRITE_MULTIPLIER = 1.25;

// Breakpoint budget. The API allows 4 per request; one is spent on the system/tools prefix, leaving
// three for the conversation. Three is not arbitrary: one is the write for the next turn, and the
// other two are read points that keep working as the conversation grows past a single lookback
// window.
const MAX_BREAKPOINTS = 4;
const MAX_CONVERSATION_MARKS = 3;

// Maximum content blocks between consecutive conversation breakpoints. Set below the API's 20-block
// lookback so a turn that adds several blocks at once cannot push the next breakpoint out of range.
// Raising this to 20 removes the margin and reintroduces silent whole-prefix re-billing.
const MAX_BLOCK_GAP = 15;

/**
 * Build the `system` field as cache-marked blocks.
 *
 * THE ORDERING HERE IS THE WHOLE FEATURE. `stable` is everything identical across calls for one
 * agent — its handbook, the untrusted-output security guard, the tool-budget notice. `volatile` is
 * everything that differs per call, and on this platform that critically includes the
 * **per-call random nonce** from fenceUntrusted(): a fresh nonce in the prefix makes every request
 * byte-unique, so before this split the system prompt could never have cached even once, on any
 * call carrying untrusted content. Volatile content goes AFTER the breakpoint, where changing it
 * costs nothing.
 *
 * Returns a plain string when there is nothing to cache-mark, so callers that pass no volatile part
 * and no marker keep the old wire shape exactly.
 *
 * TTL is left at the 5-minute default deliberately. A 1-hour TTL doubles the write cost (200% vs
 * 125%) and needs three reads rather than two to break even — worth it only for traffic with gaps
 * longer than five minutes between requests sharing a prefix. A tool loop's turns are seconds
 * apart, so the default already covers the case this exists for.
 */
function systemBlocks(stable, volatile, { cache = true } = {}) {
  const stableText = String(stable || '');
  const volatileText = String(volatile || '');
  if (!cache) return volatileText ? stableText + volatileText : stableText;
  if (!stableText) return volatileText || '';

  const blocks = [{ type: 'text', text: stableText, cache_control: { type: 'ephemeral' } }];
  // The volatile block is deliberately UNMARKED. Marking it would spend a second breakpoint to
  // cache content that is different on every request — a guaranteed write with no possible read.
  if (volatileText) blocks.push({ type: 'text', text: volatileText });
  return blocks;
}

/** Number of content blocks a message contributes (a plain string counts as one). */
function blockCount(message) {
  if (!message || message.content == null) return 0;
  return Array.isArray(message.content) ? message.content.length : 1;
}

/**
 * Place rolling cache breakpoints through a growing tool-loop conversation.
 *
 * Called after each turn is appended. Marks the last content block of selected messages, walking
 * BACKWARDS from the newest: the newest mark is the cache write that the next request will read,
 * and the older marks stay valid as read points. Spacing honours MAX_BLOCK_GAP so no breakpoint
 * falls outside the API's lookback window.
 *
 * Existing marks are cleared first. Without that, a long loop accumulates markers past the
 * four-breakpoint limit and the request is rejected outright — a hard failure mid-stage, which on
 * this platform means a dead pipeline run rather than a degraded one.
 *
 * Mutates `messages` in place (they are request-local) and returns the number of marks placed.
 */
function markConversation(messages, { maxMarks = MAX_CONVERSATION_MARKS, maxGap = MAX_BLOCK_GAP } = {}) {
  if (!Array.isArray(messages) || !messages.length) return 0;

  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) { if (b && typeof b === 'object' && b.cache_control) delete b.cache_control; }
    }
  }

  const marks = [];
  let blocksSinceMark = 0;
  for (let i = messages.length - 1; i >= 0 && marks.length < maxMarks; i--) {
    const m = messages[i];
    const n = blockCount(m);
    if (!n) continue;

    // Always mark the newest eligible message; after that, only once the gap approaches the
    // lookback window. Marking every turn would burn the budget within three turns of a 30-turn
    // loop and leave the oldest — and largest — span of the conversation uncached.
    const isNewest = marks.length === 0;
    if (isNewest || blocksSinceMark >= maxGap) {
      // A string `content` cannot carry cache_control; promote it to a text block. Done only for
      // messages actually being marked, so untouched turns keep their original wire shape.
      if (!Array.isArray(m.content)) m.content = [{ type: 'text', text: String(m.content) }];
      const last = m.content[m.content.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
        marks.push(i);
        blocksSinceMark = 0;
        continue;
      }
    }
    blocksSinceMark += n;
  }
  return marks.length;
}

/**
 * Price one response's usage with cache rates applied.
 *
 * The three token fields are DISJOINT — `input_tokens` is the uncached remainder only, not the
 * total. Summing them is the only way to get the real prompt size, and reading `input_tokens`
 * alone (as this repo's ledger did) makes a heavily-cached call look almost free in tokens while
 * the dollar figure stays right, which is a worse kind of wrong than either error alone.
 *
 * @returns {{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, uncachedInputTokens, cost}}
 */
function priceUsage(usage, rates) {
  const u = usage || {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const uncached = num(u.input_tokens);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  const output = num(u.output_tokens);

  const rIn = num(rates && rates.input);
  const rOut = num(rates && rates.output);
  const cost = (uncached / 1e6) * rIn
    + (write / 1e6) * rIn * CACHE_WRITE_MULTIPLIER
    + (read / 1e6) * rIn * CACHE_READ_MULTIPLIER
    + (output / 1e6) * rOut;

  return {
    // Reported as the TOTAL prompt size so token counts stay comparable across cached and uncached
    // calls; the split is preserved alongside for anyone auditing the cost.
    inputTokens: uncached + read + write,
    uncachedInputTokens: uncached,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: output,
    cost,
  };
}

/** Cache hit rate over a set of priced results, for reporting. Null when nothing was cacheable. */
function hitRate({ cacheReadTokens = 0, inputTokens = 0 } = {}) {
  if (!inputTokens) return null;
  return Math.round((cacheReadTokens / inputTokens) * 1000) / 10;
}

module.exports = {
  systemBlocks,
  markConversation,
  priceUsage,
  hitRate,
  minCacheableTokens,
  blockCount,
  MIN_CACHEABLE_TOKENS,
  DEFAULT_MIN_CACHEABLE_TOKENS,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MAX_BREAKPOINTS,
  MAX_CONVERSATION_MARKS,
  MAX_BLOCK_GAP,
};
