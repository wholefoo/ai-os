// ai-os-commercial — Main entry point
// Validates license key and exports the commercial feature set

const path = require('path');
const fs = require('fs');
const { validateLicenseKey, generateLicenseKey } = require('./lib/license-validator');
const { getFeaturesForTier, getLimitsForTier } = require('./lib/tier-resolver');
const { createTierGate } = require('./lib/feature-gate');
const { COMMERCIAL_DEPARTMENTS, ADDITIONAL_AGENTS } = require('./org-chart/departments');

// --- License Key Resolution ---
// Check env var first, then .magent/license.key file
function resolveLicenseKey() {
  if (process.env.AIOS_LICENSE_KEY) {
    return process.env.AIOS_LICENSE_KEY.trim();
  }

  const keyPaths = [
    path.join(process.cwd(), '.magent', 'license.key'),
    path.join(process.cwd(), 'license.key'),
    path.join(__dirname, '..', '.magent', 'license.key'),
  ];

  for (const kp of keyPaths) {
    try {
      if (fs.existsSync(kp)) {
        return fs.readFileSync(kp, 'utf8').trim();
      }
    } catch (e) {
      // ignore read errors
    }
  }

  return null;
}

// --- Validate ---
const licenseKey = resolveLicenseKey();
const validation = validateLicenseKey(licenseKey);

if (validation.valid) {
  console.log(`[LICENSE] ✓ Valid ${validation.tier.toUpperCase()} license (issued ${validation.issuedAt.toISOString().split('T')[0]})`);
} else {
  console.warn(`[LICENSE] ✗ ${validation.error} — commercial features disabled`);
}

const activeTier = validation.valid ? validation.tier : 'community';
const features = getFeaturesForTier(activeTier);
const limits = getLimitsForTier(activeTier);
const requireTier = createTierGate(activeTier);

// --- Route Registration ---
// Each module exports a registerRoutes(app, ctx) function.
// ctx provides shared utilities from server.js: { requireAdmin, requirePlan, broadcast, logActivity, ... }

function registerRoutes(app, ctx) {
  if (activeTier === 'community') return;

  // Register the tier gate middleware on the context so modules can use it
  ctx.requireTier = requireTier;
  ctx.activeTier = activeTier;
  ctx.features = features;
  ctx.limits = limits;

  // Load and register each module's routes
  const moduleDir = path.join(__dirname, 'modules');
  const moduleNames = [
    'creative-studio',
    'seo-unlimited',
    'youtube-intel',
    'agent-builder',
    'advanced-reporting',
    'video-meetings',
    'lead-gen',
    'grok-intel',
    'self-improving',
    'hermes-advanced',
    'browser-agent',
    'design-system',
  ];

  for (const modName of moduleNames) {
    const modPath = path.join(moduleDir, modName, 'index.js');
    if (fs.existsSync(modPath)) {
      try {
        const mod = require(modPath);
        if (typeof mod.registerRoutes === 'function') {
          mod.registerRoutes(app, ctx);
          console.log(`[COMMERCIAL] ✓ Loaded module: ${modName}`);
        }
      } catch (err) {
        console.error(`[COMMERCIAL] ✗ Failed to load module ${modName}:`, err.message);
      }
    }
  }
}

// --- Export ---
module.exports = {
  tier: activeTier,
  valid: validation.valid,
  licenseKey: licenseKey ? `${licenseKey.substring(0, 12)}...` : null,

  orgChartExtension: validation.valid ? {
    departments: COMMERCIAL_DEPARTMENTS,
    additionalAgents: ADDITIONAL_AGENTS,
  } : {
    departments: [],
    additionalAgents: {},
  },

  features,
  limits,
  registerRoutes,
  requireTier,

  // Expose generator for admin use
  generateLicenseKey,

  // Module accessors (populated after registerRoutes)
  modules: {},
};
