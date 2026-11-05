// lib/csp-inline-hashes.js: the CSP hashes that let the dashboard's inline import maps through
// script-src (no 'unsafe-inline' since AS-02). Without them the browser blocks the import map, the
// LiveAvatar SDK's bare `events` import fails, and the video avatar never starts — prod, 2026-08-12
// to 2026-11-04. The end-to-end check (served /app HTML vs served CSP header) is in test-audit-smoke.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done, repoRoot, readRepoFile } = require('./test-util');
const { importMapHashes, importMapHashesInDir, cspHash } = require('../lib/csp-inline-hashes');

const APP_MAP = '{ "imports": { "events": "/vendor/events.esm.js" } }';

// An INDEPENDENT oracle: the hash Chrome itself printed for app.html's import map when it blocked it
// ("Either the 'unsafe-inline' keyword, a hash ('sha256-cS+N…'), or a nonce … is required").
assert(importMapHashes(`<script type="importmap">${APP_MAP}</script>`).join() === "'sha256-cS+NSc3aoC6ZNUccvZGKqEw4pEX3cd3rIo8LlW22QYg='",
  'the hash matches the one Chrome demanded for this exact import map');

// The browser hashes the text between the tags EXACTLY — whitespace included.
assert(importMapHashes('<script type="importmap">\n{}\n</script>').join() === cspHash('\n{}\n') && cspHash('\n{}\n') !== cspHash('{}'),
  'the text is hashed untrimmed (a newline inside the tags changes the hash)');
assert(importMapHashes("<script data-x=1 type='importmap' >{}</script>").join() === cspHash('{}'), 'single quotes / extra attributes still match');
assert(importMapHashes('<script type="application/ld+json">{}</script><script type="module" src="/a.js"></script>').length === 0,
  'ld+json (data) and module scripts are not import maps — nothing added for them');
assert(importMapHashes(`<script type="importmap">${APP_MAP}</script><script type="importmap">${APP_MAP}</script>`).length === 1, 'duplicates collapse');
assert(importMapHashes('').length === 0 && importMapHashes(null).length === 0, 'no HTML -> no hashes');

// The real dashboard: app.html's import map is found, and it hashes to the value Chrome demanded.
assert(/<script type="importmap">/.test(readRepoFile('dashboard/app.html')), 'dashboard/app.html still has its inline import map (else this suite tests nothing)');
const dash = importMapHashesInDir(path.join(repoRoot, 'dashboard'));
assert(dash.includes("'sha256-cS+NSc3aoC6ZNUccvZGKqEw4pEX3cd3rIo8LlW22QYg='"), 'scanning dashboard/ yields app.html\'s import-map hash');

// The directory walk: nested pages found, vendor/ and node_modules/ skipped, a missing dir is empty.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-hashes-'));
try {
  fs.mkdirSync(path.join(tmp, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'vendor'));
  fs.writeFileSync(path.join(tmp, 'docs', 'deep', 'p.html'), '<script type="importmap">{"a":1}</script>');
  fs.writeFileSync(path.join(tmp, 'vendor', 'v.html'), '<script type="importmap">{"vendored":1}</script>');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), '<script type="importmap">{"txt":1}</script>');
  const got = importMapHashesInDir(tmp);
  assert(got.join() === cspHash('{"a":1}'), 'a nested page\'s import map is found; vendor/ and non-.html files are not');
  assert(importMapHashesInDir(path.join(tmp, 'missing')).length === 0, 'a missing directory yields nothing (never throws at boot)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

done();
