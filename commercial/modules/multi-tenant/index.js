/**
 * Multi-Tenant Commercial Module
 * Tier: business+
 * Routes: 20
 *
 * Tenant CRUD, monitoring, analytics, templates,
 * custom AI training (instructions, knowledge base, agent personas).
 */

const { defaultTenantSettings } = require('../../../lib/default-settings');

module.exports = {
  name: 'multi-tenant',
  tier: 'business',
  registerRoutes(app, ctx) {
    if (!ctx.features.multiTenant) {
      console.log('[COMMERCIAL] Skipping multi-tenant (requires business+ license)');
      return;
    }
    const { requireAdmin, requirePlan, broadcast, logActivity, uuidv4, saveState,
            tenantRegistry, users, seoAudits, settings, costLedger, freeAuditLog, licenses,
            ensureTenantDir, saveTenantState, loadTenantState,
            loadTrainingConfig, saveTrainingConfig, buildTenantContext, getTrainingDir,
            callAnthropic, MASTER_TENANT_ID, INDUSTRY_TEMPLATES, EFFORT_ROUTING, PLAN_LEVELS } = ctx;

    // ─── Tenant CRUD ─────────────────────────────────────────────

    // GET /api/tenants — list all tenants
    app.get('/api/tenants', requireAdmin, (req, res) => {
      res.json(Object.values(tenantRegistry));
    });

    // GET /api/tenants/:id — single tenant detail
    app.get('/api/tenants/:id', requireAdmin, (req, res) => {
      const tenant = tenantRegistry[req.params.id];
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      res.json(tenant);
    });

    // POST /api/tenants — provision a new tenant (from franchise activation)
    app.post('/api/tenants', requireAdmin, (req, res) => {
      const { name, subdomain, domain, ownerEmail, plan, industry, template, franchiseId, branding } = req.body;
      if (!name || !ownerEmail) return res.status(400).json({ error: 'Name and owner email required' });

      // Check subdomain uniqueness
      if (subdomain && Object.values(tenantRegistry).find(t => t.subdomain === subdomain)) {
        return res.status(400).json({ error: `Subdomain "${subdomain}" is already taken` });
      }

      const tenantId = uuidv4().substring(0, 12);
      const tenant = {
        id: tenantId,
        name,
        domain: domain || null,
        subdomain: subdomain || null,
        ownerId: ownerEmail,
        plan: plan || 'franchise',
        status: 'active',
        branding: {
          companyName: name,
          tagline: branding?.tagline || 'Powered by AI OS',
          logo: branding?.logo || null,
          primaryColor: branding?.primaryColor || '#3b82f6',
          accentColor: branding?.accentColor || '#8b5cf6',
        },
        industry: industry || null,
        template: template || null,
        createdAt: new Date().toISOString(),
        franchiseId: franchiseId || null,
      };

      // Create tenant directory and seed initial state
      ensureTenantDir(tenantId);

      // Seed tenant admin user
      const tenantUsers = [{
        email: ownerEmail,
        passwordHash: null, // Owner sets password on first login
        plan: 'franchise',
        role: 'admin',
        tenantId,
        createdAt: new Date().toISOString(),
      }];
      saveTenantState(tenantId, 'users', tenantUsers);

      // Seed tenant settings with defaults
      const tenantSettings = defaultTenantSettings();
      saveTenantState(tenantId, 'settings', tenantSettings);

      // Apply industry template if specified
      if (template && INDUSTRY_TEMPLATES[template]) {
        const tmpl = INDUSTRY_TEMPLATES[template];
        tenant.branding.tagline = tmpl.tagline;
        if (tmpl.settings) {
          Object.assign(tenantSettings.general, tmpl.settings);
          saveTenantState(tenantId, 'settings', tenantSettings);
        }
      }

      tenantRegistry[tenantId] = tenant;
      saveState('tenant_registry', tenantRegistry);

      logActivity('tenant', `Tenant provisioned: ${name} (${tenantId})`, { tenantId, ownerEmail, industry, template });
      broadcast({ event: 'tenant_provisioned', data: { id: tenantId, name, subdomain } });

      res.json({ ok: true, tenant });
    });

    // PUT /api/tenants/:id — update tenant config
    app.put('/api/tenants/:id', requireAdmin, (req, res) => {
      const tenant = tenantRegistry[req.params.id];
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const { name, subdomain, domain, status, branding, industry } = req.body;
      if (name) tenant.name = name;
      if (subdomain !== undefined) {
        if (subdomain && Object.values(tenantRegistry).find(t => t.id !== tenant.id && t.subdomain === subdomain)) {
          return res.status(400).json({ error: `Subdomain "${subdomain}" is already taken` });
        }
        tenant.subdomain = subdomain;
      }
      if (domain !== undefined) tenant.domain = domain;
      if (status) tenant.status = status;
      if (branding) Object.assign(tenant.branding, branding);
      if (industry) tenant.industry = industry;

      saveState('tenant_registry', tenantRegistry);
      res.json({ ok: true, tenant });
    });

    // DELETE /api/tenants/:id — deactivate a tenant (soft delete)
    app.delete('/api/tenants/:id', requireAdmin, (req, res) => {
      const tenant = tenantRegistry[req.params.id];
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      if (tenant.id === MASTER_TENANT_ID) return res.status(400).json({ error: 'Cannot delete master tenant' });

      tenant.status = 'deactivated';
      saveState('tenant_registry', tenantRegistry);
      logActivity('tenant', `Tenant deactivated: ${tenant.name} (${tenant.id})`, { tenantId: tenant.id });
      res.json({ ok: true });
    });

    // GET /api/tenants/:id/stats — tenant usage stats
    app.get('/api/tenants/:id/stats', requireAdmin, (req, res) => {
      const tenant = tenantRegistry[req.params.id];
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const tenantUsers = loadTenantState(tenant.id, 'users', []);
      const tenantAudits = loadTenantState(tenant.id, 'seo_audits', []);
      const tenantSettings = loadTenantState(tenant.id, 'settings', {});

      const configuredKeys = Object.values(tenantSettings.ai || {}).filter(v => !!v).length;

      res.json({
        tenantId: tenant.id,
        name: tenant.name,
        status: tenant.status,
        users: Array.isArray(tenantUsers) ? tenantUsers.length : 0,
        seoAudits: Array.isArray(tenantAudits) ? tenantAudits.length : 0,
        apiKeysConfigured: configuredKeys,
        createdAt: tenant.createdAt,
      });
    });

    // GET /api/tenants/monitoring — central monitoring dashboard across all tenants
    app.get('/api/tenants/monitoring', requireAdmin, (req, res) => {
      const tenants = Object.values(tenantRegistry);
      const monitoring = tenants.map(t => {
        const tenantUsers = t.id === MASTER_TENANT_ID ? users : loadTenantState(t.id, 'users', []);
        const tenantAudits = t.id === MASTER_TENANT_ID ? seoAudits : loadTenantState(t.id, 'seo_audits', []);
        const tenantSettings = t.id === MASTER_TENANT_ID ? settings : loadTenantState(t.id, 'settings', {});

        const configuredKeys = Object.values(tenantSettings.ai || {}).filter(v => !!v).length;
        const totalKeys = Object.keys(tenantSettings.ai || {}).length;

        return {
          id: t.id,
          name: t.name,
          status: t.status,
          plan: t.plan,
          subdomain: t.subdomain,
          domain: t.domain,
          industry: t.industry,
          ownerId: t.ownerId,
          createdAt: t.createdAt,
          users: Array.isArray(tenantUsers) ? tenantUsers.length : 0,
          audits: Array.isArray(tenantAudits) ? tenantAudits.length : 0,
          apiKeys: `${configuredKeys}/${totalKeys}`,
          apiKeysConfigured: configuredKeys,
          branding: t.branding,
          health: configuredKeys > 0 ? 'ready' : 'needs-setup',
        };
      });

      // Aggregate stats
      const activeTenants = monitoring.filter(t => t.status === 'active').length;
      const totalUsers = monitoring.reduce((sum, t) => sum + t.users, 0);
      const totalAudits = monitoring.reduce((sum, t) => sum + t.audits, 0);
      const readyTenants = monitoring.filter(t => t.health === 'ready').length;

      res.json({
        summary: { totalTenants: tenants.length, activeTenants, totalUsers, totalAudits, readyTenants },
        tenants: monitoring,
      });
    });

    // GET /api/tenants/analytics — usage analytics across all tenants
    app.get('/api/tenants/analytics', requireAdmin, (req, res) => {
      const now = Date.now();
      const dayAgo = now - 86400000;
      const weekAgo = now - 7 * 86400000;
      const monthAgo = now - 30 * 86400000;

      // Cost analytics from ledger
      const dailyCost = costLedger.filter(e => new Date(e.timestamp) > dayAgo).reduce((sum, e) => sum + (e.cost || 0), 0);
      const weeklyCost = costLedger.filter(e => new Date(e.timestamp) > weekAgo).reduce((sum, e) => sum + (e.cost || 0), 0);
      const monthlyCost = costLedger.filter(e => new Date(e.timestamp) > monthAgo).reduce((sum, e) => sum + (e.cost || 0), 0);

      // Usage by model
      const byModel = {};
      costLedger.forEach(e => {
        if (!byModel[e.model]) byModel[e.model] = { calls: 0, cost: 0, tokens: 0 };
        byModel[e.model].calls++;
        byModel[e.model].cost += e.cost || 0;
        byModel[e.model].tokens += (e.inputTokens || 0) + (e.outputTokens || 0);
      });

      // Usage by agent
      const byAgent = {};
      costLedger.forEach(e => {
        if (!byAgent[e.agent]) byAgent[e.agent] = { calls: 0, cost: 0 };
        byAgent[e.agent].calls++;
        byAgent[e.agent].cost += e.cost || 0;
      });

      // Free audit leads
      const freeLeads = freeAuditLog.length;
      const recentLeads = freeAuditLog.filter(l => new Date(l.createdAt) > weekAgo).length;

      // License stats
      const activeLicenses = licenses.filter(l => l.status === 'active').length;
      const pendingLicenses = licenses.filter(l => l.status === 'pending' || l.status === 'payment').length;

      res.json({
        cost: { daily: Math.round(dailyCost * 100) / 100, weekly: Math.round(weeklyCost * 100) / 100, monthly: Math.round(monthlyCost * 100) / 100 },
        byModel: Object.entries(byModel).map(([model, data]) => ({ model, ...data, cost: Math.round(data.cost * 100) / 100 })).sort((a, b) => b.cost - a.cost),
        byAgent: Object.entries(byAgent).map(([agent, data]) => ({ agent, ...data, cost: Math.round(data.cost * 100) / 100 })).sort((a, b) => b.calls - a.calls).slice(0, 20),
        leads: { total: freeLeads, thisWeek: recentLeads },
        licenses: { active: activeLicenses, pending: pendingLicenses },
        totalApiCalls: costLedger.length,
      });
    });

    // ─── Templates ───────────────────────────────────────────────

    // GET /api/templates — list available industry templates
    app.get('/api/templates', (req, res) => {
      res.json(Object.entries(INDUSTRY_TEMPLATES).map(([id, t]) => ({ id, ...t })));
    });

    // ─── Custom AI Training per Tenant ───────────────────────────
    // Business+ plans can customize agent behavior with custom instructions,
    // knowledge docs, and custom agent personas.

    // GET /api/training — load training config for current tenant
    app.get('/api/training', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      res.json({ ok: true, ...config });
    });

    // PUT /api/training/instructions — update custom instructions
    app.put('/api/training/instructions', requirePlan('business'), (req, res) => {
      const { global, brandVoice, industry, rules } = req.body;
      const config = loadTrainingConfig(req.tenantId);
      if (global !== undefined) config.instructions.global = global.substring(0, 5000);
      if (brandVoice !== undefined) config.instructions.brandVoice = brandVoice.substring(0, 3000);
      if (industry !== undefined) config.instructions.industry = industry.substring(0, 2000);
      if (rules !== undefined) config.instructions.rules = (Array.isArray(rules) ? rules : []).slice(0, 50).map(r => String(r).substring(0, 500));
      saveTrainingConfig(req.tenantId, config);
      logActivity('training', `Custom instructions updated for tenant ${req.tenantId}`);
      res.json({ ok: true, instructions: config.instructions });
    });

    // ─── Tenant Knowledge Base ───────────────────────────────────

    // GET /api/training/knowledge — list knowledge docs
    app.get('/api/training/knowledge', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      res.json({ ok: true, docs: config.knowledgeBase, count: config.knowledgeBase.length });
    });

    // POST /api/training/knowledge — add a knowledge doc
    app.post('/api/training/knowledge', requirePlan('business'), (req, res) => {
      const { title, content, category } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'Title and content required' });

      const config = loadTrainingConfig(req.tenantId);
      const maxDocs = PLAN_LEVELS[req.session?.plan] >= PLAN_LEVELS.enterprise ? 500 : 100;
      if (config.knowledgeBase.length >= maxDocs) {
        return res.status(400).json({ error: `Knowledge base limit reached (${maxDocs} docs). Upgrade plan for more.` });
      }

      const doc = {
        id: uuidv4(),
        title: title.substring(0, 200),
        content: content.substring(0, 50000),
        category: (category || 'general').substring(0, 50),
        createdAt: new Date().toISOString(),
      };
      config.knowledgeBase.push(doc);
      saveTrainingConfig(req.tenantId, config);
      logActivity('training', `Knowledge doc added: "${doc.title}" for tenant ${req.tenantId}`);
      res.json({ ok: true, doc });
    });

    // PUT /api/training/knowledge/:id — update a knowledge doc
    app.put('/api/training/knowledge/:id', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      const doc = config.knowledgeBase.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      if (req.body.title) doc.title = req.body.title.substring(0, 200);
      if (req.body.content) doc.content = req.body.content.substring(0, 50000);
      if (req.body.category) doc.category = req.body.category.substring(0, 50);
      doc.updatedAt = new Date().toISOString();

      saveTrainingConfig(req.tenantId, config);
      res.json({ ok: true, doc });
    });

    // DELETE /api/training/knowledge/:id — remove a knowledge doc
    app.delete('/api/training/knowledge/:id', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      const idx = config.knowledgeBase.findIndex(d => d.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Document not found' });

      const removed = config.knowledgeBase.splice(idx, 1)[0];
      saveTrainingConfig(req.tenantId, config);
      logActivity('training', `Knowledge doc removed: "${removed.title}" for tenant ${req.tenantId}`);
      res.json({ ok: true, removed: removed.id });
    });

    // ─── Custom Agent Personas ───────────────────────────────────

    // GET /api/training/agents — list custom agents
    app.get('/api/training/agents', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      res.json({ ok: true, agents: config.customAgents, count: config.customAgents.length });
    });

    // POST /api/training/agents — create a custom agent
    app.post('/api/training/agents', requirePlan('business'), (req, res) => {
      const { name, title, prompt, modelTier, avatar, department } = req.body;
      if (!name || !prompt) return res.status(400).json({ error: 'Name and prompt required' });

      const config = loadTrainingConfig(req.tenantId);
      const maxAgents = PLAN_LEVELS[req.session?.plan] >= PLAN_LEVELS.enterprise ? 50 : 10;
      if (config.customAgents.length >= maxAgents) {
        return res.status(400).json({ error: `Custom agent limit reached (${maxAgents}). Upgrade plan for more.` });
      }

      // Validate model tier
      const validTiers = ['strategic', 'professional', 'scout', 'creative', 'economy', 'realtime'];
      const tier = validTiers.includes(modelTier) ? modelTier : 'professional';

      const agent = {
        id: uuidv4(),
        name: name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().substring(0, 50),
        displayName: name.substring(0, 100),
        title: (title || 'Custom Agent').substring(0, 100),
        prompt: prompt.substring(0, 20000),
        modelTier: tier,
        avatar: (avatar || '').substring(0, 10),
        department: (department || 'Custom').substring(0, 50),
        createdAt: new Date().toISOString(),
      };

      // Prevent name collisions with built-in agents
      const builtInNames = Object.keys(EFFORT_ROUTING).flatMap(t => EFFORT_ROUTING[t].agents);
      if (builtInNames.includes(agent.name)) {
        agent.name = `custom-${agent.name}`;
      }

      config.customAgents.push(agent);
      saveTrainingConfig(req.tenantId, config);
      logActivity('training', `Custom agent created: "${agent.displayName}" for tenant ${req.tenantId}`);
      res.json({ ok: true, agent });
    });

    // PUT /api/training/agents/:id — update a custom agent
    app.put('/api/training/agents/:id', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      const agent = config.customAgents.find(a => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: 'Custom agent not found' });

      if (req.body.title) agent.title = req.body.title.substring(0, 100);
      if (req.body.prompt) agent.prompt = req.body.prompt.substring(0, 20000);
      if (req.body.modelTier) {
        const validTiers = ['strategic', 'professional', 'scout', 'creative', 'economy', 'realtime'];
        if (validTiers.includes(req.body.modelTier)) agent.modelTier = req.body.modelTier;
      }
      if (req.body.avatar !== undefined) agent.avatar = req.body.avatar.substring(0, 10);
      if (req.body.department) agent.department = req.body.department.substring(0, 50);
      if (req.body.displayName) agent.displayName = req.body.displayName.substring(0, 100);
      agent.updatedAt = new Date().toISOString();

      saveTrainingConfig(req.tenantId, config);
      res.json({ ok: true, agent });
    });

    // DELETE /api/training/agents/:id — delete a custom agent
    app.delete('/api/training/agents/:id', requirePlan('business'), (req, res) => {
      const config = loadTrainingConfig(req.tenantId);
      const idx = config.customAgents.findIndex(a => a.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Custom agent not found' });

      const removed = config.customAgents.splice(idx, 1)[0];
      saveTrainingConfig(req.tenantId, config);
      logActivity('training', `Custom agent deleted: "${removed.displayName}" for tenant ${req.tenantId}`);
      res.json({ ok: true, removed: removed.id });
    });

    // POST /api/training/agents/:id/test — test-run a custom agent
    app.post('/api/training/agents/:id/test', requirePlan('business'), async (req, res) => {
      const { task } = req.body;
      if (!task) return res.status(400).json({ error: 'Task text required' });

      const config = loadTrainingConfig(req.tenantId);
      const agent = config.customAgents.find(a => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: 'Custom agent not found' });

      // Build a temporary execution with the custom prompt
      const tenantInstructions = buildTenantContext(req.tenantId);
      const fullPrompt = tenantInstructions ? `${agent.prompt}\n\n${tenantInstructions}` : agent.prompt;

      try {
        const result = await callAnthropic(fullPrompt, task, 'high', 2048);
        res.json({ ok: true, response: result.content, model: 'opus-4.8-high', inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    console.log('[COMMERCIAL] ✓ Multi-Tenant routes registered');
  },
};
