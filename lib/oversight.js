// lib/oversight.js
// ============================================================
//  THE OVERSIGHT LEDGER — P1 of the 2026-08-28 agent-overhead audit.
//
//  The platform measured tokens, dollars, run counts and agent latency, and NOTHING about the
//  operator's side of the work: how many decisions the platform demanded, how long they waited,
//  how deep the queue is right now. Every approval already persisted `createdAt` and
//  `approvedAt`/`rejectedAt` — the raw material was all there, unsubtracted. This module is the
//  subtraction. (Nate B Jones, "Managing AI Agents at Scale": the human management work "has no
//  name, no owner, and no line on any dashboard". This is the line on the dashboard.)
//
//  PURE on purpose: takes the approvals array and the auto-approve counters, touches no state,
//  reads no clock unless given one — so the whole thing is unit-testable with synthetic data.
// ============================================================

/**
 * Nearest-rank percentile of a SORTED ascending array. Empty → null, never NaN — an empty queue is
 * "no data yet", and NaN in a JSON payload serialises to null anyway but poisons any arithmetic
 * done before serialisation.
 */
function pctl(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Compute the operator-side metrics from the approvals queue.
 *
 * @param {Array}  approvals  the pending_approvals array (holds pending AND resolved items)
 * @param {Object} counters   { autoApproved: number, autoByDay: { 'YYYY-MM-DD': number } }
 * @param {Object} opts       { now?: epoch ms, windowDays?: number }
 *
 * Decision time is (approvedAt|rejectedAt) − createdAt. Items with status 'failed' were approved
 * and then their executor threw — the DECISION was made, so they count in decision-time stats
 * (via approvedAt) and are ALSO surfaced as failedAfterApproval: that number is recovery debt the
 * audit found dead-ends silently (no retry route), so it must not hide inside "approved".
 */
function computeOversight(approvals, counters = {}, { now = Date.now(), windowDays = 30 } = {}) {
  const list = Array.isArray(approvals) ? approvals.filter((a) => a && a.createdAt) : [];
  const windowStart = now - windowDays * 86400000;

  // --- the queue as it stands ------------------------------------------------------------------
  const pending = list.filter((a) => a.status === 'pending');
  const pendingAges = pending
    .map((a) => now - Date.parse(a.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((x, y) => x - y);
  const byRisk = {};
  for (const a of pending) byRisk[a.risk || 'unknown'] = (byRisk[a.risk || 'unknown'] || 0) + 1;

  // --- decisions made inside the window --------------------------------------------------------
  const decided = list.filter((a) => a.approvedAt || a.rejectedAt);
  const inWindow = decided.filter((a) => {
    const t = Date.parse(a.approvedAt || a.rejectedAt);
    return Number.isFinite(t) && t >= windowStart && t <= now;
  });
  const times = inWindow
    .map((a) => Date.parse(a.approvedAt || a.rejectedAt) - Date.parse(a.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((x, y) => x - y);

  const approvedCount = inWindow.filter((a) => a.approvedAt && a.status !== 'failed').length;
  const rejectedCount = inWindow.filter((a) => a.rejectedAt).length;
  const failedAfterApproval = inWindow.filter((a) => a.status === 'failed').length;

  // Remediation cost (audit P3): operator-logged cleanup time on resolved actions. Bucketed by
  // WHEN it was logged (remediationAt), because that is the only timestamp the logging carries —
  // cleanup for an old action logged today is this window's work.
  const remediated = list.filter((a) => {
    if (!Number.isFinite(a.remediationMinutes) || !a.remediationAt) return false;
    const t = Date.parse(a.remediationAt);
    return Number.isFinite(t) && t >= windowStart && t <= now;
  });
  const remediationMinutes = remediated.reduce((s, a) => s + a.remediationMinutes, 0);

  // --- gated vs auto inside the window ---------------------------------------------------------
  // Gated demand = approvals CREATED in the window (each one asked the operator for a decision,
  // whether or not it has been answered yet). Auto = the counter the auto-approve branch bumps.
  const gatedCreated = list.filter((a) => {
    const t = Date.parse(a.createdAt);
    return Number.isFinite(t) && t >= windowStart && t <= now;
  }).length;
  const autoByDay = (counters && counters.autoByDay) || {};
  let autoInWindow = 0;
  for (const [day, n] of Object.entries(autoByDay)) {
    const t = Date.parse(day + 'T00:00:00Z');
    if (Number.isFinite(t) && t >= windowStart - 86400000 && t <= now) autoInWindow += n || 0;
  }
  const demandTotal = gatedCreated + autoInWindow;

  return {
    windowDays,
    pending: {
      depth: pending.length,
      oldestAgeMs: pendingAges.length ? pendingAges[pendingAges.length - 1] : null,
      byRisk,
    },
    decided: {
      total: inWindow.length,
      approved: approvedCount,
      rejected: rejectedCount,
      // Approved, then the executor threw. Terminal today (no retry route) — this line existing is
      // the point: recovery debt was invisible before it.
      failedAfterApproval,
      medianDecisionMs: pctl(times, 50),
      p90DecisionMs: pctl(times, 90),
      perDay: Math.round((inWindow.length / windowDays) * 100) / 100,
      // Operator-logged cleanup cost (the essay's 9-seconds/30-hours asymmetry, finally on a
      // dashboard). count distinguishes "0 minutes logged" from "nobody logs remediation here".
      remediation: { minutes: remediationMinutes, count: remediated.length },
    },
    autoVsGated: {
      autoApproved: autoInWindow,
      gated: gatedCreated,
      // Share of actions that DEMANDED a human decision. null when nothing ran at all —
      // 0 would falsely read as "fully autonomous".
      gatedShare: demandTotal ? Math.round((gatedCreated / demandTotal) * 100) : null,
      autoApprovedAllTime: (counters && counters.autoApproved) || 0,
    },
  };
}

module.exports = { computeOversight, pctl };
