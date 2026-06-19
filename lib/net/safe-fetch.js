// lib/net/safe-fetch.js
// ============================================================
//  SSRF-safe outbound text fetch — shared by every place AI OS fetches a user/agent-supplied
//  URL (design-clone, AEO readability/crawler checks, trending feeds). Promoted out of
//  web-studio/design-extract.js after the review found those other fetchers followed redirects
//  raw, so an attacker domain could 302 → 169.254.169.254 / loopback and hit cloud metadata.
//
//  Guarantees: http/https only; the hostname is resolved ONCE, every resolved IP is validated
//  (IPv4 + fully-normalized IPv6 incl. mapped / NAT64 / hex forms), and the connection is PINNED
//  to that exact IP via a custom lookup (so the OS can't re-resolve to a rebound private address).
//  Every redirect hop re-validates + re-pins. Internal-suffix + trailing-dot hosts are blocked.
//  Byte cap + wall-clock deadline + identity encoding + a text-only content-type gate bound DoS.
// ============================================================

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (compatible; AI-OS/1.0; +https://aiosorchestrationlab.com)';

// Expand any IPv6 string (compressed, mixed-v4, hex-mapped) to its 16 bytes, or null.
function ipv6ToBytes(input) {
  let s = String(input).toLowerCase().replace(/%.*$/, ''); // drop zone id
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    const hx = (((o[0] << 8) | o[1]) >>> 0).toString(16) + ':' + (((o[2] << 8) | o[3]) >>> 0).toString(16);
    s = s.slice(0, s.length - v4[1].length) + hx;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parse = (seg) => (seg === '' ? [] : seg.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(dbl[0]);
  const tail = dbl.length === 2 ? parse(dbl[1]) : [];
  if (head.some(isNaN) || tail.some(isNaN)) return null;
  let hextets;
  if (dbl.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    hextets = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8 || hextets.some((h) => h < 0 || h > 0xffff)) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 8; i++) { b[2 * i] = (hextets[i] >> 8) & 0xff; b[2 * i + 1] = hextets[i] & 0xff; }
  return b;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true;             // link-local + cloud metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] >= 224) return true;                               // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const b = ipv6ToBytes(ip);
    if (!b) return true;                                        // unparseable → unsafe
    if (b.every((x) => x === 0)) return true;                   // ::  unspecified
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
    const embeddedV4 = () => isPrivateIp(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return embeddedV4(); // ::ffff:0:0/96 mapped
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return embeddedV4(); // 64:ff9b::/96 NAT64
    if (b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1)) return embeddedV4(); // ::/96 v4-compat
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // fe80::/10 link-local
    if ((b[0] & 0xfe) === 0xfc) return true;                    // fc00::/7 ULA
    if (b[0] === 0xff) return true;                             // ff00::/8 multicast
    return false;
  }
  return true; // not a recognizable IP → unsafe
}

// Resolve a hostname ONCE, validate every answer, return the pinned address to dial.
async function resolvePinned(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, ''); // strip a single trailing dot
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('blocked host');
  }
  let addr, family;
  if (net.isIP(host)) { addr = host; family = net.isIPv6(host) ? 6 : 4; }
  else {
    const recs = await dns.lookup(host, { all: true });
    if (!recs.length) throw new Error('host did not resolve');
    for (const r of recs) if (isPrivateIp(r.address)) throw new Error('blocked private address');
    addr = recs[0].address; family = recs[0].family;
  }
  if (isPrivateIp(addr)) throw new Error('blocked private address');
  return { host, addr, family };
}

// One pinned GET. Connects to the pre-validated IP (no second name resolution), keeping the
// real hostname for Host + TLS SNI. Resolves { redirect } or { body }, or rejects.
function requestPinned(targetUrl, pin, { timeoutMs, maxBytes, headers }) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(targetUrl); } catch { return reject(new Error('invalid URL')); }
    const mod = u.protocol === 'https:' ? https : http;
    // PIN: ignore the name, dial the validated IP. Handle BOTH lookup conventions —
    // net may call us with { all: true } (expects an array) or without (single addr/family).
    const lookup = (_h, opts, cb) => (opts && opts.all)
      ? cb(null, [{ address: pin.addr, family: pin.family }])
      : cb(null, pin.addr, pin.family);
    let done = false;
    const req = mod.request(u, {
      method: 'GET',
      lookup,
      servername: u.protocol === 'https:' ? pin.host : undefined,
      headers,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); finish({ redirect: new URL(res.headers.location, u).href }); return;
      }
      if (status !== 200) { res.resume(); fail(new Error(`fetch returned ${status}`)); return; }
      const ct = String(res.headers['content-type'] || '');
      if (ct && !/text|html|css|xml|json|javascript|octet-stream/i.test(ct)) { res.resume(); fail(new Error('unsupported content-type')); return; }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      } catch { /* fall back to raw */ }
      const chunks = []; let received = 0;
      stream.on('data', (c) => {
        received += c.length;
        if (received > maxBytes) {
          const keep = maxBytes - (received - c.length);
          if (keep > 0) chunks.push(c.subarray(0, keep));
          try { req.destroy(); } catch {}
          finish({ body: Buffer.concat(chunks).toString('utf-8') });
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => finish({ body: Buffer.concat(chunks).toString('utf-8') }));
      stream.on('error', () => finish({ body: Buffer.concat(chunks).toString('utf-8') }));
    });
    const timer = setTimeout(() => { try { req.destroy(new Error('timeout')); } catch {} }, Math.max(1, timeoutMs));
    function settle() { if (done) return false; done = true; clearTimeout(timer); return true; }
    function finish(v) { if (settle()) resolve(v); }
    function fail(e) { if (settle()) reject(e); }
    req.on('error', fail);
    req.end();
  });
}

/**
 * SSRF-safe text fetch. Resolve+validate+pin per hop, manual redirect cap, shared deadline.
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=3000000]
 * @param {number} [opts.timeoutMs=15000]  overall budget (ignored if `deadline` given)
 * @param {number} [opts.deadline]         absolute ms deadline shared across multiple fetches
 * @param {number} [opts.maxRedirects=4]
 * @param {object} [opts.headers]          extra/override request headers
 * @param {string} [opts.userAgent]        convenience override for User-Agent
 * @param {string} [opts.accept]           convenience override for Accept
 * @returns {Promise<string>} the response body text (throws on SSRF / non-200 / cap).
 */
async function safeFetch(rawUrl, { maxBytes = 3_000_000, timeoutMs = 15000, deadline, maxRedirects = 4, headers = {}, userAgent, accept } = {}) {
  const dl = deadline || (Date.now() + timeoutMs);
  const hdrs = { 'User-Agent': userAgent || DEFAULT_UA, Accept: accept || '*/*', 'Accept-Encoding': 'identity', ...headers };
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u; try { u = new URL(url); } catch { throw new Error('invalid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
    const remaining = dl - Date.now();
    if (remaining <= 0) throw new Error('fetch timed out');
    const pin = await resolvePinned(u.hostname);
    const r = await requestPinned(u.href, pin, { timeoutMs: Math.min(remaining, 12000), maxBytes, headers: hdrs });
    if (r.redirect) { url = r.redirect; continue; }
    return r.body;
  }
  throw new Error('too many redirects');
}

module.exports = { safeFetch };
