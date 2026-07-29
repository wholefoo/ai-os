'use strict';

// A2A (Agent-to-Agent) interop surface — lets other vendors' agents discover and call this instance.
//
// Two pieces (transport + Task construction live in server.js, which has uuid/clock):
//   - buildAgentCard(): the discovery document advertised at /.well-known/agent.json
//   - resolveSkill():    maps a requested skillId to a SAFE, allowlisted AI OS agent
//   - extractText():     pulls the text out of an inbound A2A message
//
// Only the curated skill->agent allowlist below is reachable — an external caller can NOT invoke
// arbitrary internal agents (devops, sysadmin, ...), and the server does not enable MCP tools for
// A2A-dispatched runs.

const PROTOCOL_VERSION = '0.3.0';

const A2A_SKILLS = [
  { id: 'orchestrate', name: 'Orchestrate a task', agent: 'orchestrator', description: 'Coordinate a multi-step task across the AI OS agent workforce.', tags: ['general', 'coordination'], examples: ['Plan and draft a go-to-market brief for a new feature.'] },
  { id: 'research', name: 'Research a topic', agent: 'researcher', description: 'Gather, verify, and synthesize information into a cited brief.', tags: ['research'], examples: ['Summarize the current state of WebGPU adoption, with sources.'] },
  { id: 'web-intel', name: 'Real-time web intelligence', agent: 'grok-realtime', description: 'Live web / X search and fact-checking on current events.', tags: ['search', 'realtime'], examples: ['What are people saying about today’s product launch?'] },
  { id: 'content', name: 'Write content', agent: 'writer', description: 'Produce written deliverables — articles, briefs, marketing copy.', tags: ['writing'], examples: ['Write a 200-word intro for a blog post about agentic AI.'] },
  { id: 'support', name: 'AI OS product support', agent: 'support-helpdesk', description: 'Answer questions about AI OS, grounded in its documentation.', tags: ['support'], examples: ['How do I connect an MCP server?'] },
];

function buildAgentCard({ baseUrl }) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: 'AI OS Orchestration Lab',
    // Honest about access: the message endpoint is authenticated and NOT open to arbitrary callers — a
    // caller needs a bearer token provisioned by the instance operator (there is no self-serve A2A key yet).
    description: 'A self-hosted virtual company of AI agents across 11 departments, exposing a curated set of skills over A2A. Access is not open: calling this endpoint requires a bearer token provisioned by the instance operator.',
    url: `${url}/api/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    provider: { organization: 'AI OS Orchestration Lab', url },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
    skills: A2A_SKILLS.map(({ agent, ...skill }) => skill), // advertise skills, not internal agent names
  };
}

// Resolve a requested skillId to its agent (defaults to 'orchestrate'). Returns { id, agent, name }.
function resolveSkill(skillId) {
  const s = A2A_SKILLS.find(x => x.id === skillId) || A2A_SKILLS.find(x => x.id === 'orchestrate');
  return { id: s.id, agent: s.agent, name: s.name };
}

// Public skill catalogue (skill ids/names/descriptions only — never the internal agent names).
// Used by the admin key-mint UI to scope a key to a subset of skills.
function listSkills() {
  return A2A_SKILLS.map(({ agent, ...skill }) => skill);
}

// Is `id` one of the curated A2A skill ids? (validates a scope request at key-mint time).
function isValidSkillId(id) {
  return A2A_SKILLS.some(s => s.id === id);
}

// Concatenate the text parts of an A2A message (supports both `kind` and legacy `type` discriminators).
function extractText(message) {
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts
    .filter(p => p && (p.kind === 'text' || p.type === 'text') && typeof p.text === 'string')
    .map(p => p.text).join('\n').trim();
}

module.exports = { buildAgentCard, resolveSkill, extractText, listSkills, isValidSkillId };
