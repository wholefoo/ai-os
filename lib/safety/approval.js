// lib/safety/approval.js
// ============================================================
//  Auto-Mode approval policy — pure, server-agnostic, unit-testable. Decides whether a
//  classified action may run immediately under the current automation mode, or must wait for
//  a human. No I/O, no deps. The server (server.js `gateAction`) owns the queue, the secret
//  handling, and the actual execution; this module only answers "allow now, or gate?".
//
//  Risk is intrinsic to the action TYPE (irreversible / outward-facing = higher). Mode sets the
//  ceiling of risk that runs WITHOUT a human:
//    manual     → only 'low' auto-runs              (gate medium and up)
//    supervised → 'low' + 'medium' auto-run          (gate high and up)   [default]
//    auto       → everything auto-runs               (gate nothing)
//  'auto' deliberately bypasses every gate — it is the "I trust the platform, don't ask me"
//  setting and should be chosen knowingly. 'supervised' (the default) is the safe middle: the
//  platform handles low/medium work itself but a human signs off on anything outward-facing or
//  irreversible (publish/TLS, GitHub push, delete).
// ============================================================

const RISK = { low: 0, medium: 1, high: 2, critical: 3 };

// Action type -> risk band. Unknown types default to 'medium' (gated in manual, allowed otherwise).
const ACTION_RISK = {
  'web-studio.delete-site': 'critical', // irreversible: tears down vhost + TLS cert + files + state
  'web-studio.publish': 'high',         // outward-facing: nginx vhost + Let's Encrypt (rate-limited)
  'web-studio.github-push': 'high',     // outward-facing: publishes code to an external repo
};

// Mode -> highest risk band that auto-runs (no approval). 'auto' = critical = gate nothing.
const MODES = { manual: 'low', supervised: 'medium', auto: 'critical' };

function classify(type) {
  const risk = ACTION_RISK[type] || 'medium';
  return { type, risk, level: RISK[risk] };
}

// decide(type, mode) -> { allow, risk, mode, reason }
function decide(type, mode) {
  const { risk, level } = classify(type);
  const m = MODES[mode] ? mode : 'supervised';
  const ceiling = RISK[MODES[m]];
  const allow = level <= ceiling;
  return {
    allow,
    risk,
    mode: m,
    reason: allow
      ? `auto-approved: ${risk} within ${m}-mode ceiling (${MODES[m]})`
      : `approval required: ${risk} exceeds ${m}-mode ceiling (${MODES[m]})`,
  };
}

module.exports = { MODES, decide };
