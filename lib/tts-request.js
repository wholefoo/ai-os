// lib/tts-request.js — the OpenAI text-to-speech request body for POST /api/tts, kept out of server.js
// so the allow-lists are testable without calling OpenAI (tools/test-tts-request.js).
//
// Formats: 'mp3' (default) is played by the browser. 'pcm' is raw 16-bit signed little-endian MONO at
// 24 kHz, no header — exactly what a LiveAvatar LITE session lip-syncs to (SDK repeatAudio(base64)).
// LITE mode does no text-to-speech of its own: `repeat(text)` throws "Not permitted in LITE mode", so
// the video avatar's lips can only move to audio we send it (dashboard/js/app.js sendToHeyGen).

const TTS_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse']);
const TTS_FORMATS = new Set(['mp3', 'pcm']);
const MAX_INPUT_CHARS = 4096;          // OpenAI's input limit
const MAX_INSTRUCTION_CHARS = 500;

function buildTtsBody({ text, voice, instructions, format } = {}) {
  const body = {
    model: 'gpt-4o-mini-tts',
    input: String(text || '').substring(0, MAX_INPUT_CHARS),
    voice: TTS_VOICES.has(voice) ? voice : 'onyx',            // reject unknown ids rather than 400 at OpenAI
    response_format: TTS_FORMATS.has(format) ? format : 'mp3', // anything else falls back to the default
  };
  // Per-agent character steering — only sent when provided (kept short + safe).
  if (instructions && typeof instructions === 'string') body.instructions = instructions.slice(0, MAX_INSTRUCTION_CHARS);
  return body;
}

module.exports = { buildTtsBody, TTS_FORMATS };
