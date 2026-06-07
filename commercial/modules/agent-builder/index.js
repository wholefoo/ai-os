// modules/agent-builder/index.js — Custom agent builder
// Tier: enterprise+ — requires ai-os-commercial license
//
// Create, configure, train, and deploy custom AI agents.
// Includes agent templates, custom tool definitions, and deployment management.

module.exports = {
  name: 'agent-builder',
  tier: 'enterprise',

  registerRoutes(app, ctx) {
    const { features, limits, requireTier, activeTier } = ctx;

    // Feature gate: skip if tier is insufficient
    if (!features.agentBuilder) {
      console.log('[COMMERCIAL] Skipping agent-builder (requires enterprise+ license)');
      return;
    }

    // No routes to extract from server.js yet — this feature's API
    // endpoints have not been implemented in the monolith.
    //
    // Planned routes (implement here when ready):
    // - POST /api/agents/create — create custom agent
    // - GET  /api/agents — list custom agents
    // - PUT  /api/agents/:id — update agent config
    // - POST /api/agents/:id/train — train agent on data
    // - POST /api/agents/:id/deploy — deploy agent
    // - DELETE /api/agents/:id — remove agent

    console.log(`[COMMERCIAL] Agent Builder ready (tier=${activeTier}, maxAgents=${limits.customAgents})`);
  },
};
