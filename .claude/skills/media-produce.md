---
name: media-produce
description: Generate video, image, or 3D assets from prompts using Remotion, Google Vids, or Blender
category: creative
agent: media-producer
est: ~60s
parameters:
  - name: title
    type: string
    description: Production title
  - name: type
    type: string
    description: Output type
    options: [video, image, audio, 3d]
  - name: engine
    type: string
    description: Rendering engine
    options: [remotion-local, google-vids, blender-mcp]
    default: remotion-local
  - name: prompt
    type: string
    description: Description of what to produce
  - name: template
    type: string
    description: Optional template ID to use
---

# Media Produce

Starts a media production job:
1. Validates inputs and selects engine
2. Queues the production
3. Renders using selected engine
4. Outputs to `.magent/artifacts/media/`

Supports batch rendering when used with routines.
