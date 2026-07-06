// lib/web-studio/import.js
// ============================================================
//  Import a site to host AS-IS from an uploaded ZIP or a GitHub repo. The content is
//  UNTRUSTED, so the whole module is built around that:
//   - We NEVER run the import's build scripts / npm install (no code execution).
//   - Every path is sanitized: no absolute paths, no `..` traversal (zip-slip), no
//     backslash traversal, no control chars/null bytes, no dotfiles / .git / node_modules.
//   - Only an allowlist of static web asset extensions is accepted.
//   - Caps: total bytes, file count, per-file bytes, examined-entry budget, and a
//     compression-ratio ceiling — checked BEFORE decompression (zip-bomb defense).
//   - Imports are single-flighted (one at a time) so a flood can't pile up sync work.
//   - git clone is restricted to https://github.com/<owner>/<repo> (no SSRF), shallow,
//     protocol-pinned, with prompts disabled and the token scrubbed from any error.
//  Result lands in <workspace>/src as plain static files; build.js staticBuild() mirrors
//  it to dist/. From there it edits/previews/publishes like any other site.
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB uncompressed
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ENTRIES_EXAMINED = 20000;       // central-dir / dir-walk iteration budget
const MAX_COMPRESSION_RATIO = 200;        // declared/compressed ceiling (zip-bomb)

const SAFE_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'map', 'txt', 'md', 'xml',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf', 'wasm', 'csv', 'yml', 'yaml', 'webmanifest',
]);

function sanitizeRelPath(name) {
  const n = String(name == null ? '' : name).replace(/\\/g, '/').trim();
  if (!n || n.endsWith('/')) return null;                       // empty or directory marker
  if (/[\x00-\x1f\x7f]/.test(n)) return null;                   // control chars / null bytes
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;   // absolute (posix or windows)
  const parts = n.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '..')) return null;               // traversal (zip-slip)
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p.startsWith('.'))) return null;
  const rel = parts.join('/');
  const ext = (rel.match(/\.([a-zA-Z0-9]+)$/) || [])[1];
  if (!ext || !SAFE_EXT.has(ext.toLowerCase())) return null;    // not an allowlisted static asset
  return rel;
}

