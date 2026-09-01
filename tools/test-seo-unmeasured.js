// A dimension the audit FAILED to measure must produce no score, no advice, and no claim.
//
// WHY THIS SUITE EXISTS. On 2026-09-01 DataForSEO began returning HTTP 401 in production. Each agent
// catches its own error, so the promises FULFILLED — with `score = 0`. Nothing downstream could tell
// that zero from a real one, and the consequences compounded:
//   - the composite averaged the survivors and was presented as an overall score
//   - generateExecutiveSummary interpolated "Technical health: 0/100" and, because 0 < 50, added
//     "the site has critical technical issues blocking crawlers and lacks content depth"
//   - generateQuickWins fired every `score < 70` branch, recommending "Fix crawler blocking rules
//     in Cloudflare/server config"
// A real business was handed a specific, confident diagnosis of a site nothing had looked at. The
// wrong number was the least of it; the invented advice was the harm.
//
// The fix makes a failure yield `score: null` and status 'error'. THE TRAP THIS SUITE EXISTS TO
// CATCH: in JavaScript `null < 70` is TRUE, because null coerces to 0. So switching 0 → null does
// NOT by itself stop any of the branches above — every consumer needs an explicit
// `typeof === 'number'` guard, and a future edit that writes `x < n` again reintroduces the whole
// defect silently. Each assertion below therefore checks the OUTPUT TEXT, not the score field.
'use strict';

const vm = require('vm');
const { assert, done, readRepoFile } = require('./test-util');

const server = readRepoFile('server.js');

function grabFn(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  return null;
}

