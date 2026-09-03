// SCHEDULED PRICE CHANGES ARE ENFORCED, NOT REMEMBERED.
//
// WHY THIS FILE EXISTS — AND WHY ITS FIRST VERSION WAS WRONG. server.js's COST_RATES carried this,
// in prose, from 2026-07-01:
//
//     INTRODUCTORY $2/$10 per 1M through 2026-08-31, then reverts to $3/$15 on 2026-09-01
//     — bump these to 3.00/15.00 on that date.
//
// On 2026-09-02 this file was written to ENFORCE that: the date had arrived, the rates were still
// $2/$10, and the conclusion was "under-reported for two days, invisible by construction". Guard,
// mutation test, commit message. All of it built on a forecast.
//
// Anthropic had CANCELLED the increase on 2026-08-10 — release notes, verbatim: "the previously
// scheduled increase to $3 / $15 per MTok on September 1, 2026 will not occur." The comment, the
// claude-api skill's pricing cache (2026-06-24), and the engineer all carried the stale schedule
// forward. So for ~24 hours the guard enforced the WRONG price, in the over-reporting direction,
// with exactly the invisibility it was written to prevent. It was caught by the compiled intel brief
// (lib/intel-brief-compiled.js) reading the provider's own changelog — one $0.07 model call.
//
// TWO LESSONS, both kept: a dated obligation living only in a comment is a hope, not a reminder —
// so the marker mechanism stays. AND a schedule baked into code assumes the future arrives as
// scheduled; vendors cancel things. So a marker must record a VERIFIED fact with the date it became
// true, not a forecast — and price facts come from the primary source, which the compiled brief now
// reads daily. If it ever reports a Sonnet 5 price change, this file is what to update.
//
// HOW IT WORKS. Any rate with a scheduled change carries a machine-readable marker directly above it:
//
//     // RATE-CHANGE: YYYY-MM-DD <model-prefix> -> <input>/<output>
//
// Before that date the marker is dormant. On and after it, this suite asserts EVERY COST_RATES entry
// whose key starts with <model-prefix> matches the scheduled numbers — and fails, loudly and with the
// exact edit to make, until someone does. It deliberately becomes a failing test on a calendar date,
// because a suite that goes red on the day the price changes is strictly better than a ledger that
// goes quietly wrong and stays wrong.
//
// ADDING A FUTURE CHANGE: write one marker line. That is the whole registration. The parser finds it
// by SHAPE, so a rate nobody thought to list here is still covered the moment it carries a marker —
// the boundary-guard-enumeration lesson, applied to prices.

const { assert, done, serverSource } = require('./test-util');

const src = serverSource();

// --- extract the COST_RATES table -----------------------------------------------------------------
const tableStart = src.indexOf('const COST_RATES');
assert(tableStart > 0, 'COST_RATES is where this suite expects it in server.js');
const tableEnd = src.indexOf('};', tableStart);
const table = src.slice(tableStart, tableEnd);

/** Every `'key': { input: N, output: M }` row, with whatever trailing comment the line carries. */
function parseRates(text) {
  const out = {};
  const RE = /'([a-z0-9.\-]+)'\s*:\s*\{\s*input:\s*([0-9.]+)\s*,\s*output:\s*([0-9.]+)\s*\}\s*,?\s*(\/\/.*)?/gi;
  let m;
  while ((m = RE.exec(text))) out[m[1]] = { input: parseFloat(m[2]), output: parseFloat(m[3]), note: (m[4] || '').trim() };
  return out;
}
const rates = parseRates(table);
assert(Object.keys(rates).length > 8, `the rate table parses (${Object.keys(rates).length} entries) — a parser that silently matched nothing would make every assertion below vacuous`);

// --- the sanity floor -----------------------------------------------------------------------------
// A zero rate is the worst possible value: it does not error, it bills everything as free.
//
// But zero is sometimes CORRECT — `manus` is credit-based, not per-token, so a per-token rate is
// genuinely inapplicable there, and this suite flagged it on its first run. The fix is NOT to exempt
// "manus" by name: an enumerated allowlist loses to the next credit-based provider nobody adds to it
// (the boundary-guard-enumeration lesson, which this repo has already paid for once). Instead a zero
// rate must DECLARE itself non-per-token on its own line. An accidental zero still fails; a
// documented one passes, and the documentation is what makes it pass.
const NON_TOKEN = /credit-based|not per-token|non-token|flat fee/i;
for (const [key, r] of Object.entries(rates)) {
  if (r.input === 0 || r.output === 0) {
    assert(NON_TOKEN.test(r.note),
      `${key} is 0-rated and says why on its own line ("${r.note || 'NO COMMENT'}") — an undeclared zero rate bills every call as free and nothing reports it`);
  } else {
    assert(r.input > 0 && r.output > 0, `${key} has positive rates (${r.input}/${r.output})`);
    assert(r.output >= r.input, `${key} output rate >= input rate (${r.input}/${r.output}) — true of every model here; an inversion means a transposed pair`);
    assert(r.input < 100 && r.output < 500, `${key} rates are within a sane order of magnitude (${r.input}/${r.output})`);
  }
}

