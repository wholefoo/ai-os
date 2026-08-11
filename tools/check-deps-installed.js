#!/usr/bin/env node
// tools/check-deps-installed.js
// ============================================================
//  Answers one question: is every PRODUCTION dependency actually present in node_modules?
//
//  WHY THIS EXISTS. On 2026-08-11 a deploy ran `npm ci --omit=dev && pm2 restart` as one chained
//  command. `npm ci` DELETES node_modules before rebuilding; the rebuild did not complete; the
//  restart then ran against a partial tree; server.js died at `require` and crash-looped. The main
//  site was down ~40 minutes. Two packages were missing on two separate attempts (`exceljs`, then
//  `adm-zip`) — and nothing anywhere checked, because a partial tree looks exactly like a healthy
//  one until something requires the file that isn't there.
//
//  A missing dependency is not detectable from the install's exit code alone (that is the whole
//  lesson: we never did establish why `npm ci` failed there, and it may not have reported failure
//  at all). So this checks the RESULT rather than trusting the process.
//
//  Deliberately checks `node_modules/<name>/package.json` rather than `require.resolve(name)`:
//  resolve fails for perfectly-installed packages that have no resolvable main entry, which would
//  produce false alarms on a deploy — and a false alarm on a deploy step gets it deleted.
//
//  Usage:  node tools/check-deps-installed.js [rootDir]
//  Exit 0 = every production dependency is present.  Exit 1 = at least one is missing (named).
// ============================================================

const fs = require('fs');
const path = require('path');

/** @returns {{checked: number, missing: string[]}} */
function checkDeps(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`no package.json at ${root}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  // Production only: deploys install with --omit=dev, so devDependencies being absent is CORRECT
  // and flagging them would make this fire on every healthy deploy.
  const deps = Object.keys(pkg.dependencies || {});
  const missing = deps.filter((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));
  return { checked: deps.length, missing };
}

module.exports = { checkDeps };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  let r;
  try {
    r = checkDeps(root);
  } catch (e) {
    console.error(`check-deps-installed: ${e.message}`);
    process.exit(2);
  }
  if (!r.checked) {
    // No production dependencies at all is almost certainly a truncated or wrong package.json, not
    // a legitimately dependency-free app. Treat it as a failure rather than a vacuous pass.
    console.error('check-deps-installed: package.json declares NO production dependencies — refusing to call that a pass');
    process.exit(2);
  }
  if (r.missing.length) {
    console.error(`check-deps-installed: ${r.missing.length} of ${r.checked} production dependencies MISSING from node_modules:`);
    for (const m of r.missing) console.error(`    ${m}`);
    console.error('  The install did not complete. DO NOT restart the app against this tree —');
    console.error('  it will crash at require() and the old process will stop serving.');
    console.error('  Repair with:  npm install --omit=dev   (reconciles; unlike `npm ci` it does not wipe first)');
    process.exit(1);
  }
  console.log(`check-deps-installed: OK — all ${r.checked} production dependencies present`);
}
