// lib/web-studio/hosting.js
// ============================================================
//  The Node -> root bridge for Web Studio hosting.
//
//  This is the ONLY place the app crosses the privilege boundary. It invokes the
//  three root-owned scripts (/usr/local/sbin/aios-site-{vhost,cert,remove}) via the
//  sudoers allowlist. It never touches /etc/nginx or runs certbot directly.
//
//  Two invariants enforced here:
//   1. Every domain is normalized + re-validated against the SAME regex the scripts
//      use, so a bad domain fails fast in-process and never reaches sudo.
//   2. All root-script calls are SERIALIZED through one mutex chain — only one
//      nginx reload / cert issuance happens at a time (no reload storms, no races).
//
//  Used by BOTH core (server.js, for the Community 1-site base) and the web-studio
//  commercial module (Business/Enterprise), so it lives in lib/ not commercial/.
// ============================================================

const { execFile } = require('child_process');

// Mirror of the scripts' DOMAIN_RE — keep in lockstep with deploy/hosting/*.sh.
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const SBIN = {
  vhost: '/usr/local/sbin/aios-site-vhost',
  cert: '/usr/local/sbin/aios-site-cert',
  remove: '/usr/local/sbin/aios-site-remove',
};

/**
 * Lowercase, strip a trailing dot, validate. Throws on anything that wouldn't pass
 * the root scripts' own check — so callers get a clean error instead of a sudo failure.
 */
function normalizeDomain(input) {
  const d = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  // Reject any char outside the FQDN set (catches embedded newlines / control chars
  // that survive trim) BEFORE the structural test — mirrors the scripts' allowlist.
  if (d.length === 0 || d.length > 253 || /[^a-z0-9.-]/.test(d) || !DOMAIN_RE.test(d)) {
    const e = new Error(`Invalid domain: ${JSON.stringify(input)}`);
    e.code = 'INVALID_DOMAIN';
    throw e;
  }
  return d;
}

// --- Single-flight serialization for all root-script calls ---
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {}); // never let a rejection break the chain
  return run;
}

function runScript(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    // `sudo -n`: non-interactive; fails immediately if (mis)configuration ever
    // demanded a password rather than hanging. Fixed argv (no shell) — args are
    // passed as discrete array elements, so no quoting/injection surface here.
    execFile('sudo', ['-n', bin, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = (stdout || '').toString().trim();
      const errout = (stderr || '').toString().trim();
      if (err) {
        const e = new Error(`${bin.split('/').pop()} failed: ${errout || err.message}`);
        e.stdout = out;
        e.stderr = errout;
        e.code = err.code;
        return reject(e);
      }
      resolve(out);
    });
  });
}

/**
 * Create/replace the nginx vhost for a site.
 * @param {string} domain
 * @param {{tls?: boolean}} opts  tls:true requires an already-issued cert (call issueCert first)
 */
function createVhost(domain, opts = {}) {
  const d = normalizeDomain(domain);
  const args = opts.tls ? [d, '--tls'] : [d];
  return serialize(() => runScript(SBIN.vhost, args));
}

/** Issue (or renew-if-needed) a Let's Encrypt cert via webroot http-01. ~2 min budget. */
function issueCert(domain) {
  const d = normalizeDomain(domain);
  return serialize(() => runScript(SBIN.cert, [d], { timeoutMs: 120000 }));
}

/** Remove the nginx vhost (and optionally the cert) for a site. */
function removeSite(domain, opts = {}) {
  const d = normalizeDomain(domain);
  const args = opts.dropCert ? [d, '--cert'] : [d];
  return serialize(() => runScript(SBIN.remove, args));
}

/**
 * One transactional flow used by "attach custom domain": HTTP vhost -> issue cert ->
 * re-render with TLS. If the cert step fails (e.g. DNS not propagated), the site is
 * left live over HTTP and the error propagates — never a blind rollback, never a
 * half-applied TLS vhost (the script refuses --tls without a real cert).
 */
async function attachDomainWithTls(domain) {
  const d = normalizeDomain(domain);
  await createVhost(d, { tls: false }); // serve + expose ACME challenge over HTTP
  await issueCert(d);                   // throws if challenge fails; site stays HTTP
  await createVhost(d, { tls: true });  // promote to HTTPS
  return d;
}

module.exports = {
  DOMAIN_RE,
  normalizeDomain,
  createVhost,
  issueCert,
  removeSite,
  attachDomainWithTls,
};
