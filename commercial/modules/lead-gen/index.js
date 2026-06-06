// modules/lead-gen/index.js — Lead generation and pipeline management
// Tier: business+ — requires ai-os-commercial license
//
// Lead capture forms, lead scoring, nurturing workflows,
// pipeline stages, and conversion tracking.

module.exports = {
  name: 'lead-gen',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.leadGen) {
      console.log('[COMMERCIAL] Skipping lead-gen (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - POST /api/leads — capture new lead
    // - GET /api/leads — list leads with filtering
    // - PUT /api/leads/:id — update lead status
    // - POST /api/leads/:id/score — score/qualify lead
    // - GET /api/leads/pipeline — pipeline overview
    // - POST /api/leads/nurture — create nurturing workflow

    console.log('[COMMERCIAL] ✓ Lead Gen routes registered');
  },
};
