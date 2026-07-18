// Real Veo video generation (lib/omni-video.js): tier/resolution/duration resolution + clamping,
// pricing math against the verified 2026-07-17 rate table, the filename allowlist, and the full
// submit -> poll -> download lifecycle against a mocked global.fetch (no real network/API cost).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const omniVideo = require('../lib/omni-video');
const { VEO_TIERS, VIDEO_FILE_RE, priceFor, submitGeneration, pollOperation, downloadVideo, generateVideo } = omniVideo;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-video-'));
  const realFetch = global.fetch;

  // --- priceFor() — verified against ai.google.dev/gemini-api/docs/pricing 2026-07-17
  assert(priceFor('fast', '720p', 8) === 0.8, `fast/720p/8s = $0.80 (got ${priceFor('fast', '720p', 8)})`);
  assert(priceFor('fast', '1080p', 8) === 0.96, `fast/1080p/8s = $0.96 (got ${priceFor('fast', '1080p', 8)})`);
  assert(priceFor('standard', '720p', 8) === 3.2, `standard/720p/8s = $3.20 (got ${priceFor('standard', '720p', 8)})`);
  assert(priceFor('lite', '720p', 4) === 0.2, `lite/720p/4s = $0.20 (got ${priceFor('lite', '720p', 4)})`);
  assert(priceFor('lite', '1080p', 6) === 0.48, `lite/1080p/6s = $0.48 (got ${priceFor('lite', '1080p', 6)})`);

  // --- resolution fallback: lite has no 4k pricing, so it must fall back to 720p rather than NaN
  assert(priceFor('lite', '4k', 8) === priceFor('lite', '720p', 8), 'lite/4k (unsupported) falls back to lite/720p pricing, not NaN');

  // --- unknown tier/duration/resolution all degrade to safe defaults, never throw or NaN
  assert(priceFor('nonsense-tier', '720p', 8) === priceFor('fast', '720p', 8), 'unknown tier falls back to fast');
  assert(priceFor('fast', 'nonsense-res', 8) === priceFor('fast', '720p', 8), 'unknown resolution falls back to 720p');
  assert(priceFor('fast', '720p', 999) === priceFor('fast', '720p', 8), 'unrecognized duration falls back to 8s (only 4/6/8 are valid)');
  assert(!Number.isNaN(priceFor(undefined, undefined, undefined)), 'fully missing args never produce NaN');

  // --- VIDEO_FILE_RE allowlist
  const validName = 'omni-video-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.mp4';
  assert(VIDEO_FILE_RE.test(validName), `allowlist accepts a real uuid filename (${validName})`);
  for (const bad of ['../../etc/passwd', 'omni-video-not-a-uuid.mp4', 'evil.mp4', 'omni-video-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.mp4.exe', 'omni-video-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.avi']) {
    assert(!VIDEO_FILE_RE.test(bad), `allowlist rejects "${bad}"`);
  }

  // --- submitGeneration(): correct endpoint/model per tier, request body shape
  let lastReq = null;
  global.fetch = async (url, opts) => {
    lastReq = { url, opts };
    return { ok: true, json: async () => ({ name: 'models/veo-3.1-fast-generate-preview/operations/op123' }) };
  };
  const opName = await submitGeneration({ apiKey: 'KEY', prompt: 'a cat playing piano', tier: 'fast', resolution: '1080p', durationSeconds: 6, aspectRatio: '9:16' });
  assert(opName === 'models/veo-3.1-fast-generate-preview/operations/op123', 'submitGeneration returns the operation name');
  assert(lastReq.url.includes('veo-3.1-fast-generate-preview:predictLongRunning'), `submitGeneration hits the fast-tier model endpoint (${lastReq.url})`);
  assert(lastReq.url.includes('key=KEY'), 'submitGeneration passes the API key as a query param (matches callGemini convention)');
  const body = JSON.parse(lastReq.opts.body);
  assert(body.instances[0].prompt === 'a cat playing piano', 'request body carries the prompt');
  // durationSeconds must be a JSON NUMBER — the live API rejects a string (verified 2026-07-18).
  assert(body.parameters.resolution === '1080p' && body.parameters.durationSeconds === 6 && body.parameters.aspectRatio === '9:16', `request body carries resolved parameters, durationSeconds as a number (${JSON.stringify(body.parameters)})`);

  // --- submitGeneration(): non-ok response surfaces the API error message
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid prompt' } }) });
  try {
    await submitGeneration({ apiKey: 'KEY', prompt: 'x' });
    assert(false, 'submitGeneration should throw on non-ok response');
  } catch (e) {
    assert(e.message === 'Invalid prompt', `submitGeneration surfaces the real API error (got "${e.message}")`);
  }

  // --- submitGeneration(): missing operation name is a clear error, not a silent undefined
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  try {
    await submitGeneration({ apiKey: 'KEY', prompt: 'x' });
    assert(false, 'submitGeneration should throw when no operation name is returned');
  } catch (e) {
    assert(/operation name/.test(e.message), `clear error when Veo returns no operation name (got "${e.message}")`);
  }

  // --- pollOperation()
  global.fetch = async (url) => { lastReq = { url }; return { ok: true, json: async () => ({ done: true, response: {} }) }; };
  const op = await pollOperation({ apiKey: 'KEY', operationName: 'models/x/operations/op123' });
  assert(op.done === true, 'pollOperation returns the parsed operation body');
  assert(lastReq.url.includes('models/x/operations/op123') && lastReq.url.includes('key=KEY'), `pollOperation hits the operation URL with the API key (${lastReq.url})`);

  // --- downloadVideo(): writes real bytes to disk, creating the parent dir
  const fakeBytes = Buffer.from('FAKE_MP4_BYTES');
  global.fetch = async (url) => { lastReq = { url }; return { ok: true, arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength) }; };
  const destPath = path.join(dir, 'nested', 'video.mp4');
  const written = await downloadVideo({ apiKey: 'KEY', uri: 'https://example.com/video?alt=media', destPath });
  assert(written === fakeBytes.length, `downloadVideo reports the correct byte count (${written})`);
  assert(fs.existsSync(destPath), 'downloadVideo creates the parent directory and writes the file');
  assert(fs.readFileSync(destPath).equals(fakeBytes), 'downloadVideo writes the exact bytes returned by the API');
  assert(lastReq.url.includes('key=KEY') && lastReq.url.includes('&key='), `downloadVideo appends the API key with the correct separator for a URL that already has a query string (${lastReq.url})`);

  // --- downloadVideo(): non-ok response throws
  global.fetch = async () => ({ ok: false, status: 403 });
  try {
    await downloadVideo({ apiKey: 'KEY', uri: 'https://example.com/v', destPath: path.join(dir, 'x.mp4') });
    assert(false, 'downloadVideo should throw on non-ok response');
  } catch (e) {
    assert(/403/.test(e.message), `downloadVideo surfaces the HTTP status (got "${e.message}")`);
  }

  // --- generateVideo(): full lifecycle — submit, poll twice (not done, then done), download
  let pollCount = 0;
  const progressLog = [];
  global.fetch = async (url, opts) => {
    if (url.includes('predictLongRunning')) {
      return { ok: true, json: async () => ({ name: 'models/veo-3.1-fast-generate-preview/operations/opXYZ' }) };
    }
    if (url.includes('operations/opXYZ')) {
      pollCount++;
      if (pollCount < 2) return { ok: true, json: async () => ({ done: false }) };
      return { ok: true, json: async () => ({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://example.com/final.mp4' } }] } } }) };
    }
    if (url.includes('final.mp4')) {
      return { ok: true, arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const lifecycleDest = path.join(dir, 'lifecycle.mp4');
  const result = await generateVideo({
    apiKey: 'KEY', prompt: 'a sunrise over mountains', tier: 'fast', resolution: '720p', durationSeconds: 8,
    destPath: lifecycleDest, pollIntervalMs: 5, maxWaitMs: 5000,
    onProgress: (pct, msg) => progressLog.push({ pct, msg }),
  });
  assert(result.bytes === fakeBytes.length, `generateVideo reports the downloaded byte count (${result.bytes})`);
  assert(result.tier === 'fast' && result.resolution === '720p' && result.durationSeconds === 8, `generateVideo echoes back the resolved params (${JSON.stringify(result)})`);
  assert(result.cost === priceFor('fast', '720p', 8), `generateVideo reports the correct real-dollar cost (${result.cost})`);
  assert(fs.existsSync(lifecycleDest) && fs.readFileSync(lifecycleDest).equals(fakeBytes), 'generateVideo writes the final downloaded bytes to destPath');
  assert(progressLog.length >= 2, `onProgress fired multiple times across the lifecycle (${progressLog.length} calls)`);
  assert(progressLog[0].pct < 100 && progressLog[progressLog.length - 1].pct < 100, 'progress percentages stay under 100 until the caller marks completion (100 is set by the route, not this module)');

  // --- generateVideo(): operation error is surfaced, not silently swallowed
  global.fetch = async (url) => {
    if (url.includes('predictLongRunning')) return { ok: true, json: async () => ({ name: 'models/x/operations/opErr' }) };
    return { ok: true, json: async () => ({ done: true, error: { message: 'Content policy violation' } }) };
  };
  try {
    await generateVideo({ apiKey: 'KEY', prompt: 'x', destPath: path.join(dir, 'err.mp4'), pollIntervalMs: 5, maxWaitMs: 5000 });
    assert(false, 'generateVideo should throw when the operation itself errors');
  } catch (e) {
    assert(e.message === 'Content policy violation', `generateVideo surfaces the operation error (got "${e.message}")`);
  }

  // --- generateVideo(): done-but-no-video-URI is a clear error, not a crash on undefined access
  global.fetch = async (url) => {
    if (url.includes('predictLongRunning')) return { ok: true, json: async () => ({ name: 'models/x/operations/opEmpty' }) };
    return { ok: true, json: async () => ({ done: true, response: {} }) };
  };
  try {
    await generateVideo({ apiKey: 'KEY', prompt: 'x', destPath: path.join(dir, 'empty.mp4'), pollIntervalMs: 5, maxWaitMs: 5000 });
    assert(false, 'generateVideo should throw when done but no video URI is present');
  } catch (e) {
    assert(/no video/.test(e.message), `clear error for a done-but-empty response (got "${e.message}")`);
  }

  // --- generateVideo(): missing API key fails fast with a clear message, before any network call
  global.fetch = async () => { throw new Error('should not be called'); };
  try {
    await generateVideo({ apiKey: '', prompt: 'x', destPath: path.join(dir, 'nokey.mp4') });
    assert(false, 'generateVideo should throw immediately with no API key');
  } catch (e) {
    assert(/API key/.test(e.message), `clear error for a missing API key (got "${e.message}"), no network call attempted`);
  }

  // --- generateVideo(): times out rather than polling forever
  global.fetch = async (url) => {
    if (url.includes('predictLongRunning')) return { ok: true, json: async () => ({ name: 'models/x/operations/opForever' }) };
    return { ok: true, json: async () => ({ done: false }) };
  };
  try {
    await generateVideo({ apiKey: 'KEY', prompt: 'x', destPath: path.join(dir, 'timeout.mp4'), pollIntervalMs: 5, maxWaitMs: 15 });
    assert(false, 'generateVideo should time out rather than poll forever');
  } catch (e) {
    assert(/timed out/.test(e.message), `generateVideo enforces maxWaitMs (got "${e.message}")`);
  }

  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
