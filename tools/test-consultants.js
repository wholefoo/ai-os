// LLM provider consultants: frontmatter integrity, provider-routing completeness, and the
// canonical count guard (registry must stay at 66 so the auto-research drift guard matches).
const fs = require('fs');
const path = require('path');
const { assert, done } = require('./test-util');

const agentsDir = path.join(__dirname, '..', '.claude', 'agents');
const CONSULTANTS = ['anthropic', 'openai', 'gemini', 'deepseek', 'grok', 'perplexity', 'manus'];

// --- every consultant file exists with valid frontmatter + WebSearch + a knowledge pack
for (const slug of CONSULTANTS) {
  const f = path.join(agentsDir, `consultant-${slug}.md`);
  assert(fs.existsSync(f), `consultant-${slug}.md exists`);
  const c = fs.readFileSync(f, 'utf8');
  const fm = (c.match(/^---([\s\S]*?)---/) || [])[1] || '';
  assert(new RegExp(`name:\\s*consultant-${slug}\\b`).test(fm), `${slug}: name frontmatter matches`);
  assert(/tools:.*WebSearch/.test(fm), `${slug}: has WebSearch (freshness discipline)`);
  assert(/Knowledge pack/i.test(c) && /Adopting it in AI OS/i.test(c), `${slug}: has knowledge pack + AI OS adoption section`);
}

// --- provider-routing map in server.js covers all seven and points each somewhere real
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mapBlock = (server.match(/const CONSULTANT_PROVIDER = \{([\s\S]*?)\};/) || [])[1] || '';
assert(mapBlock, 'CONSULTANT_PROVIDER map present in server.js');
for (const slug of CONSULTANTS) {
  assert(new RegExp(`'consultant-${slug}':`).test(mapBlock), `routing map includes consultant-${slug}`);
}
assert(/'consultant-manus': 'anthropic'/.test(mapBlock), 'manus routes to anthropic (no Manus caller — honest fallback)');
// the executeAgent branch must map each non-anthropic provider to a real caller
for (const [prov, caller] of [['openai', 'callOpenAI'], ['gemini', 'callGemini'], ['deepseek', 'callDeepSeek'], ['grok', 'callGrok'], ['perplexity', 'callPerplexity']]) {
  assert(new RegExp(`consultantProvider === '${prov}'[\\s\\S]{0,80}${caller}\\(`).test(server), `${prov} consultant routes to ${caller}`);
}

// --- Communications Director exists and disseminates (does not decide)
const comms = path.join(agentsDir, 'comms-director.md');
assert(fs.existsSync(comms), 'comms-director.md exists');
const cd = fs.readFileSync(comms, 'utf8');
assert(/name:\s*comms-director\b/.test(cd), 'comms-director name frontmatter');
assert(/dissemination flow/i.test(cd) && /consultant/i.test(cd), 'comms-director documents the consultant→dissemination flow');

// --- collaboration protocol: orchestrator + architect consult the consultants and route via comms-director
for (const a of ['orchestrator', 'architect']) {
  const t = fs.readFileSync(path.join(agentsDir, `${a}.md`), 'utf8');
  assert(/consultant-\w+/.test(t) && /comms-director/.test(t), `${a}.md wires consultants + comms-director`);
}
// --- each consultant reciprocally points findings at the comms-director
for (const slug of CONSULTANTS) {
  const t = fs.readFileSync(path.join(agentsDir, `consultant-${slug}.md`), 'utf8');
  assert(/comms-director/.test(t) && /Orchestrator/.test(t), `consultant-${slug} routes findings via comms-director`);
}

// --- canonical count guard: the registry is 68 and the auto-research guards agree
// 68 = 66 + chief-librarian + archivist, added with the Knowledge & Records department (#11).
// This assertion is the tripwire that catches a new agent file landing without the product copy
// being swept — which is the whole reason it is an equality check and not a `>=`.
const registry = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).length;
assert(registry === 68, `agent registry is 68 (58 + 7 consultants + comms-director + 2 Knowledge & Records), got ${registry}`);
const score = fs.readFileSync(path.join(__dirname, '..', 'auto-research', 'score.js'), 'utf8');
assert(/\/\\b68\\b\//.test(score), 'auto-research score.js FACTS guards 68');
assert(/\(\?!68\\b\)/.test(score), 'auto-research score.js drift-throw guards 68');

done();
