// modules/creative-studio/index.js — Creative Studio department
// Tier: business+ — requires ai-os-commercial license
//
// Media production department: video generation, image generation,
// audio production, and creative asset management.

module.exports = {
  name: 'creative-studio',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.creativeStudio) {
      console.log('[COMMERCIAL] Skipping creative-studio (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - POST /api/creative/generate-image — AI image generation
    // - POST /api/creative/generate-video — AI video generation
    // - GET /api/creative/assets — list creative assets
    // - POST /api/creative/render — render media project
    // - Media production pipeline endpoints

    console.log('[COMMERCIAL] ✓ Creative Studio routes registered');
  },
};
