// lib/csp-inline-hashes.js — CSP hashes for the dashboard's inline IMPORT MAPS.
//
// script-src has no 'unsafe-inline' (AS-02), and browsers enforce script-src on an inline
// <script type="importmap"> exactly as on an executable inline script: without its hash the import
// map is blocked, every bare import it maps fails to resolve, and the module that needed it never
// runs. That is how the video avatar broke silently from 2026-08-12 (the SDK's bare `events` import
// in dashboard/app.html). ld+json blocks really are data and need nothing.
//
// The hashes are COMPUTED from the files at startup, never pasted: an edited import map gets its new
// hash on the next deploy (which restarts the process) instead of breaking until someone notices.
// tools/test-audit-smoke.js checks the served /app page against the served header end to end.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The text between the tags is exactly what the browser hashes — no trimming.
const IMPORTMAP_RE = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;

const cspHash = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function importMapHashes(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(IMPORTMAP_RE)) out.add(cspHash(m[1]));
  return [...out];
}

// Every .html under `dir` (vendor bundles and node_modules skipped). A file that can't be read is
// skipped — a missing page must not take the whole server's CSP down at boot.
function importMapHashesInDir(dir) {
  const out = new Set();
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        try { for (const h of importMapHashes(fs.readFileSync(p, 'utf8'))) out.add(h); } catch { /* unreadable: skip */ }
      }
    }
  };
  walk(dir);
  return [...out];
}

module.exports = { importMapHashes, importMapHashesInDir, cspHash };
