// Real Gemini Interactions API image + speech generation (lib/omni-media.js): aspect-ratio/voice
// resolution + clamping, the filename allowlists, response parsing (steps[].content[] shape
// verified live against the real API 2026-07-18), and WAV-wrapping of raw PCM — against a mocked
// global.fetch (no real network/API cost).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const omniMedia = require('../lib/omni-media');
const {
  IMAGE_MODEL, TTS_MODEL, VOICES, DEFAULT_VOICE, IMAGE_FILE_RE, AUDIO_FILE_RE,
  resolveAspectRatio, resolveVoice, generateImage, generateSpeech,
} = omniMedia;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-media-'));
  const realFetch = global.fetch;

  // --- model IDs, verified live against the real API 2026-07-18
  assert(IMAGE_MODEL === 'gemini-3.1-flash-image', `image model id (${IMAGE_MODEL})`);
  assert(TTS_MODEL === 'gemini-3.1-flash-tts-preview', `TTS model id (${TTS_MODEL})`);

  // --- resolveAspectRatio(): allowlisted values pass through, unknowns fall back to the caller's default
  assert(resolveAspectRatio('16:9', '1:1') === '16:9', 'a valid aspect ratio passes through');
  assert(resolveAspectRatio('9:16', '1:1') === '9:16', 'another valid aspect ratio passes through');
  assert(resolveAspectRatio('nonsense', '1:1') === '1:1', 'an invalid aspect ratio falls back to the caller-supplied default');
  assert(resolveAspectRatio(undefined, '16:9') === '16:9', 'a missing aspect ratio falls back to the caller-supplied default');

  // --- resolveVoice(): allowlisted voices pass through, unknowns fall back to DEFAULT_VOICE
  assert(VOICES.size === 30, `30 prebuilt voices are allowlisted (got ${VOICES.size})`);
  assert(DEFAULT_VOICE === 'Kore', `default voice is Kore (got ${DEFAULT_VOICE})`);
  assert(resolveVoice('Puck') === 'Puck', 'a valid voice name passes through');
  assert(resolveVoice('NotARealVoice') === DEFAULT_VOICE, 'an unknown voice falls back to the default, not passed through unchecked');
  assert(resolveVoice(undefined) === DEFAULT_VOICE, 'a missing voice falls back to the default');

  // --- IMAGE_FILE_RE / AUDIO_FILE_RE allowlists — same shape as omni-video.js's VIDEO_FILE_RE
  const validImage = 'omni-image-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.jpg';
  const validAudio = 'omni-audio-a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789.wav';
  assert(IMAGE_FILE_RE.test(validImage), `image allowlist accepts a real uuid filename (${validImage})`);
  assert(AUDIO_FILE_RE.test(validAudio), `audio allowlist accepts a real uuid filename (${validAudio})`);
  for (const bad of ['../../etc/passwd', 'omni-image-not-a-uuid.jpg', 'evil.jpg', validImage + '.exe', validImage.replace('.jpg', '.png')]) {
    assert(!IMAGE_FILE_RE.test(bad), `image allowlist rejects "${bad}"`);
  }
  for (const bad of ['../../etc/passwd', 'omni-audio-not-a-uuid.wav', 'evil.wav', validAudio + '.exe', validAudio.replace('.wav', '.mp3')]) {
    assert(!AUDIO_FILE_RE.test(bad), `audio allowlist rejects "${bad}"`);
  }

  // --- generateImage(): correct endpoint/headers/body, parses the real steps[].content[] response shape
  let lastReq = null;
  const fakeJpeg = Buffer.from('FAKE_JPEG_BYTES');
  global.fetch = async (url, opts) => {
    lastReq = { url, opts };
    return {
      ok: true,
      json: async () => ({
        id: 'v1_fake', status: 'completed', model: IMAGE_MODEL,
        usage: { total_input_tokens: 14, total_output_tokens: 1441 },
        steps: [
          { type: 'thought', signature: 'x' },
          { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: fakeJpeg.toString('base64') }] },
        ],
      }),
    };
  };
  const imgDest = path.join(dir, 'nested', 'img.jpg');
  const imgResult = await generateImage({ apiKey: 'KEY', prompt: 'a red circle', aspectRatio: '16:9', destPath: imgDest });
  assert(lastReq.url === 'https://generativelanguage.googleapis.com/v1beta/interactions', `generateImage hits the Interactions endpoint (${lastReq.url})`);
  assert(lastReq.opts.headers['x-goog-api-key'] === 'KEY', 'generateImage sends the API key as a header, not a query param (Interactions API convention, unlike callGemini/Veo)');
  const imgBody = JSON.parse(lastReq.opts.body);
  assert(imgBody.model === IMAGE_MODEL && imgBody.input[0].text === 'a red circle', 'request body carries the model and prompt');
  assert(imgBody.response_format.aspect_ratio === '16:9', 'request body carries the resolved aspect ratio');
  assert(imgResult.bytes === fakeJpeg.length && imgResult.mimeType === 'image/jpeg', `generateImage reports the correct byte count and mime type (${JSON.stringify(imgResult)})`);
  assert(imgResult.inputTokens === 14 && imgResult.outputTokens === 1441, 'generateImage surfaces real usage token counts for cost-ledger billing');
  assert(fs.existsSync(imgDest) && fs.readFileSync(imgDest).equals(fakeJpeg), 'generateImage creates the parent directory and writes the exact decoded bytes');

  // --- generateImage(): missing API key fails fast, before any network call
  global.fetch = async () => { throw new Error('should not be called'); };
  try {
    await generateImage({ apiKey: '', prompt: 'x', destPath: path.join(dir, 'nokey.jpg') });
    assert(false, 'generateImage should throw immediately with no API key');
  } catch (e) {
    assert(/API key/.test(e.message), `clear error for a missing API key (got "${e.message}")`);
  }

  // --- generateImage(): non-ok response surfaces the API error message
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Blocked prompt' } }) });
  try {
    await generateImage({ apiKey: 'KEY', prompt: 'x', destPath: path.join(dir, 'err.jpg') });
    assert(false, 'generateImage should throw on non-ok response');
  } catch (e) {
    assert(e.message === 'Blocked prompt', `generateImage surfaces the real API error (got "${e.message}")`);
  }

  // --- generateImage(): a response with no image content step is a clear error, not a crash
  global.fetch = async () => ({ ok: true, json: async () => ({ steps: [{ type: 'model_output', content: [] }] }) });
  try {
    await generateImage({ apiKey: 'KEY', prompt: 'x', destPath: path.join(dir, 'empty.jpg') });
    assert(false, 'generateImage should throw when no image output is present');
  } catch (e) {
    assert(/no "image" output/.test(e.message), `clear error for a missing image step (got "${e.message}")`);
  }

  // --- generateSpeech(): correct request shape, wraps raw PCM in a valid 44-byte WAV header
  const pcmSamples = Buffer.alloc(2000); // silence — content doesn't matter for header verification
  global.fetch = async (url, opts) => {
    lastReq = { url, opts };
    return {
      ok: true,
      json: async () => ({
        usage: { total_input_tokens: 16, total_output_tokens: 127 },
        steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16', channels: 1, sample_rate: 24000, data: pcmSamples.toString('base64') }] }],
      }),
    };
  };
  const audioDest = path.join(dir, 'nested', 'speech.wav');
  const audioResult = await generateSpeech({ apiKey: 'KEY', text: 'hello world', voice: 'Puck', destPath: audioDest });
  const audioBody = JSON.parse(lastReq.opts.body);
  assert(audioBody.model === TTS_MODEL && audioBody.input === 'hello world', 'request body carries the model and text (input is a plain string for TTS, not an array like image)');
  assert(audioBody.response_format.type === 'audio' && audioBody.generation_config.speech_config[0].voice === 'Puck', 'request body carries the audio response_format and resolved voice');
  assert(audioResult.mimeType === 'audio/wav', `generateSpeech reports audio/wav after WAV-wrapping raw PCM (got ${audioResult.mimeType})`);
  assert(audioResult.bytes === pcmSamples.length + 44, `generateSpeech's WAV output is exactly the 44-byte header plus the raw PCM (got ${audioResult.bytes})`);
  const written = fs.readFileSync(audioDest);
  assert(written.toString('ascii', 0, 4) === 'RIFF' && written.toString('ascii', 8, 12) === 'WAVE', 'WAV file starts with a valid RIFF/WAVE header');
  assert(written.readUInt16LE(22) === 1 && written.readUInt32LE(24) === 24000, `WAV header carries the real channel count and sample rate reported by the API (${written.readUInt16LE(22)}ch @ ${written.readUInt32LE(24)}Hz)`);
  assert(written.slice(44).equals(pcmSamples), 'WAV file body is the exact PCM bytes returned by the API, untouched');

  // --- generateSpeech(): an unknown voice is resolved to the default before being sent, not passed through raw
  global.fetch = async (url, opts) => {
    lastReq = { url, opts };
    return { ok: true, json: async () => ({ usage: {}, steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16', channels: 1, sample_rate: 24000, data: Buffer.alloc(10).toString('base64') }] }] }) };
  };
  await generateSpeech({ apiKey: 'KEY', text: 'x', voice: '<script>alert(1)</script>', destPath: path.join(dir, 'sanitize.wav') });
  const sentVoice = JSON.parse(lastReq.opts.body).generation_config.speech_config[0].voice;
  assert(sentVoice === DEFAULT_VOICE, `an unrecognized/malicious voice string is never forwarded to the API — resolved to the default instead (got "${sentVoice}")`);

  // --- generateSpeech(): missing API key fails fast, before any network call
  global.fetch = async () => { throw new Error('should not be called'); };
  try {
    await generateSpeech({ apiKey: '', text: 'x', destPath: path.join(dir, 'nokey.wav') });
    assert(false, 'generateSpeech should throw immediately with no API key');
  } catch (e) {
    assert(/API key/.test(e.message), `clear error for a missing API key (got "${e.message}")`);
  }

  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
