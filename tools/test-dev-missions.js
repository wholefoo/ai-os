// Dev-platform MISSIONS (lib/dev, P1): the mission state machine, the reconciling engine, the ship
// package and the HTTP routes — driven against a REAL board.sqlite with a fake dispatcher (tasks are
// finished by hand with the runner's real result vocabulary), a fake research call and a fake
// approval queue. Nothing here needs the box, the network or server.js. Each guard is proven by
// making it fire.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, cleanupAndFinish, requireFinish } = require('./test-util');
requireFinish();   // a test that hangs on a never-settling promise must FAIL, not exit 0 mid-suite

const board = require('../lib/board');
const repo = board.repo;
const missions = require('../lib/dev/missions');
const { createMissionEngine } = require('../lib/dev/engine');
const ship = require('../lib/dev/ship');
const { registerDevRoutes } = require('../lib/dev/routes');
const rawDb = () => require('../lib/board/db').getDb();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-'));
const reset = () => { rawDb().exec('DELETE FROM missions; DELETE FROM tasks;'); };

// ---- fakes -------------------------------------------------------------------------------------
const approvals = new Map();                 // id -> status
const approvalCalls = [];                    // missions passed to requestApproval
const withdrawn = [];
let approvalSeq = 0;
let researchImpl = async () => ({ ok: true, content: 'RESEARCH: use X, avoid Y.', cost: 0.3 });
let researchCalls = 0;
const files = new Map();                     // `${workspace}/${name}` -> content
const readTaskFile = (task, name) => files.get(`${task.workspace}/${name}`) || '';

function mkEngine(over = {}) {
  return createMissionEngine({
    research: async (m) => { researchCalls++; return researchImpl(m); },
    requestApproval: async (m) => { approvalCalls.push(m); const id = `ap_${++approvalSeq}`; approvals.set(id, 'pending'); return id; },
    approvalStatus: (id) => approvals.get(id),
    withdrawApproval: (id, reason) => { withdrawn.push({ id, reason }); approvals.set(id, 'rejected'); },
    readTaskFile,
    planBudgetUsd: 2, buildBudgetUsd: 5, minTaskBudgetUsd: 0.25,
    ...over,
  });
}

