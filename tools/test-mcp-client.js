// The MCP Streamable-HTTP client in lib/integrations.js, against a real local MCP server.
//
// This suite exists because the module had NO coverage at all, which is a bad property for the code
// that talks to admin-registered third-party servers on the operator's behalf — and it is the reason
// a duplicated `initialize` handshake sat in mcpListTools and mcpCallTool untouched: there was no way
// to prove a refactor of it was safe. Written FIRST, green against the un-refactored module, so that
// the extraction that follows is checked rather than asserted.
//
// The server here is deliberately a real http.Server on an ephemeral port, not a stubbed `fetch`. The
// things most likely to break in this client are wire-level: which headers go out, whether the
// session id from the initialize RESPONSE is echoed on later requests, and whether an SSE body is
// parsed at all. A fetch stub would have to reimplement each of those to test them, and would then be
// testing the stub. Port 0 also sidesteps this repo's usual "kill the test server by port" problem —
// nothing is ever bound twice.
'use strict';

const http = require('http');
const { assert, done } = require('./test-util');
const { mcpListTools, mcpCallTool, maskSecret, probeWebhook } = require('../lib/integrations');

const PROTOCOL_VERSION = '2025-06-18';

const send = (res, status, obj, extraHeaders = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(obj === null ? '' : JSON.stringify(obj));
};

/** Start a throwaway MCP server. `handler(msg, res)` decides each reply; every request is recorded
 *  so the tests can assert on what actually went over the wire. */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch { /* non-JSON body */ }
      requests.push({ method: req.method, headers: req.headers, msg });
      handler(msg, res, requests);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const okInitialize = (msg, res) => send(res, 200, {
  jsonrpc: '2.0', id: msg.id,
  result: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake-mcp', version: '9.9' } },
}, { 'Mcp-Session-Id': 'sess-abc' });

/** A well-behaved server: initialize -> initialized -> tools/list | tools/call. */
function healthy({ tools = [], callResult = { content: [{ type: 'text', text: 'done' }] } } = {}) {
  return (msg, res) => {
    if (!msg || !msg.method) return send(res, 202, null);
    if (msg.method === 'initialize') return okInitialize(msg, res);
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/list') return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools } });
    if (msg.method === 'tools/call') return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: callResult });
    return send(res, 404, {});
  };
}

async function withServer(handler, fn) {
  const s = await startServer(handler);
  try { return await fn(s); } finally { await s.close(); }
}

