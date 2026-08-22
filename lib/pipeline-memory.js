// lib/pipeline-memory.js
// ============================================================
//  The docx's "compounding memory": a run reads what previous runs of the SAME pipeline learned.
//
//  WHAT IS INJECTED, AND WHY SO LITTLE. Only OUTCOMES — which stages failed on recent runs and the
//  reason recorded in the manifest. Deliberately not past outputs:
//    - Cost and context. A stage prompt already carries every upstream deliverable from the current
//      run (`inputsFor` + `clipStageOutput`). Appending prior runs' content would multiply the
//      prompt by the number of remembered runs, and stage agents run at high effort.
//    - Signal. "The last two runs of this stage failed with a 120s timeout" changes what an agent
//      does. "Here is a report we wrote in July" mostly does not, and invites the agent to copy it.
//  So memory here means "what went wrong before", which is the actionable half of the docx's
//  "remembers what worked and what failed".
//
//  SCOPED TO THE STAGE. A stage hears about ITS OWN history, not the whole pipeline's. The
//  `compile` stage does not benefit from knowing that `research` once timed out, and a prompt that
//  lists every stage's history is one nobody reads — the same reason the seclint rules restrict
//  what they report.
//
//  IT CANNOT FABRICATE. Everything comes from `run.json` manifests written by pipeline-trail. If
//  there is no history, this returns '' and the prompt is unchanged — memory is additive, and a
//  pipeline with no past must behave exactly as it does today.
// ============================================================

const trail = require('./pipeline-trail.js');

/** Keep prompts bounded: how many past runs to consider, and how much of an error to quote. */
const MAX_RUNS = 5;
const MAX_NOTES = 3;
const MAX_REASON = 160;

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_REASON ? t.slice(0, MAX_REASON - 1) + '…' : t;
};

/**
 * ENVIRONMENTAL failures carry no lesson for the agent, so they are NOT remembered.
 *
 * Found in the real trail, not imagined: run-1786164291515 failed with "You have reached your
 * specified API usage limits. You will regain access on 2026-09-01". Injecting that would tell an
 * agent it failed before and advise a "tighter deliverable" — advice that is actively WRONG, since
 * nothing about the work caused the failure and nothing about the work can prevent it. The account
 * was out of credit.
 *
 * The distinction that matters is whether the STAGE could have done anything differently. A timeout
 * or an oversized output is a lesson. A spend cap, a provider outage or a network drop is weather.
 */
const ENVIRONMENTAL = /usage limits?|rate.?limit|quota|insufficient (credit|funds)|billing|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|503|502|overloaded|service unavailable/i;
const isEnvironmental = (err) => ENVIRONMENTAL.test(String(err || ''));

/**
 * Notes for ONE stage, drawn from recent runs of the same pipeline.
 *
 * @param {string} baseDir      the runs directory (PIPELINE_RUNS_DIR)
 * @param {object} opts
 * @param {string} opts.pipeline   pipeline name — history is per-pipeline, never global
 * @param {string} opts.stageId    the stage about to run
 * @param {string} [opts.excludeRunId]  the CURRENT run, which is not its own history
 * @returns {string} a short prompt fragment, or '' when there is nothing worth saying
 */
function priorStageNotes(baseDir, { pipeline, stageId, excludeRunId } = {}) {
  if (!baseDir || !pipeline || !stageId) return '';

  let runs;
  try { runs = trail.listRuns(baseDir) || []; } catch { return ''; }

  const recent = runs
    .filter((r) => r && r.pipeline === pipeline && r.id !== excludeRunId)
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))
    .slice(0, MAX_RUNS);

  const notes = [];
  for (const r of recent) {
    let m;
    try { m = trail.readManifest(baseDir, r.id); } catch { continue; }
    const st = m && (m.stages || []).find((s) => s.id === stageId);
    if (!st) continue;
    // Only FAILURES carry a lesson. A stage that succeeded five times running needs no reminder,
    // and saying so would crowd out the one line that matters.
    if (st.status === 'failed' || st.error) {
      if (isEnvironmental(st.error)) continue;   // weather, not a lesson — see isEnvironmental
      notes.push(`- run ${r.id}: ${st.status}${st.error ? ` — ${clip(st.error)}` : ''}`);
    }
    if (notes.length >= MAX_NOTES) break;
  }

  if (!notes.length) return '';
  return `\nThis stage has failed before, on previous runs of this pipeline:\n${notes.join('\n')}\n`
    + 'Take that into account — do not repeat the same failure. If the cause was a timeout or a size '
    + 'limit, produce a tighter deliverable rather than a longer one.\n';
}

module.exports = { priorStageNotes, MAX_RUNS, MAX_NOTES, MAX_REASON };