// What the dispatcher + runner would do to a task: claim it, then record the runner's verdict.
function runTask(id, { status, costUsd = '', planMd = '', branch = '', prUrl = '', workspace = '' }) {
  repo.setState(id, 'running');
  return repo.finish(id, { status, costUsd, planMd, branch, prUrl, workspace, exitCode: status === 'pushed' || status === 'planned' ? 0 : 1 });
}
const ev = (id, type) => missions.events(id).filter((e) => e.type === type);
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  board.openDb(path.join(dir, 'board.sqlite'));
  const ver = rawDb().prepare("SELECT value FROM schema_meta WHERE key='version'").get();
  assert(Number(ver.value) >= 4, 'board.sqlite migrated to version >= 4 (missions)');

  // ---------- create: validation + starting state ---------------------------------------------
  const refuses = (args, label) => { let t = false; try { missions.create(args); } catch { t = true; } assert(t, `create refuses ${label}`); };
  refuses({ budgetUsd: 5 }, 'a mission with no goal');
  refuses({ goal: 'x'.repeat(8001), budgetUsd: 5 }, 'an over-long goal');
  refuses({ goal: 'g', budgetUsd: 0 }, 'a zero budget');
  refuses({ goal: 'g', budgetUsd: 101 }, 'a budget over the ceiling');
  refuses({ goal: 'g' }, 'a missing budget');
  refuses({ goal: 'g', budgetUsd: 5, model: '--probe' }, 'a model name that looks like an option (board rule)');
  refuses({ goal: 'g', budgetUsd: 5, researchUrls: ['https://a', 'https://b', 'https://c', 'https://d'] }, 'more than 3 research URLs');
  refuses({ goal: 'g', budgetUsd: 5, researchUrls: ['file:///etc/passwd'] }, 'a non-http research URL');
  refuses({ goal: 'g', budgetUsd: 5, maxBuildAttempts: 9 }, 'too many build attempts');
  const plain = missions.create({ goal: 'Add a /healthz route\nmore detail', budgetUsd: 10 });
  assert(plain.state === 'planning' && plain.title === 'Add a /healthz route', 'no research -> starts planning; title defaults to the goal\'s first line');
  const withR = missions.create({ goal: 'g', budgetUsd: 10, researchQuery: 'what changed in X?' });
  assert(withR.state === 'researching', 'a research query -> starts researching');
  assert(missions.create({ goal: 'g', budgetUsd: 10, researchUrls: ['https://example.com/a'] }).research_urls[0] === 'https://example.com/a', 'research URLs are stored normalised');
  let illegal = false; try { missions.setState(plain.id, 'done'); } catch { illegal = true; }
  assert(illegal && missions.get(plain.id).state === 'planning', 'an illegal mission transition (planning -> done) throws and changes nothing');

  // ---------- happy path, no research ----------------------------------------------------------
  reset();
  const e = mkEngine();
  let m = missions.create({ goal: 'Add a /healthz route', budgetUsd: 10 });
  await e.tick();
  m = missions.get(m.id);
  const planTask = repo.get(m.current_task_id);
  assert(planTask && planTask.mode === 'plan' && planTask.mission_id === m.id, 'planning: the engine files a plan-mode board task owned by the mission');
  assert(planTask.budget_usd === 2 && planTask.max_turns === 40 && planTask.state === 'ready', 'planning: the plan task gets the plan budget and turn cap');
  await e.tick();
  assert(missions.tasks(m.id).length === 1, 'planning: a second tick does not file a second plan task (idempotent)');
  runTask(planTask.id, { status: 'planned', costUsd: '0.60', planMd: '## Goal\nAdd it.\n## Approach\nRoute + test.', workspace: 'plan-ws1' });
  await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'awaiting_approval' && m.approval_id && approvals.get(m.approval_id) === 'pending', 'a finished plan -> awaiting_approval with a pending approval');
  assert(approvalCalls.length === 1 && /Route \+ test/.test(approvalCalls[0].plan_md) && /Route \+ test/.test(m.plan_md), 'the approval request carries the plan, and the plan is stored on the mission');
  await e.tick();
  assert(missions.get(m.id).state === 'awaiting_approval' && approvalCalls.length === 1, 'awaiting approval: nothing advances and no second approval is requested');
  assert(missions.tasks(m.id).length === 1, 'awaiting approval: NO build task exists before a human approves');

  const ap = e.approvePlan(m.id);
  assert(ap.ok && missions.get(m.id).state === 'building' && missions.get(m.id).plan_approved, 'approvePlan -> building, plan_approved');
  approvals.set(m.approval_id, 'approved');
  await flush(); await e.tick();
  m = missions.get(m.id);
  const build1 = repo.get(m.current_task_id);
  assert(build1 && build1.mode === 'task' && build1.mission_id === m.id && m.build_attempts === 1, 'building: one build task (mode task) is filed, attempt 1');
  assert(/APPROVED PLAN:/.test(build1.body) && /Route \+ test/.test(build1.body) && /Add a \/healthz route/.test(build1.body), 'the build task carries the goal and the approved plan');
  assert(build1.budget_usd === 5, 'build budget = min(build cap, what the mission has left)');
  assert(e.approvePlan(m.id).already === true, 'approvePlan again is a no-op once building on this plan');

  files.set('build-ws1/SUMMARY.md', 'Added GET /healthz returning 200 and a test.');
  files.set('build-ws1/changed-files.txt', 'server.js\npackage-lock.json\ntools/test-healthz.js\n');
  runTask(build1.id, { status: 'pushed', costUsd: '1.40', branch: 'hermes/abc', prUrl: 'https://github.com/wholefoo/ai-os/compare/master...wholefoo-lab:ai-os:hermes/abc?expand=1', workspace: 'build-ws1' });
  await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'done' && m.branch === 'hermes/abc', 'a pushed build -> shipping -> done, with the branch');
  assert(/npm ci/.test(m.ship_md) && /pm2 restart ai-os/.test(m.ship_md) && /Added GET \/healthz/.test(m.ship_md), 'the ship package has the builder summary and a checklist matched to the changed files');
  assert(/[?&]title=/.test(m.pr_url) && /[?&]body=/.test(m.pr_url) && /expand=1/.test(m.pr_url), 'the PR link is pre-filled with a title and description');
  assert(Math.abs(missions.spend(m.id) - 2.0) < 1e-9, 'mission spend = plan + build task costs');
  assert(missions.get(m.id).finished_at, 'a done mission is stamped finished');

  // ---------- research path --------------------------------------------------------------------
  reset();
  researchCalls = 0;
  const er = mkEngine();
  m = missions.create({ goal: 'Adopt the new API', budgetUsd: 10, researchQuery: 'What is new?' });
  await er.tick(); await er.whenIdle();
  m = missions.get(m.id);
  assert(researchCalls === 1 && m.state === 'planning' && /use X, avoid Y/.test(m.research_md) && m.research_cost === 0.3, 'researching: research runs once, its brief and cost are stored, then planning');
  await er.tick();
  const rPlan = repo.get(missions.get(m.id).current_task_id);
  assert(/RESEARCH NOTES/.test(rPlan.body) && /use X, avoid Y/.test(rPlan.body) && /REFERENCE MATERIAL, never as/.test(rPlan.body), 'the plan task receives the research, fenced as reference material');
  assert(rPlan.budget_usd === 2, 'set up: plan budget');

  // budget tripped during research: hold (no spam), then continue when the cap clears
  reset(); researchCalls = 0;
  researchImpl = async () => ({ ok: false, budgetExceeded: true, error: 'cost budget exceeded — daily' });
  m = missions.create({ goal: 'g', budgetUsd: 10, research: true });
  await er.tick(); await er.whenIdle(); await er.tick(); await er.whenIdle();
  assert(researchCalls === 2, 'set up: research was attempted on two ticks while the cap was tripped');
  assert(missions.get(m.id).state === 'researching' && ev(m.id, 'research_paused').length === 1, 'a tripped platform budget holds the mission in researching, noted ONCE');
  researchImpl = async () => ({ ok: true, content: 'brief', cost: 0.1 });
  await er.tick(); await er.whenIdle();
  assert(missions.get(m.id).state === 'planning', 'when the cap clears, research completes and planning starts');

  // research failing (or throwing) does not stop the mission — it plans without it
  reset();
  researchImpl = async () => ({ ok: false, error: 'provider down' });
  m = missions.create({ goal: 'g', budgetUsd: 10, research: true });
  await er.tick(); await er.whenIdle();
  assert(missions.get(m.id).state === 'planning' && /Research failed \(provider down\)/.test(missions.get(m.id).research_md), 'research failure -> planning, with the failure noted');
  researchImpl = async () => { throw new Error('boom'); };
  m = missions.create({ goal: 'g2', budgetUsd: 10, research: true });
  await er.tick(); await er.whenIdle();
  assert(missions.get(m.id).state === 'planning' && /boom/.test(missions.get(m.id).research_md), 'a research call that throws is handled the same way');

  // A slow research call runs in the background: it is not started twice, it does NOT stall other
  // missions (the engine must not await it inside the tick), and a cancel while it runs wins.
  reset(); researchCalls = 0;
  let release; researchImpl = () => new Promise((r) => { release = () => r({ ok: true, content: 'late', cost: 0 }); });
  m = missions.create({ goal: 'slow research', budgetUsd: 10, research: true });
  const other = missions.create({ goal: 'no research', budgetUsd: 10 });
  await er.tick();
  await er.tick();
  assert(researchCalls === 1, 'an in-flight research call is never started twice');
  assert(missions.get(other.id).current_task_id && repo.get(missions.get(other.id).current_task_id).mode === 'plan',
    'a slow research call does not stall other missions (their plan task is filed while it runs)');
  er.cancel(m.id, 'mike');
  release(); await er.whenIdle(); await er.tick();
  assert(missions.get(m.id).state === 'cancelled' && missions.tasks(m.id).length === 0, 'cancelled during research: stays cancelled, no plan task is filed');
  researchImpl = async () => ({ ok: true, content: 'RESEARCH: use X, avoid Y.', cost: 0.3 });

  // ---------- approval outcomes ----------------------------------------------------------------
  const toAwaiting = async (eng, opts = {}) => {
    const mm = missions.create({ goal: opts.goal || 'g', budgetUsd: opts.budgetUsd || 10 });
    await eng.tick();
    runTask(missions.get(mm.id).current_task_id, { status: 'planned', costUsd: opts.planCost || '0.5', planMd: '## Goal\nx', workspace: `pw-${mm.id}` });
    await eng.tick();
    return missions.get(mm.id);
  };
  reset();
  m = await toAwaiting(e);
  approvals.set(m.approval_id, 'rejected');
  await e.tick();
  assert(missions.get(m.id).state === 'rejected' && missions.tasks(m.id).length === 1, 'a rejected plan -> mission rejected, and no build task ever exists');
  let noRetry = false; try { e.retry(m.id); } catch { noRetry = true; }
  assert(noRetry, 'a rejected mission cannot be retried (it is terminal)');
  m = await toAwaiting(e);
  approvals.set(m.approval_id, 'failed');
  await e.tick();
  assert(missions.get(m.id).state === 'failed', 'an approval that failed to execute -> mission failed');
  m = await toAwaiting(e);
  let early = false; try { e.approvePlan(missions.create({ goal: 'z', budgetUsd: 5 }).id); } catch { early = true; }
  assert(early, 'approvePlan refuses a mission that is not awaiting approval');
  // failed -> building is a LEGAL edge (retry uses it), so only approvePlan's own state check stops a
  // stale approval from building a FAILED mission whose plan was never approved.
  const stale = await toAwaiting(e);
  missions.setState(stale.id, 'failed', { failure_reason: 'engine error' });
  let staleRefused = false; try { e.approvePlan(stale.id); } catch { staleRefused = true; }
  assert(staleRefused && missions.get(stale.id).state === 'failed' && !missions.get(stale.id).plan_approved,
    'a stale approval landing on a failed mission is refused — nothing builds');
  // requestApproval throwing -> failed, nothing built
  const eBadAp = mkEngine({ requestApproval: async () => { throw new Error('queue down'); } });
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 10 });
  await eBadAp.tick();
  runTask(missions.get(m.id).current_task_id, { status: 'planned', costUsd: '0.5', planMd: 'p', workspace: 'w' });
  await eBadAp.tick();
  assert(missions.get(m.id).state === 'failed' && /could not request plan approval: queue down/.test(missions.get(m.id).failure_reason), 'if the approval cannot be filed, the mission fails (and builds nothing)');
  // cancelled WHILE the approval is being filed: the just-filed approval is withdrawn, nothing advances
  const lateWithdrawn = [];
  let cancelDuring = null;
  const eRace = mkEngine({
    requestApproval: async (mm) => { cancelDuring(mm.id); return 'ap_race'; },
    withdrawApproval: (id, reason) => lateWithdrawn.push({ id, reason }),
  });
  cancelDuring = (id) => eRace.cancel(id, 'mike');
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 10 });
  await eRace.tick();
  runTask(missions.get(m.id).current_task_id, { status: 'planned', costUsd: '0.5', planMd: 'p', workspace: 'w' });
  await eRace.tick();
  assert(missions.get(m.id).state === 'cancelled' && lateWithdrawn.length === 1 && lateWithdrawn[0].id === 'ap_race',
    'a mission cancelled while its approval was being filed withdraws that approval and stays cancelled');

  // ---------- the debug facet: one bounded retry with the failure fed back ---------------------
  reset();
  m = await toAwaiting(e);
  e.approvePlan(m.id); await flush(); await e.tick();
  const b1 = repo.get(missions.get(m.id).current_task_id);
  files.set(`${'bw1'}/runner-tests.log`, `${'x'.repeat(9000)}\nAssertionError: expected 200, got 404 at test-healthz.js:12`);
  runTask(b1.id, { status: 'tests_failed', costUsd: '1.0', workspace: 'bw1' });
  await e.tick();
  m = missions.get(m.id);
  const b2 = repo.get(m.current_task_id);
  assert(m.state === 'building' && b2.id !== b1.id && m.build_attempts === 2, 'tests_failed -> a second build attempt, still building');
  assert(/PREVIOUS ATTEMPT FAILED with "tests_failed"/.test(b2.body) && /expected 200, got 404/.test(b2.body), 'the retry carries the failing test output');
  assert(b2.body.length < 80000 && !b2.body.includes('x'.repeat(7000)), 'only the TAIL of the test log is fed back');
  assert(ev(m.id, 'build_retry').length === 1, 'the retry is recorded as an event');
  runTask(b2.id, { status: 'tests_failed', costUsd: '1.0', workspace: 'bw2' });
  await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'failed' && /after 2 attempt/.test(m.failure_reason) && missions.tasks(m.id).length === 3, 'a second failure stops at max_build_attempts (no third build)');
  // operator retry after a BUILD failure: rebuild against the approved plan, no new approval
  const apBefore = approvalCalls.length;
  e.retry(m.id, 'mike'); await flush(); await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'building' && m.build_attempts === 1 && approvalCalls.length === apBefore, 'retry after a build failure rebuilds on the approved plan without asking again');
  // non-retriable results never auto-retry
  for (const [result, re] of [['unsafe', /build failed: unsafe/], ['push_failed', /push_failed/]]) {
    reset();
    m = await toAwaiting(e);
    e.approvePlan(m.id); await flush(); await e.tick();
    runTask(missions.get(m.id).current_task_id, { status: result, costUsd: '0.5', workspace: 'w' });
    await e.tick();
    assert(missions.get(m.id).state === 'failed' && re.test(missions.get(m.id).failure_reason) && missions.tasks(m.id).length === 2, `${result} fails the mission at once, with no automatic retry`);
  }
  reset();
  m = await toAwaiting(e);
  e.approvePlan(m.id); await flush(); await e.tick();
  runTask(missions.get(m.id).current_task_id, { status: 'no_changes', workspace: 'w' });
  await e.tick();
  assert(missions.get(m.id).state === 'failed' && /made no changes/.test(missions.get(m.id).failure_reason), 'a build with no changes fails the mission (a human decides)');

  // ---------- planner outcomes ----------------------------------------------------------------
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 10 });
  await e.tick();
  files.set('pblk/BLOCKED.md', 'The goal contradicts CLAUDE.md rule 4.');
  runTask(missions.get(m.id).current_task_id, { status: 'blocked', workspace: 'pblk' });
  await e.tick();
  assert(missions.get(m.id).state === 'failed' && /planner blocked: The goal contradicts/.test(missions.get(m.id).failure_reason), 'a blocked planner fails the mission with its BLOCKED.md reason');
  const apN = approvalCalls.length;
  e.retry(m.id); await flush(); await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'planning' && repo.get(m.current_task_id).mode === 'plan' && missions.tasks(m.id).length === 2, 'retry before approval re-plans with a NEW plan task');
  runTask(m.current_task_id, { status: 'planned', planMd: 'p2', workspace: 'w' });
  await e.tick();
  assert(approvalCalls.length === apN + 1 && missions.get(m.id).state === 'awaiting_approval', 'a re-plan asks for approval again');

  // ---------- mission budget ------------------------------------------------------------------
  reset();
  m = await toAwaiting(e, { budgetUsd: 2.2, planCost: '2.00' });
  e.approvePlan(m.id); await flush(); await e.tick();
  m = missions.get(m.id);
  assert(m.state === 'failed' && /mission budget exhausted/.test(m.failure_reason) && missions.tasks(m.id).length === 1, 'when the mission budget is spent, no build task is filed and the mission fails with the reason');
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 3 });
  await e.tick();
  assert(repo.get(missions.get(m.id).current_task_id).budget_usd === 2, 'set up: plan task capped at the plan budget');
  runTask(missions.get(m.id).current_task_id, { status: 'planned', costUsd: '0.5', planMd: 'p', workspace: 'w' });
  await e.tick(); e.approvePlan(m.id); await flush(); await e.tick();
  assert(repo.get(missions.get(m.id).current_task_id).budget_usd === 2.5, 'the build task gets only what the mission has left (3 - 0.5), not the full build cap');

  // ---------- cancel --------------------------------------------------------------------------
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 10 });
  await e.tick();
  const queuedPlan = missions.get(m.id).current_task_id;
  e.cancel(m.id, 'mike');
  assert(missions.get(m.id).state === 'cancelled' && repo.get(queuedPlan).state === 'cancelled', 'cancel: the mission and its queued task are cancelled');
  let twice = false; try { e.cancel(m.id); } catch { twice = true; }
  assert(twice, 'cancelling a cancelled mission is refused');
  m = await toAwaiting(e);
  e.cancel(m.id, 'mike');
  assert(withdrawn.some((w) => w.id === m.approval_id) && approvals.get(m.approval_id) === 'rejected', 'cancel while awaiting approval withdraws the pending approval');
  let lateApprove = false; try { e.approvePlan(m.id); } catch { lateApprove = true; }
  assert(lateApprove, 'an approval that lands after cancel is refused (nothing is built)');
  // a running task cannot be cancelled; its result is ignored after the mission is cancelled
  reset();
  m = missions.create({ goal: 'g', budgetUsd: 10 });
  await e.tick();
  const runningId = missions.get(m.id).current_task_id;
  repo.setState(runningId, 'running');
  e.cancel(m.id);
  repo.finish(runningId, { status: 'planned', planMd: 'late plan' });
  await e.tick();
  assert(missions.get(m.id).state === 'cancelled' && approvalCalls.every((c) => c.id !== m.id), 'a running task that finishes after cancel is ignored (no approval requested)');

  // ---------- engine isolation ----------------------------------------------------------------
  reset();
  const eIso = mkEngine({ approvalStatus: (id) => { if (id === 'ap_boom') throw new Error('store exploded'); return approvals.get(id); } });
  const broken = missions.create({ goal: 'broken', budgetUsd: 10 });
  missions.setState(broken.id, 'awaiting_approval', { approval_id: 'ap_boom' });
  const fine = missions.create({ goal: 'fine', budgetUsd: 10 });
  await eIso.tick();
  assert(missions.get(broken.id).state === 'failed' && /engine error in awaiting_approval: store exploded/.test(missions.get(broken.id).failure_reason), 'an engine error fails THAT mission, visibly');
  assert(missions.get(fine.id).current_task_id, '...and the other missions in the same tick still advance');

  // ---------- the plan gate is wired as a HARD gate in server.js --------------------------------
  // The policy alone does NOT stop a 'high' action in auto mode — only ALWAYS_GATE does. Pin both
  // facts, so removing the ALWAYS_GATE entry (and quietly letting auto mode build unapproved plans)
  // turns this suite red.
  const { serverSource } = require('./test-util');
  const approvalPolicy = require('../lib/safety/approval');
  const src = serverSource();
  assert(approvalPolicy.ACTION_RISK['dev.mission-plan'] === 'high', 'gate: dev.mission-plan is classified high (so it notifies Telegram/Slack)');
  assert(approvalPolicy.decide('dev.mission-plan', 'auto').allow === true, 'gate: (fact) in auto mode the policy alone WOULD allow it — which is why ALWAYS_GATE is required');
  assert(/const ALWAYS_GATE = new Set\(\[[^\]]*'dev\.mission-plan'/.test(src), 'gate: dev.mission-plan is in server.js ALWAYS_GATE — human-approved in every mode');
  assert(/'dev\.mission-plan': async \(\{ missionId \}\) => \{[\s\S]{0,400}devEngine\.approvePlan\(missionId\)/.test(src), 'gate: its executor exists and approves through the engine');
  assert(/if \(!gate\.pending\) throw new Error\('dev\.mission-plan was not held for approval/.test(src), 'gate: requestApproval refuses to proceed if the plan was ever NOT held for approval');
  assert(/String\(process\.env\.HERMES_DEV_MISSIONS \|\| ''\) === '1'/.test(src), 'gate: the engine only starts where HERMES_DEV_MISSIONS=1');

  // ---------- research provider call (lib/dev/research.js) -----------------------------------
  const { createResearcher } = require('../lib/dev/research');
  const agentCalls = [];
  const fetched = [];
  const researcher = createResearcher({
    executeAgent: async (agent, task, opts) => { agentCalls.push({ agent, task, opts }); return { ok: true, content: 'brief', cost: 0.12 }; },
    safeFetch: async (u) => { fetched.push(u); if (/bad/.test(u)) throw new Error('blocked private address'); return '<html><script>steal()</script><p>Release notes: v2 drops X.</p></html>'; },
  });
  const rr = await researcher({ goal: 'Adopt v2', research_query: 'What breaks?', research_urls: ['https://ok.example/a', 'https://bad.example/b'] });
  const call0 = agentCalls[0];
  assert(rr.ok && rr.cost === 0.12 && rr.content === 'brief', 'research: returns the brief and its cost from executeAgent (the ledgered, capped path)');
  assert(call0.agent === 'consultant-perplexity' && call0.opts.skill === 'dev-research' && /research assistant/.test(call0.opts.systemOverride), 'research: runs on the grounded web consultant with a research brief system prompt');
  assert(/Adopt v2/.test(call0.task) && /What breaks\?/.test(call0.task), 'research: the goal and the research question are the task');
  assert(call0.opts.untrusted && call0.opts.untrusted.label === 'operator-supplied pages' && /v2 drops X/.test(call0.opts.untrusted.text), 'research: fetched pages go in as UNTRUSTED data, not as the task');
  assert(!/steal\(\)/.test(call0.opts.untrusted.text) && !/v2 drops X/.test(call0.task), 'research: page scripts are stripped, and page text never enters the task itself');
  assert(/bad\.example\/b\n\(fetch failed: blocked private address\)/.test(call0.opts.untrusted.text), 'research: a refused fetch is reported, not fatal');
  await researcher({ goal: 'g', research_urls: ['https://1', 'https://2', 'https://3', 'https://4'] });
  assert(fetched.length === 2 + 3, 'research: at most 3 URLs are fetched per mission');
  await researcher({ goal: 'g' });
  assert(agentCalls[2].opts.untrusted === undefined, 'research: no URLs -> no untrusted block');
  const capped = createResearcher({ executeAgent: async () => ({ ok: false, budgetExceeded: true, error: 'cost budget exceeded — daily' }), safeFetch: async () => '' });
  const cr0 = await capped({ goal: 'g' });
  assert(cr0.ok === false && cr0.budgetExceeded === true, 'research: a tripped hard cap is passed through so the engine holds the mission');

  // ---------- ship package (pure) ------------------------------------------------------------
  const dc = (fl) => ship.deployChecklist(fl);
  assert(dc(['docs/x.md', 'README.md']).docOnly === true, 'checklist: docs-only changes need no deploy');
  assert(dc(['package-lock.json']).rules.includes('deps') && /never run npm as root/.test(dc(['package-lock.json']).lines.join(' ')), 'checklist: a dependency change -> npm ci as the app user, never chained, never root');
  assert(dc(['deploy/coding-instance/hermes-task']).rules.includes('runner'), 'checklist: a runner change -> reinstall the runner');
  assert(!dc(['deploy/coding-instance/test/harness.sh']).rules.includes('runner'), 'checklist: a runner TEST change does not ask for a runner reinstall');
  assert(dc(['deploy/coding-instance/hermes-agent-launch']).rules.includes('launcher') && /PROBE: PASS/.test(dc(['deploy/coding-instance/hermes-agent-launch']).lines.join(' ')), 'checklist: a launcher change -> reinstall + require a passing probe');
  assert(dc(['deploy/coding-instance/ai-os-hermes.service']).rules.includes('units'), 'checklist: a unit change -> daemon-reload');
  const boardRules = dc(['lib/board/repo.js']).rules;
  assert(boardRules.includes('board') && boardRules.includes('server'), 'checklist: board code -> restart both services, and the app');
  assert(dc(['lib/board/db.js']).rules.includes('migration'), 'checklist: a db.js change -> back up before the migration');
  assert(dc(['dashboard/js/app.js']).rules.join() === 'static', 'checklist: front-end only -> static (CDN) note only');
  assert(/upstream/.test(dc(['server.js']).lines.join(' ')) && /never merges/.test(dc(['server.js']).lines.join(' ')), 'checklist: always says pull from upstream on Hermes-Dev and that it never merges');
  assert(/unknown/.test(dc([]).lines.join(' ')), 'checklist: unknown changed files are said to be unknown, not guessed');
  const pr = ship.prefilledPrUrl('https://github.com/o/r/compare/master...f:r:hermes/x?expand=1', 'T', 'B'.repeat(5000));
  const pu = new URL(pr);
  assert(pu.searchParams.get('title') === 'T' && pu.searchParams.get('expand') === '1', 'PR link: title and expand set');
  assert(pu.searchParams.get('body').length < 2000 && /truncated/.test(pu.searchParams.get('body')), 'PR link: a long body is truncated with a note');
  assert(ship.prefilledPrUrl('', 'T', 'B') === '' && ship.prefilledPrUrl('not a url', 'T', 'B') === 'not a url', 'PR link: no/invalid compare URL is passed through, never invented');

  // ---------- routes --------------------------------------------------------------------------
  reset();
  const chain = (fns) => (req, res) => { let i = 0; const next = () => { const f = fns[i++]; if (f) f(req, res, next); }; next(); };
  const mkApp = (into) => ({ get: (p, ...fns) => { into[`GET ${p}`] = chain(fns); }, post: (p, ...fns) => { into[`POST ${p}`] = chain(fns); } });
  const fakeRequireHuman = (req, res, next) => (req.session && req.session.service ? res.status(403).json({ error: 'human only' }) : next());
  const callOn = (table) => (key, { params = {}, body = {}, query = {}, session = { email: 'mike@x' } } = {}) => {
    let code = 200, out = null;
    const res = { status(c) { code = c; return this; }, json(o) { out = o; return this; } };
    table[key]({ params, body, query, session }, res);
    return { code, out };
  };
  const off = {};
  registerDevRoutes(mkApp(off), { requireAdmin: (q, r, n) => n(), requireHuman: fakeRequireHuman, getEngine: () => null });
  assert(callOn(off)('POST /api/dev/missions', { body: { goal: 'g' } }).code === 503, 'routes: with no engine (not the coding box), create is a 503 with the reason');
  const offList = callOn(off)('GET /api/dev/missions');
  assert(offList.code === 200 && offList.out.enabled === false, 'routes: reads still work and say the engine is off');
  const on = {};
  const eR = mkEngine();
  registerDevRoutes(mkApp(on), { requireAdmin: (q, r, n) => n(), requireHuman: fakeRequireHuman, getEngine: () => eR, defaultBudgetUsd: 7 });
  const call = callOn(on);
  const cr = call('POST /api/dev/missions', { body: { goal: 'Add X' } });
  assert(cr.code === 200 && cr.out.mission.budget_usd === 7 && cr.out.mission.created_by === 'mike@x', 'routes: create uses the default budget and records the actor');
  assert(call('POST /api/dev/missions', { body: { goal: 'g', researchUrls: ['ftp://x'] } }).code === 400, 'routes: an invalid mission is a 400');
  await flush(); await eR.tick();
  const one = call('GET /api/dev/missions/:id', { params: { id: cr.out.mission.id } });
  assert(one.code === 200 && one.out.tasks.length === 1 && Array.isArray(one.out.events) && typeof one.out.spentUsd === 'number', 'routes: GET one mission returns its tasks, events and spend');
  missions.update(cr.out.mission.id, { plan_md: 'P'.repeat(500) });
  const li = call('GET /api/dev/missions');
  assert(li.out.missions[0].plan_md === undefined && li.out.missions[0].plan_md_chars === 500, 'routes: the list reports long text by size, not content');
  assert(call('GET /api/dev/missions/:id', { params: { id: 'nope' } }).code === 404, 'routes: unknown mission is a 404');
  assert(call('POST /api/dev/missions/:id/cancel', { params: { id: cr.out.mission.id } }).out.mission.state === 'cancelled', 'routes: cancel works');
  const failedM = missions.create({ goal: 'f', budgetUsd: 5 });
  missions.setState(failedM.id, 'failed', { failure_reason: 'x' });
  assert(call('POST /api/dev/missions/:id/retry', { params: { id: failedM.id }, session: { service: true } }).code === 403, 'routes: a service key cannot retry (it spends money) — human only');
  assert(call('POST /api/dev/missions/:id/retry', { params: { id: failedM.id } }).out.mission.state === 'planning', 'routes: a human can retry a failed mission');

  e.stop(); er.stop(); eR.stop();
  try { rawDb().close(); } catch {}
  cleanupAndFinish(dir);
})().catch((err) => { console.error('FAIL: missions suite threw:', err && err.stack || err); process.exitCode = 1; try { rawDb().close(); } catch {} cleanupAndFinish(dir); });
