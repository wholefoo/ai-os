#!/usr/bin/env node
// tools/seo-audit-repair.js
// ============================================================
//  Repairs stored SEO audits that recorded a DataForSEO OUTAGE as findings about a customer's site.
//
//  WHAT WENT WRONG. Each DataForSEO agent catches its own error, so a failed call FULFILLED its
//  promise with `score = 0`. Nothing downstream could tell that from a measured zero, so the audit
//  was finalised as if it had run: the composite averaged the survivors, generateExecutiveSummary
//  emitted "Technical health: 0/100 ... the site has critical technical issues blocking crawlers",
//  and generateQuickWins fired every `score < 70` branch and recommended specific remediation.
//  `5846b67` fixed that going forward — but `executiveSummary` and `quickWins` are computed ONCE at
//  finalise time and STORED on the record, so every audit taken during the outage still carries the
//  invented text. `/api/seo/free-audit/<id>` is public and needs no auth, so a lead who kept their
//  result link can still read a confident diagnosis of a site nothing ever looked at.
//
//  WHY THIS MATCHES ON PROSE, which this repo otherwise treats as an antipattern. The structured
//  signal that would identify a failed dimension — `score: null`, `status: 'error'` — is exactly
//  what these records lack; its absence IS the defect being repaired. There is no flag to read, so
//  the only evidence available is the failure finding each agent wrote about itself. To keep that as
//  narrow as possible a dimension must match on BOTH counts before it is touched:
//    1. the structural shape: status 'complete' AND score === 0
//    2. the agent's own failure text: "<something> failed: <error>" with a DataForSEO recommendation
//  A genuine zero has neither. Going forward no new record can need this tool, because the status is
//  now structural — this is a one-off for data written by code that no longer exists.
//
//  WHAT IT DOES NOT DO. It does not touch the CRM. `crm.attachAudit` wrote the fabricated composite
//  onto the contact record in `.magent/crm.sqlite`, a different store with a different shape, and
//  quietly rewriting a customer database is not something a repair script should do unasked. The
//  affected emails are PRINTED instead, for a deliberate decision.
//
//  SAFETY. Dry run is the default and `--apply` is required to write anything. Applying takes a
//  timestamped backup of the state file first. The transform is idempotent: a repaired record no
//  longer matches (its scores are null and its status is 'error'), so re-running is a no-op.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAGENT_DIR = path.join(ROOT, '.magent');
// MUST match server.js's STATE_DIR, including the AIOS_STATE_SUBDIR override the test suites use.
const STATE_SUBDIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(process.env.AIOS_STATE_SUBDIR || '')
  ? process.env.AIOS_STATE_SUBDIR
  : 'state';
const STATE_DIR = path.join(MAGENT_DIR, STATE_SUBDIR);
const KEY = 'seo_audits';

/** The four quick-wins generateQuickWins derives from a dimension score. Only these are removed —
 *  the schema-markup and title-tag entries depend on no measurement and stay valid. Kept as exact
 *  literals copied from server.js; if they drift the tool simply removes nothing, which is the safe
 *  direction to fail. */
const SCORE_DERIVED_WINS = Object.freeze([
  'Fix crawler blocking rules in Cloudflare/server config',
  'Submit updated XML sitemap to Google Search Console',
  'Add unique meta descriptions to all service pages',
  'Set up 301 redirects for backlinks pointing to 404 pages',
]);

/** The self-description each failing agent wrote: "Keyword research failed: …", "Technical audit
 *  failed: …", "Competitor analysis failed: …", "Content analysis failed: …", "Backlink analysis
 *  failed: …". Anchored on " failed:" plus the DataForSEO recommendation so an unrelated finding
 *  that happens to contain the word cannot match. */
const FAILURE_ISSUE = /\bfailed:/i;
const FAILURE_RECO = /dataforseo/i;

/** Did this dimension record an outage as a measurement? Both the structural shape and the agent's
 *  own failure text must agree before anything is rewritten. */
function isFabricatedFailure(agent) {
  if (!agent || typeof agent !== 'object') return false;
  if (agent.status !== 'complete') return false;   // already 'error'/'skipped' → nothing to repair
  if (agent.score !== 0) return false;             // a real score, including a real 0 with no failure finding
  const findings = Array.isArray(agent.findings) ? agent.findings : [];
  return findings.some((f) => f && FAILURE_ISSUE.test(String(f.issue || '')) && FAILURE_RECO.test(String(f.recommendation || '')));
}

/**
 * Rewrite one audit into what today's code would have produced. Returns
 * `{ changed, audit, repaired: [names] }`; `audit` is a NEW object when changed, so a dry run cannot
 * mutate what it is only reporting on.
 */
