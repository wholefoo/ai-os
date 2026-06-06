// commercial/loader.js — Commercial module loader
// Loads the commercial module (index.js) and validates the license key.
// Without AIOS_LICENSE_KEY + AIOS_SIGNING_SECRET env vars, falls back to community defaults.

let commercial = null;

try {
  commercial = require('./index');
  if (commercial.valid) {
    console.log(`[COMMERCIAL] Loaded — ${commercial.tier.toUpperCase()} license active`);
  } else {
    console.log(`[COMMERCIAL] Loaded — no valid license key, running in Community mode`);
  }
} catch (err) {
  console.error(`[COMMERCIAL] Failed to load module:`, err.message);
}

// Community defaults — used when no license key is present or module fails to load
const COMMUNITY_DEFAULTS = {
  tier: 'community',
  valid: true,
  licenseKey: null,

  orgChartExtension: {
    departments: [],
    additionalAgents: {},
  },

  features: {
    multiTenant: false,
    creativeStudio: false,
    youtubeIntel: false,
    unlimitedSeo: false,
    grokIntel: false,
    leadGen: false,
    browserAgent: false,
    advancedReporting: false,
    videoMeetings: false,
    agentBuilder: false,       // enterprise
    selfImproving: false,      // enterprise
    whiteLabel: false,         // enterprise
    hermesAdvanced: false,
    batchQueue: false,
    designSystem: false,
    productFactory: false,
    sso: false,                // enterprise
    customAgentBuilder: false, // enterprise
    slaConfig: false,          // enterprise
    prioritySupport: false,    // enterprise
  },

  limits: {
    seoAuditsPerMonth: 1,
    memoryEntries: 100,
    schedules: 3,
    pipelines: 2,
    routines: 1,
    plugins: 0,
    reports: 0,
    customAgents: 0,
    customDocs: 0,
  },

  registerRoutes: () => {},
  modules: {},
};

// If commercial module loaded but no valid license, use community defaults
// but keep registerRoutes so the module can still register routes if tier is sufficient
if (commercial && !commercial.valid) {
  module.exports = { ...COMMUNITY_DEFAULTS, registerRoutes: commercial.registerRoutes };
} else if (commercial && commercial.valid) {
  module.exports = commercial;
} else {
  module.exports = COMMUNITY_DEFAULTS;
}
