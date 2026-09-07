'use strict';

// The deadline covers headers AND body. Count bytes before accumulating them.
async function boundedFetch(url, opts = {}, ms = 120000, maxBytes = 16 * 1024 * 1024) {
  const ctrl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  try {
    const response = await fetch(url, { ...opts, signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { ctrl.abort(); throw new Error(`Response exceeds ${maxBytes} bytes`); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (e) {
    if (!timedOut) throw e;
    const error = new Error(`request exceeded the ${Math.round(ms / 1000)}s client timeout`);
    error.timedOut = true;
    error.timeoutMs = ms;
    error.cause = e;
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = { boundedFetch };
