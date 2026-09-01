'use strict';

// Integrations registry helpers (P1 "connect any tool" surface).
//
// A minimal MCP (Model Context Protocol) Streamable-HTTP client used to test a registered MCP server
// and discover its tools, plus a side-effect-free reachability probe for n8n/webhook endpoints.
//
// SECURITY NOTE: integration endpoints are ADMIN-supplied operator config and are frequently local
// (e.g. the Hermes worker at 127.0.0.1:8420). These calls therefore intentionally do NOT route through
// lib/net/safeFetch — that guard blocks private/loopback IPs to stop SSRF from UNTRUSTED input, which
// would make legitimate local MCP servers untestable. Callers MUST keep these endpoints admin-only.

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY = 256 * 1024; // cap how much of a response we read/parse

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// A JSON-RPC response may arrive as application/json OR as a text/event-stream (SSE) body. Return all
// JSON-RPC messages found either way.
function parseJsonRpcBody(text, contentType) {
  const msgs = [];
  if (contentType && contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1]) { try { msgs.push(JSON.parse(m[1])); } catch { /* skip non-JSON data lines */ } }
    }
  } else {
    try { const j = JSON.parse(text); Array.isArray(j) ? msgs.push(...j) : msgs.push(j); } catch { /* not JSON */ }
  }
  return msgs;
}

async function mcpRpc(endpoint, body, { token, sessionId, timeoutMs = 8000 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  const ct = res.headers.get('content-type') || '';
  const raw = (await res.text()).slice(0, MAX_BODY);
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') || sessionId,
    messages: parseJsonRpcBody(raw, ct),
  };
}

// The opening MCP handshake: validate the endpoint, `initialize`, then send the `initialized`
// notification. Every call that talks to a server needs exactly this before it can do anything, and
// it is ONE decision, not two — the protocol version, the client identity we present, what counts as
// an auth rejection, and what proves the thing on the other end is even an MCP server must not be
// able to drift between callers. It had been written out twice, in mcpListTools and mcpCallTool,
// which is precisely the shape where a protocol bump gets applied to one copy.
//
// Returns { ok:false, error } if the endpoint is malformed, auth was rejected, or the peer did not
// answer initialize with a result; otherwise { ok:true, serverInfo, sessionId }.
async function mcpHandshake(endpoint, { token, timeoutMs }) {
  try { new URL(endpoint); } catch { return { ok: false, error: 'invalid endpoint URL' }; }

  const init = await mcpRpc(endpoint, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ai-os', version: '1.0' } },
  }, { token, timeoutMs });

  if (init.status === 401 || init.status === 403) return { ok: false, error: `auth failed (HTTP ${init.status}) — check the token` };

  const initMsg = init.messages.find(m => m.id === 1);
  if (!initMsg || !initMsg.result) {
    const err = (init.messages.find(m => m.error) || {}).error;
    return { ok: false, error: err ? `MCP error: ${err.message || JSON.stringify(err)}` : `not an MCP server (HTTP ${init.status}, no initialize result)` };
  }
  const sessionId = init.sessionId;

  // initialized notification — best-effort; some servers gate tools/list behind it
  try { await mcpRpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, sessionId, timeoutMs: 4000 }); } catch { /* non-fatal */ }

  return { ok: true, serverInfo: initMsg.result.serverInfo || {}, sessionId };
}

// Connect to an MCP server (initialize -> initialized -> tools/list) and return its advertised tools.
// Returns { ok, serverInfo:{name,version}, tools:[{name,description}] } or { ok:false, error }.
async function mcpListTools(endpoint, { token, timeoutMs = 8000 } = {}) {
  try {
    const hs = await mcpHandshake(endpoint, { token, timeoutMs });
    if (!hs.ok) return hs;
    const { serverInfo, sessionId } = hs;

    const list = await mcpRpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { token, sessionId, timeoutMs });
    const listMsg = list.messages.find(m => m.id === 2);
    const tools = (listMsg && listMsg.result && Array.isArray(listMsg.result.tools))
      ? listMsg.result.tools.map(t => ({ name: String(t.name || '').slice(0, 80), description: String(t.description || '').slice(0, 200), inputSchema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object' } }))
      : [];

    return { ok: true, serverInfo: { name: String(serverInfo.name || '').slice(0, 80), version: String(serverInfo.version || '').slice(0, 40) }, tools };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Reachability probe for an n8n/webhook endpoint. Uses HEAD (falling back to GET) so it never triggers
// the workflow — n8n webhooks fire on their configured method (usually POST), so any HTTP response here
// (even a 404 "not registered for GET") proves the endpoint is reachable.
async function probeWebhook(url, { token, timeoutMs = 6000 } = {}) {
  try { new URL(url); } catch { return { ok: false, error: 'invalid URL' }; }
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', headers }, timeoutMs).catch(() => null);
    if (!res || res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs);
    }
    return { ok: res.status < 500, status: res.status, error: res.status >= 500 ? `server error (HTTP ${res.status})` : undefined };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

function maskSecret(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= 6) return '••••';
  return s.slice(0, 3) + '••••' + s.slice(-2);
}

// Invoke a tool on an MCP server (initialize -> initialized -> tools/call). Returns { ok, content, error }.
async function mcpCallTool(endpoint, toolName, args, { token, timeoutMs = 20000 } = {}) {
  try {
    const hs = await mcpHandshake(endpoint, { token, timeoutMs });
    if (!hs.ok) return hs;
    const { sessionId } = hs;
    const call = await mcpRpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args || {} } }, { token, sessionId, timeoutMs });
    const msg = call.messages.find(m => m.id === 2);
    if (!msg) return { ok: false, error: `no tools/call response (HTTP ${call.status})` };
    if (msg.error) return { ok: false, error: msg.error.message || JSON.stringify(msg.error) };
    const r = msg.result || {};
    // MCP tool results are an array of content blocks; flatten the text ones for the model.
    const text = Array.isArray(r.content)
      ? r.content.map(b => (b && b.type === 'text') ? b.text : (b && b.type ? `[${b.type} content]` : '')).filter(Boolean).join('\n').trim()
      : (typeof r.content === 'string' ? r.content : JSON.stringify(r.content || r));
    return { ok: !r.isError, content: text || '(empty result)', isError: Boolean(r.isError) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { mcpListTools, mcpCallTool, probeWebhook, maskSecret };
