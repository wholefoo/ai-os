// lib/dev/routes.js
// ============================================================
//  Mission HTTP API (dev-platform P1). Admin-only. Reads always work; writes need the engine, which
//  only runs where HERMES_DEV_MISSIONS=1 (the Hermes-Dev box) — elsewhere they answer 503 with the
//  reason instead of creating missions nothing will ever advance.
//
//    POST /api/dev/missions              create   { goal, title?, research?, researchQuery?, researchUrls?, budgetUsd?, model?, maxBuildAttempts? }
//    GET  /api/dev/missions[?state=]     list (long text fields reported by size)
//    GET  /api/dev/missions/:id          one mission + events + its tasks + spend
//    POST /api/dev/missions/:id/cancel
//    POST /api/dev/missions/:id/retry    human-only: re-runs spend money
//
//  Plan APPROVAL is not here on purpose: it goes through the platform's one approvals queue
//  (/api/approvals), where it is always gated (ALWAYS_GATE) and human-only.
// ============================================================

const missions = require('./missions');

const actor = (req) => (req.session && (req.session.email || req.session.username || req.session.name)) || 'admin';
const LONG = ['plan_md', 'research_md', 'ship_md'];
const summarize = (m) => {
  const out = { ...m };
  for (const k of LONG) out[`${k}_chars`] = String(m[k] || '').length;
  for (const k of LONG) delete out[k];
  return out;
};

function registerDevRoutes(app, ctx) {
  const { requireAdmin, broadcast = () => {}, getEngine = () => null, defaultBudgetUsd = 10 } = ctx;
  const requireHuman = ctx.requireHuman || ((req, res) => res.status(503).json({ error: 'unavailable: requireHuman not wired' }));
  const bump = (data) => { try { broadcast({ event: 'dev_update', data }); } catch {} };
  const engineOr503 = (res) => {
    const e = getEngine();
    if (!e) res.status(503).json({ error: 'Missions are disabled on this instance (set HERMES_DEV_MISSIONS=1 on the coding box).' });
    return e;
  };

  app.get('/api/dev/missions', requireAdmin, (req, res) => {
    const state = req.query.state && missions.STATES.includes(String(req.query.state)) ? String(req.query.state) : undefined;
    res.json({ enabled: Boolean(getEngine()), states: missions.STATES, missions: missions.list({ state, limit: Math.min(Number(req.query.limit) || 100, 500) }).map(summarize) });
  });

  app.get('/api/dev/missions/:id', requireAdmin, (req, res) => {
    const m = missions.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'no such mission' });
    res.json({ mission: m, events: missions.events(m.id), tasks: missions.tasks(m.id), spentUsd: Math.round(missions.spend(m.id) * 100) / 100 });
  });

  app.post('/api/dev/missions', requireAdmin, (req, res) => {
    const engine = engineOr503(res); if (!engine) return;
    const b = req.body || {};
    try {
      const m = missions.create({
        title: b.title, goal: b.goal,
        research: b.research === true, researchQuery: b.researchQuery, researchUrls: b.researchUrls,
        budgetUsd: b.budgetUsd === undefined || b.budgetUsd === null || b.budgetUsd === '' ? defaultBudgetUsd : b.budgetUsd,
        model: b.model || '', maxBuildAttempts: b.maxBuildAttempts === undefined ? 2 : b.maxBuildAttempts,
        createdBy: actor(req),
      });
      bump({ type: 'created', id: m.id, state: m.state });
      setImmediate(() => { engine.tick().catch(() => {}); });
      res.json({ ok: true, mission: m });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/dev/missions/:id/cancel', requireAdmin, (req, res) => {
    const engine = engineOr503(res); if (!engine) return;
    try { const m = engine.cancel(req.params.id, actor(req)); bump({ type: 'cancel', id: m.id, state: m.state }); res.json({ ok: true, mission: m }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/dev/missions/:id/retry', requireAdmin, requireHuman, (req, res) => {
    const engine = engineOr503(res); if (!engine) return;
    try { const m = engine.retry(req.params.id, actor(req)); bump({ type: 'retry', id: m.id, state: m.state }); res.json({ ok: true, mission: m }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { registerDevRoutes };