function repairAudit(audit) {
  if (!audit || typeof audit !== 'object' || !audit.agents) return { changed: false, audit, repaired: [] };

  const repaired = Object.keys(audit.agents).filter((n) => isFabricatedFailure(audit.agents[n]));
  if (!repaired.length) return { changed: false, audit, repaired: [] };

  const agents = {};
  for (const [name, a] of Object.entries(audit.agents)) {
    agents[name] = repaired.includes(name)
      // Null, not 0 — the whole point. Findings are KEPT: they say the call failed, which is true and
      // is the only honest record of what happened.
      ? { ...a, score: null, status: 'error' }
      : { ...a };
  }

  const measured = Object.values(agents).map((a) => a.score).filter((s) => typeof s === 'number');
  const unmeasured = Object.keys(agents).filter((n) => agents[n].status === 'error');

  // Replaced rather than regenerated. generateExecutiveSummary lives in server.js and is not
  // exported, and requiring server.js boots an Express app, a websocket server and cron jobs — see
  // the same note in tools/library-migrate.js. Reimplementing it here would put the wording in two
  // places and let them drift, so this states plainly what happened instead of imitating a summary.
  const summary = `This audit could not be completed: ${unmeasured.length} of ${Object.keys(agents).length} `
    + `analysis dimensions (${unmeasured.join(', ')}) failed to return data. `
    + `The previous version of this report presented those failures as findings about the site — they were not. `
    + `Nothing here is a judgement of ${audit.domain || 'the site'}. Please run a fresh audit.`;

  return {
    changed: true,
    repaired,
    audit: {
      ...audit,
      agents,
      unmeasured,
      compositeScore: measured.length ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null,
      executiveSummary: summary,
      quickWins: (Array.isArray(audit.quickWins) ? audit.quickWins : []).filter((w) => !SCORE_DERIVED_WINS.includes(w && w.action)),
      repairedAt: new Date().toISOString(),
    },
  };
}

/** Map over a whole seo_audits array. Pure — returns a new array plus a report. */
function repairAll(audits) {
  const list = Array.isArray(audits) ? audits : [];
  const report = [];
  const out = list.map((a) => {
    const r = repairAudit(a);
    if (r.changed) {
      report.push({
        id: a.id, domain: a.domain, email: a.email || null, source: a.source || null,
        repaired: r.repaired, wasComposite: a.compositeScore,
        // THE ONE THING THIS TOOL CANNOT UNDO. `POST /api/seo/audit/:id/email-lead` is admin-only
        // and operator-clicked, so a fabricated report only left the building if someone pressed
        // send — but if they did, it is in a real person's inbox and no amount of state repair
        // reaches it. Surfaced per-audit so that possibility is decided about rather than assumed
        // away. Each entry is { to, at }.
        emailedTo: Array.isArray(a.emailedTo) ? a.emailedTo : [],
      });
    }
    return r.audit;
  });
  return { audits: out, report };
}

// ---- CLI ------------------------------------------------------------------------------------------

function main() {
  const apply = process.argv.includes('--apply');
  const file = path.join(STATE_DIR, `${KEY}.json`);

  if (!fs.existsSync(file)) {
    console.error(`No state file at ${file} — nothing to repair.`);
    process.exit(1);
  }

  let audits;
  try {
    audits = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`REFUSING TO RUN: ${file} does not parse as JSON (${e.message}). Fix or restore it first.`);
    process.exit(1);
  }
  if (!Array.isArray(audits)) {
    console.error(`REFUSING TO RUN: ${file} is not an array.`);
    process.exit(1);
  }

  const { audits: repairedAudits, report } = repairAll(audits);

  console.log(`\nseo-audit-repair — ${audits.length} stored audit(s) scanned\n`);
  if (!report.length) {
    console.log('  Nothing to repair: no audit records an outage as a measurement.\n');
    return;
  }

  for (const r of report) {
    console.log(`  ${r.id}  ${r.domain}`);
    console.log(`      source=${r.source}  composite ${r.wasComposite} -> recomputed`);
    console.log(`      dimensions repaired: ${r.repaired.join(', ')}`);
    if (r.email) console.log(`      lead: ${r.email}`);
    if (r.emailedTo.length) {
      console.log(`      *** ALREADY EMAILED — repairing this record does NOT reach that inbox:`);
      for (const e of r.emailedTo) console.log(`          -> ${e.to} at ${e.at}`);
    }
  }

  const emails = [...new Set(report.map((r) => r.email).filter(Boolean))];
  const wereEmailed = report.filter((r) => r.emailedTo.length);
  console.log(`\n  ${report.length} audit(s) would be repaired.`);
  if (wereEmailed.length) {
    console.log(`\n  *** ${wereEmailed.length} of them WERE EMAILED to a real recipient. A fabricated report`);
    console.log(`      is sitting in an inbox and this tool cannot retract it. Decide whether to send a`);
    console.log(`      correction BEFORE repairing the record, because the record is the evidence of`);
    console.log(`      what was sent.`);
  } else {
    console.log(`  None of them were ever emailed — the fabricated text never left the server.`);
  }
  if (emails.length) {
    console.log(`\n  CRM NOT TOUCHED — crm.attachAudit wrote the fabricated composite onto these contacts.`);
    console.log(`  Correct them deliberately, in .magent/crm.sqlite:`);
    for (const e of emails) console.log(`    - ${e}`);
  }

  if (!apply) {
    console.log(`\n  DRY RUN. Nothing was written. Re-run with --apply to write.\n`);
    return;
  }

  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repairedAudits, null, 2));
  fs.renameSync(tmp, file); // atomic replace, matching server.js's saveState
  console.log(`\n  Backup: ${backup}`);
  console.log(`  Written: ${file}`);
  console.log(`  Restart the app so it reloads state:  sudo -iu aios pm2 restart ai-os --update-env\n`);
}

if (require.main === module) main();

module.exports = { isFabricatedFailure, repairAudit, repairAll, SCORE_DERIVED_WINS };
