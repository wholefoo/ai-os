// feature-gate.js — Express middleware for tier-gated features

const { meetsRequirement } = require('./tier-resolver');

/**
 * Create middleware that blocks requests unless the active tier meets the required tier
 * @param {string} activeTier - Current active tier ('business' or 'enterprise')
 * @returns {function} Middleware factory
 */
function createTierGate(activeTier) {
  /**
   * @param {string} requiredTier - 'business' or 'enterprise'
   * @returns {function} Express middleware
   */
  return function requireTier(requiredTier) {
    return (req, res, next) => {
      if (meetsRequirement(activeTier, requiredTier)) {
        return next();
      }
      res.status(403).json({
        error: `This feature requires a ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)} license or higher.`,
        currentTier: activeTier,
        requiredTier,
        upgradeUrl: 'https://aiosorchestrationlab.com/#pricing',
      });
    };
  };
}

module.exports = { createTierGate };
