// Same-origin guard for cookie-authenticated mutations — CSRF defence in depth. SOC 2 gap item 14.
//
// WHAT ALREADY STOPS CSRF HERE, verified before this was written (tools/test-csrf-posture.js pins
// each one): the session cookie is SameSite=Lax at all three places it is set, so a cross-site
// POST never carries it in any current browser; CORS is closed in production, so a JSON request
// from another origin fails its preflight; session routes parse JSON only, so a plain HTML form
// (no preflight) arrives with an empty body; and the two form-encoded public routes take no
// session at all. Only two GET routes change state, and both are safe by construction (Stripe
// success is verified against Stripe; unsubscribe is meant to work from an email link).
//
// WHAT THIS ADDS: one more independent check, so the posture does not rest on the browser alone.
// A mutating /api request that is authenticated BY COOKIE and carries an Origin header from a
// different host is refused. Bearer-authenticated requests are exempt — a token is not ambient, a
// cross-site page cannot attach it — and requests with no Origin header (non-browser clients,
// same-origin GET navigations) are exempt, because the browser sends Origin on every cross-site
// POST, so absence means there is nothing to check.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Hostname[:port] of an Origin value, or null when it is not a parseable origin. */
function originHost(origin) {
  try { return new URL(String(origin)).host.toLowerCase(); } catch { return null; }
}

/**
 * @param {object} req  { method, headers: { origin?, cookie?, authorization? }, host }  — `host`
 *                      is the request's own host (behind the proxy, express's req.get('host')).
 * @returns {null | { reason }}  null = allowed; an object = refuse with that reason
 */
function crossSiteCookieMutation(req) {
  if (!MUTATING.has(String(req.method || '').toUpperCase())) return null;
  const h = req.headers || {};
  const bearer = String(h.authorization || '').trim();
  if (bearer) return null;                                  // token auth is not ambient
  const cookieAuthed = /(?:^|;\s*)ai-os-session=/.test(String(h.cookie || ''));
  if (!cookieAuthed) return null;                           // nothing ambient to ride on
  const origin = h.origin;
  if (origin === undefined || origin === null || origin === '') return null; // no Origin → not a cross-site browser POST
  const from = originHost(origin);
  const own = String(req.host || '').toLowerCase();
  if (from && own && from === own) return null;
  return { reason: `cookie-authenticated ${req.method} from origin "${origin}" does not match this host "${own || '?'}"` };
}

/** Express middleware form. */
function sameOriginGuard(opts = {}) {
  const log = opts.log || (() => {});
  return (req, res, next) => {
    const bad = crossSiteCookieMutation({ method: req.method, headers: req.headers, host: req.get ? req.get('host') : req.headers.host });
    if (!bad) return next();
    log(bad.reason, { path: req.originalUrl, ip: req.ip });
    return res.status(403).json({ error: 'Cross-site request refused. Sign in on this site and try again.' });
  };
}

module.exports = { crossSiteCookieMutation, sameOriginGuard };
