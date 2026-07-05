// lib/self-improve/github-pr.js
// ============================================================
//  Open a DRAFT pull request proposing a set of file changes — the "distribution blueprint": an
//  AI-planned upgrade to the public open-core repo (e.g. wholefoo/ai-os), surfaced for a human to
//  review and merge. This module structurally CANNOT touch the repo's default branch ref — it only
//  ever creates a NEW branch and opens a PR from it. There is no code path here that PATCHes
//  heads/<default-branch>; the only ref-mutating call is a POST that creates a brand-new ref.
//
//  Reuses the Git Data API primitive already audited in lib/web-studio/export.js (ghFetch/
//  parseRepo): the token travels in the Authorization header only, every call has a timeout, and
//  errors surface with the real GitHub status code.
// ============================================================

const { ghFetch, parseRepo } = require('../web-studio/export');

const BRANCH_PREFIX = 'ai-upgrade/';

function safeBranchSlug(s) {
  return String(s || 'upgrade').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'upgrade';
}

/**
 * Open a draft PR on `repoUrl` proposing `files` (full new file contents — same shape as
 * lib/self-improve/plan-store.js's plan.files). Additive: the new commit is overlaid on the
 * CURRENT tip of the default branch, so files not in the plan are untouched. Never updates the
 * default branch's own ref — only creates a new branch + PR.
 * @param {object} o
 * @param {string} o.repoUrl   "owner/repo" or a github.com URL — the TARGET repo
 * @param {string} o.token     GitHub PAT (repo scope) — header only, never persisted by this module
 * @param {Array<{path:string, content:string}>} o.files
 * @param {string} o.title     PR title
 * @param {string} [o.body]    PR description (e.g. the plan's summary/risk/rollback notes)
 * @returns {Promise<{prUrl, prNumber, branch, owner, repo}>}
 */
async function openDraftUpgradePR({ repoUrl, token, files, title, body }) {
  if (!token) throw new Error('a GitHub token is required');
  if (!Array.isArray(files) || !files.length) throw new Error('no files in the proposed change set');
  const { owner, repo } = parseRepo(repoUrl);

  const info = await ghFetch(token, 'GET', `/repos/${owner}/${repo}`);
  const base = info.default_branch || 'main';
  const baseRef = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${base}`);
  const baseCommitSha = baseRef.object.sha;
  const baseCommit = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  // One blob per file, overlaid onto the base tree (additive — files outside the plan survive).
  const tree = [];
  for (const f of files) {
    const blob = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: Buffer.from(String(f.content), 'utf-8').toString('base64'), encoding: 'base64',
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const treeRes = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseTreeSha, tree });
  const commitRes = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message: String(title || 'AI-proposed upgrade').slice(0, 500),
    tree: treeRes.sha,
    parents: [baseCommitSha],
  });

  // ALWAYS a brand-new branch — this is the only ref-mutating call in this module, and it is a
  // ref CREATE, never a ref UPDATE against the default branch.
  const branch = `${BRANCH_PREFIX}${safeBranchSlug(title)}-${Date.now()}`;
  await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitRes.sha });

  const pr = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title: String(title || 'AI-proposed upgrade').slice(0, 250),
    body: String(body || '').slice(0, 60000),
    head: branch,
    base,
    draft: true,
  });

  return { prUrl: pr.html_url, prNumber: pr.number, branch, owner, repo };
}

module.exports = { openDraftUpgradePR };
