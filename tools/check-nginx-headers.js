#!/usr/bin/env node
// tools/check-nginx-headers.js
// ============================================================
//  Reads an nginx server config on STDIN and reports any `location` block that declares its own
//  `add_header` while missing the security headers, because nginx SILENTLY drops the inherited set
//  in exactly that case.
//
//  WHY THIS EXISTS RATHER THAN A DIFF AGAINST deploy/nginx.conf. The live config is legitimately
//  NOT the template: install-vps.sh `sed`s the domain in (:353) and conditionally appends an n8n
//  block (:364-381). A textual diff therefore always differs, would fire on every deploy, and would
//  be ignored within a week — the same failure mode as a dependency bot nobody reads. This checks
//  the PROPERTY that actually broke instead, so a clean result means something.
//
//  WHAT BROKE. nginx inherits add_header from the enclosing level ONLY IF the current level
//  declares none; one `add_header Cache-Control` in a child REPLACES the entire parent set. On
//  2026-08-10 /css/, /js/ and /docs/ had each set Cache-Control, so all five security headers were
//  absent from those paths — including nosniff on the path serving JavaScript — while the config
//  read as though they were global. `nginx -t` cannot see this; it is valid configuration.
//
//  Usage:  sudo cat /etc/nginx/sites-available/ai-os | node tools/check-nginx-headers.js
//  Exit 0 = every add_header block carries the required set (or no block declares one).
//  Exit 1 = at least one block would silently drop them.
// ============================================================

// Only headers whose ABSENCE is a security regression. Cache-Control and friends are per-block by
// design and must not be required here, or every static block reports a false positive.
const REQUIRED = ['X-Content-Type-Options'];
// Reported when missing, but do not fail the check on their own: the hosted-site template
// deliberately carries a smaller set than the dashboard vhost.
const ADVISORY = ['Strict-Transport-Security', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy'];

/** Split into `location` blocks with brace matching. Comments are stripped FIRST — an early
 *  version of this matched the word "location" inside a comment and silently mis-parsed. */
function locationBlocks(text) {
  const src = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const out = [];
  const re = /location\s+([^{]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ name: m[1].trim(), body: src.slice(re.lastIndex, i) });
  }
  return out;
}

function check(text) {
  const findings = [];
  let inspected = 0;
  for (const b of locationBlocks(text)) {
    // A block with no add_header of its own INHERITS correctly — it is not a finding.
    if (!/add_header/.test(b.body)) continue;
    inspected++;
    const missingRequired = REQUIRED.filter((h) => !b.body.includes(h));
    const missingAdvisory = ADVISORY.filter((h) => !b.body.includes(h));
    if (missingRequired.length) findings.push({ name: b.name, missingRequired, missingAdvisory });
  }
  return { inspected, findings };
}

module.exports = { check, locationBlocks, REQUIRED, ADVISORY };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => {
    if (!buf.trim()) {
      // An empty read is NOT a pass. Piping from a file that needs sudo silently yields nothing,
      // and reporting "0 problems" there would be the exact class of bug this tool exists to catch.
      console.error('check-nginx-headers: EMPTY INPUT — nothing was read on stdin. This is not a pass.');
      process.exit(2);
    }
    const { inspected, findings } = check(buf);
    if (!findings.length) {
      console.log(`check-nginx-headers: OK — ${inspected} location block(s) declare add_header, all carry ${REQUIRED.join(', ')}`);
      process.exit(0);
    }
    console.error(`check-nginx-headers: ${findings.length} of ${inspected} add_header block(s) SILENTLY DROP inherited headers:`);
    for (const f of findings) {
      console.error(`  location ${f.name}`);
      console.error(`    missing (required):  ${f.missingRequired.join(', ')}`);
      if (f.missingAdvisory.length) console.error(`    missing (advisory):  ${f.missingAdvisory.join(', ')}`);
    }
    console.error('  Fix: repeat the server-level add_header directives inside each block above.');
    process.exit(1);
  });
}
