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

  d.stop(); bad.stop();
  try { rawDb().close(); } catch {}      // release the sqlite handle so Windows can remove the dir
  cleanupAndFinish(dir);
})().catch((e) => { console.error('FAIL: board suite threw:', e && e.stack || e); process.exitCode = 1; try { rawDb().close(); } catch {} cleanupAndFinish(dir); });
