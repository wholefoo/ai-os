// The adoption route. Adoption KEEPS CONTENT and REPLACES PRESENTATION on a site that may be live,
// so the guards are the point: a dry run by default, an explicit confirm, a refusal when there is
// nothing substantial to adopt, a reversible backup, and never an automatic deploy.
//
// Repo convention: this reads server.js as text. The behaviour was proven by a live probe against
// the real server (throwaway state, real rebuilt Truth Counters content in the workspace) and the
// results are in the commit message.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const block = src.slice(src.indexOf('//  Adoption — give an imported static site a plan'),
  src.indexOf('// --- Rebuild from current workspace source'));
assert(block.length > 800, 'the adoption block was located in server.js');

assert(block.includes("app.post('/api/web-studio/sites/:id/adopt'"), 'the adopt route is defined');
assert(/app\.post\('\/api\/web-studio\/sites\/:id\/adopt', requireClientOrAdmin/.test(block),
  'adoption is behind requireClientOrAdmin');
assert(/wsFindSite\(req, res\); if \(!site\) return;/.test(block),
  'adoption resolves the site through the ownership-scoped wsFindSite');

// ---------- dry run is the DEFAULT -------------------------------------------------------------------
// Adoption rewrites a site's presentation. Defaulting to "do it" would make a mistyped request
// destructive, so the caller must opt IN.
assert(/const dryRun = body\.dryRun !== false && body\.confirm !== true;/.test(block),
  'a request with no body is a DRY RUN — a real run needs an explicit confirm');
assert(/if \(dryRun\) \{[\s\S]*return res\.json\(\{ dryRun: true/.test(block),
  'the dry run returns before anything is written');
// Nothing may be written before the dryRun check.
const beforeDry = block.slice(0, block.indexOf('if (dryRun)'));
for (const forbidden of ['fs.cpSync', 'fs.rmSync', 'scaffoldWorkspace', 'wsApplyPlanChange']) {
  assert(!beforeDry.includes(forbidden), `the dry-run path does not call ${forbidden}`);
}

// ---------- refusing to adopt nothing ------------------------------------------------------------------
// The whole reason this feature exists is that an empty SPA shell was imported and published over
// real content. Adoption must not repeat that in the other direction.
assert(/code: 'NOTHING_TO_ADOPT'/.test(block), 'a derivation that found nothing is refused');
assert(/!derived\.stats\.articlesAdopted && derived\.stats\.pagesAdopted <= 1/.test(block),
  'the refusal triggers when no articles and no real pages were extracted');
assert(/replace the site with an empty shell/.test(block), 'the refusal explains the consequence');
assert(/source:"live"/.test(block), 'the refusal suggests the live-release source as the remedy');

// ---------- reversibility ------------------------------------------------------------------------------
assert(/src\.pre-adopt-/.test(block), 'the original src/ is backed up before being replaced');
assert(/fs\.cpSync\(srcDir, backup, \{ recursive: true \}\)[\s\S]{0,200}fs\.rmSync\(srcDir/.test(block),
  'the backup is taken BEFORE the original is cleared');

// ---------- never deploys --------------------------------------------------------------------------------
assert(/\{ deploy: false, persistPlanOnFailure: true \}/.test(block),
  'adoption never auto-deploys, and keeps its plan even if the build fails');
assert(/Nothing was deployed/.test(block), 'the response says plainly that nothing went live');

// ---------- source selection ------------------------------------------------------------------------------
// 'live' exists because a workspace can be STALE: a site deployed by hand into a release directory
// serves content its workspace has never seen. Both recovered sites are in exactly that state.
assert(/function wsAdoptSource/.test(src), 'the source resolver exists');
const source = src.slice(src.indexOf('function wsAdoptSource'), src.indexOf("app.post('/api/web-studio/sites/:id/adopt'"));
assert(/WS_SITES_ROOT, site\.domain, 'current'/.test(source),
  "source:'live' reads the deployed release the domain is actually serving");
assert(/\['src', 'dist', ''\]/.test(source), 'the workspace source tries src/, then dist/, then the root');
assert(/no live release found/.test(source), 'a missing live release is reported, not silently skipped');

// ---------- traversal safety of the collector ------------------------------------------------------------
const collect = src.slice(src.indexOf('function wsCollectHtml'), src.indexOf('function wsAdoptSource'));
assert(/name !== 'node_modules' && !name\.startsWith\('\.'\)/.test(collect),
  'the collector skips node_modules and dotfiles');
assert(/cap = 500/.test(collect) && /out\.length >= cap/.test(collect),
  'the collector is bounded, so a pathological tree cannot exhaust memory');

done();
