// The repair tool for audits that recorded a DataForSEO outage as findings about a customer's site.
//
// THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT NOT ACTING. This tool rewrites stored customer
// records, and it identifies its targets partly by PROSE, because the structured signal that would
// identify a failed dimension is precisely what those records lack — its absence is the defect. A
// tool like that is far more dangerous when it over-matches than when it under-matches: erasing a
// real 0/100 finding destroys a true result and the customer never learns it was there. So the
// suite spends most of its weight on shapes that must be left ALONE, and the failure direction is
// deliberately asymmetric — under-matching leaves a bad record for a human to notice, over-matching
// silently destroys a good one.
'use strict';

const { assert, done } = require('./test-util');
const { isFabricatedFailure, repairAudit, repairAll, SCORE_DERIVED_WINS } = require('./seo-audit-repair');

const failedAgent = (over = {}) => ({
  status: 'complete', score: 0,
  findings: [{ severity: 'critical', issue: 'Keyword research failed: DataForSEO HTTP 401', recommendation: 'Verify DataForSEO credentials and API credits.' }],
  ...over,
});

// --- what MUST be repaired -------------------------------------------------------------------------
assert(isFabricatedFailure(failedAgent()), 'a status-complete, score-0 dimension carrying its own "failed:" finding is fabricated');

// --- what MUST BE LEFT ALONE (the dangerous direction) ---------------------------------------------
assert(!isFabricatedFailure({ status: 'complete', score: 0, findings: [{ severity: 'critical', issue: 'No organic rankings found for example.com', recommendation: 'Start with keyword research.' }] }),
  'a GENUINE 0 with a real finding is NOT touched — this is the case that must never be destroyed');
assert(!isFabricatedFailure({ status: 'complete', score: 0, findings: [] }),
  'a score of 0 with no findings at all is not evidence of failure — left alone');
assert(!isFabricatedFailure({ status: 'complete', score: 42, findings: [{ issue: 'Something failed: x', recommendation: 'DataForSEO' }] }),
  'a dimension with a REAL score is never repaired, whatever its findings say');
assert(!isFabricatedFailure({ status: 'error', score: null, findings: [{ issue: 'failed: x', recommendation: 'DataForSEO' }] }),
  'an already-correct record is not re-repaired (idempotence at the dimension level)');
assert(!isFabricatedFailure({ status: 'skipped', score: null, findings: [] }), 'a skipped dimension is not a failure');
assert(!isFabricatedFailure({ status: 'complete', score: 0, findings: [{ issue: 'Crawl failed: timeout', recommendation: 'Retry the audit.' }] }),
  'a failure finding that does NOT name DataForSEO is out of scope — both signals are required');
assert(!isFabricatedFailure(null) && !isFabricatedFailure(undefined) && !isFabricatedFailure('x'),
  'malformed input is not a match');

// --- the record-level transform --------------------------------------------------------------------
const dirty = () => ({
  id: 'a1', domain: 'example.com', email: 'lead@example.com', source: 'free', status: 'complete',
  compositeScore: 14,
  executiveSummary: 'example.com scores 14/100 overall (critical). Technical health: 0/100 — the site has critical technical issues blocking crawlers.',
  quickWins: [
    { priority: 1, action: 'Fix crawler blocking rules in Cloudflare/server config' },
    { priority: 3, action: 'Add unique meta descriptions to all service pages' },
    { priority: 5, action: 'Add LocalBusiness schema markup to homepage' },
    { priority: 6, action: 'Optimize title tags with primary keyword + location' },
  ],
  agents: {
    keyword: failedAgent(), technical: failedAgent(), competitor: failedAgent(),
    content: failedAgent(), backlink: failedAgent(),
    aeo: { status: 'complete', score: 14, findings: [{ severity: 'info', issue: 'AEO Readiness 14/100' }] },
    local: { status: 'skipped', score: null, findings: [] },
  },
});

const before = dirty();
const r = repairAudit(before);
assert(r.changed === true, 'the outage audit is identified as needing repair');
assert(r.repaired.join(',') === 'keyword,technical,competitor,content,backlink', 'exactly the five failed dimensions are repaired');

assert(Object.values(r.audit.agents).filter((a) => a.status === 'error').length === 5, 'the five become status error');
assert(r.repaired.every((n) => r.audit.agents[n].score === null), 'and their scores become null, not 0');
assert(r.audit.agents.aeo.score === 14 && r.audit.agents.aeo.status === 'complete', 'the dimension that DID measure is untouched');
assert(r.audit.agents.local.status === 'skipped', 'and a skipped dimension stays skipped');
assert(r.audit.agents.keyword.findings.length === 1,
  'the failure FINDINGS are kept — they say the call failed, which is true and is the only honest record of it');

