// lib/web-studio/export.js
// ============================================================
//  Export a BUILT site (dist/) — download it as a ZIP, or push it to GitHub as ONE clean
//  commit via the Git Data API. The mirror of lib/web-studio/import.js, and it keeps the
//  same security posture:
//    - only dist/ is ever read (the deployable static build), never the workspace at large;
//    - symlinks are skipped, and size / file-count caps bound the work;
//    - the GitHub token travels ONLY in the Authorization header — never in a URL, in argv
//      (we use the REST API, not a `git push` with a token-in-URL remote), in a temp file,
//      or in any log line.
// ============================================================

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const GH_API = 'https://api.github.com';
const UA = 'AI-OS-WebStudio/1.0';
const MAX_FILES = 2000;                      // bound the per-file blob API fan-out
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;    // 60 MB total
const MAX_FILE_BYTES = 25 * 1024 * 1024;     // GitHub blob practical ceiling

// Walk dir → [{ rel (posix), abs, size }], skipping symlinks + non-files. Throws on caps.
function listFiles(dir) {
  const out = [];
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      let st; try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;       // never follow or emit symlinks
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) throw new Error(`file too large to export: ${path.relative(dir, abs).replace(/\\/g, '/')}`);
      total += st.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('site exceeds the export size cap (60 MB)');
      out.push({ rel: path.relative(dir, abs).replace(/\\/g, '/'), abs, size: st.size });
      if (out.length > MAX_FILES) throw new Error('site exceeds the export file-count cap (2000)');
    }
  };
  walk(dir);
  return out;
}

// Build a ZIP buffer of dir's contents (files sit at the archive root).
function zipDir(dir) {
  const files = listFiles(dir);
  if (!files.length) throw new Error('nothing to export (empty dist)');
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.rel, fs.readFileSync(f.abs));
  return zip.toBuffer();
}

// owner/repo from a GitHub URL ("https://github.com/owner/repo(.git)") or "owner/repo".
function parseRepo(url) {
  const s = String(url || '').trim().replace(/\.git$/i, '');
  const m = s.match(/github\.com[/:]+([^/]+)\/([^/?#]+)/i) || s.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error('could not parse owner/repo from the GitHub URL');
  return { owner: m[1], repo: m[2] };
}

// Single GitHub REST call. Token is sent in the Authorization header only.
async function ghFetch(token, method, urlPath, body) {
  const res = await fetch(GH_API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error((json && json.message) || `GitHub API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Push the contents of distDir to GitHub as a single commit (Git Data API).
 * For an EXISTING repo the commit is overlaid on the default branch's current tree, so
 * unrelated files survive (same-path files are replaced) — it is additive, not a force-wipe.
 *
 * @param {object} o
 * @param {string} o.distDir      built site dir
 * @param {string} o.token        GitHub PAT (repo scope) — headers only; never persisted
 * @param {'new'|'existing'} o.mode
 * @param {string} [o.repoName]   for mode 'new'
 * @param {boolean}[o.isPrivate]  for mode 'new'
 * @param {string} [o.repoUrl]    for mode 'existing' (URL or "owner/repo")
 * @param {string} [o.message]    commit message
 * @returns {Promise<{repoUrl, commitUrl, branch, owner, repo, files}>}
 */
async function exportToGitHub({ distDir, token, mode, repoName, isPrivate, repoUrl, message }) {
  if (!token) throw new Error('a GitHub token is required');
  const files = listFiles(distDir);
  if (!files.length) throw new Error('nothing to export (empty dist)');

  let owner, repo, branch, baseCommitSha = null, baseTreeSha = null;

  if (mode === 'new') {
    const name = String(repoName || '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('invalid repo name (use letters, digits, . _ -)');
    const created = await ghFetch(token, 'POST', '/user/repos', {
      name, private: !!isPrivate, auto_init: false, description: 'Exported from AI OS Web Studio',
    });
    owner = created.owner.login; repo = created.name;
    branch = created.default_branch || 'main';      // empty repo: this ref does not exist yet
  } else {
    ({ owner, repo } = parseRepo(repoUrl));
    const info = await ghFetch(token, 'GET', `/repos/${owner}/${repo}`);
    branch = info.default_branch || 'main';
    // Current head of the default branch (404/409 = empty repo → fresh commit, no parent).
    try {
      const ref = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      baseCommitSha = ref.object.sha;
      const commit = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
      baseTreeSha = commit.tree.sha;
    } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }
  }

  // 1. one blob per file
  const tree = [];
  for (const f of files) {
    const blob = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: fs.readFileSync(f.abs).toString('base64'), encoding: 'base64',
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  // 2. tree (overlay onto the base tree for existing repos)
  const treeRes = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/trees`,
    baseTreeSha ? { base_tree: baseTreeSha, tree } : { tree });
  // 3. commit
  const commitRes = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message: String(message || 'Deploy site from AI OS Web Studio').slice(0, 500),
    tree: treeRes.sha,
    parents: baseCommitSha ? [baseCommitSha] : [],
  });
  // 4. point the branch at the new commit (create the ref if it doesn't exist yet)
  if (baseCommitSha) {
    await ghFetch(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: commitRes.sha, force: false });
  } else {
    await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitRes.sha });
  }

  return { repoUrl: `https://github.com/${owner}/${repo}`, commitUrl: commitRes.html_url, branch, owner, repo, files: files.length };
}

module.exports = { zipDir, exportToGitHub, listFiles, parseRepo };
