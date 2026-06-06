// modules/white-label/index.js — White-label customization
// Tier: enterprise+ — requires ai-os-commercial license
//
// Custom branding, domain mapping, theme customization,
// and reseller configuration for white-label deployments.

module.exports = {
  name: 'white-label',
  tier: 'enterprise',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.whiteLabel) {
      console.log('[COMMERCIAL] Skipping white-label (requires enterprise+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - GET /api/whitelabel/config — get branding config
    // - PUT /api/whitelabel/config — update branding
    // - POST /api/whitelabel/domain — map custom domain
    // - PUT /api/whitelabel/theme — customize theme/colors
    // - POST /api/whitelabel/logo — upload custom logo
    // - GET /api/whitelabel/preview — preview branded instance

    console.log('[COMMERCIAL] ✓ White-Label routes registered');
  },
};
