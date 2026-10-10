// lib/board/dispatcher.js
// ============================================================
//  The DUMB dispatcher. On each tick, while under the concurrency cap, it claims the top-priority
//  `ready` task (atomic CAS in repo.claimNext) and runs it as a real OS process — the hermes-task
//  runner — then records where it landed and moves the card. It holds no domain logic: the board is
//  the state, the runner is the work, this just pumps one into the other.
//
//  The runner command is INJECTABLE (like the runner's own HT_LAUNCH), so the same code drives the
//  real `sudo -u hermes hermes-task` on the box and a stub in the tests. Nothing here needs the box.
//
//  Crash safety: the row is flipped to `running` (persisted) BEFORE the process is spawned, so a
//  second tick can never double-claim it across the async window; and recoverStale() on boot fails
//  out any task left `running` by a previous process so the board never wedges.
// ============================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const repo = require('./repo');

// The runner prints these; parse only its contract, not its chatter.
//   RESULT: <status>   (tests: <t>, changed files: <n>)
//   Open a draft PR: <compareUrl><branch>?expand=1
//   ==> claude: ... est_cost=$<cost> ...
//   ----- BEGIN PLAN ----- … ----- END PLAN -----   (a --plan run; only printed once the leak scan passed)
const PLAN_MAX_CHARS = 200 * 1024;
function parseRunnerOutput(out) {
  const raw = String(out || '');
  const pm = raw.match(/^----- BEGIN PLAN -----\r?\n([\s\S]*?)\r?\n?----- END PLAN -----$/m);
  const planMd = pm ? pm[1].slice(0, PLAN_MAX_CHARS) : '';
  // Everything else is parsed with the plan REMOVED: a plan is agent-written text, and a plan that
  // contained "Open a draft PR: …" or "est_cost=$…" must not be able to fake a PR link or a cost.
  const text = pm ? raw.replace(pm[0], '') : raw;
  const status = (text.match(/^RESULT:\s*(\S+)/m) || [])[1] || '';
  const prUrl = (text.match(/Open a draft PR:\s*(\S+)/) || [])[1] || '';
  // Branch is the token between the final ':' and '?expand=1' in the compare URL.
  const branch = prUrl ? ((prUrl.match(/:([^:?\s]+)\?expand=1/) || [])[1] || '') : '';
  const costUsd = (text.match(/est_cost=\$?([0-9.]+)/) || [])[1] || '';
  return { status, prUrl, branch, costUsd, planMd };
}

// The runner's argv for one task. Options come from the task's own columns (validated on create);
// the task text always follows `--`, so a body that starts with "-" (a markdown bullet) is the task,
// never an option the runner refuses. Spawned without a shell, so nothing here is interpreted.
function runnerArgs(task) {
  const args = [];
  if (task.mode === 'plan') args.push('--plan');
  if (task.model) args.push('--model', String(task.model));
  if (task.budget_usd !== null && task.budget_usd !== undefined && task.budget_usd !== '') args.push('--budget', String(task.budget_usd));
  if (task.max_turns !== null && task.max_turns !== undefined && task.max_turns !== '') args.push('--turns', String(task.max_turns));
  args.push('--', task.body && task.body.trim() ? task.body : task.title);
  return args;
}

