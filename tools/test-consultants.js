// LLM provider consultants: frontmatter integrity, provider-routing completeness, and the
// canonical count guard (registry must stay at 64 so the auto-research drift guard matches).
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

// --- canonical count guard: the registry is 64 and the auto-research guards agree
const registry = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).length;
assert(registry === 64, `agent registry is 64 (57 + 7 consultants), got ${registry}`);
const score = fs.readFileSync(path.join(__dirname, '..', 'auto-research', 'score.js'), 'utf8');
assert(/\/\\b64\\b\//.test(score), 'auto-research score.js FACTS guards 64');
assert(/\(\?!64\\b\)/.test(score), 'auto-research score.js drift-throw guards 64');

done();
