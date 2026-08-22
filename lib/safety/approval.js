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
  // A destructive or production-affecting infrastructure operation: `rm -rf`, `DROP TABLE`/`DATABASE`,
  // `git push --force`, disk format/partition, `docker system prune`, volume deletion, a production
  // service restart or rollback, fleet-wide patching. Design doc §9 item 10 — the largest finding of
  // P1 — recorded that `devops`, `sysadmin` and `it-director` hold every one of these with nothing
  // but a sentence in a system prompt behind them, and recommended this id at 'critical'.
  //
  // Read the next paragraph before building anything on top of this. It is NOT a hole being plugged.
  // No dispatched agent can execute a shell command today: an agent's `tools:` frontmatter is
  // surfaced only as a description string (server.js `agentConcepts`) and never converted into a
  // runtime grant, and the sole tool surface a dispatched agent reaches is MCP — already gated as
  // `mcp.tool-call`. Every shell call in this codebase is a specific, admin-gated code path
  // (self-improve, the hosting sudo bridge, the site build, yt-dlp), not an agent's decision.
  //
  // So this id exists to make the boundary REAL AHEAD OF THE CAPABILITY, in two ways. First, the
  // three root-capable handbooks can now declare a gate the validator checks instead of prose that
  // nothing reads. Second — and this is the part that matters — it is in server.js's ALWAYS_GATE and
  // its executor REFUSES. There is deliberately no automated path from an agent's proposal to a
  // destructive infra command; a named human runs it. Anyone adding the first real infra executor has
  // to delete that refusal on purpose, in a diff someone reviews, rather than inheriting an
  // unclassified action that lands on the 'medium' default and auto-runs in supervised mode.
  'infra.destructive-op': 'critical',
  // An EVENT firing a whole pipeline, with no human in the room. Classified 'critical' — the band
  // that runs only in `auto` mode — for one reason: it is the only action here that SPENDS MONEY
  // REPEATEDLY WITHOUT A PROMPT. `clone.dispatch-agent` is already 'high' for a SINGLE agent
  // dispatch that a human asked for; an event-triggered run dispatches every stage, and
  // `repurpose-video` alone is seven paid calls. A misfiring trigger does not do one wrong thing,
  // it does one wrong thing per event, forever, until someone notices the bill.
  //
  // This is exactly the "unclassified action lands on the 'medium' default and auto-runs in
  // supervised mode" case the note above warns about, so it is classified deliberately rather than
  // inherited. In supervised mode an event-triggered run is REFUSED and logged, not queued: the
  // operator can still run the pipeline by hand, which is the safe default when the alternative is
  // unattended spend.
  'pipeline.event-dispatch': 'critical',
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

// ACTION_RISK is exported READ-ONLY so the handbook validator can assert that every action id a
// handbook promises to gate actually exists here. `decide()` cannot answer that question — an
// unknown type silently classifies as 'medium', so a typo'd or renamed id would read as a real
// guardrail. Frozen because it is a registry, not a scratchpad: a caller mutating it at runtime
// would re-band a live action without any commit to point at.
module.exports = { MODES, decide, ACTION_RISK: Object.freeze({ ...ACTION_RISK }) };
