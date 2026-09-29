// The Kanban coding board (lib/board): schema, the state machine, the atomic claim, and the dumb
// dispatcher driven against a STUB runner that emits the real hermes-task output contract
// (RESULT: <status> / "Open a draft PR: <url>"). No bash, no box: the runner command is injectable,
// so this drives the SAME dispatcher code the box runs. Each guard is proven by making it fire.
//
// claimNext picks by global priority then age, so tests reset the tasks table between sections to keep
// which-task-gets-claimed deterministic (a shared board is exactly the point in production).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, cleanupAndFinish } = require('./test-util');

const board = require('../lib/board');
const repo = board.repo;
const { createDispatcher, parseRunnerOutput } = require('../lib/board/dispatcher');
const rawDb = () => require('../lib/board/db').getDb();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));

// A stand-in for `hermes-task`: argv[2] is the task body, which we use as the MODE so one stub covers
// every case. It prints exactly what the real runner prints on stdout.
const STUB = path.join(dir, 'stub-runner.js');
fs.writeFileSync(STUB, `
const mode = process.argv[2] || 'pushed';
if (mode === 'crash') { console.error('boom, no verdict'); process.exit(3); }
console.log('==> claude: exit=0 result=success turns=4 est_cost=$0.4200 apiKeySource=none');
if (mode === 'pushed') {
  console.log('RESULT: pushed   (tests: pass, changed files: 1)');
  console.log('Open a draft PR: https://github.com/wholefoo/ai-os/compare/master...wholefoo-lab:ai-os:hermes/abc123?expand=1');
} else {
  console.log('RESULT: ' + mode + '   (tests: n/a, changed files: 0)');
}
process.exit(0);
`);
const runnerCmd = [process.execPath, STUB];

// Wipe the board so the next section's claim order is deterministic (FK cascade clears the children).
const reset = () => rawDb().exec('DELETE FROM tasks;');