async function suite() {
  // --- the handshake's wire contract -------------------------------------------------------------
  // These four are the whole reason the duplicated prologue was worth unifying: protocol version,
  // client identity, auth and session handling are ONE decision, and two copies can disagree.
  await withServer(healthy({ tools: [{ name: 'echo', description: 'echoes' }] }), async (s) => {
    const r = await mcpListTools(s.url, { token: 'secret-token' });
    assert(r.ok === true, 'listTools: healthy server returns ok');

    const init = s.requests.find((q) => q.msg && q.msg.method === 'initialize');
    assert(init, 'listTools: an initialize request is actually sent');
    assert(init.headers['mcp-protocol-version'] === PROTOCOL_VERSION,
      `listTools: MCP-Protocol-Version header is ${PROTOCOL_VERSION}`);
    assert(init.msg.params.protocolVersion === PROTOCOL_VERSION,
      'listTools: and the same version is in the initialize params — header and body must not drift');
    assert(init.msg.params.clientInfo.name === 'ai-os', 'listTools: identifies itself as ai-os');
    assert(init.headers.authorization === 'Bearer secret-token', 'listTools: bearer token is sent');
    assert(String(init.headers.accept).includes('text/event-stream'),
      'listTools: Accept advertises SSE — a Streamable-HTTP server may answer either way');

    const notified = s.requests.find((q) => q.msg && q.msg.method === 'notifications/initialized');
    assert(notified, 'listTools: the initialized notification is sent — some servers gate tools/list behind it');

    const list = s.requests.find((q) => q.msg && q.msg.method === 'tools/list');
    assert(list.headers['mcp-session-id'] === 'sess-abc',
      'listTools: the session id from the initialize RESPONSE is echoed on later requests');
    assert(notified.headers['mcp-session-id'] === 'sess-abc',
      'listTools: including on the notification itself');
  });

  // --- tools/list result shaping -----------------------------------------------------------------
  await withServer(healthy({
    tools: [
      { name: 'x'.repeat(200), description: 'd'.repeat(400), inputSchema: { type: 'object', properties: { a: {} } } },
      { name: 'plain' },
    ],
  }), async (s) => {
    const r = await mcpListTools(s.url);
    assert(r.ok === true && r.tools.length === 2, 'listTools: returns every advertised tool');
    assert(r.tools[0].name.length === 80, 'listTools: tool name is capped at 80 chars');
    assert(r.tools[0].description.length === 200, 'listTools: tool description is capped at 200 chars');
    assert(r.tools[0].inputSchema.properties.a !== undefined, 'listTools: a real inputSchema passes through');
    assert(r.tools[1].inputSchema.type === 'object',
      'listTools: a MISSING inputSchema becomes {type:object} rather than undefined — callers hand this straight to a model');
    assert(r.serverInfo.name === 'fake-mcp' && r.serverInfo.version === '9.9', 'listTools: serverInfo is reported');
  });

  // --- SSE transport -----------------------------------------------------------------------------
  // The same JSON-RPC messages, delivered as text/event-stream. If this regresses, every SSE-mode MCP
  // server silently looks like "not an MCP server" — a failure that reads as the operator's fault.
  await withServer((msg, res) => {
    if (!msg || !msg.method) return send(res, 202, null);
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    const payload = msg.method === 'initialize'
      ? { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'sse-server', version: '1' } } }
      : { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'via-sse' }] } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }, async (s) => {
    const r = await mcpListTools(s.url);
    assert(r.ok === true, 'SSE: an event-stream body is parsed, not treated as garbage');
    assert(r.tools.length === 1 && r.tools[0].name === 'via-sse', 'SSE: tools come through intact');
  });

  // --- failure paths -----------------------------------------------------------------------------
  assert((await mcpListTools('not a url')).error === 'invalid endpoint URL', 'listTools: rejects a malformed endpoint');
  assert((await mcpCallTool('not a url', 't', {})).error === 'invalid endpoint URL', 'callTool: rejects a malformed endpoint');

  for (const status of [401, 403]) {
    await withServer((msg, res) => send(res, status, { error: 'nope' }), async (s) => {
      const l = await mcpListTools(s.url);
      assert(l.ok === false && l.error === `auth failed (HTTP ${status}) — check the token`,
        `listTools: HTTP ${status} is an auth failure naming the status`);
      const c = await mcpCallTool(s.url, 'tool', {});
      assert(c.ok === false && /^auth failed \(HTTP \d+\)/.test(c.error) && c.error.includes(String(status)),
        `callTool: HTTP ${status} is an auth failure naming the status`);
    });
  }

  // An endpoint that answers, but is not an MCP server.
  await withServer((msg, res) => send(res, 200, { hello: 'i am a plain web service' }), async (s) => {
    const r = await mcpListTools(s.url);
    assert(r.ok === false && /not an MCP server/.test(r.error),
      'listTools: a 200 with no initialize result is "not an MCP server", not a crash');
  });

  // A server that speaks JSON-RPC and refuses.
  await withServer((msg, res) => send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'go away' } }),
    async (s) => {
      const r = await mcpListTools(s.url);
      assert(r.ok === false && /go away/.test(r.error), 'listTools: a JSON-RPC error is surfaced verbatim');
    });

  // --- tools/call result flattening --------------------------------------------------------------
  await withServer(healthy({
    callResult: { content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }] },
  }), async (s) => {
    const r = await mcpCallTool(s.url, 'echo', { a: 1 });
    assert(r.ok === true, 'callTool: succeeds against a healthy server');
    assert(r.content === 'first\n[image content]\nsecond',
      'callTool: text blocks are joined and non-text blocks become a placeholder rather than vanishing');
    const call = s.requests.find((q) => q.msg && q.msg.method === 'tools/call');
    assert(call.msg.params.name === 'echo', 'callTool: sends the tool name');
    assert(call.msg.params.arguments.a === 1, 'callTool: sends the arguments');
    assert(call.headers['mcp-session-id'] === 'sess-abc', 'callTool: the session id reaches the tools/call request');
  });

  await withServer(healthy({ callResult: { content: [{ type: 'text', text: 'boom' }], isError: true } }), async (s) => {
    const r = await mcpCallTool(s.url, 'bad', {});
    assert(r.ok === false && r.isError === true, 'callTool: isError in the RESULT means the call failed');
    assert(r.content === 'boom', 'callTool: and the error text is still returned to the caller');
  });

  await withServer(healthy({ callResult: { content: [] } }), async (s) => {
    const r = await mcpCallTool(s.url, 'quiet', {});
    assert(r.content === '(empty result)', 'callTool: an empty result reads as "(empty result)", never as blank');
  });

  await withServer((msg, res) => {
    if (msg && msg.method === 'initialize') return okInitialize(msg, res);
    if (msg && msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { message: 'no such tool' } });
  }, async (s) => {
    const r = await mcpCallTool(s.url, 'missing', {});
    assert(r.ok === false && r.error === 'no such tool', 'callTool: a tools/call JSON-RPC error is surfaced');
  });

  // --- unrelated helpers in the same module, previously untested ---------------------------------
  assert(maskSecret('abcdef1234') === 'abc••••34', 'maskSecret: shows first three and last two');
  assert(maskSecret('short') === '••••', 'maskSecret: a short secret reveals nothing at all');
  assert(maskSecret('') === '' && maskSecret(null) === '', 'maskSecret: empty/nullish stay empty');

  await withServer((msg, res) => send(res, 200, { ok: true }), async (s) => {
    const r = await probeWebhook(s.url);
    assert(r.ok === true && r.status === 200, 'probeWebhook: a reachable endpoint probes ok');
    assert(s.requests.every((q) => q.method !== 'POST'),
      'probeWebhook: never POSTs — an n8n webhook fires on POST, so probing must not trigger the workflow');
  });
  assert((await probeWebhook('nope')).error === 'invalid URL', 'probeWebhook: rejects a malformed URL');
}

suite().then(done, (e) => { console.error('FAIL: suite threw:', e); process.exitCode = 1; done(); });
