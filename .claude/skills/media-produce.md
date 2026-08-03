---
name: media-produce
description: Generate video, image, or 3D assets from prompts using Remotion, Google Vids, or Blender
category: creative
rubric: design
estimated_time: ~60s
---

# Media Produce

## Goal
A rendered file exists on disk at a stated path, in the requested format, or the run reports exactly
which stage failed and why. A job that ends "queued" is not a finished job.

## What good looks like
- The output file exists and is playable or viewable. A render that produced a zero-byte file is a
  failure, however cleanly the process exited.
- The output matches the requested type and engine. Silently falling back to a different engine
  changes the cost and the look, and the operator has to be told.
- The render's real duration and cost are recorded, not the estimate. Estimated cost recorded as
  actual is how a budget ledger drifts.
- A failure names the stage that failed — validation, queue, render, or write — because those have
  entirely different fixes.
- Where a template was requested, the output visibly follows it. A prompt that overrode the template
  is reported as having done so.

## Guardrails
- Never generate a real person's likeness or voice without explicit, per-request operator approval.
- Never retry a failed render automatically — generation is billed per attempt.

## Team
- **media-producer** — engine selection, the render, and the artifact write

## Parameters
- `title`: Production title
- `type`: video | image | audio | 3d
- `engine`: remotion-local | google-vids | blender-mcp (default: remotion-local)
- `prompt`: Description of what to produce
- `template`: Optional template ID to use

## Output
- `.magent/artifacts/media/` — the rendered asset, with its real duration and cost recorded
