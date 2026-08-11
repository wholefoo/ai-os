// tools/test-deps-installed.js
// ============================================================
//  tools/check-deps-installed.js — the guard that would have caught the 2026-08-11 outage.
//
//  That deploy chained `npm ci --omit=dev && pm2 restart`. `npm ci` wipes node_modules first, the
//  rebuild did not finish, and the restart ran against a partial tree. `exceljs` was missing on one
//  attempt and `adm-zip` on the next — exactly the shape reproduced below.
//
//  The assertions that matter most are the ones about NOT firing: a guard on the deploy path that
//  produces false alarms gets deleted, and then it protects nothing. So devDependencies being
//  absent must pass (deploys use --omit=dev), and this repo's real tree must pass.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkDeps } = require('./check-deps-installed');

const CHECKER = path.join(__dirname, 'check-deps-installed.js');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

/** Build a throwaway package root with a chosen set of packages actually present. */
function fixture({ deps = {}, devDeps = {}, present = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depchk-'));
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'fx', version: '1.0.0', dependencies: deps, devDependencies: devDeps }));
  for (const name of present) {
    const d = path.join(root, 'node_modules', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  return root;
}

/** Run the CLI; return {code, err}. */
function run(root) {
  try {
    const out = execFileSync('node', [CHECKER, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

// --- THE OUTAGE, reproduced. ------------------------------------------------------------------
ok('FAILS when a production dependency is missing, and NAMES it', () => {
  const root = fixture({ deps: { express: '^4', exceljs: '^4', 'adm-zip': '0.6.0' }, present: ['express'] });
  const r = run(root);
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.ok(/exceljs/.test(r.err), 'must name exceljs');
  assert.ok(/adm-zip/.test(r.err), 'must name adm-zip');
  assert.ok(/DO NOT restart/.test(r.err), 'must tell the operator not to restart against this tree');
  assert.ok(/npm install --omit=dev/.test(r.err), 'must give the repair command that actually worked');
  fs.rmSync(root, { recursive: true, force: true });
});

ok('the programmatic API reports which are missing, not just how many', () => {
  const root = fixture({ deps: { a: '1', b: '1', c: '1' }, present: ['b'] });
  const r = checkDeps(root);
  assert.strictEqual(r.checked, 3);
  assert.deepStrictEqual(r.missing.sort(), ['a', 'c']);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- MUST NOT FIRE. A noisy deploy guard is a deleted deploy guard. ----------------------------
ok('PASSES when every production dependency is present', () => {
  const root = fixture({ deps: { express: '^4', exceljs: '^4' }, present: ['express', 'exceljs'] });
  const r = run(root);
  assert.strictEqual(r.code, 0, `expected 0, got ${r.code}: ${r.err.slice(0, 200)}`);
  assert.ok(/all 2 production dependencies present/.test(r.out));
  fs.rmSync(root, { recursive: true, force: true });
});

ok('does NOT flag absent devDependencies — deploys install with --omit=dev', () => {
  const root = fixture({ deps: { express: '^4' }, devDeps: { fallow: '2.91.0', jest: '^29' }, present: ['express'] });
  const r = run(root);
  assert.strictEqual(r.code, 0, `devDeps missing must be fine, got ${r.code}: ${r.err.slice(0, 200)}`);
});

ok('handles scoped package names', () => {
  const root = fixture({ deps: { '@livekit/agents': '^1' }, present: [] });
  assert.deepStrictEqual(checkDeps(root).missing, ['@livekit/agents']);
  const root2 = fixture({ deps: { '@livekit/agents': '^1' }, present: ['@livekit/agents'] });
  assert.deepStrictEqual(checkDeps(root2).missing, []);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});

// --- Refuse to pass vacuously. ----------------------------------------------------------------
// "0 dependencies, all present" is the failure mode this whole session kept finding: a check that
// reports success for a narrower question than the one being asked.
ok('exits 2 (not 0) when package.json declares no production dependencies', () => {
  const root = fixture({ deps: {}, present: [] });
  const r = run(root);
  assert.strictEqual(r.code, 2, 'an empty dependency set must not read as a pass');
  assert.ok(/refusing to call that a pass/i.test(r.err));
  fs.rmSync(root, { recursive: true, force: true });
});

ok('exits 2 when there is no package.json at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depchk-empty-'));
  const r = run(root);
  assert.strictEqual(r.code, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- THE REAL REPO MUST PASS. -----------------------------------------------------------------
// Ties the guard to reality: if this goes red, either the local tree is genuinely broken or the
// checker is wrong. Both are worth stopping for.
ok('this repository passes its own check', () => {
  const r = checkDeps(path.join(__dirname, '..'));
  assert.strictEqual(r.missing.length, 0, `missing: ${r.missing.join(', ')}`);
  assert.ok(r.checked > 5, `expected a real dependency list, saw ${r.checked}`);
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
