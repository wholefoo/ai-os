// tools/test-vhost-scheme-guard.js
// ============================================================
//  The scheme-change guard in deploy/hosting/site-vhost.sh.
//
//  WHY IT EXISTS: on 2026-08-10 re-rendering aiserp.org with --tls took the site down. It served
//  HTTP-only at the origin (Cloudflare terminated TLS and connected back over port 80); --tls
//  replaced the port-80 content block with `return 301 https://...`, so the CDN fetched over HTTP,
//  got a redirect to HTTPS, and the browser came back through the CDN over HTTP forever. `nginx -t`
//  passed and the script printed `ok` — no part of the machinery could detect it.
//
//  The guard must satisfy FOUR properties, and the middle two are what make it non-trivial:
//    1. refuse a scheme flip on an existing site          (the outage)
//    2. ALLOW a re-render at the same scheme              (the routine case — applying a fix)
//    3. ALLOW a first render of a brand-new site          (no existing vhost to contradict)
//    4. ALLOW an explicit promotion via --allow-scheme-change  (attachDomainWithTls needs this)
//  A guard that only satisfies (1) would block domain attachment, which is worse than the bug.
//
//  HOW THIS TESTS THE REAL SCRIPT: the guard runs before any write, so we copy the script, redirect
//  its AVAIL path into a temp dir, truncate it right after the guard, and observe the exit code.
//  The relocation is textual and asserted to have applied — see patchScript(). We do NOT
//  reimplement the guard here; a reimplementation would pass while the real script failed.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'deploy', 'hosting', 'site-vhost.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-guard-'));
const AVAIL_DIR = path.join(TMP, 'sites-available');
fs.mkdirSync(AVAIL_DIR, { recursive: true });

/** Relocate the script's write path into TMP and stop it right after the guard. */
function patchScript() {
  const src = fs.readFileSync(SRC, 'utf8');

  const availLine = 'AVAIL="/etc/nginx/sites-available/aios-site-${DOMAIN}"';
  assert.ok(src.includes(availLine), 'AVAIL assignment not found — script shape changed, aborting');

  // Cut immediately before the cert check: everything above is validation + the guard, and nothing
  // above it writes. If this marker moves, the test must be revisited rather than silently testing less.
  const marker = 'if [ "$TLS" = "--tls" ] && [ ! -s "${CERT_DIR}/fullchain.pem" ]; then';
  assert.ok(src.includes(marker), 'cert-check marker not found — script shape changed, aborting');

  let out = src.replace(availLine, `AVAIL="${AVAIL_DIR.replace(/\\/g, '/')}/aios-site-\${DOMAIN}"`);
  assert.notStrictEqual(out, src, 'AVAIL relocation did not apply');

  out = out.slice(0, out.indexOf(marker)) + '\necho GUARD_PASSED\nexit 0\n';
  const p = path.join(TMP, 'vhost-under-test.sh');
  fs.writeFileSync(p, out);
  return p;
}

const SCRIPT = patchScript();

/** Run the guard. Returns {code, stderr}. */
function run(domain, args = []) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, domain, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

const writeVhost = (domain, scheme) => fs.writeFileSync(
  path.join(AVAIL_DIR, `aios-site-${domain}`),
  scheme === 'tls'
    ? 'server {\n    listen 80;\n    location / { return 301 https://$host$request_uri; }\n}\nserver {\n    listen 443 ssl;\n    http2 on;\n}\n'
    : 'server {\n    listen 80;\n    listen [::]:80;\n    root /opt/ai-os/sites/x/current;\n}\n');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- 1. THE OUTAGE. http-only site + --tls must be refused. -----------------------------------
writeVhost('httponly.test', 'http');
ok('REFUSES --tls on an existing http-only site (the aiserp.org outage)', () => {
  const r = run('httponly.test', ['--tls']);
  assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}. stderr: ${r.err.slice(0, 200)}`);
  assert.ok(/REFUSING/.test(r.err), 'stderr must say it refused');
  assert.ok(/http to tls/.test(r.err), `stderr must name BOTH schemes, got: ${r.err.slice(0, 160)}`);
});

ok('...and the refusal explains the fix, not just the error', () => {
  const r = run('httponly.test', ['--tls']);
  assert.ok(/drop --tls/.test(r.err), 'must tell the operator what to do instead');
  assert.ok(/--allow-scheme-change/.test(r.err), 'must name the deliberate override');
});

// --- 2. The reverse flip is equally refused. ---------------------------------------------------
writeVhost('tlssite.test', 'tls');
ok('REFUSES dropping --tls on an existing TLS site', () => {
  const r = run('tlssite.test', []);
  assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}`);
  assert.ok(/tls to http/.test(r.err), `stderr must name both schemes, got: ${r.err.slice(0, 160)}`);
  assert.ok(/add --tls/.test(r.err), 'the suggestion must be the MIRROR of the http->tls case');
});

// --- 3. THE ROUTINE CASE MUST STILL WORK. ------------------------------------------------------
// A guard that blocks same-scheme re-renders would have blocked the nosniff fix this all started
// from — it would prevent the very repair it was written alongside.
ok('ALLOWS re-render of an http-only site with no flag', () => {
  const r = run('httponly.test', []);
  assert.strictEqual(r.code, 0, `expected 0, got ${r.code}. stderr: ${r.err.slice(0, 200)}`);
  assert.ok(/GUARD_PASSED/.test(r.out));
});
ok('ALLOWS re-render of a TLS site with --tls', () => {
  const r = run('tlssite.test', ['--tls']);
  assert.strictEqual(r.code, 0, `expected 0, got ${r.code}. stderr: ${r.err.slice(0, 200)}`);
});

// --- 4. New sites are unaffected — there is nothing to contradict. -----------------------------
ok('ALLOWS a first render of a brand-new site, with or without --tls', () => {
  assert.strictEqual(run('brandnew.test', []).code, 0);
  assert.strictEqual(run('brandnew2.test', ['--tls']).code, 0);
});

// --- 5. The sanctioned promotion path (attachDomainWithTls) still works. -----------------------
ok('ALLOWS the flip when --allow-scheme-change is passed explicitly', () => {
  const r = run('httponly.test', ['--tls', '--allow-scheme-change']);
  assert.strictEqual(r.code, 0, `promotion must work, got ${r.code}: ${r.err.slice(0, 200)}`);
});
ok('...in either flag order — argument position must not matter', () => {
  assert.strictEqual(run('httponly.test', ['--allow-scheme-change', '--tls']).code, 0);
});

// --- 6. Validation is not weakened by the new parsing loop. ------------------------------------
// The flags are parsed in a loop now; an unknown flag must still be rejected rather than ignored,
// and the domain allowlist must still run FIRST — this is a privilege boundary.
ok('still rejects an unknown flag', () => {
  const r = run('httponly.test', ['--wat']);
  assert.strictEqual(r.code, 2, `expected 2, got ${r.code}`);
});
ok('still rejects an invalid domain, before any flag handling', () => {
  assert.strictEqual(run('bad;rm -rf /', ['--tls']).code, 2);
  assert.strictEqual(run('', []).code, 2);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL TESTS PASSED\n${pass} assertions`);
