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
    multiTenant: isBusiness,
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
    whiteLabel: isEnterprise,
    hermesAdvanced: isBusiness,
    batchQueue: isBusiness,
    designSystem: isBusiness,
    productFactory: isBusiness,
    // Enterprise-only
    sso: isEnterprise,
    customAgentBuilder: isEnterprise,
    slaConfig: isEnterprise,
    prioritySupport: isEnterprise,
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
    };
  }

  // Community fallback (should not reach here in commercial module)
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
  };
}

module.exports = { meetsRequirement, getFeaturesForTier, getLimitsForTier, TIER_HIERARCHY };
