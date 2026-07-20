// lib/omni-video.js — real video generation via Veo on the Gemini Developer API.
//
// Text generation in this codebase (server.js callGemini) hits :generateContent and returns
// immediately. Video generation is a fundamentally different shape: a long-running operation
// (Google's docs cite up to several minutes) — submit via :predictLongRunning, poll
// operations.get until done, then download the resulting video bytes from the URI in the final
// response. This module owns that whole lifecycle so callers get one async generateVideo() with
// a progress callback, mirroring the shape of the fake setTimeout-driven job it replaces.
//
// Contract verified against ai.google.dev/gemini-api/docs/veo and .../pricing on 2026-07-17;
// extension contract re-verified against the same page on 2026-07-19.
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

// Extension (continuing an already-generated video with real visual continuity, conditioned on
// its final second/24 frames) is documented as supported only on these two tiers — Lite is
// explicitly excluded. Each extend call nets ~7s of new output; Google caps the cumulative chain
// at 148s. Extension is 720p-only regardless of what the base clip's resolution was.
const EXTENSION_TIERS = ['fast', 'standard'];
const EXTEND_NET_SECONDS = 7;

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

// Billing note: Google's pricing page gives only a flat per-second rate with no separate line
// item for extension calls. We bill every call — the first generation AND every extend — as a
// full 8 seconds at that rate, matching the durationSeconds actually sent on every extend request.
// This is a deliberately conservative (over- rather than under-) estimate: if extends turn out to
// only bill their ~7 net new seconds, real spend will run slightly below what this shows. Never
// assumed the cheaper direction without a live confirmed source.
function priceFor(tier, resolution, durationSeconds) {
  const t = VEO_TIERS[resolveTier(tier)];
  const perSec = t.pricePerSecond[resolveResolution(resolution, tier)] || t.pricePerSecond['720p'];
  return Math.round(perSec * resolveDuration(durationSeconds) * 10000) / 10000;
}

async function submitGeneration({ apiKey, prompt, tier, resolution, durationSeconds, aspectRatio, priorVideoBase64 }) {
  const resolvedTierKey = resolveTier(tier);
  if (priorVideoBase64 && !EXTENSION_TIERS.includes(resolvedTierKey)) {
    throw new Error(`Video extension is not supported on the "${resolvedTierKey}" tier (Lite excluded per Veo docs)`);
  }
  const t = VEO_TIERS[resolvedTierKey];
  const instance = { prompt };
  // Extension request shape per ai.google.dev/gemini-api/docs/veo: the prior video is sent as
  // inline base64 (not a URI/operation reference) — "this must be a video from a previous
  // generation."
  if (priorVideoBase64) instance.video = { inlineData: { mimeType: 'video/mp4', data: priorVideoBase64 } };
  const res = await fetch(`${API_BASE}/models/${t.model}:predictLongRunning?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        numberOfVideos: 1,
        aspectRatio: resolveAspectRatio(aspectRatio),
        // Extension is 720p-only regardless of the requested resolution (Google's docs) —
        // resolveResolution() below is called with an already-forced '720p' by generateVideo()
        // whenever priorVideoBase64 is present, so this just re-validates, it doesn't decide.
        resolution: resolveResolution(resolution, tier),
        // Must be a JSON number — the live API rejects a string here ("The value type for
        // `durationSeconds` needs to be a number"), despite doc examples suggesting otherwise.
        // Verified against the real endpoint 2026-07-18. Extension requests also send 8 here
        // (the model always works in 8-second chunks; ~7s of it is genuinely new output, the
        // rest anchors continuity to the prior clip's final second).
        durationSeconds: resolveDuration(durationSeconds),
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
//
// priorVideoPath: when set, this call EXTENDS that video (real continuity, conditioned on its
// final second/24 frames per Google's docs) instead of starting a fresh clip. The response is the
// FULL cumulative video each time, not just the new segment — so a chain of extend calls is just
// "call generateVideo again with priorVideoPath pointing at the file the last call wrote," no
// separate stitching step. Extension forces 720p regardless of what resolution was requested,
// since Google's docs state extension is 720p-only.
async function generateVideo({
  apiKey, prompt, tier, resolution, durationSeconds, aspectRatio, destPath,
  priorVideoPath, onProgress, pollIntervalMs = 8000, maxWaitMs = 8 * 60 * 1000,
}) {
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');
  const resolvedTier = resolveTier(tier);
  const resolvedResolution = priorVideoPath ? '720p' : resolveResolution(resolution, tier);
  const resolvedDuration = resolveDuration(durationSeconds);

  let priorVideoBase64 = null;
  if (priorVideoPath) {
    onProgress?.(5, 'Preparing prior clip for extension...');
    priorVideoBase64 = fs.readFileSync(priorVideoPath).toString('base64');
  }

  onProgress?.(10, priorVideoPath ? 'Submitting extension to Veo...' : 'Submitting to Veo...');
  const operationName = await submitGeneration({
    apiKey, prompt, tier: resolvedTier, resolution: resolvedResolution,
    durationSeconds: resolvedDuration, aspectRatio, priorVideoBase64,
  });

  const start = Date.now();
  let op;
  for (;;) {
    if (Date.now() - start > maxWaitMs) throw new Error('Veo generation timed out');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    op = await pollOperation({ apiKey, operationName });
    const elapsedPct = Math.min(85, 20 + Math.round(((Date.now() - start) / maxWaitMs) * 65));
    onProgress?.(elapsedPct, priorVideoPath ? 'Veo is extending your video...' : 'Veo is rendering your video...');
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
    extended: !!priorVideoPath,
  };
}

module.exports = {
  VEO_TIERS, VIDEO_FILE_RE, EXTEND_NET_SECONDS, priceFor,
  submitGeneration, pollOperation, downloadVideo, generateVideo,
};
