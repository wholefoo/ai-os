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
const STATES = ['queued', 'ready', 'running', 'blocked', 'done', 'failed', 'cancelled'];

// Who is acting — the signed-in admin's email if we have it, else a generic label. Cosmetic (author
// on events/comments); requireAdmin has already enforced the actual authorization.
const actor = (req) => (req.session && (req.session.email || req.session.username)) || 'admin';

function registerBoardRoutes(app, ctx) {
  const { requireAdmin, broadcast = () => {} } = ctx;
  const bump = (data) => { try { broadcast({ event: 'board_update', data }); } catch {} };

  // ---------- reads ----------
  // One call feeds the whole board: tasks grouped by state (capped per column), plus true counts.
  app.get('/api/board/board', requireAdmin, (req, res) => {
    const per = Math.min(Number(req.query.per) || 100, 500);
    const columns = {};
    for (const s of STATES) columns[s] = repo.list({ state: s, limit: per });
    res.json({ states: STATES, columns, counts: repo.counts(), running: repo.runningCount() });
  });

  app.get('/api/board/tasks/:id', requireAdmin, (req, res) => {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such task' });
    res.json({ task: t, events: repo.events(req.params.id), comments: repo.comments(req.params.id) });
  });

  // ---------- writes ----------
  app.post('/api/board/tasks', requireAdmin, (req, res) => {
    const { title, body, priority, assignee, dependsOn, start } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    try {
      const t = repo.create({
        title, body: body || '', priority: Number(priority) || 100, assignee: assignee || '',
        createdBy: actor(req), dependsOn: Array.isArray(dependsOn) ? dependsOn : [], start: start !== false,
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
    const { title, body, priority, assignee, source, dedupeKey } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    try {
      if (dedupeKey) {
        const existing = repo.findByDedupe(dedupeKey);
        if (existing) return res.json({ ok: true, deduped: true, task: existing });
      }
      const t = repo.create({
        title, body: body || '', priority: Number(priority) || 100, assignee: assignee || '',
        createdBy: `intake:${String(source || 'external').slice(0, 40)}`, dedupeKey: dedupeKey || null,
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
}

module.exports = { registerBoardRoutes };
