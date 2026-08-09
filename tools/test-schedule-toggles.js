// A paused schedule must STAY paused across a restart.
//
// THE DEFECT. `PUT /api/schedules/:id/toggle` flipped `enabled` in memory and nothing wrote it
// down: `persistAllState` never included schedules, and the four definitions are re-created from
// code on every boot with `enabled` defaulting to true. So every deploy silently re-enabled
// everything an operator had deliberately paused, and nothing reported that it had happened.
//
// Found on 2026-08-09 while pausing all four schedules for the duration of the Anthropic account
// limit — a three-week pause that the next restart would have quietly undone. Same class as the
// rest of this repo's recurring bugs: an action that appears to succeed, reverts silently, and
// leaves no evidence that it reverted.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();

// --- only the FLAG is persisted, never the definition ------------------------------------------------
const saver = (src.match(/function saveScheduleToggles\(\)[\s\S]*?\n\}/) || [''])[0];
assert(saver.length > 0, 'saveScheduleToggles is defined');
assert(/map\[s\.id\] = !!s\.enabled;/.test(saver), 'it writes a flat {id: boolean} map');
assert(/saveState\('schedule_toggles', map\)/.test(saver), 'under its own state key');
// The definitions (cron, agent, skill, description) are CODE. Persisting them would resurrect a
// stale cron or a renamed skill after the code moved on — the same "half an old graph, half a new
// one" hazard that pipeline resume refuses. If this ever fails, someone has started writing the
// whole schedule object to disk.
for (const field of ['cron', 'agent', 'skill', 'description', '_job']) {
  assert(!new RegExp(`\\b${field}\\b`).test(saver), `and never persists \`${field}\` — that is code, not operator state`);
}

// --- restore is defensive about what it finds on disk --------------------------------------------------
const restore = (src.match(/const saved = loadState\('schedule_toggles'[\s\S]*?\n\}\)\(\);/) || [''])[0];
assert(restore.length > 0, 'the restore block exists');
assert(/if \(!sched \|\| typeof enabled !== 'boolean' \|\| sched\.enabled === enabled\) continue;/.test(restore),
  'it skips ids that no longer exist, non-boolean values, and no-op changes — a stale toggle file must not crash a boot');
assert(/sched\._job/.test(restore) && /\.start\(\)/.test(restore) && /\.stop\(\)/.test(restore),
  'and actually starts/stops the cron job, not just the flag — a flag alone would leave the job firing');
assert(/nextRun = enabled \? getNextRun\(sched\.cron\) : null/.test(restore),
  'and clears nextRun when paused, so the UI does not advertise a run that will not happen');
assert(/console\.log\(`\[SCHEDULE\] restored/.test(restore),
  'and SAYS which schedules it changed — a silent restore is how the original bug stayed invisible');

// --- the toggle route persists IMMEDIATELY ---------------------------------------------------------------
const route = (src.match(/app\.put\('\/api\/schedules\/:id\/toggle'[\s\S]*?\n\}\);/) || [''])[0];
assert(route.length > 0, 'the toggle route exists');
assert(/saveScheduleToggles\(\);/.test(route), 'and persists the change');
// Immediately, not via persistAllState on shutdown: that only runs on a graceful SIGTERM, so a crash
// or a hard restart would undo a deliberate pause with no trace.
//
// Scan EXECUTABLE lines only. The route carries a comment explaining why persistAllState is the
// wrong mechanism here, and a naive scan flags the very documentation that prevents the regression —
// the same trap tools/test-deploy-determinism.js already had to solve for `npm install`.
const routeCode = route.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
assert(!/persistAllState/.test(routeCode), 'in the route itself, not deferred to shutdown');
assert(/persistAllState/.test(route),
  'and the comment saying why persistAllState is NOT used survives — that reasoning is what stops someone "tidying" it back');
const persistAll = (src.match(/function persistAllState\(\)[\s\S]*?\n\}/) || [''])[0];
assert(persistAll.length > 0, 'persistAllState located');
assert(!/schedule_toggles/.test(persistAll),
  'and persistAllState is NOT the mechanism — relying on a graceful shutdown to keep a pause is how the pause gets lost');

// --- ordering: the restore must run AFTER the schedules exist ----------------------------------------------
const iFirstCreate = src.indexOf("createSchedule('sched-scout-daily'");
const iRestore = src.indexOf("const saved = loadState('schedule_toggles'");
assert(iFirstCreate > -1 && iRestore > -1, 'both the definitions and the restore were found');
assert(iRestore > iFirstCreate,
  'the restore runs AFTER the schedules are created — running first would find an empty Map and silently do nothing');

// --- the runner still honours the flag ---------------------------------------------------------------------
// Belt and braces: even if a cron job were left running, the dispatcher refuses a disabled schedule.
const runner = (src.match(/\nfunction runScheduledAgent[\s\S]*?\n\}/) || [''])[0];
assert(runner.length > 0 && /if \(!sched \|\| !sched\.enabled\) return;/.test(runner),
  'runScheduledAgent still refuses a disabled schedule, so the flag is enforced in two places');

done();