function createDispatcher({
  runnerCmd,                                   // array, e.g. ['sudo','-n','-u','hermes','-H','/usr/local/bin/hermes-task']
  maxConcurrency = 1,
  pollMs = 5000,
  timeoutMs = 0,                               // 0 = no dispatcher-side timeout (the runner has its own)
  id = `${os.hostname()}:${process.pid}`,
  cwd = undefined,
  env = undefined,
  onLog = null,                                // optional (taskId, chunk) => void for live streaming
  logDir = null,                               // if set, persist each run's combined output to <logDir>/<taskId>.log
  budgetCheck = () => repo.budgetAllowsClaim(), // () => { allow, reason }; injectable for tests
} = {}) {
  if (!Array.isArray(runnerCmd) || runnerCmd.length === 0) {
    throw new Error('createDispatcher: runnerCmd must be a non-empty array');
  }
  let timer = null;
  let ticking = false;
  let lastBudgetReason = null;                 // log budget pauses on CHANGE only, not every tick

  // Ask the budget gate before claiming. A refusal leaves every task where it is (ready); the pump
  // simply does not start new runs. A gate that throws is treated as a refusal (fail closed).
  function budgetOk() {
    let v;
    try { v = budgetCheck() || { allow: false, reason: 'budget check returned nothing' }; }
    catch (e) { v = { allow: false, reason: `budget check failed: ${e && e.message}` }; }
    const key = v.allow ? null : v.reason;
    if (key !== lastBudgetReason) {
      lastBudgetReason = key;
      try { console.log(v.allow ? '[board] budget OK — dispatching resumed' : `[board] dispatch paused: ${v.reason}`); } catch {}
    }
    return v.allow;
  }

  // Persist a run's combined stdout+stderr to disk so a failure is diagnosable AFTER the fact. Without
  // this the runner's output was only broadcast over WebSocket and lost — a dispatcher-spawned run that
  // died left no on-disk trace of WHY (the runner's own .hermes only has what it wrote before it died).
  // Best-effort: a logging failure must never affect the task's outcome. Returns the path or null.
  function persistLog(taskId, out, meta) {
    if (!logDir) return null;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const p = path.join(logDir, `${String(taskId).replace(/[^\w.-]/g, '_')}.log`);
      const header = `# board task ${taskId}\n# ${meta || ''}\n# ${new Date().toISOString()}\n${'='.repeat(72)}\n`;
      fs.writeFileSync(p, header + String(out || ''));
      return p;
    } catch (e) {
      try { console.error('[board] could not persist run log:', e.message); } catch {}
      return null;
    }
  }

  function _run(task) {
    return new Promise((resolve) => {
      const [cmd, ...base] = runnerCmd;
      let child;
      try {
        child = spawn(cmd, [...base, ...runnerArgs(task)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        // Could not even spawn (ENOENT etc.) — fail the task, never leave it running.
        persistLog(task.id, `[spawn threw] ${e && e.message}`, 'status=dispatch_error');
        resolve(repo.finish(task.id, { status: 'dispatch_error', exitCode: null }));
        return;
      }
      let out = '';
      const cap = 512 * 1024;                   // keep the last chunk bounded
      const grab = (buf) => { out += buf; if (out.length > cap) out = out.slice(-cap); if (onLog) { try { onLog(task.id, String(buf)); } catch {} } };
      child.stdout.on('data', grab);
      child.stderr.on('data', grab);

      let killed = false;
      const to = timeoutMs > 0 ? setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs) : null;

      // A task must be finished EXACTLY ONCE. spawn failures emit both 'error' and 'close', and a
      // second finish would either be a wasted illegal-transition attempt or (after shutdown) throw
      // "database is not open". Settle on the first event only.
      let settled = false;
      const settle = (compute) => { if (settled) return; settled = true; if (to) clearTimeout(to); resolve(compute()); };

      child.on('error', (err) => settle(() => {
        persistLog(task.id, `${out}\n[spawn error] ${err && err.message}`, 'status=dispatch_error');
        return repo.finish(task.id, { status: 'dispatch_error', exitCode: null });
      }));
      child.on('close', (code) => settle(() => {
        const { status, prUrl, branch, costUsd, planMd } = parseRunnerOutput(out);
        // No RESULT line means the runner never reached its own verdict (crash/timeout/kill).
        const finalStatus = status || (killed ? 'timeout' : 'agent_error');
        // The runner's first line is "==> task <ID>" — capture the workspace dir name so a reviewer can
        // find /srv/hermes-tasks/<ID> even when the runner died before writing its own result.json.
        const workspace = (out.match(/^==> task (\S+)/m) || [])[1] || '';
        persistLog(task.id, out, `status=${finalStatus} exit=${code} workspace=${workspace || '-'}`);
        // Only a plan run's plan is kept; a task run never carries one.
        return repo.finish(task.id, { status: finalStatus, branch, prUrl, workspace, exitCode: code, costUsd, planMd: task.mode === 'plan' ? planMd : '' });
      }));
    });
  }

  // Claim + run exactly one task if there is capacity. Returns the finished task, or null if nothing
  // was claimed. Used by the tests and callable on demand.
  async function tickOnce() {
    if (repo.runningCount() >= maxConcurrency) return null;
    if (!budgetOk()) return null;
    const task = repo.claimNext(id);
    if (!task) return null;
    return _run(task);
  }

  // The background pump: fill up to the concurrency cap, running each claimed task fire-and-forget.
  function _tick() {
    if (ticking) return;
    ticking = true;
    try {
      while (repo.runningCount() < maxConcurrency) {
        if (!budgetOk()) break;
        const task = repo.claimNext(id);
        if (!task) break;
        _run(task).catch(() => {});           // _run already records failure; never throw out of the loop
      }
    } finally {
      ticking = false;
    }
  }

  // Fail out any task this worker left `running` (previous process died mid-run). running->failed is
  // legal; the operator can requeue. This never re-runs a task automatically (no accidental dup push).
  function recoverStale() {
    const stuck = repo.list({ state: 'running' });
    let n = 0;
    for (const t of stuck) {
      try { repo.finish(t.id, { status: 'interrupted', exitCode: null }); n++; } catch {}
    }
    return n;
  }

  function start() {
    if (timer) return;
    recoverStale();
    timer = setInterval(_tick, pollMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { id, start, stop, tickOnce, recoverStale, _run, parseRunnerOutput, get maxConcurrency() { return maxConcurrency; } };
}

module.exports = { createDispatcher, parseRunnerOutput, runnerArgs };
