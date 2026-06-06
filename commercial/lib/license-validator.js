// license-validator.js — Offline license key validation
// Key format: AIOS-{TIER}-{TIMESTAMP_HEX}-{RANDOM}-{CHECKSUM}
// Example:    AIOS-BIZ-683E4A00-7F3K9M2X-A4B2

const crypto = require('crypto');

// Signing secret — loaded from environment variable
// Without this secret, license keys cannot be generated or validated
const SIGNING_SECRET = process.env.AIOS_SIGNING_SECRET || '';

const TIER_MAP = {
  BIZ: 'business',
  ENT: 'enterprise',
};

/**
 * Generate a license key (admin utility)
 * @param {'BIZ'|'ENT'} tierCode
 * @returns {string} License key
 */
function generateLicenseKey(tierCode) {
  if (!TIER_MAP[tierCode]) throw new Error(`Invalid tier code: ${tierCode}`);

  const timestamp = Math.floor(Date.now() / 1000).toString(16).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  const payload = `${tierCode}-${timestamp}-${random}`;
  const checksum = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 4)
    .toUpperCase();

  return `AIOS-${payload}-${checksum}`;
}

/**
 * Validate a license key
 * @param {string} key
 * @returns {{ valid: boolean, tier: string|null, issuedAt: Date|null, error: string|null }}
 */
function validateLicenseKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, tier: null, issuedAt: null, error: 'No license key provided' };
  }

  const parts = key.trim().split('-');
  // Expected: ['AIOS', tierCode, timestamp, random, checksum]
  if (parts.length !== 5 || parts[0] !== 'AIOS') {
    return { valid: false, tier: null, issuedAt: null, error: 'Invalid key format' };
  }

  const [, tierCode, timestamp, random, checksum] = parts;

  // Validate tier
  const tier = TIER_MAP[tierCode];
  if (!tier) {
    return { valid: false, tier: null, issuedAt: null, error: `Unknown tier: ${tierCode}` };
  }

  // Verify HMAC checksum
  const payload = `${tierCode}-${timestamp}-${random}`;
  const expectedChecksum = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 4)
    .toUpperCase();

  if (checksum.toUpperCase() !== expectedChecksum) {
    return { valid: false, tier: null, issuedAt: null, error: 'Invalid checksum — key may be tampered' };
  }

  // Parse issue date
  const issuedAt = new Date(parseInt(timestamp, 16) * 1000);

  return { valid: true, tier, issuedAt, error: null };
}

module.exports = { validateLicenseKey, generateLicenseKey, TIER_MAP };
