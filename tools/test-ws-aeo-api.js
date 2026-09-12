// The AEO compliance routes. Repo convention: read server.js as text; the behaviour was proven by
// a live probe against the real server with the REAL rebuilt Truth Counters build in the workspace
// (21 pages, score 66/B, 15 fixes proposed) and the results are in the commit message.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const block = src.slice(src.indexOf('//  AEO / SEO compliance'), src.indexOf('// --- Rebuild from current workspace source'));
assert(block.length > 800, 'the AEO block was located in server.js');

assert(block.includes("app.get('/api/web-studio/sites/:id/aeo'"), 'the audit route exists');
assert(block.includes("app.post('/api/web-studio/sites/:id/aeo/fix'"), 'the fix route exists');
for (const line of block.split('\n').filter((l) => /^app\.(get|post)\('\/api\/web-studio/.test(l))) {
  assert(/requireClientOrAdmin/.test(line), 'route is authenticated: ' + line.slice(0, 64));
}
assert((block.match(/wsFindSite\(req, res\); if \(!site\) return;/g) || []).length === 2,
  'both routes resolve the site through the ownership-scoped wsFindSite');

// ---------- what gets audited ----------------------------------------------------------------------
// The BUILT html, not the plan: the score should be the one a crawler would actually compute.
assert(/function wsAuditSource/.test(block), 'the audit source resolver exists');
assert(/path\.join\(ws, 'dist'\)/.test(block), 'dist/ is the primary source');
assert(/WS_SITES_ROOT, site\.domain, 'current'/.test(block), 'the live release is available as a source');
assert(/code: 'NO_BUILD'/.test(block), 'a site with nothing built is refused with a machine-readable code');
assert(/build the site first/.test(block), 'the refusal says what to do about it');

// An imported site with no plan can still be AUDITED — it just cannot have fixes written back.
assert(/fixable: !!plan/.test(block), 'auditing does not require a plan');
assert(/Adopt it first/.test(block), 'the un-fixable case explains why and what to do');

// ---------- the injection guard --------------------------------------------------------------------
// A proposal carries a before/after pair. If the route trusted the CLIENT's copy of that pair, a
// caller could write arbitrary text into the plan through an endpoint that only claims to apply its
// own computed fixes. The route therefore re-derives proposals server-side and accepts only ids.
const fix = block.slice(block.indexOf("app.post('/api/web-studio/sites/:id/aeo/fix'"));
assert(/const proposals = webStudioAeo\.proposeFixes\(plan, webStudioAeo\.auditSite\(files\), files\)/.test(fix),
  'the fix route RE-DERIVES proposals rather than trusting the request');
assert(/applyFixes\(plan, proposals, ids\)/.test(fix), 'only ids come from the caller');
assert(!/req\.body\.(after|before|fixes)\b/.test(fix), 'no fix CONTENT is read from the request body');
assert(/Array\.isArray\(\(req\.body \|\| \{\}\)\.ids\)/.test(fix), 'ids must be an array');
assert(/select at least one fix/.test(fix), 'an empty selection is refused with an explanation');

// ---------- applying is a real content change ---------------------------------------------------------
assert(/wsApplyPlanChange\(site, next\)/.test(fix), 'applying re-renders and rebuilds like any content edit');
assert(/none of the selected fixes could be applied/.test(fix), 'a wholly failed apply is reported, not silently 200');
assert(/may have changed since the audit/.test(fix), 'and it explains the likely cause');

done();
