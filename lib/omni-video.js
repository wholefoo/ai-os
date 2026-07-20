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

async function submitGeneration({ apiKey, prompt, tier, resolution, durationSeconds, aspectRatio, priorVideoUri }) {
  const resolvedTierKey = resolveTier(tier);
  if (priorVideoUri && !EXTENSION_TIERS.includes(resolvedTierKey)) {
    throw new Error(`Video extension is not supported on the "${resolvedTierKey}" tier (Lite excluded per Veo docs)`);
  }
  const t = VEO_TIERS[resolvedTierKey];
  const instance = { prompt };
  // Extension references the PRIOR generation's own server-side video via the `uri` Google
  // returned in that generation's completed operation response (op.response.generateVideoResponse
  // .generatedSamples[0].video.uri, threaded through by the caller) -- not re-uploaded bytes.
  // Google's own docs page shows `video: {inlineData: {mimeType, data: base64}}` here, but three
  // independent live fetches of that page (including bypassing the WebFetch cache) all still show
  // it, and the live endpoint rejects it outright: "inlineData isn't supported by this model" --
  // confirmed against a real request 2026-07-20. The docs are stale for this field, the same way
  // they were for numberOfVideos. This bare {"uri": ...} shape matches a real user's confirmed-
  // working request reported on Google's own developer forum.
  if (priorVideoUri) instance.video = { uri: priorVideoUri };
  const res = await fetch(`${API_BASE}/models/${t.model}:predictLongRunning?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        // No numberOfVideos here: a doc example (via secondary summarization, not a source read
        // directly) suggested sending it, but the live endpoint rejects it outright ("numberOfVideos
        // isn't supported by this model. Please remove it") — confirmed against a real request
        // 2026-07-20. The original single-clip call never sent it and always worked; don't send it.
        aspectRatio: resolveAspectRatio(aspectRatio),
        // Extension is 720p-only regardless of the requested resolution (Google's docs) —
        // resolveResolution() below is called with an already-forced '720p' by generateVideo()
        // whenever priorVideoUri is present, so this just re-validates, it doesn't decide.
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
// priorVideoUri: when set, this call EXTENDS that video (real continuity, conditioned on its
// final second/24 frames per Google's docs) instead of starting a fresh clip. Pass the `uri` a
// PRIOR call to this same function returned (see the return value below) -- Google keeps that
// generation server-side for 2 days, and extension references it there directly, no re-upload.
// The response is the FULL cumulative video each time, not just the new segment -- so a chain of
// extend calls is just "call generateVideo again with priorVideoUri set to the last call's
// returned uri," no separate stitching step. Extension forces 720p regardless of what resolution
// was requested, since Google's docs state extension is 720p-only.
async function generateVideo({
  apiKey, prompt, tier, resolution, durationSeconds, aspectRatio, destPath,
  priorVideoUri, onProgress, pollIntervalMs = 8000, maxWaitMs = 8 * 60 * 1000,
}) {
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');
  const resolvedTier = resolveTier(tier);
  const resolvedResolution = priorVideoUri ? '720p' : resolveResolution(resolution, tier);
  const resolvedDuration = resolveDuration(durationSeconds);

  onProgress?.(10, priorVideoUri ? 'Submitting extension to Veo...' : 'Submitting to Veo...');
  const operationName = await submitGeneration({
    apiKey, prompt, tier: resolvedTier, resolution: resolvedResolution,
    durationSeconds: resolvedDuration, aspectRatio, priorVideoUri,
  });

  const start = Date.now();
  let op;
  for (;;) {
    if (Date.now() - start > maxWaitMs) throw new Error('Veo generation timed out');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    op = await pollOperation({ apiKey, operationName });
    const elapsedPct = Math.min(85, 20 + Math.round(((Date.now() - start) / maxWaitMs) * 65));
    onProgress?.(elapsedPct, priorVideoUri ? 'Veo is extending your video...' : 'Veo is rendering your video...');
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
    extended: !!priorVideoUri,
    uri, // thread this into the NEXT call's priorVideoUri to continue the chain
  };
}

module.exports = {
  VEO_TIERS, VIDEO_FILE_RE, EXTEND_NET_SECONDS, priceFor,
  submitGeneration, pollOperation, downloadVideo, generateVideo,
};
