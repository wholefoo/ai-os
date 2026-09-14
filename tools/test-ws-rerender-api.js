// The /build route's `rerender` flag.
//
// WHY IT EXISTS: renderPlanToWorkspace is what writes the .astro pages (which carry the canonical
// tag) AND public/{sitemap.xml,llms.txt,robots.txt,knowledge/}. The build route did not call it —
// it ran Astro over whatever was already on disk. So a fix to any emitter could be committed,
// deployed, and rebuilt, and the live site would still serve the OLD canonical and the OLD sitemap,
// while the route cheerfully reported ok:true. That happened: the trailing-slash fix was rebuilt
// onto two live sites and changed nothing.
//
// WHY IT IS OPT-IN: re-rendering from the plan overwrites files edited by hand through PUT /file or
// ai-edit. Defaulting to "re-render" would silently discard those.
//
// Repo convention: this reads server.js as text; live behaviour is proven by probes recorded in the
// commit message.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const start = src.indexOf("app.post('/api/web-studio/sites/:id/build'");
assert(start > 0, 'the build route was located in server.js');
const block = src.slice(start, src.indexOf("app.post('/api/web-studio/sites/:id/domain'", start));
assert(block.length > 600, 'the build route block has content');

// ---------- the flag exists and is opt-in --------------------------------------------------------
assert(/if \(\(req\.body \|\| \{\}\)\.rerender\)/.test(block),
  'the route reads a `rerender` flag off the body');
assert(/const result = await wsApplyPlanChange\(site, site\.plan\)/.test(block),
  'rerender goes through wsApplyPlanChange, which renders the plan to the workspace then builds');

// The default path must NOT re-render — that is what makes the flag opt-in rather than a behaviour
// change for every existing caller.
const afterFlag = block.slice(block.indexOf('site.status = \'building\''));
assert(!afterFlag.includes('renderPlanToWorkspace') && !afterFlag.includes('wsApplyPlanChange'),
  'the DEFAULT build path still does not re-render — hand-edited files survive a plain rebuild');

// ---------- it refuses when there is nothing to render from --------------------------------------
assert(/if \(!site\.plan\) return res\.status\(409\)/.test(block),
  'a site with no plan is refused with 409 rather than rendering undefined');
const planGuard = block.indexOf('if (!site.plan)');
const applyCall = block.indexOf('wsApplyPlanChange');
assert(planGuard > 0 && planGuard < applyCall,
  'the no-plan guard comes BEFORE the render call, not after');

// ---------- it persists and announces -------------------------------------------------------------
assert(/saveState\('web_studio_sites', webStudioSites\)/.test(block.slice(0, applyCall + 600)),
  'the rerender path persists state');
assert(/broadcast\(\{ event: 'web_studio_site', data: site \}\)/.test(block.slice(applyCall, applyCall + 700)),
  'the rerender path broadcasts the updated site');
assert(/rerendered: true/.test(block),
  'the response says it re-rendered, so a caller can tell the two paths apart');

// ---------- failures are not reported as success --------------------------------------------------
assert(/res\.status\(result\.ok \? 200 : 500\)/.test(block),
  'a failed re-render returns 500, not 200');
assert(/error: result\.ok \? undefined : site\.error/.test(block),
  'a failed re-render reports the error');

// ---------- ownership ------------------------------------------------------------------------------
assert(/app\.post\('\/api\/web-studio\/sites\/:id\/build', requireClientOrAdmin/.test(block),
  'the build route is behind requireClientOrAdmin');
assert(/const site = wsFindSite\(req, res\); if \(!site\) return;/.test(block),
  'the site is resolved through the ownership-scoped wsFindSite');

done('ws-rerender-api');