function within(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function extractZip(buffer, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES_EXAMINED) throw new Error(`archive has too many entries (>${MAX_ENTRIES_EXAMINED})`);

  // Reject up front, BEFORE decompressing anything, if the declared uncompressed total
  // already blows the cap (avoids inflating a zip-bomb just to discover it's too big).
  let declaredTotal = 0;
  for (const e of entries) { if (!e.isDirectory) declaredTotal += (e.header && e.header.size) || 0; }
  if (declaredTotal > MAX_TOTAL_BYTES) throw new Error('archive declares more than the 30 MB uncompressed cap');

  let total = 0, count = 0;
  const written = [], warnings = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    try {
      const safe = sanitizeRelPath(e.entryName);
      if (!safe) { warnings.push(`skipped ${String(e.entryName).slice(0, 120)}`); continue; }
      const declared = (e.header && e.header.size) || 0;
      const comp = (e.header && e.header.compressedSize) || 0;
      if (declared > MAX_FILE_BYTES) { warnings.push(`too large: ${safe}`); continue; }
      if (comp > 0 && declared / comp > MAX_COMPRESSION_RATIO) { warnings.push(`suspicious ratio: ${safe}`); continue; }
      if (count + 1 > MAX_FILES) throw new Error(`import exceeds file-count cap (${MAX_FILES})`);
      if (total + declared > MAX_TOTAL_BYTES) throw new Error('import exceeds size cap (30 MB)');
      const data = e.getData();                                 // decompress only after the gates pass
      if (data.length > MAX_FILE_BYTES || total + data.length > MAX_TOTAL_BYTES) { warnings.push(`too large: ${safe}`); continue; }
      const target = path.join(destDir, safe);
      if (!within(destDir, target)) { warnings.push(`escape blocked: ${safe}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      total += data.length; count++; written.push(safe);
    } catch (err) {
      if (/cap|too many/.test(err.message)) throw err;          // caps are hard stops
      warnings.push(`error on ${String(e.entryName).slice(0, 80)}: ${err.message}`); // one bad entry can't kill the import
    }
  }
  return { written, warnings, bytes: total, count };
}

function findStaticRoot(dir) {
  const candidates = ['', 'dist', 'build', 'public', '_site', 'out', 'site', 'www', 'static', 'htdocs', 'web', 'wwwroot', 'docs', 'app'];
  for (const c of candidates) {
    const p = c ? path.join(dir, c) : dir;
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  // single top-level dir -> descend and re-check the candidates inside it
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'));
    if (items.length === 1 && items[0].isDirectory()) {
      const sub = path.join(dir, items[0].name);
      for (const c of candidates) {
        const p = c ? path.join(sub, c) : sub;
        if (fs.existsSync(path.join(p, 'index.html'))) return p;
      }
    }
  } catch { /* fall through */ }
  // last resort: shallow search (depth <= 3) for the SHALLOWEST index.html anywhere,
  // skipping dot-dirs and node_modules. Handles layouts like static/, htdocs/2024/, etc.
  let best = null, bestDepth = Infinity;
  const seek = (cur, depth) => {
    if (depth > 3 || (best && depth >= bestDepth)) return;
    let items; try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    if (items.some((it) => it.isFile() && it.name === 'index.html')) {
      if (depth < bestDepth) { best = cur; bestDepth = depth; }
      return;
    }
    for (const it of items) {
      if (it.isDirectory() && !it.name.startsWith('.') && it.name !== 'node_modules') seek(path.join(cur, it.name), depth + 1);
    }
  };
  seek(dir, 0);
  return best || dir;
}

// When no index.html is found, figure out WHY so we can tell the operator something actionable
// instead of a generic "no index.html". The common case is importing an app-SOURCE repo (React/Vue/
// Next/Astro/Vite/etc.) that must be built first — those have a package.json + a framework config but
// ship no pre-built HTML. Returns a short human sentence, or null if it just looks like an empty/odd repo.
function diagnoseNoIndex(dir) {
  const scan = (base) => {
    let items; try { items = fs.readdirSync(base, { withFileTypes: true }); } catch { return null; }
    return items;
  };
  // look at the repo root and, if there's a single wrapper dir, inside it too
  const roots = [dir];
  const top = (scan(dir) || []).filter((d) => !d.name.startsWith('.'));
  if (top.length === 1 && top[0].isDirectory()) roots.push(path.join(dir, top[0].name));
  const CONFIGS = ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'astro.config.mjs', 'astro.config.ts', 'nuxt.config.ts', 'svelte.config.js', 'gatsby-config.js', 'angular.json', 'remix.config.js'];
  for (const r of roots) {
    const names = new Set((scan(r) || []).map((d) => d.name));
    if (names.has('package.json')) {
      const cfg = CONFIGS.find((c) => names.has(c));
      const kind = cfg ? cfg.replace(/\.(config\.(ts|js|mjs)|json)$/, '').replace(/-config$/, '') : 'a Node/JS';
      return `This looks like ${cfg ? `a ${kind}` : 'an application-source'} project (found package.json${cfg ? ` + ${cfg}` : ''}) with no pre-built HTML. Web Studio imports static sites as-is and does not run a build. Build it first (e.g. "npm run build") and import the output folder (usually dist/ or build/), or push the built output to the repo.`;
    }
  }
  return 'No index.html was found at the imported site root. Import a pre-built static site (an index.html plus its assets), a committed dist/ or build/ folder, or a plain HTML/CSS/JS site.';
}

function ingestDir(srcRoot, destSrc) {
  let total = 0, count = 0, examined = 0;
  const written = [], warnings = [];
  const walk = (cur, relBase) => {
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (++examined > MAX_ENTRIES_EXAMINED) throw new Error(`import has too many entries (>${MAX_ENTRIES_EXAMINED})`);
      const rel = relBase ? `${relBase}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (it.name === '.git' || it.name === 'node_modules' || it.name.startsWith('.')) continue;
        walk(path.join(cur, it.name), rel);
        continue;
      }
      if (!it.isFile()) continue;                                // skip symlinks/devices/fifos
      const safe = sanitizeRelPath(rel);
      if (!safe) { warnings.push(`skipped ${rel.slice(0, 120)}`); continue; }
      const srcFile = path.join(cur, it.name);
      let st;
      try { st = fs.lstatSync(srcFile); } catch { continue; }
      if (!st.isFile()) continue;                                // symlink guard (lstat)
      if (st.size > MAX_FILE_BYTES) { warnings.push(`too large: ${safe}`); continue; }
      if (count + 1 > MAX_FILES) throw new Error(`import exceeds file-count cap (${MAX_FILES})`);
      if (total + st.size > MAX_TOTAL_BYTES) throw new Error('import exceeds size cap (30 MB)');
      const target = path.join(destSrc, safe);
      if (!within(destSrc, target)) { warnings.push(`escape blocked: ${safe}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(srcFile, target);
      total += st.size; count++; written.push(safe);
    }
  };
  walk(srcRoot, '');
  return { written, warnings, bytes: total, count };
}

function cloneGitHub(repoUrl, token, destDir) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(repoUrl)); } catch { return reject(new Error('invalid repo URL')); }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') {
      return reject(new Error('only https://github.com/<owner>/<repo> repositories are supported'));
    }
    const pathPart = u.pathname.replace(/\.git$/, '');
    if (!/^\/[\w.-]+\/[\w.-]+$/.test(pathPart)) return reject(new Error('invalid GitHub repo path'));
    const clean = token
      ? `https://${encodeURIComponent(token)}@github.com${pathPart}.git`
      : `https://github.com${pathPart}.git`;
    execFile('git',
      ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        'clone', '--depth', '1', '--no-tags', '--single-branch', clean, destDir],
      { timeout: 120000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_PROTOCOL_FROM_USER: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          let msg = (stderr || err.message || 'git clone failed').toString();
          for (const t of [token, token && encodeURIComponent(token)]) { if (t) msg = msg.split(t).join('***'); }
          msg = msg.replace(/https:\/\/[^@\s/]*@/g, 'https://***@'); // backstop: redact any userinfo
          // Map git's cryptic auth failures to actionable guidance. GitHub returns 401 for BOTH private
          // and non-existent repos (to avoid leaking existence), and with prompts disabled that surfaces
          // as "could not read Username" / "terminal prompts disabled".
          if (/could not read Username|terminal prompts disabled|Authentication failed|HTTP Basic|403|401/i.test(msg)) {
            return reject(new Error(token
              ? 'GitHub authentication failed. The personal access token is invalid, expired, or lacks access to this repository (needs "repo" scope for private repos). Check the token and try again.'
              : 'This repository is private or does not exist. If it is private, paste a GitHub personal access token (with "repo" scope) into the token field. If it is public, double-check the URL.'));
          }
          if (/not found|repository not found|does not exist|Repository not found/i.test(msg)) {
            return reject(new Error('Repository not found. Check the URL, or if it is private, provide a GitHub personal access token with access to it.'));
          }
          return reject(new Error(`git clone failed: ${msg.slice(0, 300)}`));
        }
        resolve(destDir);
      });
  });
}

