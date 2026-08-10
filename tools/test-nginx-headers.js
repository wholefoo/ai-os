// tools/test-nginx-headers.js
// ============================================================
//  Pins tools/check-nginx-headers.js against the REAL configs it exists to police, plus the shapes
//  that make a naive implementation useless.
//
//  The checker replaced a textual diff on purpose (see its header). A diff always differs, so it
//  would be ignored; this checks the property, so a clean result carries information. That only
//  holds if the checker is right about which blocks are and are not findings — which is what these
//  assertions are for.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check } = require('./check-nginx-headers');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- THE DEFECT, as it actually appeared on 2026-08-10. ---------------------------------------
const BROKEN = `
server {
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    location /js/ {
        alias /opt/ai-os/dashboard/js/;
        add_header Cache-Control "no-cache";
        access_log off;
    }
    location / { try_files $uri $uri/ /index.html =404; }
}`;

ok('FLAGS a block that sets Cache-Control and thereby drops the inherited set', () => {
  const r = check(BROKEN);
  assert.strictEqual(r.findings.length, 1, 'exactly one block is broken');
  assert.strictEqual(r.findings[0].name, '/js/');
  assert.ok(r.findings[0].missingRequired.includes('X-Content-Type-Options'));
});

ok('does NOT flag the sibling block that declares no add_header — it inherits correctly', () => {
  const r = check(BROKEN);
  assert.strictEqual(r.inspected, 1, 'only add_header-declaring blocks are inspected');
  assert.ok(!r.findings.some((f) => f.name === '/'));
});

// --- The fixed shape must come back clean, or the checker is useless as a gate. ----------------
ok('PASSES once the headers are repeated inside the block', () => {
  const r = check(BROKEN.replace('add_header Cache-Control "no-cache";',
    'add_header Cache-Control "no-cache";\n        add_header X-Content-Type-Options "nosniff" always;'));
  assert.strictEqual(r.findings.length, 0, 'the repaired config must pass');
  assert.strictEqual(r.inspected, 1);
});

// --- `expires` does NOT break inheritance; flagging it would be a false positive. ---------------
// This distinction is the one most likely to be got wrong, and getting it wrong means telling the
// operator to "fix" blocks that were always correct.
ok('does NOT flag a block using `expires` instead of add_header', () => {
  const r = check(`server {
    add_header X-Content-Type-Options "nosniff" always;
    location /assets/ { alias /x/; expires 7d; access_log off; }
}`);
  assert.strictEqual(r.inspected, 0);
  assert.strictEqual(r.findings.length, 0);
});

// --- Comments must not be parsed as config. ----------------------------------------------------
// An earlier ad-hoc version of this logic matched the word "location" inside a comment and
// mis-parsed the file, reporting a garbage block name. Caught by hand at the time; pinned here.
ok('ignores the word "location" inside a comment', () => {
  const r = check(`server {
    # if you add another location block that sets any add_header, repeat these
    add_header X-Content-Type-Options "nosniff" always;
    location /js/ { add_header Cache-Control "no-cache"; add_header X-Content-Type-Options "nosniff" always; }
}`);
  assert.strictEqual(r.findings.length, 0, 'the comment must not become a phantom finding');
  assert.strictEqual(r.inspected, 1);
});

// --- Nested braces inside a block must not truncate it early. ----------------------------------
ok('handles nested braces without losing the rest of the block', () => {
  const r = check(`server {
    location /x/ {
        if ($request_method = POST) { return 405; }
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options "nosniff" always;
    }
}`);
  assert.strictEqual(r.findings.length, 0, 'the header AFTER the nested block must still be seen');
});

// --- THE REAL FILES IN THIS REPO MUST PASS. ---------------------------------------------------
// This is the assertion that ties the checker to reality: if someone reintroduces the defect in
// either config, this test goes red without anyone remembering to look.
ok('deploy/nginx.conf passes its own checker', () => {
  const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx.conf'), 'utf8');
  const r = check(conf);
  assert.strictEqual(r.findings.length, 0,
    `deploy/nginx.conf has blocks dropping headers: ${JSON.stringify(r.findings)}`);
  assert.ok(r.inspected >= 3, `expected >=3 add_header blocks (/css/, /js/, /docs/), saw ${r.inspected}`);
});

ok('the generated hosted-site vhost passes too (both schemes)', () => {
  // Render the real generator rather than a fixture — a fixture would drift from the script.
  const script = path.join(__dirname, '..', 'deploy', 'hosting', 'site-vhost.sh');
  const src = fs.readFileSync(script, 'utf8');
  const marker = 'TMP="$(mktemp)"';
  assert.ok(src.includes(marker), 'render marker not found — script shape changed');
  // Neutralise the cert precondition: --tls legitimately refuses without a real certificate, and
  // this test is about the RENDERED HEADERS, not cert handling (which test-vhost-scheme-guard.js
  // and the script's own exit 3 cover). Asserted to have applied, per the CRLF no-op lesson.
  const certGuard = 'if [ "$TLS" = "--tls" ] && [ ! -s "${CERT_DIR}/fullchain.pem" ]; then';
  assert.ok(src.includes(certGuard), 'cert-guard marker not found — script shape changed');
  const harness = src.slice(0, src.indexOf(marker)).replace(certGuard, 'if false; then') + '\nrender\n';
  assert.ok(!harness.includes(certGuard), 'cert-guard neutralisation did not apply');
  const p = path.join(require('os').tmpdir(), 'vhost-render-check.sh');
  fs.writeFileSync(p, harness);
  for (const args of [['x.example.com'], ['x.example.com', '--tls']]) {
    const out = execFileSync('bash', [p, ...args], { encoding: 'utf8' });
    const r = check(out);
    assert.strictEqual(r.findings.length, 0,
      `generated vhost (${args.join(' ')}) drops headers: ${JSON.stringify(r.findings)}`);
    assert.ok(r.inspected >= 1, `expected the asset block to be inspected for ${args.join(' ')}`);
  }
  fs.rmSync(p, { force: true });
});

// --- An empty read must NOT be reported as a pass. ---------------------------------------------
// `sudo cat | node …` yields nothing if the sudo fails, and "0 problems" there would be precisely
// the silent-omission bug this whole tool exists to prevent.
ok('CLI treats empty stdin as an error, not a pass', () => {
  let code = 0;
  try {
    execFileSync('node', [path.join(__dirname, 'check-nginx-headers.js')], { input: '', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2, 'empty input must exit 2, never 0');
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
