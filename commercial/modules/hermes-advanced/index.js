// modules/hermes-advanced/index.js — Advanced Hermes agent capabilities + Batch Queue
// Tier: business+ — requires ai-os-commercial license
//
// Extended autonomous operations, advanced MCP tool integration,
// multi-step task orchestration, and enhanced agent memory.
// Also includes: Routines and Batch Generation Queue (batchQueue feature).

module.exports = {
  name: 'hermes-advanced',
  tier: 'business',

  registerRoutes(app, ctx) {
    const { features, limits, requireTier, activeTier } = ctx;

    // Feature gate: skip if tier is insufficient
    if (!features.hermesAdvanced) {
      console.log('[COMMERCIAL] Skipping hermes-advanced (requires business+ license)');
      return;
    }

    // No hermes-advanced routes to extract from server.js yet — this feature's
    // API endpoints have not been implemented in the monolith.
    //
    // Planned routes (implement here when ready):
    // - POST /api/hermes/advanced/execute — extended autonomous task
    // - POST /api/hermes/advanced/orchestrate — multi-step orchestration
    // - GET  /api/hermes/advanced/memory — enhanced agent memory
    // - POST /api/hermes/advanced/mcp-chain — chain MCP tool calls
    // - GET  /api/hermes/advanced/capabilities — list advanced capabilities

    console.log(`[COMMERCIAL] Hermes Advanced ready (tier=${activeTier})`);

    // --- Batch Queue (routines + batch generation) ---
    if (!features.batchQueue) {
      console.log('[COMMERCIAL] Skipping batch-queue routes (batchQueue not enabled)');
      return;
    }

    const { broadcast, logActivity, validateBody, heavyLimiter, executeAgent,
            routines, batchQueue, settings, DEMO_MODE, BASE, fs, path } = ctx;

    // ---- Routine Routes ----

    app.get('/api/routines', (req, res) => {
      res.json(routines);
    });

    app.get('/api/routines/stats', (req, res) => {
      const active = routines.filter(r => r.enabled);
      const totalRuns = routines.reduce((sum, r) => sum + r.stats.totalRuns, 0);
      const totalOutputs = routines.reduce((sum, r) => sum + r.stats.totalOutputs, 0);
      const avgSuccess = routines.length > 0
        ? Math.round(routines.reduce((sum, r) => sum + r.stats.successRate, 0) / routines.length * 10) / 10
        : 0;

      res.json({
        total: routines.length,
        active: active.length,
        paused: routines.length - active.length,
        totalRuns,
        totalOutputs,
        avgSuccessRate: avgSuccess,
        outputsPerDay: Math.round(totalOutputs / 30),
      });
    });

    app.put('/api/routines/:id/toggle', (req, res) => {
      const routine = routines.find(r => r.id === req.params.id);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });
      routine.enabled = !routine.enabled;
      routine.status = routine.enabled ? 'active' : 'paused';
      if (!routine.enabled) routine.stats.nextRun = null;
      broadcast({ event: 'routine_update', data: routine });
      logActivity('routine', `Routine ${routine.enabled ? 'enabled' : 'paused'}: ${routine.name}`);
      res.json(routine);
    });

    app.post('/api/routines/:id/run', (req, res) => {
      const routine = routines.find(r => r.id === req.params.id);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });

      // Check rate limit
      if (routine.rateLimit.currentHour >= routine.rateLimit.maxPerHour) {
        return res.status(429).json({ error: 'Rate limit reached for this hour', nextReset: 'Top of next hour' });
      }

      routine.rateLimit.currentHour++;
      routine.stats.totalRuns++;
      routine.stats.totalOutputs += routine.batchSize;
      routine.stats.lastRun = new Date().toISOString();

      broadcast({ event: 'routine_update', data: { ...routine, running: true } });
      logActivity('routine', `Routine manually triggered: ${routine.name} (batch of ${routine.batchSize})`);

      setTimeout(() => {
        broadcast({ event: 'routine_update', data: { ...routine, running: false } });
      }, 4000);

      res.json({ ok: true, routine, outputsGenerated: routine.batchSize });
    });

    app.post('/api/routines', (req, res) => {
      const { name, description, skill, agent, interval, intervalHuman, batchSize = 1, rateLimit = {} } = req.body;
      if (!name || !skill || !interval) return res.status(400).json({ error: 'Name, skill, and interval required' });

      const id = 'routine-' + require('crypto').randomUUID().slice(0, 8);
      const routine = {
        id, name, description: description || '', skill, agent: agent || 'orchestrator',
        interval, intervalHuman: intervalHuman || interval,
        status: 'active',
        rateLimit: { maxPerHour: rateLimit.maxPerHour || 10, currentHour: 0, cooldownMs: rateLimit.cooldownMs || 0 },
        stats: { totalRuns: 0, totalOutputs: 0, successRate: 100, lastRun: null, nextRun: new Date(Date.now() + 3600000).toISOString() },
        outputPath: `.magent/artifacts/${skill}/`,
        batchSize,
        enabled: true,
      };

      routines.push(routine);
      broadcast({ event: 'routine_update', data: routine });
      logActivity('routine', `New routine created: ${name}`);
      res.json(routine);
    });

    // ---- Batch Generation Queue Routes ----

    app.get('/api/batch', (req, res) => {
      res.json(batchQueue.batches);
    });

    app.get('/api/batch/stats', (req, res) => {
      const b = batchQueue.batches;
      res.json({
        total: b.length,
        running: b.filter(x => x.status === 'running').length,
        queued: b.filter(x => x.status === 'queued').length,
        done: b.filter(x => x.status === 'done').length,
        totalItems: b.reduce((s, x) => s + x.count, 0),
        completedItems: b.reduce((s, x) => s + x.completed, 0),
        totalCost: b.reduce((s, x) => s + x.cost, 0),
      });
    });

    app.post('/api/batch', heavyLimiter, (req, res) => {
      const errs = validateBody(req.body, {
        name: { type: 'string', maxLength: 200 },
        type: { type: 'string', oneOf: ['social-posts', 'email-variants', 'ad-copy', 'blog-outlines', 'seo-descriptions', 'text'] },
        count: { type: 'number', min: 1, max: 1000 },
      });
      if (errs) return res.status(400).json({ error: errs.join('; ') });
      const { name, type, count, agent } = req.body;
      const batch = {
        id: `batch-${Date.now()}`,
        name: name || 'Untitled Batch',
        type: type || 'text',
        count: count || 10,
        completed: 0,
        status: 'queued',
        agent: agent || 'deepseek-worker',
        startedAt: null,
        completedAt: null,
        cost: 0,
        outputPath: `.magent/artifacts/${type === 'image' ? 'media' : 'docs'}/batch-${Date.now()}/`,
      };
      batchQueue.batches.unshift(batch);
      broadcast({ event: 'batch_update', data: batch });

      if (!DEMO_MODE && (settings.ai.deepseek_api_key || settings.ai.anthropic_api_key)) {
        // Real batch processing
        (async () => {
          batch.status = 'running';
          batch.startedAt = new Date().toISOString();
          broadcast({ event: 'batch_update', data: batch });

          const results = [];
          for (let i = 0; i < batch.count; i++) {
            try {
              const prompt = `Generate ${batch.type} item ${i + 1} of ${batch.count}. Name: "${batch.name}". Be concise and professional.`;
              const result = await executeAgent(batch.agent || 'deepseek-worker', prompt, { skill: 'batch-' + batch.type });
              results.push(result.content);
              batch.completed = i + 1;
              broadcast({ event: 'batch_update', data: batch });
            } catch (e) {
              results.push(`Error: ${e.message}`);
              batch.completed = i + 1;
            }
          }

          batch.status = 'done';
          batch.completedAt = new Date().toISOString();
          // Save results to vault
          const outDir = path.join(BASE, batch.outputPath);
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
          broadcast({ event: 'batch_update', data: batch });
          logActivity('batch', `Batch complete: ${batch.name} (${batch.count} items)`, { batchId: batch.id });
        })().catch(e => console.error('[BATCH] Failed:', e.message));
      } else {
        // Demo mode simulation
        setTimeout(() => {
          batch.status = 'running';
          batch.startedAt = new Date().toISOString();
          broadcast({ event: 'batch_update', data: batch });
        }, 2000);
        setTimeout(() => {
          batch.status = 'done';
          batch.completed = batch.count;
          batch.completedAt = new Date().toISOString();
          batch.cost = +(batch.count * 0.008).toFixed(3);
          broadcast({ event: 'batch_update', data: batch });
        }, 8000);
      }
      res.json(batch);
    });

    console.log('[COMMERCIAL] ✓ Batch Queue routes registered');
  },
};