assert(r.audit.compositeScore === 14, 'the composite is recomputed from the measured dimensions only (aeo=14)');
assert(r.audit.unmeasured.join(',') === 'keyword,technical,competitor,content,backlink', 'unmeasured is populated');

assert(!/critical technical issues blocking crawlers/.test(r.audit.executiveSummary), 'the fabricated diagnosis is gone from the summary');
assert(!/0\/100/.test(r.audit.executiveSummary), 'and no 0/100 claim survives');
assert(/Nothing here is a judgement of example\.com/i.test(r.audit.executiveSummary),
  'the replacement explicitly disclaims being a judgement of the site, and names the domain so it cannot be read generically');
assert(/were not\b/.test(r.audit.executiveSummary),
  'and says outright that the previous findings were not findings about the site');
assert(/could not be completed/i.test(r.audit.executiveSummary), 'and says the audit did not complete');

const actions = r.audit.quickWins.map((w) => w.action);
assert(!actions.some((a) => SCORE_DERIVED_WINS.includes(a)), 'every score-derived recommendation is removed');
assert(actions.includes('Add LocalBusiness schema markup to homepage') && actions.includes('Optimize title tags with primary keyword + location'),
  'the recommendations that depend on NO measurement are kept — the repair is not a blanket wipe');

// PURITY: a dry run must not mutate what it is only reporting on.
assert(before.compositeScore === 14 && before.agents.keyword.score === 0 && /blocking crawlers/.test(before.executiveSummary),
  'repairAudit does not mutate its input — the dry-run path reports without changing anything');

// IDEMPOTENCE, mechanically: the repaired record no longer matches.
assert(repairAudit(r.audit).changed === false, 're-running over a repaired record is a no-op');

// --- an audit with nothing measured at all ---------------------------------------------------------
const allFailed = repairAudit({
  id: 'a2', domain: 'z.test',
  agents: { keyword: failedAgent(), technical: failedAgent() },
  compositeScore: 0, quickWins: [], executiveSummary: 'z.test scores 0/100 overall (critical).',
});
assert(allFailed.audit.compositeScore === null, 'with nothing measured the composite becomes null, not 0');
assert(!/\d+\/100/.test(allFailed.audit.executiveSummary), 'and the summary quotes no score at all');

// --- a HEALTHY audit must pass through completely untouched ----------------------------------------
const healthy = {
  id: 'a3', domain: 'good.test', compositeScore: 82,
  executiveSummary: 'good.test scores 82/100 overall (good).',
  quickWins: [{ priority: 1, action: 'Fix crawler blocking rules in Cloudflare/server config' }],
  agents: { keyword: { status: 'complete', score: 80, findings: [] }, technical: { status: 'complete', score: 84, findings: [] } },
};
const h = repairAudit(healthy);
assert(h.changed === false, 'a healthy audit is not touched');
assert(h.audit === healthy, 'and is returned by reference — no needless rewrite of good data');
assert(h.audit.quickWins.length === 1,
  'in particular its score-derived recommendation SURVIVES: those are only stripped from audits that failed');

// --- the array-level pass ---------------------------------------------------------------------------
const { audits, report } = repairAll([dirty(), healthy, dirty()]);
assert(audits.length === 3, 'every audit is returned, repaired or not');
assert(report.length === 2, 'and only the broken ones are reported');
assert(report[0].email === 'lead@example.com', 'the report carries the lead email, for the CRM follow-up the tool deliberately does not do');
assert(audits[1] === healthy, 'the healthy record in the middle is passed through by reference');
assert(repairAll([]).report.length === 0 && repairAll(null).audits.length === 0, 'empty and malformed input are handled without throwing');

// --- the one thing repairing cannot undo -----------------------------------------------------------
// A fabricated report that was EMAILED is in a real person's inbox, and rewriting the stored record
// does not reach it. The record is also the only evidence of what was sent, so this has to be
// surfaced BEFORE the repair, not discovered after it.
const emailed = { ...dirty(), emailedTo: [{ to: 'real@customer.test', at: '2026-09-01T04:00:00.000Z' }] };
const er = repairAll([emailed]).report[0];
assert(Array.isArray(er.emailedTo) && er.emailedTo.length === 1, 'the report surfaces that an affected audit was emailed');
assert(er.emailedTo[0].to === 'real@customer.test', 'and to whom');
assert(er.emailedTo[0].at === '2026-09-01T04:00:00.000Z', 'and when');
assert(repairAll([dirty()]).report[0].emailedTo.length === 0,
  'an audit that was never emailed reports an empty list, not undefined — the CLI branches on length');
// The repaired record must KEEP emailedTo: it is the evidence of what was sent to whom.
const keptRecord = repairAudit(emailed).audit;
assert(Array.isArray(keptRecord.emailedTo) && keptRecord.emailedTo.length === 1,
  'and repairing PRESERVES emailedTo — erasing the record of a send would destroy the evidence of it');

done();