// --- the scheduled-change enforcement -------------------------------------------------------------
const MARKER = /\/\/\s*RATE-CHANGE:\s*(\d{4}-\d{2}-\d{2})\s+([a-z0-9.\-]+)\s*->\s*([0-9.]+)\s*\/\s*([0-9.]+)/gi;
const markers = [];
let mm;
while ((mm = MARKER.exec(src))) {
  markers.push({ date: mm[1], prefix: mm[2], input: parseFloat(mm[3]), output: parseFloat(mm[4]) });
}
assert(markers.length > 0, 'at least one RATE-CHANGE marker exists — if this ever drops to zero, either every scheduled change is genuinely done, or the marker format drifted and this whole suite went vacuous');

// Compare as YYYY-MM-DD strings: lexicographic order is chronological order for ISO dates, and it
// sidesteps timezone entirely. The VPS is UTC and this box is local — a Date-based comparison would
// flip a day at the boundary, which for a "did this date arrive?" check is exactly the wrong kind of
// clever. The handoff already records one incident of UTC/local skew being misread as a real change.
const today = new Date().toISOString().slice(0, 10);

let due = 0;
let pending = 0;
for (const m of markers) {
  const affected = Object.keys(rates).filter((k) => k.startsWith(m.prefix));
  assert(affected.length > 0, `RATE-CHANGE marker for "${m.prefix}" matches at least one rate key — a marker naming a model that no longer exists is a guard pointed at nothing`);

  if (today >= m.date) {
    due++;
    for (const key of affected) {
      const r = rates[key];
      const matches = r.input === m.input && r.output === m.output;
      // The message has to read correctly BOTH ways — test-util prints it on pass and on fail alike,
      // so a message written purely as a failure narrative prints a scary paragraph next to "ok :".
      assert(matches, matches
        ? `${key} is at its scheduled ${m.input}/${m.output} (due ${m.date})`
        : `${key} MISSED its scheduled rate change: due ${m.date}, today ${today}, expected ${m.input}/${m.output} but found ${r.input}/${r.output}. `
          + `Every call since ${m.date} under-reported spend and no dashboard could tell you — the number that would warn you IS the wrong number. `
          + `Fix: set all '${m.prefix}-*' entries in server.js COST_RATES to input ${m.input} / output ${m.output}.`);
    }
  } else {
    pending++;
    // Dormant, and it must STAY dormant — a marker that fires early would push a price change before
    // the vendor actually made it, which over-reports spend just as silently as the reverse.
    const wrongAlready = affected.filter((k) => rates[k].input === m.input && rates[k].output === m.output);
    // No assertion on the rates here on purpose: a dormant marker constrains nothing yet. Logged so a
    // reader can see it is being watched, which is all a future change can honestly claim.
    console.log(`  info: future change for ${m.prefix} on ${m.date} is dormant (${affected.length} keys watched)`);
  }
}

console.log(`  info: ${markers.length} RATE-CHANGE marker(s) — ${due} due and enforced, ${pending} dormant (today ${today})`);

// --- the specific obligation that caused this file ------------------------------------------------
// THE OBLIGATION THAT CAUSED THIS FILE WAS ITSELF WRONG. On 2026-09-02 these asserted $3/$15 —
// "the intro expired 2026-08-31 and was missed by two days". Anthropic had cancelled that increase
// on 2026-08-10. The guard enforced a stale forecast for 24 hours, in the over-reporting direction,
// and was caught by the compiled intel brief reading the provider's own changelog. The assertion now
// pins the VERIFIED price. Its marker in server.js carries the date it became standard.
for (const tier of ['sonnet-5-xhigh', 'sonnet-5-high', 'sonnet-5-medium', 'sonnet-5-low']) {
  assert(rates[tier] && rates[tier].input === 2.00 && rates[tier].output === 10.00,
    `${tier} is $2/$10 — the "scheduled" rise to $3/$15 was CANCELLED by Anthropic on 2026-08-10 (release notes), and a guard that enforced the cancelled schedule over-billed for a day`);
}

// The superseded Opus 4.8 rows must survive. Deleting them would make every historical ledger entry
// miss the table and re-bill at the fallback, silently rewriting past spend (server.js says so).
for (const tier of ['opus-4.8-xhigh', 'opus-4.8-low']) {
  assert(rates[tier], `${tier} is retained as a price even though nothing routes to it — the persisted ledger is full of those strings, and deleting the row would rewrite history at the fallback rate`);
}

done();