const summarySrc = grabFn(server, 'generateExecutiveSummary');
const winsSrc = grabFn(server, 'generateQuickWins');
assert(!!summarySrc && /compositeScore/.test(summarySrc), 'located generateExecutiveSummary and it really reads the composite');
assert(!!winsSrc && /quickWins|wins\.push/.test(winsSrc), 'located generateQuickWins and it really builds recommendations');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${summarySrc}\n${winsSrc}`, ctx);

/** An audit whose classic-SEO dimensions all failed (the live 401 shape): AEO scored, rest null. */
const failedAudit = (over = {}) => ({
  domain: 'example.com',
  compositeScore: 14,
  unmeasured: ['keyword', 'technical', 'competitor', 'content', 'backlink'],
  agents: {
    keyword: { status: 'error', score: null }, technical: { status: 'error', score: null },
    competitor: { status: 'error', score: null }, content: { status: 'error', score: null },
    backlink: { status: 'error', score: null }, aeo: { status: 'complete', score: 14 },
    local: { status: 'skipped', score: null, applicable: false },
  },
  ...over,
});

// --- the executive summary must not describe what it did not measure -------------------------------
const s = ctx.generateExecutiveSummary(failedAudit());
assert(!/Technical health: 0\/100/.test(s) && !/Content quality: 0\/100/.test(s) && !/Backlink profile: 0\/100/.test(s),
  'no "0/100" is reported for a dimension that was never measured');
assert(!/critical technical issues blocking crawlers/.test(s),
  'and no invented diagnosis — the "blocking crawlers" claim is not made about an unmeasured site');
assert(/could not be analysed|could not run|only part of the picture/i.test(s),
  'the summary SAYS that dimensions are missing rather than quietly omitting them');
assert(s.includes('keyword') && s.includes('backlink'),
  'and names which ones, so the reader can tell what is absent');

// The AEO dimension DID measure, so it may still be cited.
const measured = ctx.generateExecutiveSummary({
  domain: 'x.test', compositeScore: 60, unmeasured: [],
  agents: { technical: { score: 55 }, content: { score: 62 }, backlink: { score: 70 }, aeo: { score: 60 } },
});
assert(/Technical health: 55\/100/.test(measured) && /Backlink profile: 70\/100/.test(measured),
  'a fully measured audit still reports every dimension exactly as before');
assert(!/could not be analysed/i.test(measured), 'and carries no missing-data caveat when nothing is missing');

// A REAL zero is a measurement and must still be reported as 0/100 — the opposite failure.
const realZero = ctx.generateExecutiveSummary({
  domain: 'z.test', compositeScore: 20, unmeasured: [],
  agents: { technical: { score: 0 }, content: { score: 30 }, backlink: { score: 30 }, aeo: { score: 20 } },
});
assert(/Technical health: 0\/100/.test(realZero),
  'a genuine score of 0 IS reported as 0/100 — suppressing it would be the mirror-image bug');

// Nothing measured at all: make no claim whatsoever about the site.
const nothing = ctx.generateExecutiveSummary({
  domain: 'n.test', compositeScore: null, unmeasured: ['keyword', 'technical', 'competitor', 'content', 'backlink', 'aeo'],
  agents: { technical: { score: null }, content: { score: null }, backlink: { score: null } },
});
assert(/could not be audited/i.test(nothing), 'a total failure says the audit could not run');
assert(/not a finding about the site/i.test(nothing), 'and explicitly disclaims being a judgement of the site');
assert(!/\d+\/100/.test(nothing), 'and quotes no score of any kind');

// --- quick wins must not recommend fixes for unmeasured dimensions ---------------------------------
// THE `null < 70` TRAP. These four branches all fired before the guard, because null coerces to 0.
const wins = ctx.generateQuickWins(failedAudit());
const actions = wins.map((w) => w.action).join(' | ');
assert(!/Fix crawler blocking rules/.test(actions),
  'no "fix crawler blocking rules" advice for a technical dimension that never ran');
assert(!/Submit updated XML sitemap/.test(actions), 'no sitemap advice from an unmeasured technical score');
assert(!/unique meta descriptions/.test(actions), 'no meta-description advice from an unmeasured content score');
assert(!/301 redirects/.test(actions), 'no redirect advice from an unmeasured backlink score');

// The score-independent wins are still offered — the guard must not empty the list entirely.
assert(/LocalBusiness schema/.test(actions) && /title tags/.test(actions),
  'the recommendations that depend on NO measurement are still offered');

// And a genuinely low measured score still triggers its advice.
const lowWins = ctx.generateQuickWins({
  domain: 'l.test', compositeScore: 30, unmeasured: [],
  agents: { technical: { score: 40 }, content: { score: 40 }, backlink: { score: 40 }, local: { score: 90, applicable: true }, aeo: { score: 30 } },
}).map((w) => w.action).join(' | ');
assert(/Fix crawler blocking rules/.test(lowWins) && /unique meta descriptions/.test(lowWins) && /301 redirects/.test(lowWins),
  'a REAL low score still produces every one of those recommendations — the guard blocks absence, not badness');

// Boundary: a measured 0 is the lowest real score and must behave like 40, not like null.
const zeroWins = ctx.generateQuickWins({
  domain: '0.test', compositeScore: 0, unmeasured: [],
  agents: { technical: { score: 0 }, content: { score: 0 }, backlink: { score: 0 }, aeo: { score: 0 } },
}).map((w) => w.action).join(' | ');
assert(/Fix crawler blocking rules/.test(zeroWins),
  'a measured 0 still triggers its recommendation — 0 is a finding, null is not');

// --- the source-level guard itself ------------------------------------------------------------------
// A future edit reverting to a bare `<` reintroduces everything above. Pin the shape, not just the
// behaviour, because this is the exact line that was wrong.
assert(!/audit\.agents\.(technical|content|backlink)\.score\s*<\s*\d/.test(winsSrc),
  'generateQuickWins compares scores through a guard, never with a bare `score < n` (null < n is TRUE)');

// The agents themselves must null their score on failure rather than inventing a zero.
const zeroOnCatch = (server.match(/^\s{4}score = 0;$/gm) || []).length;
assert(zeroOnCatch === 0,
  `no agent sets score = 0 in a failure path (found ${zeroOnCatch}) — that is the fabricated zero this whole suite is about`);
assert((server.match(/^\s{4}score = null;$/gm) || []).length >= 5,
  'all five DataForSEO agents null their score on failure');

// And runRealSeoAudit must classify a scoreless-but-fulfilled agent as an error, not a completion.
const runner = grabFn(server, 'runRealSeoAudit');
assert(!!runner, 'located runRealSeoAudit');
assert(/const measured = result\.value\.score != null/.test(runner),
  'runRealSeoAudit decides completion on whether a score came back, not on the promise resolving');
assert(/status = !applicable \? 'skipped' : \(measured \? 'complete' : 'error'\)/.test(runner),
  'and maps that to three distinct statuses');
assert(/typeof s === 'number'/.test(runner),
  'the composite is averaged over measured scores only — `> 0` would discard a genuine zero too');

done();
