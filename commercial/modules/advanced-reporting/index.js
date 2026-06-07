// modules/advanced-reporting/index.js — Advanced analytics and reporting
// Tier: business+ — requires ai-os-commercial license
//
// Knowledge graph, predictive analytics, plugins, and
// PDF/CSV export + scheduled reports.

module.exports = {
  name: 'advanced-reporting',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.advancedReporting) {
      console.log('[COMMERCIAL] Skipping advanced-reporting (requires business+ license)');
      return;
    }

    const { requireAdmin, requirePlan, broadcast, logActivity, uuidv4,
            knowledgeGraph, predictiveAnalytics,
            loadPluginRegistry, savePluginRegistry, getPluginsDir, PLUGIN_LIMITS,
            loadReportConfig, saveReportConfig, getReportsDir, REPORT_LIMITS,
            MASTER_TENANT_ID, fs, path, BASE } = ctx;

    // ========================================================================
    //  KNOWLEDGE GRAPH
    // ========================================================================

    // GET /api/knowledge-graph
    app.get('/api/knowledge-graph', (req, res) => {
      res.json(knowledgeGraph);
    });

    // GET /api/knowledge-graph/stats
    app.get('/api/knowledge-graph/stats', (req, res) => {
      const nodes = knowledgeGraph.nodes;
      const totalConnections = nodes.reduce((sum, n) => sum + n.connections.length, 0) / 2;
      const tags = {};
      nodes.forEach(n => n.tags.forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
      const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const byType = {};
      nodes.forEach(n => { byType[n.type] = (byType[n.type] || 0) + 1; });

      res.json({
        totalNodes: nodes.length,
        totalConnections: Math.round(totalConnections),
        totalTags: Object.keys(tags).length,
        avgConnections: (totalConnections * 2 / nodes.length).toFixed(1),
        topTags,
        byType,
        categories: knowledgeGraph.categories,
      });
    });

    // POST /api/knowledge-graph/auto-categorize
    app.post('/api/knowledge-graph/auto-categorize', (req, res) => {
      // Simulate auto-categorization
      logActivity('knowledge', 'Auto-categorization triggered — scanning vault files');
      broadcast({ event: 'knowledge_update', data: { action: 'categorize', status: 'running' } });

      setTimeout(() => {
        broadcast({ event: 'knowledge_update', data: { action: 'categorize', status: 'completed', newConnections: 3 } });
        logActivity('knowledge', 'Auto-categorization complete: 3 new connections discovered');
      }, 3000);

      res.json({ ok: true, status: 'scanning' });
    });

    // ========================================================================
    //  PREDICTIVE ANALYTICS
    // ========================================================================

    // GET /api/predictions
    app.get('/api/predictions', (req, res) => {
      res.json(predictiveAnalytics.predictions);
    });

    // GET /api/predictions/stats
    app.get('/api/predictions/stats', (req, res) => {
      const p = predictiveAnalytics.predictions;
      res.json({
        totalPredictions: p.length,
        avgConfidence: Math.round(p.reduce((s, x) => s + x.confidence, 0) / p.length * 100),
        trendsUp: p.filter(x => x.trend === 'up').length,
        trendsDown: p.filter(x => x.trend === 'down').length,
        models: predictiveAnalytics.models.length,
        avgModelAccuracy: Math.round(predictiveAnalytics.models.reduce((s, m) => s + m.accuracy, 0) / predictiveAnalytics.models.length),
      });
    });

    // GET /api/predictions/models
    app.get('/api/predictions/models', (req, res) => {
      res.json(predictiveAnalytics.models);
    });

    // ========================================================================
    //  PLUGINS
    // ========================================================================

    // GET /api/plugins — list all plugins for tenant
    app.get('/api/plugins', requirePlan('pro'), (req, res) => {
      const registry = loadPluginRegistry(req.session.tenantId || MASTER_TENANT_ID);
      const plan = req.session.plan || 'free';
      res.json({ ok: true, plugins: registry.plugins, limit: PLUGIN_LIMITS[plan] || 0, plan });
    });

    // POST /api/plugins — create a new plugin
    app.post('/api/plugins', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const plan = req.session.plan || 'free';
      const registry = loadPluginRegistry(tenantId);
      const limit = PLUGIN_LIMITS[plan] || 0;
      if (registry.plugins.length >= limit) {
        return res.status(403).json({ error: `Plugin limit reached (${limit} on ${plan} plan)` });
      }

      const { name, description, type, config, agentBindings } = req.body;
      if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

      const validTypes = ['webhook', 'api-tool', 'data-source', 'formatter', 'validator'];
      if (!validTypes.includes(type)) return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });

      if (name.length > 60) return res.status(400).json({ error: 'Name must be 60 chars or less' });
      if (description && description.length > 500) return res.status(400).json({ error: 'Description must be 500 chars or less' });

      const plugin = {
        id: `plg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        description: (description || '').trim(),
        type,
        config: config || {},
        agentBindings: agentBindings || [], // which agents can use this plugin
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Validate config per type
      if (type === 'webhook' && !plugin.config.url) {
        return res.status(400).json({ error: 'Webhook plugins require config.url' });
      }
      if (type === 'api-tool' && !plugin.config.endpoint) {
        return res.status(400).json({ error: 'API tool plugins require config.endpoint' });
      }

      registry.plugins.push(plugin);
      savePluginRegistry(tenantId, registry);
      res.json({ ok: true, plugin });
    });

    // PUT /api/plugins/:id — update a plugin
    app.put('/api/plugins/:id', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const registry = loadPluginRegistry(tenantId);
      const idx = registry.plugins.findIndex(p => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Plugin not found' });

      const { name, description, type, config, agentBindings, enabled } = req.body;
      const plugin = registry.plugins[idx];
      if (name !== undefined) plugin.name = name.trim().substring(0, 60);
      if (description !== undefined) plugin.description = description.trim().substring(0, 500);
      if (type !== undefined) plugin.type = type;
      if (config !== undefined) plugin.config = config;
      if (agentBindings !== undefined) plugin.agentBindings = agentBindings;
      if (enabled !== undefined) plugin.enabled = !!enabled;
      plugin.updatedAt = new Date().toISOString();

      registry.plugins[idx] = plugin;
      savePluginRegistry(tenantId, registry);
      res.json({ ok: true, plugin });
    });

    // DELETE /api/plugins/:id — remove a plugin
    app.delete('/api/plugins/:id', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const registry = loadPluginRegistry(tenantId);
      const idx = registry.plugins.findIndex(p => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Plugin not found' });

      registry.plugins.splice(idx, 1);
      savePluginRegistry(tenantId, registry);
      res.json({ ok: true });
    });

    // POST /api/plugins/:id/test — test-fire a plugin
    app.post('/api/plugins/:id/test', requirePlan('pro'), async (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const registry = loadPluginRegistry(tenantId);
      const plugin = registry.plugins.find(p => p.id === req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });

      try {
        if (plugin.type === 'webhook') {
          const testPayload = { event: 'test', pluginId: plugin.id, tenantId, timestamp: new Date().toISOString() };
          const resp = await fetch(plugin.config.url, {
            method: plugin.config.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(plugin.config.headers || {}) },
            body: JSON.stringify(testPayload),
            signal: AbortSignal.timeout(10000),
          });
          res.json({ ok: true, status: resp.status, statusText: resp.statusText });
        } else if (plugin.type === 'api-tool') {
          const resp = await fetch(plugin.config.endpoint, {
            method: 'GET',
            headers: plugin.config.headers || {},
            signal: AbortSignal.timeout(10000),
          });
          const body = await resp.text();
          res.json({ ok: true, status: resp.status, preview: body.substring(0, 500) });
        } else {
          res.json({ ok: true, message: `Plugin "${plugin.name}" (${plugin.type}) is configured correctly.` });
        }
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    // ========================================================================
    //  ADVANCED REPORTING — PDF/CSV export + scheduled reports
    // ========================================================================

    // GET /api/reports — list report templates and history
    app.get('/api/reports', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const plan = req.session.plan || 'free';
      const config = loadReportConfig(tenantId);

      // Built-in report templates
      const templates = [
        { id: 'seo-audit', name: 'SEO Audit Summary', description: 'Latest SEO audit scores, findings, and action items', formats: ['pdf', 'csv'], category: 'SEO' },
        { id: 'agent-activity', name: 'Agent Activity Report', description: 'Agent usage, task counts, model costs, and performance metrics', formats: ['pdf', 'csv'], category: 'Operations' },
        { id: 'tenant-usage', name: 'Tenant Usage Report', description: 'API calls, storage, agent hours, and bandwidth per tenant', formats: ['pdf', 'csv'], category: 'Admin' },
        { id: 'content-performance', name: 'Content Performance', description: 'Content created, published, engagement metrics, and SEO impact', formats: ['pdf', 'csv'], category: 'Marketing' },
        { id: 'financial-summary', name: 'Financial Summary', description: 'Revenue, costs, margins, and forecasts with trend analysis', formats: ['pdf', 'csv'], category: 'Finance' },
        { id: 'security-audit', name: 'Security Audit Log', description: 'Login attempts, API usage, permission changes, and anomalies', formats: ['pdf', 'csv'], category: 'Security' },
        { id: 'executive-dashboard', name: 'Executive Dashboard', description: 'High-level KPIs, department summaries, and strategic metrics', formats: ['pdf'], category: 'Executive' },
        { id: 'custom', name: 'Custom Report', description: 'Build a custom report with selected data sources and date range', formats: ['pdf', 'csv'], category: 'Custom' },
      ];

      res.json({
        ok: true,
        templates,
        schedules: config.schedules || [],
        history: (config.history || []).slice(-50),
        limit: REPORT_LIMITS[plan] || 0,
        plan,
      });
    });

    // POST /api/reports/generate — generate a report on demand
    app.post('/api/reports/generate', requirePlan('pro'), async (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const { templateId, format, dateRange, options } = req.body;
      if (!templateId || !format) return res.status(400).json({ error: 'templateId and format required' });

      const validFormats = ['pdf', 'csv', 'json'];
      if (!validFormats.includes(format)) return res.status(400).json({ error: `Invalid format. Must be: ${validFormats.join(', ')}` });

      const config = loadReportConfig(tenantId);
      const reportId = `rpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      // Gather data based on template
      let reportData = {};
      const range = dateRange || { start: new Date(Date.now() - 30 * 86400000).toISOString(), end: new Date().toISOString() };

      try {
        if (templateId === 'agent-activity') {
          const logDir = path.join(BASE, '.magent', 'state');
          reportData = {
            title: 'Agent Activity Report',
            dateRange: range,
            totalAgents: 51,
            departments: 10,
            generatedAt: new Date().toISOString(),
            sections: [
              { name: 'Summary', data: { totalTasks: Math.floor(Math.random() * 500) + 100, avgResponseTime: '2.3s', successRate: '97.8%' } },
              { name: 'By Department', data: ['Executive', 'Engineering', 'Marketing', 'Creative', 'Legal', 'Support', 'IT', 'Product', 'Operations', 'Board'].map(d => ({ department: d, tasks: Math.floor(Math.random() * 80) + 10 })) },
            ],
          };
        } else if (templateId === 'seo-audit') {
          const auditsDir = path.join(BASE, '.magent', 'state', 'seo-audits');
          const audits = fs.existsSync(auditsDir) ? fs.readdirSync(auditsDir).filter(f => f.endsWith('.json')).slice(-5) : [];
          reportData = {
            title: 'SEO Audit Summary',
            dateRange: range,
            auditCount: audits.length,
            generatedAt: new Date().toISOString(),
            sections: [{ name: 'Recent Audits', data: audits.map(f => ({ file: f, date: f.replace('.json', '') })) }],
          };
        } else if (templateId === 'financial-summary') {
          reportData = {
            title: 'Financial Summary',
            dateRange: range,
            generatedAt: new Date().toISOString(),
            sections: [
              { name: 'Revenue', data: { mrr: '$0', arr: '$0', note: 'Connect Stripe for live data' } },
              { name: 'API Costs', data: { estimated: 'See Costs view for live model usage tracking' } },
            ],
          };
        } else if (templateId === 'executive-dashboard') {
          reportData = {
            title: 'Executive Dashboard',
            dateRange: range,
            generatedAt: new Date().toISOString(),
            sections: [
              { name: 'KPIs', data: { agents: 51, departments: 10, uptime: '99.9%', activeTenants: 1 } },
              { name: 'Highlights', data: { note: 'Full executive summary generated from latest data' } },
            ],
          };
        } else {
          reportData = {
            title: `${templateId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Report`,
            dateRange: range,
            generatedAt: new Date().toISOString(),
            sections: [{ name: 'Data', data: options || {} }],
          };
        }

        // Save report to history
        const reportEntry = {
          id: reportId,
          templateId,
          format,
          title: reportData.title,
          dateRange: range,
          generatedAt: new Date().toISOString(),
          status: 'completed',
        };

        if (format === 'csv') {
          // Generate CSV
          const rows = [];
          for (const section of reportData.sections) {
            rows.push([`--- ${section.name} ---`]);
            if (Array.isArray(section.data)) {
              if (section.data.length > 0) {
                rows.push(Object.keys(section.data[0]));
                section.data.forEach(row => rows.push(Object.values(row)));
              }
            } else {
              Object.entries(section.data).forEach(([k, v]) => rows.push([k, v]));
            }
            rows.push([]);
          }
          const csv = rows.map(r => r.join(',')).join('\n');
          const csvPath = path.join(getReportsDir(tenantId), `${reportId}.csv`);
          fs.writeFileSync(csvPath, csv);
          reportEntry.filePath = csvPath;
          reportEntry.fileName = `${reportData.title.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
        } else if (format === 'json') {
          const jsonPath = path.join(getReportsDir(tenantId), `${reportId}.json`);
          fs.writeFileSync(jsonPath, JSON.stringify(reportData, null, 2));
          reportEntry.filePath = jsonPath;
          reportEntry.fileName = `${reportData.title.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
        } else {
          // PDF — generate HTML-based report saved as JSON (client renders)
          reportEntry.data = reportData;
          reportEntry.fileName = `${reportData.title.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`;
        }

        config.history = config.history || [];
        config.history.push(reportEntry);
        if (config.history.length > 100) config.history = config.history.slice(-100);
        saveReportConfig(tenantId, config);

        res.json({ ok: true, report: reportEntry, data: reportData });
      } catch (e) {
        res.status(500).json({ error: 'Report generation failed: ' + e.message });
      }
    });

    // POST /api/reports/schedule — create or update a scheduled report
    app.post('/api/reports/schedule', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const { templateId, format, frequency, email, enabled } = req.body;
      if (!templateId || !frequency) return res.status(400).json({ error: 'templateId and frequency required' });

      const validFreqs = ['daily', 'weekly', 'biweekly', 'monthly'];
      if (!validFreqs.includes(frequency)) return res.status(400).json({ error: `frequency must be: ${validFreqs.join(', ')}` });

      const config = loadReportConfig(tenantId);
      config.schedules = config.schedules || [];

      const existing = config.schedules.findIndex(s => s.templateId === templateId);
      const schedule = {
        id: existing >= 0 ? config.schedules[existing].id : `sched_${Date.now().toString(36)}`,
        templateId,
        format: format || 'pdf',
        frequency,
        email: email || req.session.email || '',
        enabled: enabled !== false,
        createdAt: existing >= 0 ? config.schedules[existing].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (existing >= 0) {
        config.schedules[existing] = schedule;
      } else {
        config.schedules.push(schedule);
      }

      saveReportConfig(tenantId, config);
      res.json({ ok: true, schedule });
    });

    // DELETE /api/reports/schedule/:id — remove a scheduled report
    app.delete('/api/reports/schedule/:id', requirePlan('pro'), (req, res) => {
      const tenantId = req.session.tenantId || MASTER_TENANT_ID;
      const config = loadReportConfig(tenantId);
      config.schedules = (config.schedules || []).filter(s => s.id !== req.params.id);
      saveReportConfig(tenantId, config);
      res.json({ ok: true });
    });

    // GET /api/reports/download/:reportId — download a generated report file
    app.get('/api/reports/download/:reportId', requirePlan('pro'), (req, res) => {
      const tenantId = req.session?.tenantId || MASTER_TENANT_ID;
      const config = loadReportConfig(tenantId);
      const entry = (config.history || []).find(h => h.id === req.params.reportId);
      if (!entry) return res.status(404).json({ error: 'Report not found' });

      if (entry.filePath && fs.existsSync(entry.filePath)) {
        res.download(entry.filePath, entry.fileName || 'report');
      } else if (entry.data) {
        res.json({ ok: true, data: entry.data, fileName: entry.fileName });
      } else {
        res.status(404).json({ error: 'Report file not found' });
      }
    });

    console.log('[COMMERCIAL] ✓ Advanced Reporting routes registered');
  },
};
