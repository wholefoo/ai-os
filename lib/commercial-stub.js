// lib/commercial-stub.js — Community fallback for the open-source core.
//
// The commercial/enterprise modules live in a SEPARATE PRIVATE repo (ai-os-commercial), mounted at
// ./commercial/ on licensed/operator deployments. When that directory is absent — i.e. the public
// open-source Community core — server.js falls back to this stub so the app still boots and runs at
// the Community tier. It mirrors the COMMUNITY_DEFAULTS that commercial/loader.js itself falls back
// to, and matches the exact shape server.js consumes (tier / valid / features / limits /
// orgChartExtension / registerRoutes).
module.exports = {
  tier: 'community',
  valid: true,
  licenseKey: null,

  orgChartExtension: {
    departments: [],
    additionalAgents: {},
  },

  features: {
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
    hermesAdvanced: false,
    batchQueue: false,
    designSystem: false,
    productFactory: false,
    sso: false,                // enterprise
    customAgentBuilder: false, // enterprise
    slaConfig: false,          // enterprise
    prioritySupport: false,    // enterprise
    videoAvatar: false,        // enterprise — real-time streaming video avatar (LiveAvatar)
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
    businessClones: 1,  // the operator's own clone; selling clones to clients needs a Business licence
  },

  registerRoutes: () => {},
  modules: {},
};