(async () => {
  board.openDb(path.join(dir, 'board.sqlite'));

  // ---------- schema / open ----------------------------------------------------------------------
  assert(repo.counts && typeof repo.create === 'function', 'the board facade exposes the repo');
  const ver = rawDb().prepare("SELECT value FROM schema_meta WHERE key='version'").get();
  assert(ver && Number(ver.value) >= 1, 'schema_meta seeded at version >= 1');

  // ---------- create + default state -------------------------------------------------------------
  const a = repo.create({ title: 'Task A', body: 'pushed', createdBy: 'mike' });
  assert(a.state === 'ready', 'a task with no dependencies starts ready');
  const held = repo.create({ title: 'Held', start: false });
  assert(held.state === 'queued', 'start:false holds the task in queued');
  let threw = false; try { repo.create({ title: '' }); } catch { threw = true; }
  assert(threw, 'create refuses an empty title');

  // ---------- state machine: legal + illegal transitions ----------------------------------------
  let illegal = false;
  try { repo.setState(held.id, 'done'); } catch { illegal = true; }
  assert(illegal, 'an illegal transition (queued -> done) throws');
  assert(repo.get(held.id).state === 'queued', 'the illegal transition did NOT change the state');
  repo.setState(held.id, 'cancelled');
  assert(repo.get(held.id).state === 'cancelled', 'queued -> cancelled is allowed');
  let fromTerminal = false;
  try { repo.setState(held.id, 'ready'); } catch { fromTerminal = true; }
  assert(fromTerminal, 'cancelled is terminal — no transition out of it');

  // ---------- dependencies: queued until the blocker is done -------------------------------------
  reset();
  const dep = repo.create({ title: 'Blocker', body: 'pushed' });
  const child = repo.create({ title: 'Dependent', dependsOn: [dep.id] });
  assert(child.state === 'queued', 'a task with an unmet dependency starts queued, not ready');
  assert(!repo.depsSatisfied(child.id), 'depsSatisfied is false while the blocker is unfinished');
  repo.setState(dep.id, 'ready'); const cdep = repo.claimNext('w'); repo.finish(cdep.id, { status: 'pushed' });
  assert(repo.get(child.id).state === 'ready', 'finishing the blocker auto-promotes the dependent to ready');

  // ---------- atomic claim: no double-claim of the same row --------------------------------------
  reset();
  const t1 = repo.create({ title: 'A', body: 'pushed' });
  const t2 = repo.create({ title: 'B', body: 'pushed' });
  const c1 = repo.claimNext('w1');
  const c2 = repo.claimNext('w1');
  assert(c1 && c2 && c1.id !== c2.id, 'two claims return two DIFFERENT ready tasks, never the same row twice');
  assert(new Set([c1.id, c2.id]).size === 2 && [t1.id, t2.id].includes(c1.id), 'the claims are the two tasks that existed');
  assert(c1.state === 'running' && c1.worker === 'w1', 'a claimed task is running and stamped with the worker');
  assert(repo.runningCount() === 2, 'runningCount reflects the two claimed tasks');
  assert(repo.claimNext('w1') === null, 'claimNext returns null when no task is ready');

  // ---------- finish + outcome mapping ----------------------------------------------------------
  assert(repo.outcomeFor('pushed') === 'done' && repo.outcomeFor('no_changes') === 'done', 'pushed/no_changes map to done');
  assert(repo.outcomeFor('tests_failed') === 'failed' && repo.outcomeFor('unsafe') === 'failed', 'failure statuses map to failed');
  assert(repo.outcomeFor('blocked') === 'blocked', 'blocked maps to blocked');
  repo.finish(c1.id, { status: 'pushed', branch: 'hermes/x', prUrl: 'http://pr/1', exitCode: 0, costUsd: '0.42' });
  const done1 = repo.get(c1.id);
  assert(done1.state === 'done' && done1.branch === 'hermes/x' && done1.pr_url === 'http://pr/1' && done1.finished_at,
    'finish(pushed) -> done and records branch/pr/finished_at');
  // requeue a failed task
  repo.finish(c2.id, { status: 'tests_failed', exitCode: 0 });
  assert(repo.get(c2.id).state === 'failed', 'a tests_failed run lands in failed');
  repo.requeue(c2.id);
  assert(repo.get(c2.id).state === 'ready', 'a failed task can be requeued to ready');

  // ---------- comments + events -----------------------------------------------------------------
  repo.comment(t1.id, 'looks good', 'mike');
  assert(repo.comments(t1.id).length === 1 && repo.comments(t1.id)[0].author === 'mike', 'a comment is stored and read back');
  assert(repo.events(t1.id).some((e) => e.type === 'created') && repo.events(t1.id).some((e) => e.type === 'claimed'),
    'the event log captures created + claimed');

  // ---------- parseRunnerOutput -----------------------------------------------------------------
  const p = parseRunnerOutput('==> x est_cost=$1.23\nRESULT: pushed   (tests: pass, changed files: 1)\nOpen a draft PR: https://h/compare/master...wholefoo-lab:ai-os:hermes/feat-9?expand=1\n');
  assert(p.status === 'pushed', 'parse: RESULT status');
  assert(p.branch === 'hermes/feat-9', 'parse: branch extracted from the compare URL');
  assert(p.costUsd === '1.23', 'parse: est_cost extracted');
  assert(parseRunnerOutput('nothing here').status === '', 'parse: no RESULT line -> empty status');

  // ---------- dispatcher against the stub runner (one ready task per case for determinism) -------
  const d = createDispatcher({ runnerCmd, maxConcurrency: 1 });

  // capacity guard: when a task is already running, tickOnce claims nothing
  reset();
  repo.create({ title: 'busy', body: 'pushed' });
  const heldRun = repo.claimNext('manual');            // occupy the single slot
  assert(await d.tickOnce() === null, 'tickOnce respects maxConcurrency: nothing claimed while a task is running');
  repo.finish(heldRun.id, { status: 'pushed' });

  // happy path: the dispatcher runs the stub, parses pushed, moves the card to done
  reset();
  const okTask = repo.create({ title: 'dispatch ok', body: 'pushed' });
  const finishedOk = await d.tickOnce();
  assert(finishedOk && finishedOk.id === okTask.id && finishedOk.state === 'done', 'dispatcher: a pushed run ends done');
  assert(finishedOk.branch === 'hermes/abc123' && /expand=1/.test(finishedOk.pr_url), 'dispatcher: branch + PR parsed from the run');
  assert(finishedOk.exit_code === 0 && finishedOk.cost_usd === '0.4200', 'dispatcher: exit code and cost recorded');

  // observability: a dispatcher with logDir persists the runner's combined output to <logDir>/<id>.log
  reset();
  const logDir = path.join(dir, 'board-logs');
  const dl = createDispatcher({ runnerCmd, maxConcurrency: 1, logDir });
  const logTask = repo.create({ title: 'logged run', body: 'pushed' });
  await dl.tickOnce();
  const logFile = path.join(logDir, `${logTask.id}.log`);
  assert(fs.existsSync(logFile), 'dispatcher: the run log file is written under logDir');
  const logged = fs.readFileSync(logFile, 'utf8');
  assert(/RESULT: pushed/.test(logged) && /est_cost=/.test(logged), 'dispatcher: the run log captures the runner stdout (RESULT + cost lines)');
  assert(/# board task/.test(logged) && /status=pushed/.test(logged), 'dispatcher: the run log has a header with the task id and runner status');
  dl.stop();

  // tests_failed path
  reset();
  repo.create({ title: 'dispatch red', body: 'tests_failed' });
  const finishedRed = await d.tickOnce();
  assert(finishedRed && finishedRed.state === 'failed' && finishedRed.result === 'tests_failed', 'dispatcher: a tests_failed run ends failed');

  // crash path: no RESULT line + nonzero exit -> failed with the exit code, never stuck running
  reset();
  repo.create({ title: 'dispatch crash', body: 'crash' });
  const finishedCrash = await d.tickOnce();
  assert(finishedCrash && finishedCrash.state === 'failed', 'dispatcher: a crashed run (no verdict) ends failed, not stuck running');
  assert(finishedCrash.exit_code === 3 && finishedCrash.result === 'agent_error', 'dispatcher: crash records the exit code and agent_error');

  // ENOENT: a bad runner command fails the task instead of throwing out of the loop
  reset();
  const bad = createDispatcher({ runnerCmd: [path.join(dir, 'does-not-exist')], maxConcurrency: 1 });
  repo.create({ title: 'no runner', body: 'pushed' });
  const finishedBad = await bad.tickOnce();
  assert(finishedBad && finishedBad.state === 'failed' && finishedBad.result === 'dispatch_error', 'dispatcher: an un-spawnable runner fails the task (dispatch_error)');

  // recoverStale: a task left running by a dead process is failed on boot, never re-run silently
  reset();
  repo.create({ title: 'orphan', body: 'pushed' });
  const orphan = repo.claimNext('old-worker');
  assert(orphan && repo.get(orphan.id).state === 'running', 'set up an orphaned running task');
  const recovered = d.recoverStale();
  assert(recovered >= 1 && repo.get(orphan.id).state === 'failed' && repo.get(orphan.id).result === 'interrupted',
    'recoverStale fails out an interrupted task so the board never wedges');

  // ---------- routes (real handlers, fake app/req/res, same repo) --------------------------------
  reset();
  const { registerBoardRoutes } = require('../lib/board/routes');
  const routes = {};
  const fakeApp = { get: (p, _mw, h) => { routes[`GET ${p}`] = h; }, post: (p, _mw, h) => { routes[`POST ${p}`] = h; } };
  registerBoardRoutes(fakeApp, { requireAdmin: (req, r, n) => n(), broadcast: () => {} });
  const call = (key, { params = {}, body = {}, query = {} } = {}) => {
    let code = 200, out = null;
    const res = { status(c) { code = c; return this; }, json(o) { out = o; return this; } };
    if (!routes[key]) throw new Error(`route not registered: ${key}`);
    routes[key]({ params, body, query, session: { email: 'admin@x' } }, res);
    return { code, out };
  };

  assert(routes['GET /api/board/board'] && routes['POST /api/board/tasks'] && routes['POST /api/board/tasks/:id/cancel'],
    'routes: the board feed, create, and action endpoints are registered');

  const created = call('POST /api/board/tasks', { body: { title: 'via route', body: 'do a thing', priority: 5 } });
  assert(created.code === 200 && created.out.ok && created.out.task.state === 'ready', 'routes: POST create returns a ready task');
  const tid = created.out.task.id;
  assert(call('POST /api/board/tasks', { body: { title: '   ' } }).code === 400, 'routes: create without a title is a 400');

  const feed = call('GET /api/board/board');
  assert(feed.code === 200 && feed.out.states.includes('ready') && feed.out.columns.ready.some((t) => t.id === tid),
    'routes: the board feed groups the new task under ready');
  assert(typeof feed.out.counts === 'object' && typeof feed.out.running === 'number', 'routes: the feed carries counts + running');

  const one = call('GET /api/board/tasks/:id', { params: { id: tid } });
  assert(one.code === 200 && one.out.task.id === tid && Array.isArray(one.out.events) && Array.isArray(one.out.comments),
    'routes: GET one task returns task + events + comments');
  assert(call('GET /api/board/tasks/:id', { params: { id: 'nope' } }).code === 404, 'routes: unknown task id is a 404');

  assert(call('POST /api/board/tasks/:id/comment', { params: { id: tid }, body: { body: 'a note' } }).code === 200, 'routes: comment posts');
  assert(call('POST /api/board/tasks/:id/comment', { params: { id: tid }, body: { body: '' } }).code === 400, 'routes: empty comment is a 400');
  assert(repo.comments(tid).some((c) => c.author === 'admin@x'), 'routes: the comment records the acting admin');

  // block -> unblock round trip, then an illegal action returns 400 (repo guard shows through)
  assert(call('POST /api/board/tasks/:id/block', { params: { id: tid }, body: { reason: 'need input' } }).out.task.state === 'blocked', 'routes: block works');
  assert(call('POST /api/board/tasks/:id/unblock', { params: { id: tid } }).out.task.state === 'ready', 'routes: unblock returns to ready');
  assert(call('POST /api/board/tasks/:id/cancel', { params: { id: tid } }).out.task.state === 'cancelled', 'routes: cancel works');
  const badAction = call('POST /api/board/tasks/:id/requeue', { params: { id: tid } });
  assert(badAction.code === 400 && /illegal transition/.test(badAction.out.error), 'routes: an illegal action (requeue a cancelled task) is a 400 with the repo reason');

  // ---------- gateway intake (scoped-key create + dedupe) ---------------------------------------
  reset();
  assert(routes['POST /api/board/intake'], 'routes: the intake endpoint is registered');
  const intake1 = call('POST /api/board/intake', { body: { title: 'From Telegram', body: 'fix the footer link', source: 'telegram', dedupeKey: 'tg-42' } });
  assert(intake1.code === 200 && intake1.out.deduped === false && intake1.out.task.state === 'ready', 'intake: a new task is created ready');
  assert(intake1.out.task.created_by === 'intake:telegram', 'intake: the source is recorded as the author');
  const intake2 = call('POST /api/board/intake', { body: { title: 'From Telegram (retry)', source: 'telegram', dedupeKey: 'tg-42' } });
  assert(intake2.code === 200 && intake2.out.deduped === true && intake2.out.task.id === intake1.out.task.id,
    'intake: a repeat with the same dedupeKey returns the first task, never a duplicate');
  assert(repo.list({ state: 'ready' }).filter((t) => t.dedupe_key === 'tg-42').length === 1, 'intake: exactly one task exists for the dedupe key');
  assert(repo.findByDedupe('tg-42') && !repo.findByDedupe('nope'), 'repo.findByDedupe resolves a known key and returns null otherwise');
  assert(call('POST /api/board/intake', { body: { title: '' } }).code === 400, 'intake: a title is still required');

  d.stop(); bad.stop();
  try { rawDb().close(); } catch {}      // release the sqlite handle so Windows can remove the dir
  cleanupAndFinish(dir);
})().catch((e) => { console.error('FAIL: board suite threw:', e && e.stack || e); process.exitCode = 1; try { rawDb().close(); } catch {} cleanupAndFinish(dir); });
