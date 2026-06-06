// commercial/loader.js — Commercial module detection and loading
// This file ships with the public repo. It detects whether the ai-os-commercial
// package is installed and loads it. If not found, returns community defaults.

const path = require('path');
const fs = require('fs');

const COMMERCIAL_PATHS = [
  path.join(__dirname, 'modules'),                                    // manual drop-in: commercial/modules/
  path.join(__dirname, '..', 'node_modules', 'ai-os-commercial'),     // npm install
  process.env.AIOS_COMMERCIAL_PATH,                                   // env override
].filter(Boolean);

let commercial = null;

for (const p of COMMERCIAL_PATHS) {
  const entry = path.join(p, 'index.js');
  if (fs.existsSync(entry)) {
    try {
      commercial = require(entry);
      console.log(`[COMMERCIAL] Loaded commercial module from: ${p}`);
      break;
    } catch (err) {
      console.error(`[COMMERCIAL] Failed to load module from ${p}:`, err.message);
    }
  }
}

if (!commercial) {
  console.log('[COMMERCIAL] No commercial module found — running in Community mode');
}

// Export either the loaded commercial module or community defaults
module.exports = commercial || {
  tier: 'community',
  valid: true,
  licenseKey: null,

  // Community org chart extension — no additional departments
  orgChartExtension: {
    departments: [],
    additionalAgents: {},  // keyed by department id, arrays of agents to add
  },

  // Feature flags
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

  // Limits for community tier
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

  // No-op route registration
  registerRoutes: () => {},

  // No-op module accessors
  modules: {},
};
