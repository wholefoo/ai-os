'use strict';

// n8n workflow template library (P1 "connector breadth" via n8n's 400+ nodes).
//
// Each template is a real, importable n8n workflow (a trigger + one action node) that wires an external
// tool to this AI OS instance. Two directions:
//   outbound  — n8n Webhook trigger -> tool action. AI OS POSTs to the webhook to act on the tool
//               (Slack/Sheets/Notion/... — anything n8n integrates). `webhookPath` is the path AI OS calls.
//   inbound   — external trigger (Schedule/Gmail/...) -> HTTP Request to AI OS /api/agent/execute, so the
//               event runs an agent. The HTTP node carries {{AI_OS_URL}} (substituted on render) and a
//               {{AI_OS_TOKEN}} placeholder the operator fills with their API token inside n8n.
//
// Credentials (Slack/Gmail/Google/Notion auth) are NEVER part of an n8n export — the operator binds them
// on import. That is the normal n8n flow, not a limitation; each template lists what to connect in `requires`.

const wf = (name, nodes, connections) => ({
  name, nodes, connections, active: false, settings: { executionOrder: 'v1' }, pinData: {},
});

const webhookNode = (path, label) => ({
  parameters: { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} },
  id: `webhook-${path}`, name: label, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [260, 300], webhookId: path,
});

const httpToAiOs = (jsonBody) => ({
  parameters: {
    method: 'POST',
    url: '{{AI_OS_URL}}/api/agent/execute',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer {{AI_OS_TOKEN}}' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    options: {},
  },
  id: 'http-ai-os', name: 'AI OS · run agent', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [560, 300],
});

const link = (from, to) => ({ [from]: { main: [[{ node: to, type: 'main', index: 0 }]] } });

const TEMPLATES = [
  {
    id: 'ai-os-to-slack',
    name: 'AI OS → Slack message',
    category: 'Chat',
    direction: 'outbound',
    description: 'AI OS posts a message to a Slack channel via n8n. Trigger it from any agent or automation by POSTing { "text": "..." } to the webhook.',
    requires: ['A Slack credential in n8n', 'Pick the target channel on the Slack node'],
    webhookPath: 'ai-os-slack',
    workflow: wf('AI OS → Slack message',
      [
        webhookNode('ai-os-slack', 'AI OS calls this'),
        {
          parameters: { resource: 'message', operation: 'post', select: 'channel', channelId: { __rl: true, value: '', mode: 'list' }, text: '={{ $json.body.text || $json.text }}', otherOptions: {} },
          id: 'slack-post', name: 'Post to Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.3, position: [560, 300],
        },
      ],
      link('AI OS calls this', 'Post to Slack')),
  },
  {
    id: 'ai-os-to-sheets',
    name: 'AI OS → Google Sheets row',
    category: 'Docs',
    direction: 'outbound',
    description: 'Append a row to a Google Sheet whenever AI OS POSTs to the webhook — handy for logging agent results, leads, or audit output.',
    requires: ['A Google Sheets credential in n8n', 'Select the spreadsheet + tab on the Sheets node'],
    webhookPath: 'ai-os-sheets',
    workflow: wf('AI OS → Google Sheets row',
      [
        webhookNode('ai-os-sheets', 'AI OS calls this'),
        {
          parameters: { operation: 'append', documentId: { __rl: true, value: '', mode: 'list' }, sheetName: { __rl: true, value: '', mode: 'list' }, columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [] }, options: {} },
          id: 'sheets-append', name: 'Append row', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [560, 300],
        },
      ],
      link('AI OS calls this', 'Append row')),
  },
  {
    id: 'ai-os-to-notion',
    name: 'AI OS → Notion page',
    category: 'Docs',
    direction: 'outbound',
    description: 'Create a Notion database page from an AI OS POST — e.g. file a research brief, a ticket, or a CRM note into Notion.',
    requires: ['A Notion credential in n8n', 'Select the target database on the Notion node'],
    webhookPath: 'ai-os-notion',
    workflow: wf('AI OS → Notion page',
      [
        webhookNode('ai-os-notion', 'AI OS calls this'),
        {
          parameters: { resource: 'databasePage', operation: 'create', databaseId: { __rl: true, value: '', mode: 'list' }, title: '={{ $json.body.title || "From AI OS" }}', propertiesUi: { propertyValues: [] }, options: {} },
          id: 'notion-create', name: 'Create page', type: 'n8n-nodes-base.notion', typeVersion: 2.2, position: [560, 300],
        },
      ],
      link('AI OS calls this', 'Create page')),
  },
  {
    id: 'schedule-to-agent',
    name: 'Schedule → AI OS agent',
    category: 'Scheduling',
    direction: 'inbound',
    description: 'Run an AI OS agent on a cron schedule (e.g. a daily digest from the scout agent). Edit the agent + task in the HTTP node body.',
    requires: ['Set {{AI_OS_TOKEN}} on the HTTP node to your AI OS API token', 'Adjust the schedule + the agent/task body'],
    workflow: wf('Schedule → AI OS agent',
      [
        { parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } }, id: 'schedule', name: 'Every day', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [260, 300] },
        httpToAiOs('{\n  "agent": "scout",\n  "task": "Summarize the most important AI/tech news from the last 24h."\n}'),
      ],
      link('Every day', 'AI OS · run agent')),
  },
  {
    id: 'gmail-to-agent',
    name: 'Gmail → AI OS agent',
    category: 'Email',
    direction: 'inbound',
    description: 'When a new email arrives, hand it to an AI OS agent (triage, draft a reply, extract tasks). The email is passed through to the agent task.',
    requires: ['A Gmail credential in n8n', 'Set {{AI_OS_TOKEN}} on the HTTP node to your AI OS API token'],
    workflow: wf('Gmail → AI OS agent',
      [
        { parameters: { pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: true, filters: {} }, id: 'gmail', name: 'New email', type: 'n8n-nodes-base.gmailTrigger', typeVersion: 1.2, position: [260, 300] },
        httpToAiOs('={\n  "agent": "cs-tier1",\n  "task": "Triage this inbound email and draft a reply:\\n\\nFrom: " + $json.from + "\\nSubject: " + $json.subject + "\\n\\n" + $json.snippet\n}'),
      ],
      link('New email', 'AI OS · run agent')),
  },
];

// Public catalog metadata (no workflow JSON — keeps the list response small).
function listTemplates() {
  return TEMPLATES.map(({ workflow, ...meta }) => meta);
}

// Return the importable workflow JSON with {{AI_OS_URL}} substituted. {{AI_OS_TOKEN}} is intentionally
// left as a placeholder for the operator to fill inside n8n (we never bake the admin token into a file).
function renderTemplate(id, { baseUrl }) {
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return null;
  const json = JSON.stringify(tpl.workflow).replace(/\{\{AI_OS_URL\}\}/g, String(baseUrl || '').replace(/\/+$/, ''));
  return { meta: (({ workflow, ...m }) => m)(tpl), workflow: JSON.parse(json) };
}

module.exports = { listTemplates, renderTemplate };
