// Read-only repo tools for pipeline stages.
//
// WHY. security-sweep could not audit anything even when handed `target: /opt/ai-os`
// (run-1785993974422, $0.3609): every audit stage returned "BLOCKED — no evidence access. I have no
// filesystem, shell, or repo tooling in this stage invocation." The agent files declare
// `tools: Read, Grep, Glob, Bash` — but in this platform `tools:` is a DECLARATION, not a grant, and
// the pipeline path only ever passed `useMcpTools` (web search/fetch). Third instance of the same
// shape as `depends_on` before G1 and `required: true` before fce776b: vocabulary without enforcement.
//
// The tool itself already existed (runReadOnlyRepoTool, built for dev-architect-grok) and is NOT
// modified here — only reached from a second caller. So the security surface is unchanged, and this
// suite pins the properties that make that true.
const fs = require('fs');
const path = require('path');
const planStore = require('../lib/self-improve/plan-store');
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();

// --- 1. the guard itself: the denylist is the security boundary ------------------------------------
// Tested against the REAL module rather than a mirror of its list, because a copy of a denylist is a
// copy that goes stale — the exact failure mode this repo has hit with enumerated guards before.
for (const denied of [
  '.env',                          // API keys
  '.magent/state/settings.json',   // holds the Anthropic key at runtime
  '.magent/vault/raw/clipping.md', // web clippings — an injection vector by definition
  '.magent/artifacts/x.md',
  'commercial/modules/advanced-reporting/index.js',
  '.git/config',
  'node_modules/express/index.js',
  '../../etc/passwd',              // traversal
  '../.env',
]) {
  assert(planStore.isPathAllowed(denied) !== true, `a stage cannot read "${denied}"`);
}

for (const allowed of ['README.md', 'server.js', 'lib/pipeline-graph.js', '.claude/agents/reviewer.md', '.magent/vault/wiki/stack-decisions.md']) {
  assert(planStore.isPathAllowed(allowed) === true, `...but CAN read "${allowed}" — an audit that cannot read the code is the bug this fixes`);
}

assert(planStore.DENIED_PATH_PREFIXES.includes('.magent/vault/raw/'),
  'vault/raw stays denied: it is unprocessed web clippings, and piping those into an agent that also reads code is a prompt-injection path (same reasoning as lib/knowledge-context.js refusing excerpts)');
assert(planStore.DENIED_PATH_PREFIXES.includes('commercial/'),
  'and commercial/ stays denied — the open-core split is a boundary, not a convention');

// --- 2. the tool is REUSED, not reimplemented -------------------------------------------------------
assert((src.match(/async function runReadOnlyRepoTool/g) || []).length === 1,
  'runReadOnlyRepoTool is defined exactly once — a second copy for the pipeline path would be a second denylist to forget to update');
assert(/isPathAllowed/.test(src), 'and it still gates on the shared denylist');

// --- 3. the wiring ----------------------------------------------------------------------------------
assert(/function buildRepoToolset/.test(src), 'there is a repo toolset builder for the Anthropic tool shape');
assert(/options\.useRepoTools/.test(src),
  'executeAgent exposes useRepoTools as an explicit opt-in — other callers do not silently gain filesystem read');
assert(/useRepoTools:\s*true/.test(src), 'and pipeline stages ask for it');

// Every stage dispatch must get it, not just the first: a security-auditor with repo access whose
// code-scan sibling has none reproduces exactly the half-blocked run this fixes.
const stageCalls = src.match(/executeAgent\(stage\.agent[\s\S]{0,160}?\)/g) || [];
assert(stageCalls.length > 0, 'the pipeline stage dispatch is present');
for (const c of stageCalls) {
  assert(/useRepoTools:\s*true/.test(c), 'every pipeline stage dispatch passes useRepoTools, not just one of them');
}

// --- 4. name collisions: a remote tool must not shadow the gated reader -----------------------------
// An MCP server the operator connected could expose its own "Read". If that shadowed the repo tool,
// a denylist-gated local reader would be silently replaced by an unaudited remote one.
assert(/repo\w*\.names\.has\(|REPO_TOOL_NAMES\.has\(/.test(src),
  'repo tool names are reserved against MCP tools of the same name');

// --- 5. read-only means NO approval gate, and that must be deliberate -------------------------------
// MCP calls route through gateAction because they are outward/side-effectful. Repo reads are neither:
// gating them would queue an approval for every file an auditor opens and make the pipeline unusable.
// The property to pin is that the repo branch RETURNS before the MCP gate, not that no gate exists.
const execBlock = src.slice(src.indexOf('const toolset ='), src.indexOf('const toolset =') + 2600);
const iRepo = execBlock.search(/runReadOnlyRepoTool/);
const iGate = execBlock.search(/gateAction\(\{/);
assert(iRepo > -1 && iGate > -1, 'both the repo dispatch and the MCP approval gate are in the executor');
assert(iRepo < iGate, 'a repo read is served before the MCP approval gate is reached — read-only work must not queue an approval per file');

// --- 6. tool output is still fenced as untrusted -----------------------------------------------------
// A repo file can contain adversarial text (a README, a fixture, a vendored sample). The existing
// tool-use path already fences results; this asserts the pipeline path uses THAT function.
assert(/callAnthropicWithTools\(/.test(src), 'the toolset path goes through callAnthropicWithTools');
assert(/UNTRUSTED TOOL OUTPUT/.test(src), '...which fences every tool result as untrusted data');

console.log('  info: repo tools reuse the self-improve denylist unchanged; ' + planStore.DENIED_PATH_PREFIXES.length + ' denied prefixes');
done();
