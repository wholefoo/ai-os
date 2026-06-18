// lib/web-studio/design-extract.js
// ============================================================
//  "Clone design from a URL" — point at a public site and pull a DESIGN PROFILE:
//  color + font tokens (mapped onto the scaffold's brand/accent/ink/paper + fonts) and a
//  coarse section outline (mapped onto the pipeline's allowed section types). The pipeline
//  then generates OUR OWN clean Astro markup in that style — tokens + layout patterns, not a
//  verbatim mirror.
//
//  The target URL is UNTRUSTED. Hardened after an adversarial review:
//   - SSRF: http/https only; the hostname is resolved ONCE, every resolved IP is validated
//     (IPv4 + fully-normalized IPv6 incl. mapped/NAT64), and the connection is PINNED to that
//     exact IP via a custom lookup (so fetch can't re-resolve to a rebound private address).
//     Redirects + each linked-CSS sub-fetch re-validate and re-pin. Trailing-dot hosts and
//     internal suffixes are blocked.
//   - DoS: one shared wall-clock deadline across all fetches, concurrent stylesheet fetches,
//     per-body + aggregate-CSS byte caps, capped color scanning, identity encoding.
//   - Injection: font-family names are allowlisted to a strict CSS shape before they can reach
//     either the LLM plan prompt or the served token CSS.
// ============================================================

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (compatible; AI-OS-WebStudio/1.0; design-clone)';
const ALLOWED_SECTIONS = ['hero', 'features', 'prose', 'cta', 'contact'];
const FAMILY_RE = /^[A-Za-z0-9 _-]{1,40}$/; // strict CSS family-name shape (no punctuation → no prompt/CSS escape)

// ---------- IP classification ----------
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
function requestPinned(targetUrl, pin, { timeoutMs, maxBytes }) {
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
      headers: { 'User-Agent': UA, Accept: 'text/html,text/css,*/*', 'Accept-Encoding': 'identity' },
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

// SSRF-safe text fetch: resolve+validate+pin per hop, manual redirect cap, shared deadline.
async function safeFetch(rawUrl, { maxBytes = 3_000_000, deadline = Date.now() + 15000, maxRedirects = 3 } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u; try { u = new URL(url); } catch { throw new Error('invalid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('design extraction timed out');
    const pin = await resolvePinned(u.hostname);
    const r = await requestPinned(u.href, pin, { timeoutMs: Math.min(remaining, 12000), maxBytes });
    if (r.redirect) { url = r.redirect; continue; }
    return r.body;
  }
  throw new Error('too many redirects');
}

// ---------- color helpers ----------
function normHex(h) {
  let s = h.replace('#', '').toLowerCase();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length === 8) s = s.slice(0, 6);
  return s.length === 6 ? '#' + s : null;
}
function rgbToHex(inner) {
  const n = inner.split(',').map((x) => parseFloat(x.trim()));
  if (n.length < 3 || n.slice(0, 3).some((x) => isNaN(x))) return null;
  const to = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + to(n[0]) + to(n[1]) + to(n[2]);
}
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function saturation(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

// Tally colors out of text into `freq`, capped so a hostile token-spam body can't explode memory.
function collectColorsInto(freq, text, cap = 40000) {
  let m, n = 0;
  const reHex = /#[0-9a-fA-F]{3,8}\b/g;
  while (n < cap && (m = reHex.exec(text))) { const h = normHex(m[0]); if (h) freq.set(h, (freq.get(h) || 0) + 1); n++; }
  const reRgb = /rgba?\(([^)]{1,64})\)/gi; n = 0;
  while (n < cap && (m = reRgb.exec(text))) { const h = rgbToHex(m[1]); if (h) freq.set(h, (freq.get(h) || 0) + 1); n++; }
  return freq;
}

// ---------- font helpers ----------
function familyList(decl) { return decl.split(',')[0].replace(/['"]/g, '').trim(); }
function cleanFamily(name) { return name && FAMILY_RE.test(name) ? name : null; } // allowlist → no injection
function collectFonts(css, html) {
  const all = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}\n]{1,120})/gi)) all.push(m[1].trim());
  const gf = [];
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]{1,300})/gi)) {
    for (const f of m[1].matchAll(/family=([^&:]{1,60})/gi)) gf.push(decodeURIComponent(f[1].replace(/\+/g, ' ')));
  }
  const bodyRule = css.match(/(?:^|[\s,{])(?:body|html)\b[^{]*\{[^}]*font-family\s*:\s*([^;}\n]{1,120})/i);
  const headRule = css.match(/(?:^|[\s,{])h1\b[^{]*\{[^}]*font-family\s*:\s*([^;}\n]{1,120})/i);
  const display = cleanFamily(headRule ? familyList(headRule[1]) : null) || cleanFamily(gf[0]) || cleanFamily(all[0] ? familyList(all[0]) : null);
  const body = cleanFamily(bodyRule ? familyList(bodyRule[1]) : null) || cleanFamily(gf[1]) || cleanFamily(gf[0]) || cleanFamily(all[0] ? familyList(all[0]) : null);
  return { display, body, googleFonts: [...new Set(gf.map(cleanFamily).filter(Boolean))].slice(0, 6) };
}

// ---------- layout outline ----------
function detectSections(html) {
  const lc = html.slice(0, 1_500_000).toLowerCase(); // structure lives near the top; bound the scan
  const count = (re) => (lc.match(re) || []).length;
  const out = ['hero'];
  const h3 = count(/<h3[\s>]/g), li = count(/<li[\s>]/g), cards = count(/class="[^"]*\b(card|feature|grid)\b/gi);
  if (h3 >= 3 || cards >= 2 || li >= 6) out.push('features');
  if (count(/<blockquote[\s>]/g) >= 1 || /testimonial|review|what (our|their) (clients|customers)/i.test(lc)) out.push('prose');
  if (/<article[\s>]/i.test(lc) || count(/<p[\s>]/g) >= 8) { if (!out.includes('prose')) out.push('prose'); }
  if (/get started|sign up|book a|start (free|now)|request a demo|contact us/i.test(lc)) out.push('cta');
  if (/<footer[\s>]/i.test(lc) || /mailto:|contact/i.test(lc)) out.push('contact');
  return out.filter((s, i) => ALLOWED_SECTIONS.includes(s) && out.indexOf(s) === i);
}

