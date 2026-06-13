// tier-resolver.js — Determines active tier and feature availability

const TIER_HIERARCHY = {
  community: 0,
  business: 1,
  enterprise: 2,
};

/**
 * Check if the active tier meets or exceeds the required tier
 * @param {string} activeTier
 * @param {string} requiredTier
 * @returns {boolean}
 */
function meetsRequirement(activeTier, requiredTier) {
  return (TIER_HIERARCHY[activeTier] || 0) >= (TIER_HIERARCHY[requiredTier] || 0);
}

/**
 * Get feature flags for a given tier
 * @param {string} tier - 'business' or 'enterprise'
 * @returns {object}
 */
function getFeaturesForTier(tier) {
  const isBusiness = meetsRequirement(tier, 'business');
  const isEnterprise = meetsRequirement(tier, 'enterprise');

  return {
    creativeStudio: isBusiness,
    youtubeIntel: isBusiness,
    unlimitedSeo: isBusiness,
    grokIntel: isBusiness,
    leadGen: isBusiness,
    browserAgent: isBusiness,
    advancedReporting: isBusiness,
    videoMeetings: isBusiness,
    agentBuilder: isEnterprise,
    selfImproving: isEnterprise,
    hermesAdvanced: isBusiness,
    batchQueue: isBusiness,
    designSystem: isBusiness,
    productFactory: isBusiness,
    // Web Studio — the base (create/edit/host 1 site) lives in CORE so Community
    // gets it without loading any commercial module. These flags gate the EXTRAS.
    webStudioImport: isBusiness,        // GitHub / Firecrawl import
    webStudioCustomDomains: isBusiness, // custom domains on additional sites (Community's 1 is core)
    webStudioQualityGate: isBusiness,   // blocking WCAG gate (Community is warn-only)
    webStudioVisualQA: isBusiness,      // browser-agent visual/responsive QA
    webStudioWhiteLabel: isBusiness,    // theming (partial=business, full=enterprise)
    webStudioClientHandoff: isBusiness, // scoped sub-admin client access
    webStudioAnalytics: isBusiness,     // per-site analytics
    // Enterprise-only
    sso: isEnterprise,
    customAgentBuilder: isEnterprise,
    slaConfig: isEnterprise,
    prioritySupport: isEnterprise,
    webStudioCodexReview: isEnterprise, // cross-model code review of generated sites
  };
}

/**
 * Get limits for a given tier
 * @param {string} tier
 * @returns {object}
 */
function getLimitsForTier(tier) {
  if (meetsRequirement(tier, 'enterprise')) {
    return {
      seoAuditsPerMonth: Infinity,
      memoryEntries: Infinity,
      schedules: Infinity,
      pipelines: Infinity,
      routines: Infinity,
      plugins: 100,
      reports: 100,
      customAgents: 50,
      customDocs: 500,
      sites: Infinity,        // Web Studio hosted sites
    };
  }

  if (meetsRequirement(tier, 'business')) {
    return {
      seoAuditsPerMonth: Infinity,
      memoryEntries: Infinity,
      schedules: Infinity,
      pipelines: Infinity,
      routines: Infinity,
      plugins: 20,
      reports: 20,
      customAgents: 10,
      customDocs: 100,
      sites: 10,              // Web Studio hosted sites
    };
  }

  // Community fallback — READ BY CORE for the open-core base (the commercial module
  // never loads for community, so this block is the source of truth for its limits).
  // sites:1 is load-bearing: core gates the single-site limit on it.
  return {
    seoAuditsPerMonth: 1,
    memoryEntries: 100,
    schedules: 3,
    pipelines: 2,
    routines: 1,
    plugins: 0,
    reports: 0,
    customAgents: 0,
    customDocs: 0,
    sites: 1,                // Web Studio: one free hosted site (with 1 custom domain)
  };
}

module.exports = { meetsRequirement, getFeaturesForTier, getLimitsForTier, TIER_HIERARCHY };
