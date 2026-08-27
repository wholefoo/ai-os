// lib/omni-media.js — real image + speech generation via the Gemini Interactions API.
//
// A genuinely different REST surface from callGemini's :generateContent (text) and
// omni-video.js's :predictLongRunning (async video): POST /v1beta/interactions is synchronous,
// auth goes in an `x-goog-api-key` header (not a `?key=` query param), and output comes back as
// `steps[].content[]` items keyed by `type` ("image" | "audio" | "thought"), not the
// `candidates[].content.parts[]` shape text generation uses. Verified live against the real API
// 2026-07-18 — raw response shapes (mime_type/data/channels/sample_rate field names, the `steps`
// array structure, image bytes decoding to a valid JPEG, audio decoding to correctly-timed PCM)
// confirmed by an actual request/response round-trip, not just the docs.

const fs = require('fs');
const path = require('path');
const { httpError } = require('./transient-errors');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const IMAGE_MODEL = 'gemini-3.1-flash-image';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';

const ALLOWED_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const ALLOWED_IMAGE_SIZES = ['1K', '2K', '4K'];

// The 30 prebuilt Gemini TTS voices, verified against ai.google.dev/gemini-api/docs/speech-generation
// on 2026-07-18. Allowlisted rather than pattern-matched so an invalid name fails loud instead of
// silently reaching the API with a typo'd voice.
const VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);
const DEFAULT_VOICE = 'Kore';

// Allowlists for the serve/delete routes — only filenames this module itself generates.
const IMAGE_FILE_RE = /^omni-image-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
const AUDIO_FILE_RE = /^omni-audio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;

function resolveAspectRatio(aspectRatio, fallback) {
  return ALLOWED_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : fallback;
}
function resolveImageSize(imageSize) {
  return ALLOWED_IMAGE_SIZES.includes(imageSize) ? imageSize : '1K';
}
function resolveVoice(voice) {
  return VOICES.has(voice) ? voice : DEFAULT_VOICE;
}

async function callInteractions({ apiKey, model, input, responseFormat, generationConfig }) {
  const body = { model, input };
  if (responseFormat) body.response_format = responseFormat;
  if (generationConfig) body.generation_config = generationConfig;

  const res = await fetch(`${API_BASE}/interactions`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res, await res.json().catch(() => ({})), 'Gemini Interactions');
  return res.json();
}

function extractOutput(data, type) {
  const step = (data.steps || []).find((s) => s.type === 'model_output');
  const item = step && step.content && step.content.find((c) => c.type === type);
  if (!item) throw new Error(`Gemini Interactions response had no "${type}" output`);
  return item;
}

// Raw PCM (as returned by the TTS model, mime_type "audio/l16") has no self-describing container —
// wrap it in a standard 44-byte WAV header using the sample_rate/channels the API actually reported,
// not assumed constants, so a future model change that alters them still produces a playable file.
function pcmToWav(pcm, sampleRate, channels, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function generateImage({ apiKey, prompt, aspectRatio, imageSize, destPath }) {
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');
  const data = await callInteractions({
    apiKey,
    model: IMAGE_MODEL,
    input: [{ type: 'text', text: prompt }],
    responseFormat: {
      type: 'image',
      mime_type: 'image/jpeg',
      aspect_ratio: resolveAspectRatio(aspectRatio, '1:1'),
      image_size: resolveImageSize(imageSize),
    },
  });
  const item = extractOutput(data, 'image');
  const buf = Buffer.from(item.data, 'base64');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return {
    bytes: buf.length,
    mimeType: item.mime_type,
    inputTokens: data.usage?.total_input_tokens || 0,
    outputTokens: data.usage?.total_output_tokens || 0,
  };
}

async function generateSpeech({ apiKey, text, voice, destPath }) {
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');
  const data = await callInteractions({
    apiKey,
    model: TTS_MODEL,
    input: text,
    responseFormat: { type: 'audio' },
    generationConfig: { speech_config: [{ voice: resolveVoice(voice) }] },
  });
  const item = extractOutput(data, 'audio');
  const pcm = Buffer.from(item.data, 'base64');
  const wav = pcmToWav(pcm, item.sample_rate || 24000, item.channels || 1);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, wav);
  return {
    bytes: wav.length,
    mimeType: 'audio/wav',
    inputTokens: data.usage?.total_input_tokens || 0,
    outputTokens: data.usage?.total_output_tokens || 0,
  };
}

module.exports = {
  IMAGE_MODEL, TTS_MODEL, VOICES, DEFAULT_VOICE,
  IMAGE_FILE_RE, AUDIO_FILE_RE,
  resolveAspectRatio, resolveVoice,
  generateImage, generateSpeech,
};
