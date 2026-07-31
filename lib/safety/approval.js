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
  'mcp.tool-call': 'high',              // outward/side-effectful: an agent invoking a connected MCP tool
  // A business clone commissioning work from an agent. Not outward-facing — the result comes back
  // for review and is never sent — but it spends money and produces work attributed to a person who
  // did not write the request themselves. 'high' means the default (supervised) mode asks first, and
  // only an operator who has deliberately chosen 'auto' lets clones commission work unattended.
  'clone.dispatch-agent': 'high',
  'email.sequence-send': 'medium',      // outward-facing but operator-authored + unsubscribe-footed:
                                        // auto-runs in supervised/auto, queues per-send approval in manual
  // Destroying a company record. 'critical' matches web-studio.delete-site, the existing precedent
  // for irreversible teardown, and is DELIBERATELY not in ALWAYS_GATE (design doc D-ALWAYSGATE):
  // records deletion is arguably as irreversible as a site teardown, but promoting it to the
  // mode-independent hard-stop that self-modifying-code actions get is the operator's call, not a
  // decision to make on their behalf. In 'auto' mode these therefore run unattended — which is why
  // the legal-hold refusal lives in the EXECUTOR as well as the gate, and not only here.
  'library.delete-record': 'critical',
  'library.retention-dispose': 'critical',
  // Both of these are ALSO hard-gated regardless of mode (see server.js's ALWAYS_GATE) — 'critical'
  // here is defense-in-depth, not the only thing stopping them from auto-running.
  'self-improve.apply-plan': 'critical',      // writes to THIS platform's own source tree
  'self-improve.distribution-pr': 'critical', // opens a real PR on the public distribution repo
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