async function _importToWorkspace({ workspaceDir, zipBuffer, githubUrl, githubToken }) {
  const src = path.join(workspaceDir, 'src');
  const tmp = path.join(workspaceDir, '.import-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let staging = tmp;
    if (zipBuffer) {
      extractZip(zipBuffer, tmp);
    } else if (githubUrl) {
      const cloneDir = path.join(tmp, 'repo');
      await cloneGitHub(githubUrl, githubToken, cloneDir);
      staging = cloneDir;
    } else {
      throw new Error('no archive or repo provided');
    }
    const root = findStaticRoot(staging);
    fs.rmSync(src, { recursive: true, force: true });           // re-import replaces source
    fs.mkdirSync(src, { recursive: true });
    const result = ingestDir(root, src);
    const hasIndex = fs.existsSync(path.join(src, 'index.html'));
    const reason = hasIndex ? null : diagnoseNoIndex(staging);
    return { ok: result.count > 0, hasIndex, reason, ...result };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Single-flight: serialize all imports so a burst can't pile up synchronous extraction /
// concurrent git clones and starve the shared event loop / disk / memory.
let _importChain = Promise.resolve();
function importToWorkspace(opts) {
  const run = _importChain.then(() => _importToWorkspace(opts), () => _importToWorkspace(opts));
  _importChain = run.then(() => {}, () => {});
  return run;
}

module.exports = { importToWorkspace, sanitizeRelPath, extractZip, ingestDir, findStaticRoot, cloneGitHub, SAFE_EXT, MAX_TOTAL_BYTES, MAX_FILES };
