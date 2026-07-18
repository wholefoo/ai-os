// lib/omni-video.js — real video generation via Veo on the Gemini Developer API.
//
// Text generation in this codebase (server.js callGemini) hits :generateContent and returns
// immediately. Video generation is a fundamentally different shape: a long-running operation
// (Google's docs cite up to several minutes) — submit via :predictLongRunning, poll
// operations.get until done, then download the resulting video bytes from the URI in the final
// response. This module owns that whole lifecycle so callers get one async generateVideo() with
// a progress callback, mirroring the shape of the fake setTimeout-driven job it replaces.
//
// Contract verified against ai.google.dev/gemini-api/docs/veo and .../pricing on 2026-07-17.
// This is a PAID PREVIEW feature with no free tier — every call is billed from the first second.

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Fast is the default: a fraction of Standard's per-second cost for the same 720p/1080p output.
const VEO_TIERS = {
  lite: { model: 'veo-3.1-lite-generate-preview', pricePerSecond: { '720p': 0.05, '1080p': 0.08 } },
  fast: { model: 'veo-3.1-fast-generate-preview', pricePerSecond: { '720p': 0.10, '1080p': 0.12, '4k': 0.30 } },
  standard: { model: 'veo-3.1-generate-preview', pricePerSecond: { '720p': 0.40, '1080p': 0.40, '4k': 0.60 } },
};
const ALLOWED_DURATIONS = [4, 6, 8];
const ALLOWED_RESOLUTIONS = ['720p', '1080p', '4k'];
const ALLOWED_ASPECT_RATIOS = ['16:9', '9:16'];

// Allowlist for the download/serve route — only filenames this module itself generates.
const VIDEO_FILE_RE = /^omni-video-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

function resolveTier(tier) {
  return VEO_TIERS[tier] ? tier : 'fast';
}
function resolveResolution(resolution, tier) {
  const t = VEO_TIERS[resolveTier(tier)];
  return ALLOWED_RESOLUTIONS.includes(resolution) && t.pricePerSecond[resolution] ? resolution : '720p';
}
function resolveDuration(durationSeconds) {
  const n = Number(durationSeconds);
  return ALLOWED_DURATIONS.includes(n) ? n : 8;
}
function resolveAspectRatio(aspectRatio) {
  return ALLOWED_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '16:9';
}

function priceFor(tier, resolution, durationSeconds) {
  const t = VEO_TIERS[resolveTier(tier)];
  const perSec = t.pricePerSecond[resolveResolution(resolution, tier)] || t.pricePerSecond['720p'];
  return Math.round(perSec * resolveDuration(durationSeconds) * 10000) / 10000;
}

async function submitGeneration({ apiKey, prompt, tier, resolution, durationSeconds, aspectRatio }) {
  const t = VEO_TIERS[resolveTier(tier)];
  const res = await fetch(`${API_BASE}/models/${t.model}:predictLongRunning?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        aspectRatio: resolveAspectRatio(aspectRatio),
        resolution: resolveResolution(resolution, tier),
        durationSeconds: String(resolveDuration(durationSeconds)),
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Veo HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.name) throw new Error('Veo did not return an operation name');
  return data.name;
}

async function pollOperation({ apiKey, operationName }) {
  const res = await fetch(`${API_BASE}/${operationName}?key=${apiKey}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Veo poll HTTP ${res.status}`);
  }
  return res.json();
}

async function downloadVideo({ apiKey, uri, destPath }) {
  const sep = uri.includes('?') ? '&' : '?';
  const res = await fetch(`${uri}${sep}key=${apiKey}`);
  if (!res.ok) throw new Error(`Veo download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// Full lifecycle: submit -> poll until done -> download. onProgress(pct, msg) fires throughout so
// callers can drive the same WebSocket progress events the old simulated job used.
async function generateVideo({
  apiKey, prompt, tier, resolution, durationSeconds, aspectRatio, destPath,
  onProgress, pollIntervalMs = 8000, maxWaitMs = 8 * 60 * 1000,
}) {
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');
  const resolvedTier = resolveTier(tier);
  const resolvedResolution = resolveResolution(resolution, tier);
  const resolvedDuration = resolveDuration(durationSeconds);

  onProgress?.(10, 'Submitting to Veo...');
  const operationName = await submitGeneration({
    apiKey, prompt, tier: resolvedTier, resolution: resolvedResolution,
    durationSeconds: resolvedDuration, aspectRatio,
  });

  const start = Date.now();
  let op;
  for (;;) {
    if (Date.now() - start > maxWaitMs) throw new Error('Veo generation timed out');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    op = await pollOperation({ apiKey, operationName });
    const elapsedPct = Math.min(85, 20 + Math.round(((Date.now() - start) / maxWaitMs) * 65));
    onProgress?.(elapsedPct, 'Veo is rendering your video...');
    if (op.done) break;
  }

  if (op.error) throw new Error(op.error.message || 'Veo generation failed');
  const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw new Error('Veo finished but returned no video');

  onProgress?.(92, 'Downloading generated video...');
  const bytes = await downloadVideo({ apiKey, uri, destPath });

  return {
    bytes, tier: resolvedTier, resolution: resolvedResolution, durationSeconds: resolvedDuration,
    cost: priceFor(resolvedTier, resolvedResolution, resolvedDuration),
  };
}

module.exports = {
  VEO_TIERS, VIDEO_FILE_RE, priceFor,
  submitGeneration, pollOperation, downloadVideo, generateVideo,
};
