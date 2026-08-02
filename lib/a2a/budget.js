// lib/a2a/budget.js — reserve-then-settle accounting for a scoped A2A key's daily spend.
//
// The bug this replaces: the route refused a key only once `spentUsd >= dailyBudgetUsd`, then
// charged the ACTUAL cost after the agent had already run. A key with a cent left therefore passed
// the check and ran a full request, so the cap could be exceeded by nearly the price of one call —
// every call, forever, without ever reporting an error. A budget that can be exceeded on every
// request is a suggestion.
//
// The fix is the ordinary one from ledger accounting: hold an estimate BEFORE the work, replace it
// with the real number after. Two consequences worth accepting deliberately:
//
//   - It over-reserves. The estimate is the worst case (max output tokens at the model's output
//     rate), and most answers are far shorter, so a caller may be refused while nominally under
//     budget. That is the correct direction to be wrong in: the alternative is silently overspending
//     someone else's money, and the remedy — raise the budget — is one admin edit away.
//
//   - A crash between reserve and settle LEAKS a reservation. Bounded, not eliminated: reservations
//     live in the same daily bucket as spend, so the next UTC day clears them. The caller must
//     settle in a `finally`, and `settle` is written to be safe to call with an unknown/zero
//     reservation so a double-settle cannot mint budget.
//
// Pure module: arithmetic and shapes, no I/O, no clock beyond an injectable `today`.

'use strict';

/** Round to whole cents-of-a-cent. Money in floats drifts; every write goes through this. */
function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The usage bucket for TODAY, resetting when the day rolls over.
 * `spentUsd` is settled money; `reservedUsd` is money held for calls currently in flight.
 */
function currentUsage(usage, today = utcDay()) {
  if (usage && usage.date === today) {
    return { date: today, spentUsd: round4(usage.spentUsd), reservedUsd: round4(usage.reservedUsd) };
  }
  return { date: today, spentUsd: 0, reservedUsd: 0 };
}

/**
 * Worst-case cost of one call, in USD.
 *
 * Deliberately counts OUTPUT tokens at the output rate for the whole allowance and adds the input
 * at its own rate. Output dominates (5x the input rate on Opus), and `maxTokens` is the only hard
 * ceiling the caller actually enforces on the model — so this is the largest bill a single call can
 * produce, which is exactly what a reservation should hold.
 */
function estimateCostUsd({ maxTokens = 0, inputTokens = 0, rate }) {
  const r = rate || {};
  const out = (Number(maxTokens) || 0) / 1e6 * (Number(r.output) || 0);
  const inp = (Number(inputTokens) || 0) / 1e6 * (Number(r.input) || 0);
  return round4(out + inp);
}

/**
 * Try to hold `estimateUsd` against the key's daily budget.
 *
 * Named `hold` rather than `reserve` because lib/booking.js already exports a `reserve`,
 * and one name in two files is what the dead-code gate flags. It also reads better against
 * its partner `settle` — hold/settle is the ordinary ledger pairing.
 *
 * @returns {{ok: true, usage}} with the reservation held, or
 *          {{ok: false, usage, remainingUsd, reason}} with the bucket untouched.
 */
function hold(usage, budgetUsd, estimateUsd, today = utcDay()) {
  const u = currentUsage(usage, today);
  const budget = Math.max(0, Number(budgetUsd) || 0);
  const est = Math.max(0, round4(estimateUsd));
  const committed = round4(u.spentUsd + u.reservedUsd);
  const remaining = round4(budget - committed);

  // `>` not `>=`: a request whose worst case lands exactly on the budget is affordable. Getting
  // this backwards would make an exactly-sized budget unusable.
  if (est > remaining) {
    return {
      ok: false,
      usage: u,
      remainingUsd: Math.max(0, remaining),
      reason: remaining <= 0
        ? 'daily budget for this A2A key is exhausted'
        : `daily budget for this A2A key cannot cover this request (needs up to $${est.toFixed(4)}, $${remaining.toFixed(4)} left)`,
    };
  }

  return { ok: true, usage: { ...u, reservedUsd: round4(u.reservedUsd + est) }, reservedUsd: est };
}

/**
 * Release a reservation and charge what the call actually cost.
 *
 * `actualUsd` may be null/undefined when the provider reported no cost (a failed call) — the
 * reservation is still released, because holding money for work that did not happen would strand
 * the budget until midnight.
 *
 * Clamped at zero so a double-settle, or a settle with a reservation this bucket never held (a
 * process restart between reserve and settle), cannot drive `reservedUsd` negative and MINT budget.
 */
function settle(usage, reservedUsd, actualUsd, today = utcDay()) {
  const u = currentUsage(usage, today);
  const held = Math.max(0, round4(reservedUsd));
  const actual = Math.max(0, round4(actualUsd));
  return {
    date: u.date,
    spentUsd: round4(u.spentUsd + actual),
    reservedUsd: Math.max(0, round4(u.reservedUsd - held)),
  };
}

/** What a caller may still spend today, for reporting. */
function remainingUsd(usage, budgetUsd, today = utcDay()) {
  const u = currentUsage(usage, today);
  return Math.max(0, round4((Number(budgetUsd) || 0) - u.spentUsd - u.reservedUsd));
}

// utcDay stays internal: it is a default-argument helper, and exporting it invited a caller
// to compute the day themselves and pass a different one to hold() than to settle().
module.exports = { currentUsage, estimateCostUsd, hold, settle, remainingUsd, round4 };
