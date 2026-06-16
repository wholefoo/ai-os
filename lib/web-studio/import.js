// lib/web-studio/import.js
// ============================================================
//  Import a site to host AS-IS from an uploaded ZIP or a GitHub repo. The content is
//  UNTRUSTED, so the whole module is built around that:
//   - We NEVER run the import's build scripts / npm install (no code execution).
//   - Every path is sanitized: no absolute paths, no `..` traversal (zip-slip), no
//     dotfiles / .git / node_modules.
//   - Only an allowlist of static web asset extensions is accepted; anything that could
//     be executed server-side (.php/.py/.sh/...) or is unknown is dropped.
//   - Hard caps on total bytes, file count, and per-file bytes (zip-bomb defense).
//   - git clone is restricted to https://github.com/... (no arbitrary-host SSRF), shallow,
//     with terminal prompts disabled and the token scrubbed from any error.
//  Result lands in <workspace>/src as plain static files; build.js staticBuild() mirrors
//  it to dist/. From there it edits/previews/publishes like any other site.
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB uncompressed
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Static web asset types only. No server-executable types, ever.
const SAFE_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'map', 'txt', 'md', 'xml',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf', 'wasm', 'csv', 'yml', 'yaml', 'webmanifest',
]);

// Return a safe relative path, or null to reject the entry.
function sanitizeRelPath(name) {
  let n = String(name || '').replace(/\\/g, '/').trim();
  if (!n || n.endsWith('/')) return null;                       // empty or directory marker
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;   // absolute (posix or windows)
  const parts = n.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '..')) return null;               // traversal (zip-slip)
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p.startsWith('.'))) return null; // junk/dotfiles
  const rel = parts.join('/');
  const ext = (rel.match(/\.([a-zA-Z0-9]+)$/) || [])[1];
  if (!ext || !SAFE_EXT.has(ext.toLowerCase())) return null;    // not an allowlisted static asset
  return rel;
}

// Guard that a resolved target stays inside root (defense in depth on top of sanitizeRelPath).
function within(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function extractZip(buffer, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  let total = 0, count = 0;
  const written = [], warnings = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const safe = sanitizeRelPath(e.entryName);
    if (!safe) { warnings.push(`skipped ${String(e.entryName).slice(0, 120)}`); continue; }
    const declared = e.header && e.header.size || 0;
    if (declared > MAX_FILE_BYTES) { warnings.push(`too large: ${safe}`); continue; }
    if (count + 1 > MAX_FILES) throw new Error(`import exceeds file-count cap (${MAX_FILES})`);
    const data = e.getData();                                   // decompressed Buffer
    if (data.length > MAX_FILE_BYTES) { warnings.push(`too large: ${safe}`); continue; }
    if (total + data.length > MAX_TOTAL_BYTES) throw new Error('import exceeds size cap (30 MB)');
    const target = path.join(destDir, safe);
    if (!within(destDir, target)) { warnings.push(`escape blocked: ${safe}`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    total += data.length; count++; written.push(safe);
  }
  return { written, warnings, bytes: total, count };
}

// Where does the static site actually live? Prefer a dir that has index.html.
function findStaticRoot(dir) {
  const candidates = ['', 'dist', 'build', 'public', '_site', 'out', 'site', 'www'];
  for (const c of candidates) {
    const p = c ? path.join(dir, c) : dir;
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'));
    if (items.length === 1 && items[0].isDirectory()) {
      const sub = path.join(dir, items[0].name);
      for (const c of candidates) {
        const p = c ? path.join(sub, c) : sub;
        if (fs.existsSync(path.join(p, 'index.html'))) return p;
      }
      return sub;
    }
  } catch { /* fall through */ }
  return dir;
}

// Walk a (cloned/extracted) dir and copy only sanitized static files into destSrc.
function ingestDir(srcRoot, destSrc) {
  let total = 0, count = 0;
  const written = [], warnings = [];
  const walk = (cur, relBase) => {
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const rel = relBase ? `${relBase}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (it.name === '.git' || it.name === 'node_modules' || it.name.startsWith('.')) continue;
        walk(path.join(cur, it.name), rel);
        continue;
      }
      if (!it.isFile()) continue; // skip symlinks/devices/etc.
      const safe = sanitizeRelPath(rel);
      if (!safe) { warnings.push(`skipped ${rel.slice(0, 120)}`); continue; }
      const srcFile = path.join(cur, it.name);
      let st;
      try { st = fs.lstatSync(srcFile); } catch { continue; }
      if (!st.isFile()) continue;                                // symlink guard
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
    execFile('git', ['clone', '--depth', '1', '--no-tags', '--single-branch', clean, destDir],
      { timeout: 120000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' } },
      (err, stdout, stderr) => {
        if (err) {
          let msg = (stderr || err.message || 'git clone failed').toString();
          if (token) msg = msg.split(token).join('***'); // never leak the token
          return reject(new Error(`git clone failed: ${msg.slice(0, 300)}`));
        }
        resolve(destDir);
      });
  });
}

/**
 * Import into <workspaceDir>/src (replacing any prior src). Pass exactly one source.
 * @returns {Promise<{ok, hasIndex, count, bytes, warnings, written}>}
 */
async function importToWorkspace({ workspaceDir, zipBuffer, githubUrl, githubToken }) {
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
    return { ok: result.count > 0, hasIndex, ...result };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { importToWorkspace, sanitizeRelPath, extractZip, ingestDir, findStaticRoot, cloneGitHub, SAFE_EXT, MAX_TOTAL_BYTES, MAX_FILES };
