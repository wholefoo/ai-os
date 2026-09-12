// The article content API: route shape, auth, and the guards that protect live content.
//
// Repo convention: suites read server.js as text rather than booting it. The behaviour was proven
// by a live probe against the real server (throwaway AIOS_STATE_SUBDIR + throwaway token) and the
// results are recorded in the commit message; this suite pins the shape so a later edit cannot
// quietly drop a guard.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
// Bounded by the ADOPTION block, not the build route: adoption sits between them and its own
// routes would otherwise be counted as article routes.
const block = src.slice(src.indexOf('//  Content backend — articles'),
  src.indexOf('//  Adoption — give an imported static site a plan'));
assert(block.length > 500, 'the article content block was located in server.js');

// ---------- routes exist, with the right verbs ----------------------------------------------------
for (const [verb, route] of [
  ["get", "/api/web-studio/sites/:id/articles"],
  ["get", "/api/web-studio/sites/:id/articles/:slug"],
  ["post", "/api/web-studio/sites/:id/articles"],
  ["put", "/api/web-studio/sites/:id/articles/:slug"],
  ["delete", "/api/web-studio/sites/:id/articles/:slug"],
]) {
  assert(block.includes(`app.${verb}('${route}'`), `${verb.toUpperCase()} ${route} is defined`);
}

// ---------- every route is authenticated AND ownership-scoped --------------------------------------
// wsFindSite 404s (never 403s) a site the caller does not own, so a client cannot probe another
// tenant's site ids. Both halves matter: the guard middleware AND the ownership lookup.
const routeLines = block.split('\n').filter((l) => /^app\.(get|post|put|delete)\('\/api\/web-studio/.test(l));
assert(routeLines.length === 5, `all five article routes found (got ${routeLines.length})`);
for (const line of routeLines) {
  assert(/requireClientOrAdmin/.test(line), 'route is behind requireClientOrAdmin: ' + line.slice(0, 70));
}
assert((block.match(/wsFindSite\(req, res\); if \(!site\) return;/g) || []).length === 5,
  'every route resolves the site through the ownership-scoped wsFindSite');

// ---------- the body-size exception ------------------------------------------------------------------
// Article bodies run to hundreds of KB; the 1mb global JSON limit would reject them once escaped.
assert(/const wsArticleJson = express\.json\(\{ limit: '4mb' \}\)/.test(block),
  'article writes mount their own larger JSON parser');
for (const line of routeLines.filter((l) => /app\.(post|put)\(/.test(l))) {
  assert(/wsArticleJson/.test(line), 'write route uses the larger parser: ' + line.slice(0, 70));
}
const mount = src.slice(src.indexOf('// Skip JSON parsing for Stripe webhook'), src.indexOf('// Request logging'));
assert(/WS_ARTICLE_WRITE/.test(mount), 'the global parser skips the article write routes');
assert(/req\.method === 'POST' \|\| req\.method === 'PUT'/.test(mount),
  'ONLY the write verbs skip the global parser — GET/DELETE carry no body and must stay covered');
// Anchored (^...$) and scoped to the articles path — a loose substring match would let some other
// route quietly opt out of the 1mb body limit.
assert(src.includes("const WS_ARTICLE_WRITE = /^\\/api\\/web-studio\\/sites\\/[^/]+\\/articles(?:\\/[^/]+)?$/"),
  'the skip pattern is anchored to the articles path, not a loose substring');

// ---------- guards that protect live content ----------------------------------------------------------
assert(/function wsRequirePlan/.test(block), 'a site without a plan is refused rather than silently given one');
assert(/code: 'NO_PLAN'/.test(block), 'the no-plan refusal carries a machine-readable code');
assert(/Imported sites are static files with no plan/.test(block),
  'the refusal explains what an imported site needs (adoption), not just that it failed');
assert((block.match(/code: 'SLUG_TAKEN'/g) || []).length === 2,
  'both create AND update refuse a slug collision (an update can change the slug too)');
assert(/MAX_ARTICLES/.test(block), 'the per-site article cap is enforced');

// The summary endpoint must not ship every body: a list of 500 articles would be megabytes.
assert(/const wsArticleSummary/.test(block), 'the list endpoint uses a summary projection');
const summary = block.slice(block.indexOf('const wsArticleSummary'), block.indexOf('app.get('));
assert(!/\bhtml\b/.test(summary.replace(/wordCount\(a\.html[^)]*\)|readingMinutes\(a\.html[^)]*\)/g, '')),
  'the summary projection does not include the article body');

// ---------- deletion is explicit and recoverable ----------------------------------------------------------
const del = block.slice(block.indexOf("app.delete('/api/web-studio/sites/:id/articles/:slug'"));
assert(/deleted: removed/.test(del), 'the deleted record is returned so the caller can restore it');
assert(/previous release is still on disk/.test(del), 'the response says the deletion is recoverable');

// ---------- the stuck-build guard ----------------------------------------------------------------------------
// renderPlanToWorkspace CAN throw (a workspace missing src/ throws ENOENT). Without a catch the site
// was left permanently at status:'building' with no error recorded — a dashboard spinner forever.
const apply = block.slice(block.indexOf('async function wsApplyPlanChange'), block.indexOf('function wsRequirePlan'));
assert(/try \{[\s\S]*renderPlanToWorkspace[\s\S]*runBuild[\s\S]*\} catch/.test(apply),
  'render + build are wrapped so a throw cannot strand the site');
assert(/site\.status = 'build_failed'[\s\S]*saveState\('web_studio_sites'[\s\S]*throw e/.test(apply),
  'on a throw the site is marked build_failed, persisted and broadcast before rethrowing');

// A failed write must not persist a partial plan: site.plan is assigned only on success.
assert(/if \(result\.ok\) \{\s*\n\s*site\.plan = plan;/.test(apply),
  'the plan is committed to the site ONLY when the build succeeded');

// ---------- redeploy keeps live and saved in step --------------------------------------------------------------
assert(/if \(opts\.deploy !== false && site\.published && site\.hostingSetup && site\.domain\)/.test(apply),
  'a published site is redeployed after a content change, unless the caller opts out');
assert(/deployWithGate/.test(apply), 'redeploy goes through the gated deploy path');

// Adoption opts out: it changes how the WHOLE site looks, so it must never redecorate a live site
// as a side effect. And because it has already replaced the workspace src/, its plan is persisted
// even when the build fails — otherwise a failed build (the sandbox worker being down, which the
// handoff records happening on the VPS) leaves the old site gone AND no plan to rebuild from.
assert(/opts\.persistPlanOnFailure/.test(apply),
  'a caller can persist the plan across a failed build (adoption needs this to stay recoverable)');
const adopt = src.slice(src.indexOf('//  Adoption — give an imported static site a plan'), src.indexOf('// --- Rebuild from current workspace source'));
assert(adopt.length > 500, 'the adoption block was located');
assert(/\{ deploy: false, persistPlanOnFailure: true \}/.test(adopt),
  'adoption neither deploys nor discards its plan on a failed build');

done();
