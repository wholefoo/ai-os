// lib/web-studio/publish.js
// ============================================================
//  Atomic release deploy + symlink swap for hosted sites. PLAIN fs — runs as the
//  unprivileged app user (aios owns /opt/ai-os/sites). The privilege boundary stays
//  in hosting.js; nothing here touches /etc or sudo.
//
//  The nginx vhost (deploy/hosting/site-vhost.sh) serves from:
//      <sitesRoot>/<domain>/current        (a symlink -> the active release)
//  So publishing is: copy the built dist/ into releases/<ts>/, then atomically
//  repoint `current` at it (rename over the symlink is atomic on POSIX). A failed
//  TLS step never leaves a half-deployed site — the files are already in place and
//  the previous `current` is untouched until the swap succeeds.
// ============================================================

const fs = require('fs');
const path = require('path');

const KEEP_RELEASES = 5; // retain the last N releases per domain for rollback

function tsName(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * Deploy a built dist/ into <sitesRoot>/<domain>/releases/<ts> and atomically point
 * `current` at it.
 * @returns {{releaseDir:string, currentLink:string}}
 */
function deployRelease(distDir, sitesRoot, domain, now = Date.now()) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('nothing to publish — no built index.html (build the site first)');
  }
  const siteDir = path.join(sitesRoot, domain);
  const releasesDir = path.join(siteDir, 'releases');
  fs.mkdirSync(releasesDir, { recursive: true });

  const releaseDir = path.join(releasesDir, tsName(now));
  fs.cpSync(distDir, releaseDir, { recursive: true });

  // Atomic swap: stage a temp symlink, then rename it over `current`.
  const currentLink = path.join(siteDir, 'current');
  const tmpLink = path.join(siteDir, `.current.${tsName(now)}.tmp`);
  try { fs.unlinkSync(tmpLink); } catch { /* not there */ }
  fs.symlinkSync(releaseDir, tmpLink, 'dir');
  fs.renameSync(tmpLink, currentLink); // replaces an existing symlink atomically

  pruneReleases(releasesDir, releaseDir);
  return { releaseDir, currentLink };
}

function pruneReleases(releasesDir, keepDir) {
  let entries;
  try { entries = fs.readdirSync(releasesDir).filter((n) => !n.startsWith('.')); } catch { return; }
  // Timestamped names sort lexically == chronologically; drop the oldest beyond KEEP_RELEASES.
  const sorted = entries.sort();
  const toRemove = sorted.slice(0, Math.max(0, sorted.length - KEEP_RELEASES));
  for (const name of toRemove) {
    const p = path.join(releasesDir, name);
    if (p === keepDir) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Repoint `current` at the newest release that isn't the active one. Returns target dir or null. */
function rollback(sitesRoot, domain, now = Date.now()) {
  const siteDir = path.join(sitesRoot, domain);
  const releasesDir = path.join(siteDir, 'releases');
  const currentLink = path.join(siteDir, 'current');
  let releases;
  try { releases = fs.readdirSync(releasesDir).filter((n) => !n.startsWith('.')).sort(); } catch { return null; }
  if (releases.length < 2) return null;
  let activeName = null;
  try { activeName = path.basename(fs.readlinkSync(currentLink)); } catch { /* no current */ }
  const candidates = releases.filter((n) => n !== activeName);
  const target = candidates[candidates.length - 1];
  if (!target) return null;
  const targetDir = path.join(releasesDir, target);
  const tmpLink = path.join(siteDir, `.current.rb.${tsName(now)}.tmp`);
  try { fs.unlinkSync(tmpLink); } catch { /* not there */ }
  fs.symlinkSync(targetDir, tmpLink, 'dir');
  fs.renameSync(tmpLink, currentLink);
  return targetDir;
}

/** Remove the entire hosted tree for a domain (on unpublish-with-purge / delete). */
function removeSiteRoot(sitesRoot, domain) {
  const siteDir = path.join(sitesRoot, domain);
  try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

module.exports = { deployRelease, rollback, removeSiteRoot, pruneReleases, KEEP_RELEASES };