// ---------- main ----------
/**
 * Extract a design profile from a public URL. Never trusts the content; throws only on a hard
 * fetch/SSRF failure (callers surface the message).
 * @returns {Promise<{sourceUrl, title, tokens, sections, swatches, fonts, notes}>}
 */
async function extractProfile(rawUrl) {
  const deadline = Date.now() + 20000;            // ONE budget shared across the page + CSS fetches
  const html = await safeFetch(rawUrl, { deadline });
  const notes = [];
  const base = new URL(rawUrl);

  // CSS: inline <style> + a few linked stylesheets fetched CONCURRENTLY (same SSRF guard + deadline)
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const links = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => (m[0].match(/href=["']([^"']+)["']/i) || [])[1]).filter(Boolean).slice(0, 6);
  const fetched = await Promise.allSettled(links.map((href) => {
    let abs; try { abs = new URL(href, base).href; } catch { return Promise.reject(new Error('bad href')); }
    return safeFetch(abs, { maxBytes: 1_500_000, deadline });
  }));
  for (const r of fetched) {
    if (r.status !== 'fulfilled') continue;
    css += '\n' + r.value;
    if (css.length > 4_000_000) { css = css.slice(0, 4_000_000); break; } // aggregate CSS cap
  }
  if (!css.trim()) notes.push('no external CSS found — palette inferred from inline styles only');

  // tokens — scan css and html SEPARATELY (no giant third concat), capped
  const freq = new Map();
  collectColorsInto(freq, css);
  collectColorsInto(freq, html.slice(0, 3_000_000));
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([hex, n]) => ({ hex, n }));
  const light = colors.filter((c) => luminance(c.hex) > 0.82);
  const dark = colors.filter((c) => luminance(c.hex) < 0.18);
  const vivid = colors.filter((c) => saturation(c.hex) > 0.32 && luminance(c.hex) > 0.12 && luminance(c.hex) < 0.9);
  const paper = (light[0] || {}).hex || '#ffffff';
  const ink = (dark[0] || {}).hex || '#0f172a';
  const brand = (vivid[0] || {}).hex || '#4f46e5';
  const accent = (vivid.find((c) => c.hex !== brand) || {}).hex || '#f59e0b';

  const f = collectFonts(css, html);
  const tokens = {
    brand, accent, ink, paper,
    fontDisplay: f.display ? `'${f.display}', Georgia, serif` : "Georgia, 'Times New Roman', serif",
    fontBody: f.body ? `'${f.body}', system-ui, sans-serif` : 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  };

  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const swatches = [...new Set([brand, accent, ink, paper, ...vivid.slice(0, 4).map((c) => c.hex)])]
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8);

  return { sourceUrl: base.href, title, tokens, sections: detectSections(html), swatches, fonts: { display: f.display, body: f.body, googleFonts: f.googleFonts }, notes };
}

module.exports = { extractProfile, safeFetch, isPrivateIp, ipv6ToBytes, detectSections, collectFonts, cleanFamily };
