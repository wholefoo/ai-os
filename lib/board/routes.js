// lib/board/routes.js
// ============================================================
//  Board HTTP API. Mounted from server.js core, admin-only (requireAdmin). Reads/writes go through
//  repo.js so every transition stays validated — the routes never touch the tables directly.
//    reads:  GET /api/board/board (kanban feed), GET /api/board/tasks/:id (task + events + comments)
//    writes: POST create, comment, and the guarded actions cancel/requeue/block/unblock
//  Each write broadcasts a `board_update` so open dashboards refresh without polling.
// ============================================================

const repo = require('./repo');

// The kanban columns, in display order. Terminal columns (done/failed/cancelled) come last.
const STATES = ['awaiting_approval', 'queued', 'ready', 'running', 'blocked', 'done', 'failed', 'cancelled'];

// The per-task runner parameters a caller may set (repo.create validates them and throws on bad values,
// which the routes turn into a 400).
const runParams = (b) => ({ mode: b.mode, model: b.model, budgetUsd: b.budgetUsd, maxTurns: b.maxTurns });

// Who is acting — the signed-in admin's email if we have it, else a generic label. Cosmetic (author
// on events/comments); requireAdmin has already enforced the actual authorization.
const actor = (req) => (req.session && (req.session.email || req.session.username)) || 'admin';

function registerBoardRoutes(app, ctx) {
  // requireHuman is optional in ctx (older callers/tests pass only requireAdmin); without it the approve
  // route REFUSES rather than silently dropping the human-only check.
  const { requireAdmin, broadcast = () => {} } = ctx;
  const requireHuman = ctx.requireHuman || ((req, res) => res.status(503).json({ error: 'approval unavailable: requireHuman not wired' }));
  const bump = (data) => { try { broadcast({ event: 'board_update', data }); } catch {} };

  // ---------- reads ----------
  // One call feeds the whole board: tasks grouped by state (capped per column), plus true counts.
  app.get('/api/board/board', requireAdmin, (req, res) => {
    const per = Math.min(Number(req.query.per) || 100, 500);
    const columns = {};
    for (const s of STATES) columns[s] = repo.list({ state: s, limit: per });
    // Whether the dispatcher may start runs right now — the same verdict it computes itself, so the
    // board can say "paused: daily budget reached" instead of looking stuck.
    let budget = null;
    try { budget = repo.budgetAllowsClaim(); } catch {}
    res.json({ states: STATES, columns, counts: repo.counts(), running: repo.runningCount(), budget });
  });

  app.get('/api/board/tasks/:id', requireAdmin, (req, res) => {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such task' });
    res.json({ task: t, events: repo.events(req.params.id), comments: repo.comments(req.params.id) });
  });

  // ---------- writes ----------
  app.post('/api/board/tasks', requireAdmin, (req, res) => {
    const b = req.body || {};
    const { title, body, priority, assignee, dependsOn, start } = b;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    try {
      const t = repo.create({
        title, body: body || '', priority: Number(priority) || 100, assignee: assignee || '',
        createdBy: actor(req), dependsOn: Array.isArray(dependsOn) ? dependsOn : [], start: start !== false,
        ...runParams(b),
      });
      bump({ type: 'created', id: t.id });
      res.json({ ok: true, task: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Gateway intake: create a coding task from an EXTERNAL source (Telegram/Discord/Slack bot, an
  // n8n workflow, a GitHub webhook, an email parser). Auth is admin OR a service key scoped to reach
  // this route (the `agent` scope — see lib/security/service-keys.js AGENT_ALLOW); the global scope
  // gate has already enforced that. `source` is recorded as the author so the board shows where a
  // task came from, and `dedupeKey` makes a retrying webhook idempotent: the second POST returns the
  // first task instead of spawning another run.
  app.post('/api/board/intake', requireAdmin, (req, res) => {
    const b = req.body || {};
    const { title, body, priority, assignee, source, dedupeKey } = b;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    try {
      if (dedupeKey) {
        const existing = repo.findByDedupe(dedupeKey);
        if (existing) return res.json({ ok: true, deduped: true, task: existing });
      }
      // Intake never takes `start`: an external source cannot file a task that skips a hold, and it
      // cannot file a held one either — holds are released only by a human (approve).
      const t = repo.create({
        title, body: body || '', priority: Number(priority) || 100, assignee: assignee || '',
        createdBy: `intake:${String(source || 'external').slice(0, 40)}`, dedupeKey: dedupeKey || null,
        ...runParams(b),
      });
      bump({ type: 'intake', id: t.id, source: source || 'external' });
      res.json({ ok: true, deduped: false, task: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/board/tasks/:id/comment', requireAdmin, (req, res) => {
    const body = req.body && req.body.body;
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'comment body is required' });
    try {
      const c = repo.comment(req.params.id, body, actor(req));
      bump({ type: 'comment', id: req.params.id });
      res.json({ ok: true, comment: c });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Guarded state actions. repo enforces the legal transitions, so an out-of-order action (e.g.
  // cancelling a done task) returns 400 with the reason rather than corrupting the card.
  const action = (name, fn) => app.post(`/api/board/tasks/:id/${name}`, requireAdmin, (req, res) => {
    try {
      const t = fn(req.params.id, req.body || {}, req);
      bump({ type: name, id: req.params.id });
      res.json({ ok: true, task: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  action('cancel', (id, _b, req) => repo.cancel(id, actor(req)));
  action('requeue', (id, _b, req) => repo.requeue(id, actor(req)));
  action('block', (id, b, req) => repo.block(id, b.reason || '', actor(req)));
  action('unblock', (id, _b, req) => repo.unblock(id, actor(req)));
  // Release a held task. Human-only: a service key (an agent) must never approve its own work, so
  // this route refuses service-token sessions on top of requireAdmin.
  app.post('/api/board/tasks/:id/approve', requireAdmin, requireHuman, (req, res) => {
    try {
      const t = repo.approve(req.params.id, actor(req));
      bump({ type: 'approve', id: req.params.id });
      res.json({ ok: true, task: t });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { registerBoardRoutes };
