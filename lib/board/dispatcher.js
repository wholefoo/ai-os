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
const { spawn } = require('child_process');
const repo = require('./repo');

// The runner prints these; parse only its contract, not its chatter.
//   RESULT: <status>   (tests: <t>, changed files: <n>)
//   Open a draft PR: <compareUrl><branch>?expand=1
//   ==> claude: ... est_cost=$<cost> ...
function parseRunnerOutput(out) {
  const text = String(out || '');
  const status = (text.match(/^RESULT:\s*(\S+)/m) || [])[1] || '';
  const prUrl = (text.match(/Open a draft PR:\s*(\S+)/) || [])[1] || '';
  // Branch is the token between the final ':' and '?expand=1' in the compare URL.
  const branch = prUrl ? ((prUrl.match(/:([^:?\s]+)\?expand=1/) || [])[1] || '') : '';
  const costUsd = (text.match(/est_cost=\$?([0-9.]+)/) || [])[1] || '';
  return { status, prUrl, branch, costUsd };
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
} = {}) {
  if (!Array.isArray(runnerCmd) || runnerCmd.length === 0) {
    throw new Error('createDispatcher: runnerCmd must be a non-empty array');
  }
  let timer = null;
  let ticking = false;

  function _run(task) {
    return new Promise((resolve) => {
      const arg = task.body && task.body.trim() ? task.body : task.title;
      const [cmd, ...base] = runnerCmd;
      let child;
      try {
        child = spawn(cmd, [...base, arg], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        // Could not even spawn (ENOENT etc.) — fail the task, never leave it running.
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

      child.on('error', () => settle(() => repo.finish(task.id, { status: 'dispatch_error', exitCode: null })));
      child.on('close', (code) => settle(() => {
        const { status, prUrl, branch, costUsd } = parseRunnerOutput(out);
        // No RESULT line means the runner never reached its own verdict (crash/timeout/kill).
        const finalStatus = status || (killed ? 'timeout' : 'agent_error');
        return repo.finish(task.id, { status: finalStatus, branch, prUrl, exitCode: code, costUsd });
      }));
    });
  }

  // Claim + run exactly one task if there is capacity. Returns the finished task, or null if nothing
  // was claimed. Used by the tests and callable on demand.
  async function tickOnce() {
    if (repo.runningCount() >= maxConcurrency) return null;
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

module.exports = { createDispatcher, parseRunnerOutput };
