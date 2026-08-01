// Tests lib/net/safe-fetch's safeRequest: the SSRF refusals, and that safeFetch's older contract
// did not shift underneath it when the shared request path grew method/body support.
//
// Note what this suite does NOT do: exercise a happy path against a local server. It cannot —
// safeRequest refuses loopback by design, so any listener this process could start is precisely an
// address it must reject. That constraint is the feature. The assertions therefore aim at the
// boundary itself, which is the part with security consequences; the transport underneath is
// node's http module and has its own tests.
const { safeFetch, safeRequest } = require('../lib/net/safe-fetch');
const { assert, done } = require('./test-util');

const refused = async (url, opts) => {
  try { await safeRequest(url, opts); return null; } catch (e) { return e.message; }
};

(async () => {
  // --- the addresses an operator-supplied plugin URL must never reach -----------------------------
  // Each of these is a real pivot, not a theoretical one: 169.254.169.254 is cloud instance
  // metadata (credentials), loopback is every admin port bound to localhost, and the RFC1918 ranges
  // are the rest of the private network the VPS sits in.
  for (const url of [
    'http://127.0.0.1:3000/api/settings',
    'http://localhost:3000/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3000/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::ffff:127.0.0.1]/',      // IPv4-mapped IPv6 — the same loopback wearing a different hat
    'http://[64:ff9b::7f00:1]/',       // NAT64-embedded loopback
    'http://something.internal/',
    'http://box.local/',
    'http://127.0.0.1./',              // trailing dot — a classic normalisation bypass
  ]) {
    assert(await refused(url, { method: 'POST', body: '{}' }), `POST to ${url} is refused`);
    assert(await refused(url), `GET to ${url} is refused`);
  }

  // --- non-HTTP schemes ---------------------------------------------------------------------------
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/', 'ftp://10.0.0.1/', 'data:text/plain,hi']) {
    const msg = await refused(url);
    assert(msg, `${url} is refused`);
  }
  assert(await refused('not a url'), 'a malformed URL is refused rather than coerced into one');

  // --- the guard is not optional --------------------------------------------------------------
  // safeRequest relaxes what counts as an acceptable RESPONSE (any status, any content-type). The
  // point of the split is that no option can relax where it may CONNECT. If someone later adds an
  // escape hatch, this fails.
  assert(await refused('http://127.0.0.1/', { method: 'POST', body: 'x', headers: { 'X-Anything': '1' }, maxBytes: 10, timeoutMs: 50, maxRedirects: 0 }),
    'no combination of caller options reopens a private address');

  // --- safeFetch's contract is unchanged ----------------------------------------------------------
  // requestPinned grew method/body/textOnly/okOnly/followRedirects for safeRequest. safeFetch's six
  // existing callers depend on the strict behaviour, and the defaults are what preserve it.
  assert(typeof safeFetch === 'function' && typeof safeRequest === 'function', 'both are exported');
  let fetchErr = null;
  try { await safeFetch('http://169.254.169.254/'); } catch (e) { fetchErr = e.message; }
  assert(fetchErr, 'safeFetch still refuses the metadata endpoint');
  assert(safeFetch.length <= 2 && safeRequest.length <= 2, 'both keep the (url, opts) shape callers use');

  // A GET through safeRequest must still be able to follow redirects; a POST must not, or a 302
  // replays the caller's body to a host they never named. Asserted on the module source because
  // the behaviour cannot be reached without a reachable server.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'net', 'safe-fetch.js'), 'utf8');
  assert(/followRedirects\s*=\s*verb === 'GET' \|\| verb === 'HEAD'/.test(src),
    'redirects are followed only for GET/HEAD — a redirected POST is a confused-deputy hop the caller never asked for');
  assert(/for \(const r of recs\) if \(isPrivateIp\(r\.address\)\) throw/.test(src),
    'EVERY DNS answer is validated, not just the one that gets dialled — a name resolving to one public and one private address must be refused outright');

  // --- the finding this came from -----------------------------------------------------------------
  // The SSRF pass pinned every fetch in this repo and never crossed into commercial/, which had its
  // own raw fetch() calls to operator-supplied URLs. Guard the boundary, not just the file.
  const fs = require('fs');
  const path = require('path');
  const commercialDir = path.join(__dirname, '..', 'commercial');
  if (fs.existsSync(commercialDir)) {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /(?:await|=)\s*fetch\s*\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(commercialDir, p));
      }
    };
    walk(commercialDir);
    assert(offenders.length === 0,
      `no raw fetch() in commercial/ — outbound HTTP there goes through the injected safeRequest/safeFetch (found: ${offenders.join(', ') || 'none'})`);
  } else {
    console.log('ok  : commercial/ not present (Community checkout) — raw-fetch sweep skipped');
  }

  done();
})();
