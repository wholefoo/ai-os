// The `infra.destructive-op` gate, and the registry invariant it exposed.
//
// Design doc §9 item 10 — "THE LARGEST FINDING OF P1" — recorded that `devops`, `sysadmin` and
// `it-director` hold `rm -rf`, DROP TABLE/DATABASE, `git push --force`, disk partition operations,
// `docker system prune`, volume deletion, production restarts, rollbacks and fleet-wide patching,
// with NOTHING enforcing any of it. All three were governed by the same convention — "propose the
// exact command and wait for approval naming that specific action" — written in prose, in a system
// prompt, to a language model. P1 documented that honestly and left the fix as the operator's call.
//
// BE PRECISE ABOUT WHAT THIS SUITE DEFENDS, because the obvious reading is wrong. No dispatched
// agent can execute a shell command on this platform: `tools:` frontmatter is surfaced only as a
// description string (server.js `agentConcepts`) and never becomes a runtime grant, and the sole
// tool surface a dispatched agent reaches is MCP, already gated as `mcp.tool-call`. So this is not a
// live hole being plugged. It is a boundary being fixed in place BEFORE the capability exists, which
// is the only time it is cheap: the alternative is that the first infra executor someone writes
// lands unclassified, defaults to 'medium' in `classify()`, and auto-runs in supervised mode.
//
// Three properties, and the third is the one that generalises:
//   1. the id exists at 'critical' and is mode-independent (ALWAYS_GATE)
//   2. its executor REFUSES — the platform has no automated path to a destructive command
//   3. EVERY id in ACTION_RISK has an executor. Adding this id is what surfaced that gateAction
//      would otherwise have TypeError'd on a half-wired registry entry.
const fs = require('fs');
const path = require('path');
const approval = require('../lib/safety/approval');
const schema = require('../lib/handbooks/schema');
const { assert, done, serverSource } = require('./test-util');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const src = serverSource();

// --- 1. the id, its band, and its mode-independence ------------------------------------------------

assert(approval.ACTION_RISK['infra.destructive-op'] === 'critical',
  "infra.destructive-op is registered at 'critical' — the band §9 item 10 recommended, matching web-studio.delete-site and library.delete-record");

// 'critical' alone is NOT enough, and this is the assertion that says why. `MODES.auto = 'critical'`,
// so in 'auto' mode decide() returns allow=true for a critical action — verified in
// test-library-retention.js, where that is deliberate. Destructive infra is the case where it is not.
const autoDecision = approval.decide('infra.destructive-op', 'auto');
assert(autoDecision.allow === true,
  "the RISK POLICY alone would let it run in 'auto' mode (allow=true) — critical is the ceiling, not a stop");
assert(/const ALWAYS_GATE = new Set\(\[[^\]]*'infra\.destructive-op'/.test(src),
  '...so it is in server.js ALWAYS_GATE, which overrides the policy in every mode — that Set, not the band, is what stops an auto-mode surprise');

assert(approval.decide('infra.destructive-op', 'supervised').allow === false
  && approval.decide('infra.destructive-op', 'manual').allow === false,
  'and it is refused by the policy in supervised and manual mode independently of ALWAYS_GATE');

// gateAction must read the risk band from the registry rather than hardcoding 'critical' for every
// always-gated type: a future ALWAYS_GATE entry at a different band would otherwise be mislabelled to
// the operator in the approvals queue, which is the one place they decide from.
assert(/risk: approvalPolicy\.ACTION_RISK\[type\] \|\| 'critical'/.test(src),
  "gateAction takes an always-gated action's risk from ACTION_RISK, not a hardcoded literal");

// --- 2. the executor refuses -------------------------------------------------------------------------
// The honest implementation. There is no automated path from an agent proposing `rm -rf` to anything
// running it, and refusing is how that stays true: a future author has to delete this on purpose, in
// a diff someone reviews, rather than inheriting a silently-permissive stub.

const execMatch = src.match(/'infra\.destructive-op': async \([^)]*\) => \{([\s\S]*?)\n  \},/);
assert(execMatch, "server.js registers an ACTION_EXECUTORS entry for infra.destructive-op");
assert(execMatch && /throw new Error\(/.test(execMatch[1]),
  '...and that executor THROWS — the platform does not run destructive infrastructure commands on an agent\'s say-so');
assert(execMatch && /no automated executor/.test(execMatch[1]),
  '...with a message that names the reason, so an operator approving one is told why nothing happened rather than seeing a bare stack trace');

// --- 3. the registry invariant this change exposed ----------------------------------------------------
// gateAction's auto-approve path calls ACTION_EXECUTORS[type](params) directly. Before this change
// every ACTION_RISK id happened to have an executor, so a missing one had never been possible; the
// failure would have been `TypeError: ACTION_EXECUTORS[type] is not a function`, which reads as a
// crash rather than as a half-wired registry. Asserted as an invariant now, not left to luck.

const executorIds = Array.from(src.matchAll(/^  '([a-z-]+\.[a-z-]+)': async /gm)).map((m) => m[1]);
assert(executorIds.length >= 10, `the ACTION_EXECUTORS ids were parsed (got ${executorIds.length}: ${executorIds.join(', ')})`);

const orphans = Object.keys(approval.ACTION_RISK).filter((id) => !executorIds.includes(id));
assert(orphans.length === 0,
  `every id in ACTION_RISK has an executor${orphans.length ? ` — orphaned: ${orphans.join(', ')}` : ''}`);

// The other direction: an executor with no risk band would classify as 'medium' via classify()'s
// default and auto-run in supervised mode — the exact failure this whole id exists to pre-empt.
const unbanded = executorIds.filter((id) => !approval.ACTION_RISK[id]);
assert(unbanded.length === 0,
  `every executor has a declared risk band${unbanded.length ? ` — unbanded (would default to 'medium' and auto-run in supervised): ${unbanded.join(', ')}` : ''}`);

assert(/if \(!ACTION_EXECUTORS\[type\]\) \{/.test(src),
  'gateAction refuses an unimplemented action type before deciding — the message names the defect instead of surfacing a TypeError');

// --- the three handbooks now declare it ----------------------------------------------------------------
// The point of the id, from the handbook side: `gates:` is validated against ACTION_RISK
// (test-handbooks.js), so these three now hold a claim that is checked rather than prose that is not.

const ROOT_CAPABLE = ['devops', 'sysadmin', 'it-director'];
for (const name of ROOT_CAPABLE) {
  const meta = schema.parseFrontmatter(schema.split(fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8')).frontmatter);
  const gates = Array.isArray(meta.gates) ? meta.gates : [];
  assert(gates.includes('infra.destructive-op'),
    `${name} declares infra.destructive-op — the guardrail §9 item 10 found it holding in prose only`);
}

done();
