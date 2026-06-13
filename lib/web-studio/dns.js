// lib/web-studio/dns.js
// ============================================================
//  Pre-flight DNS check for custom-domain publishing (a locked, MANDATORY gate).
//
//  Before we ever ask certbot for a cert, confirm the domain actually resolves to
//  THIS box. A wrong/missing A record makes the Let's Encrypt http-01 challenge fail,
//  and repeated failures burn the LE rate limits (5 failures/host/hour). Catching it
//  here turns a 2-minute certbot timeout + a wasted attempt into an instant, clear
//  "point your DNS here" message.
// ============================================================

const dnsp = require('dns').promises;

let _ipCache = null; // { v4:[], v6:[], at }

/** This server's public IP(s): an operator-set AIOS_PUBLIC_IP wins; else an echo service (cached 10m). */
async function getPublicIps() {
  const envIp = (process.env.AIOS_PUBLIC_IP || '').trim();
  if (envIp) {
    const o = { v4: [], v6: [] };
    (envIp.includes(':') ? o.v6 : o.v4).push(envIp);
    return o;
  }
  if (_ipCache && (Date.now() - _ipCache.at) < 600000) return _ipCache;
  const out = { v4: [], v6: [], at: Date.now() };
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (j && j.ip) (String(j.ip).includes(':') ? out.v6 : out.v4).push(String(j.ip));
  } catch { /* detection failed — caller treats expected[] empty as "unknown" */ }
  _ipCache = out;
  return out;
}

async function resolveSafe(fn, name) {
  try { return await fn(name); } catch { return []; }
}

/**
 * @returns {Promise<{ok:boolean, found:string[], expected:string[], warning?:string, reason?:string}>}
 *   ok:true  -> safe to issue a cert. May carry a `warning` if the box IP is unknown.
 *   ok:false -> `reason` explains what to fix (no record / points elsewhere).
 */
async function checkDomainDns(domain) {
  const [a, aaaa, ips] = await Promise.all([
    resolveSafe(dnsp.resolve4.bind(dnsp), domain),
    resolveSafe(dnsp.resolve6.bind(dnsp), domain),
    getPublicIps(),
  ]);
  const found = [...a, ...aaaa];
  const expected = [...(ips.v4 || []), ...(ips.v6 || [])];

  if (found.length === 0) {
    return { ok: false, found, expected,
      reason: `No A/AAAA record found for ${domain}. Add a DNS record pointing to ${expected[0] || 'this server'} and allow time to propagate.` };
  }
  if (expected.length === 0) {
    return { ok: true, found, expected,
      warning: `Could not determine this server's public IP (set AIOS_PUBLIC_IP for a strict check). ${domain} resolves to ${found.join(', ')}; proceeding.` };
  }
  if (!found.some((ip) => expected.includes(ip))) {
    return { ok: false, found, expected,
      reason: `${domain} resolves to ${found.join(', ')} but this server is ${expected.join(', ')}. Update the DNS record and wait for it to propagate.` };
  }
  return { ok: true, found, expected };
}

module.exports = { checkDomainDns, getPublicIps };
