// tools/test-approvals-order.js
// ============================================================
//  Decision-stream ordering + the P2a wiring. The old sort was newest-first regardless of status
//  or risk, so a critical approval aged UNDER fresh low-stakes items — the operator saw the newest
//  thing, not the most important or most overdue thing.
//
//  Comparator assertions are on the RESULTING SEQUENCE OF IDS (values, not counts). Wiring is
//  asserted at source level, scoped to the constructs themselves — server.js boots on require.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compareApprovals, RISK_RANK } = require('../lib/approvals-order.js');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

const A = (id, status, risk, createdAt) => ({ id, status, risk, createdAt });

ok('pending sorts before resolved regardless of age', () => {
  const items = [
    A('resolved-new', 'approved', 'critical', '2026-08-29T12:00:00Z'),
    A('pending-old', 'pending', 'low', '2026-08-01T00:00:00Z'),
  ].sort(compareApprovals);
  assert.deepStrictEqual(items.map(i => i.id), ['pending-old', 'resolved-new']);
});

ok('within pending: risk desc, then OLDEST first inside a band', () => {
  const items = [
    A('high-new', 'pending', 'high', '2026-08-29T10:00:00Z'),
    A('low-old', 'pending', 'low', '2026-08-20T00:00:00Z'),
    A('crit', 'pending', 'critical', '2026-08-29T11:00:00Z'),
    A('high-old', 'pending', 'high', '2026-08-25T00:00:00Z'),
  ].sort(compareApprovals);
  assert.deepStrictEqual(items.map(i => i.id), ['crit', 'high-old', 'high-new', 'low-old'],
    'critical first; the high that has WAITED LONGEST beats the fresh high; low last');
});

ok('within resolved: newest first (history is scanned by recency)', () => {
  const items = [
    A('r1', 'approved', 'high', '2026-08-20T00:00:00Z'),
    A('r2', 'rejected', 'low', '2026-08-29T00:00:00Z'),
  ].sort(compareApprovals);
  assert.deepStrictEqual(items.map(i => i.id), ['r2', 'r1']);
});

ok('unknown risk ranks as medium, not first and not last by accident', () => {
  const items = [
    A('mystery', 'pending', 'someday-new-band', '2026-08-01T00:00:00Z'),
    A('high', 'pending', 'high', '2026-08-29T00:00:00Z'),
    A('low', 'pending', 'low', '2026-08-01T00:00:00Z'),
  ].sort(compareApprovals);
  assert.deepStrictEqual(items.map(i => i.id), ['high', 'mystery', 'low']);
  assert.strictEqual(RISK_RANK.critical, 3);
});

// --- wiring (source level) -----------------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

ok('GET /api/approvals uses the shared comparator', () => {
  const at = src.indexOf("app.get('/api/approvals'");
  const block = src.slice(at, src.indexOf('});', at));
  assert.ok(/approvalsOrder\.compareApprovals/.test(block), 'route must sort with the shared comparator');
  assert.ok(!/localeCompare/.test(block), 'the old inline newest-first sort must be gone from the route');
});

ok('single and batch approve share ONE executor (no drift possible)', () => {
  assert.ok(/async function executeApprovedAction\(/.test(src));
  const single = src.slice(src.indexOf("app.post('/api/approvals/:id/approve'"), src.indexOf("app.post('/api/approvals/batch'"));
  const batch = src.slice(src.indexOf("app.post('/api/approvals/batch'"), src.indexOf("app.post('/api/approvals/:id/reject'"));
  assert.ok(/executeApprovedAction\(a, secrets, actor\)/.test(single), 'single route delegates');
  assert.ok(/executeApprovedAction\(a, secrets, actor\)/.test(batch), 'batch route delegates');
  assert.ok(!/ACTION_EXECUTORS\[a\.type\]\(/.test(single), 'single route must not also execute inline');
});

ok('batch route is admin-gated, rate-limited, capped, and sequential', () => {
  const batch = src.slice(src.indexOf("app.post('/api/approvals/batch'"), src.indexOf("app.post('/api/approvals/:id/reject'"));
  assert.ok(/requireAdmin, heavyLimiter/.test(batch));
  assert.ok(/slice\(0, 100\)/.test(batch), 'ids capped at 100');
  assert.ok(/for \(const id of ids\)/.test(batch) && /await executeApprovedAction/.test(batch),
    'sequential for..of with await — executors mutate shared state and must not interleave');
});

ok('high/critical gated actions route through sendNotification (the inverted-urgency fix)', () => {
  const at = src.indexOf("broadcast({ event: 'approval_pending', data: approval });");
  assert.notStrictEqual(at, -1);
  const after = src.slice(at, at + 1400);
  assert.ok(/if \(d\.risk === 'critical' \|\| d\.risk === 'high'\)/.test(after), 'risk branch missing');
  assert.ok(/sendNotification\(/.test(after),
    'high/critical must reach Telegram/Slack via sendNotification, not only connected sockets');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
