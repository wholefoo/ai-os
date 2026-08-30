// lib/approvals-order.js
// ============================================================
//  Decision-stream ordering — P2 of the agent-overhead audit. The queue was sorted newest-first
//  with risk rendered as a display-only chip, so a critical item aged UNDER fresh low-stakes ones.
//
//  The order that fights fatigue instead of feeding it:
//    1. pending before resolved — the resolved half of the list is history, not work;
//    2. within pending: risk DESC, and inside a risk band OLDEST FIRST (FIFO — the item that has
//       waited longest is the one aging toward the stale threshold);
//    3. within resolved: newest first (recency is what you scan history for).
//
//  Pure and exported so the comparator is unit-tested on VALUES; server.js consumes it.
// ============================================================

const RISK_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

function compareApprovals(a, b) {
  const aPending = a.status === 'pending' ? 0 : 1;
  const bPending = b.status === 'pending' ? 0 : 1;
  if (aPending !== bPending) return aPending - bPending;
  if (aPending === 0) {
    const dr = (RISK_RANK[b.risk] ?? 1) - (RISK_RANK[a.risk] ?? 1);
    if (dr) return dr;
    return (a.createdAt || '').localeCompare(b.createdAt || '');   // oldest pending first
  }
  return (b.createdAt || '').localeCompare(a.createdAt || '');     // newest resolved first
}

module.exports = { compareApprovals, RISK_RANK };
