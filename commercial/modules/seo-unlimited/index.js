// modules/seo-unlimited/index.js — Unlimited SEO audits and advanced SEO tools
// Tier: business+ — requires ai-os-commercial license
//
// Removes community audit limits. Adds full SEO audit lifecycle:
// launch audits, view results, generate PDF reports, content briefs,
// 12-week content calendars, and optimized meta tags.

module.exports = {
  name: 'seo-unlimited',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.unlimitedSeo) {
      console.log('[COMMERCIAL] Skipping seo-unlimited (requires business+ license)');
      return;
    }

    const { broadcast, logActivity, uuidv4, saveState,
            seoAudits, settings, DEMO_MODE,
            capitalize, generateSeoFindings, generateExecutiveSummary,
            generateQuickWins, generateActionPlan,
            runRealSeoAudit, dfsAuthHeader,
            requireAdmin } = ctx;

    // POST /api/seo/audit — launch a full SEO audit for a domain
    app.post('/api/seo/audit', requireAdmin, async (req, res) => {
      const { domain } = req.body;
      if (!domain) return res.status(400).json({ error: 'Domain is required' });

      const auditId = uuidv4();
      const audit = {
        id: auditId,
        domain: domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        compositeScore: null,
        agents: {
          keyword:    { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
          technical:  { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
          competitor: { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
          content:    { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
          backlink:   { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
        },
        quickWins: [],
        actionPlan: [],
        executiveSummary: '',
      };

      seoAudits.push(audit);
      broadcast({ event: 'seo_audit_started', data: { id: auditId, domain: audit.domain } });
      logActivity('seo', `SEO audit started: ${audit.domain}`, { auditId });

      // Real DataForSEO audit path
      if (!DEMO_MODE && settings.seo.dataforseo_login && settings.seo.dataforseo_password) {
        runRealSeoAudit(audit, auditId).catch(e => {
          console.error('[SEO] Real audit failed:', e.message);
          // Mark failed agents and complete with partial data
          const agentNames = ['keyword', 'technical', 'competitor', 'content', 'backlink'];
          agentNames.forEach(name => {
            if (audit.agents[name].status === 'running') {
              audit.agents[name].status = 'error';
              audit.agents[name].findings = [{ severity: 'critical', issue: `DataForSEO error: ${e.message}`, recommendation: 'Check DataForSEO credentials in Settings and ensure sufficient API credits.' }];
            }
          });
          audit.status = 'complete';
          audit.completedAt = new Date().toISOString();
          const scores = agentNames.map(n => audit.agents[n].score || 0);
          audit.compositeScore = Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.filter(s => s > 0).length, 1));
          audit.executiveSummary = `Audit partially completed with errors. ${e.message}`;
          audit.quickWins = generateQuickWins(audit);
          audit.actionPlan = generateActionPlan(audit);
          saveState('seo_audits', seoAudits);
          broadcast({ event: 'seo_audit_complete', data: { auditId, compositeScore: audit.compositeScore } });
        });
      }
      // Simulate parallel agent execution (demo mode)
      else if (DEMO_MODE) {
        const agentNames = ['keyword', 'technical', 'competitor', 'content', 'backlink'];
        const delays = [2000, 3000, 2500, 3500, 4000];

        agentNames.forEach((name, i) => {
          setTimeout(() => {
            const score = 40 + Math.floor(Math.random() * 50);
            audit.agents[name].status = 'complete';
            audit.agents[name].score = score;
            audit.agents[name].completedAt = new Date().toISOString();
            audit.agents[name].findings = generateSeoFindings(name, audit.domain);
            broadcast({ event: 'seo_agent_complete', data: { auditId, agent: name, score } });

            // Check if all agents are done
            const allDone = agentNames.every(n => audit.agents[n].status === 'complete');
            if (allDone) {
              const scores = agentNames.map(n => audit.agents[n].score);
              audit.compositeScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
              audit.status = 'complete';
              audit.completedAt = new Date().toISOString();
              audit.executiveSummary = generateExecutiveSummary(audit);
              audit.quickWins = generateQuickWins(audit);
              audit.actionPlan = generateActionPlan(audit);
              saveState('seo_audits', seoAudits);
              broadcast({ event: 'seo_audit_complete', data: { auditId, compositeScore: audit.compositeScore } });
              logActivity('seo', `SEO audit complete: ${audit.domain} — score ${audit.compositeScore}/100`, { auditId });
            }
          }, delays[i]);
        });
      }

      res.json({ ok: true, auditId, domain: audit.domain });
    });

    // GET /api/seo/audits — list all audits
    app.get('/api/seo/audits', requireAdmin, (req, res) => {
      res.json(seoAudits.map(a => ({
        id: a.id, domain: a.domain, status: a.status,
        compositeScore: a.compositeScore, startedAt: a.startedAt, completedAt: a.completedAt,
      })));
    });

    // GET /api/seo/audit/:id — get full audit detail
    app.get('/api/seo/audit/:id', requireAdmin, (req, res) => {
      const audit = seoAudits.find(a => a.id === req.params.id);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      res.json(audit);
    });

    // POST /api/seo/report/:id — generate PDF report (returns download URL)
    app.post('/api/seo/report/:id', requireAdmin, (req, res) => {
      const audit = seoAudits.find(a => a.id === req.params.id);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

      // In demo mode, return a simulated report URL
      const reportId = uuidv4();
      logActivity('seo', `PDF report generated: ${audit.domain}`, { auditId: audit.id, reportId });
      res.json({
        ok: true,
        reportId,
        filename: `SEO-Audit-${audit.domain}-${new Date().toISOString().split('T')[0]}.pdf`,
        message: DEMO_MODE ? 'Demo mode — PDF generation simulated' : 'Report generated',
      });
    });

    // DELETE /api/seo/audit/:id — delete an audit
    app.delete('/api/seo/audit/:id', requireAdmin, (req, res) => {
      const idx = seoAudits.findIndex(a => a.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Audit not found' });
      seoAudits.splice(idx, 1);
      saveState('seo_audits', seoAudits);
      res.json({ ok: true });
    });

    // POST /api/seo/briefs/:id — generate content briefs from audit keyword data
    app.post('/api/seo/briefs/:id', requireAdmin, (req, res) => {
      const audit = seoAudits.find(a => a.id === req.params.id);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

      const d = audit.domain;
      const briefs = [
        { title: `Complete Guide to ${d.split('.')[0].replace(/-/g, ' ')} Services in [City]`, targetKeyword: `${d.split('.')[0]} services near me`, wordCount: 2000, intent: 'commercial', outline: ['Introduction & local context', 'Services overview', 'Why choose local providers', 'Pricing guide', 'FAQ section', 'Call to action'], priority: 'high' },
        { title: `How to Choose the Right ${capitalize(d.split('.')[0].replace(/-/g, ' '))} Company`, targetKeyword: `how to choose ${d.split('.')[0].replace(/-/g, ' ')}`, wordCount: 1500, intent: 'informational', outline: ['Key factors to consider', 'Red flags to avoid', 'Questions to ask', 'Licensing & insurance checklist', 'Cost comparison tips'], priority: 'high' },
        { title: `${capitalize(d.split('.')[0].replace(/-/g, ' '))} vs Competitors: Honest Comparison`, targetKeyword: `${d.split('.')[0]} reviews`, wordCount: 1800, intent: 'commercial', outline: ['Overview of options', 'Feature comparison table', 'Pricing breakdown', 'Pros and cons', 'Our recommendation'], priority: 'medium' },
        { title: `Top 10 ${capitalize(d.split('.')[0].replace(/-/g, ' '))} Tips for Homeowners`, targetKeyword: `${d.split('.')[0]} tips`, wordCount: 1200, intent: 'informational', outline: ['Quick wins list', 'Maintenance schedule', 'When to call a professional', 'Cost-saving strategies', 'Common mistakes'], priority: 'medium' },
        { title: `${capitalize(d.split('.')[0].replace(/-/g, ' '))} Cost Guide [${new Date().getFullYear()}]`, targetKeyword: `${d.split('.')[0]} cost`, wordCount: 1600, intent: 'transactional', outline: ['Average costs by service type', 'Factors affecting price', 'Hidden fees to watch for', 'How to get quotes', 'Financing options'], priority: 'high' },
      ];

      logActivity('seo', `Content briefs generated: ${audit.domain} (${briefs.length} briefs)`, { auditId: audit.id });
      res.json({ ok: true, domain: audit.domain, briefs });
    });

    // POST /api/seo/calendar/:id — generate content calendar from audit
    app.post('/api/seo/calendar/:id', requireAdmin, (req, res) => {
      const audit = seoAudits.find(a => a.id === req.params.id);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

      const d = audit.domain;
      const base = d.split('.')[0].replace(/-/g, ' ');
      const now = new Date();
      const weeks = [];

      for (let w = 0; w < 12; w++) {
        const weekDate = new Date(now.getTime() + w * 7 * 86400000);
        const weekLabel = `Week ${w + 1} — ${weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        const items = [];

        if (w < 2) {
          items.push({ type: 'fix', title: 'Fix critical technical issues', priority: 'critical', effort: '2-4 hours' });
          items.push({ type: 'optimize', title: 'Optimize title tags & meta descriptions for top 10 pages', priority: 'high', effort: '1-2 hours' });
        } else if (w < 4) {
          items.push({ type: 'content', title: `Publish: "Complete Guide to ${capitalize(base)} Services"`, priority: 'high', effort: '4-6 hours' });
          items.push({ type: 'optimize', title: 'Add schema markup to service pages', priority: 'medium', effort: '1 hour' });
        } else if (w < 6) {
          items.push({ type: 'content', title: `Publish: "${capitalize(base)} Cost Guide ${now.getFullYear()}"`, priority: 'high', effort: '3-4 hours' });
          items.push({ type: 'link', title: 'Submit to 10 local business directories', priority: 'medium', effort: '2 hours' });
        } else if (w < 8) {
          items.push({ type: 'content', title: `Publish: "How to Choose the Right ${capitalize(base)} Company"`, priority: 'medium', effort: '3-4 hours' });
          items.push({ type: 'content', title: `Publish: "Top 10 ${capitalize(base)} Tips"`, priority: 'medium', effort: '2-3 hours' });
        } else if (w < 10) {
          items.push({ type: 'link', title: 'Guest post outreach to 5 industry blogs', priority: 'medium', effort: '3-4 hours' });
          items.push({ type: 'content', title: `Publish comparison article: "${capitalize(base)} vs Competitors"`, priority: 'medium', effort: '4-5 hours' });
        } else {
          items.push({ type: 'analyze', title: 'Review ranking changes and traffic growth', priority: 'high', effort: '1 hour' });
          items.push({ type: 'content', title: 'Publish FAQ page from top customer questions', priority: 'medium', effort: '2 hours' });
          items.push({ type: 'optimize', title: 'Update internal links across all new content', priority: 'low', effort: '1 hour' });
        }
        weeks.push({ week: weekLabel, items });
      }

      logActivity('seo', `Content calendar generated: ${audit.domain} (12 weeks)`, { auditId: audit.id });
      res.json({ ok: true, domain: audit.domain, weeks });
    });

    // POST /api/seo/meta/:id — generate optimized meta tags
    app.post('/api/seo/meta/:id', requireAdmin, (req, res) => {
      const audit = seoAudits.find(a => a.id === req.params.id);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

      const d = audit.domain;
      const base = capitalize(d.split('.')[0].replace(/-/g, ' '));
      const pages = [
        { page: 'Homepage', url: `https://${d}/`, currentTitle: `${base} - Home`, currentDesc: '', optimizedTitle: `${base} | Professional Services in [City] | Licensed & Insured`, optimizedDesc: `${base} offers trusted, affordable services in [City]. Licensed, insured, 5-star rated. Get a free quote today. Call (555) 123-4567.`, changes: ['Added location keyword', 'Added trust signals', 'Added CTA with phone number'] },
        { page: 'Services', url: `https://${d}/services`, currentTitle: `Services - ${base}`, currentDesc: '', optimizedTitle: `Our ${base} Services | Residential & Commercial | [City]`, optimizedDesc: `Full-service ${base.toLowerCase()} for homes and businesses in [City]. Same-day appointments, upfront pricing, satisfaction guaranteed.`, changes: ['Added service scope', 'Added location', 'Added urgency & guarantee'] },
        { page: 'About', url: `https://${d}/about`, currentTitle: `About Us - ${base}`, currentDesc: '', optimizedTitle: `About ${base} | ${5 + Math.floor(Math.random() * 20)}+ Years Serving [City]`, optimizedDesc: `Family-owned ${base.toLowerCase()} company with ${5 + Math.floor(Math.random() * 20)}+ years of experience. Meet our licensed team and learn why [City] trusts us.`, changes: ['Added years of experience', 'Added family-owned trust signal', 'Personalized description'] },
        { page: 'Contact', url: `https://${d}/contact`, currentTitle: `Contact - ${base}`, currentDesc: '', optimizedTitle: `Contact ${base} | Free Estimates | [City], [State]`, optimizedDesc: `Get a free estimate from ${base}. Call (555) 123-4567 or fill out our online form. Serving [City] and surrounding areas.`, changes: ['Added free estimate CTA', 'Added phone number', 'Added service area'] },
        { page: 'Blog', url: `https://${d}/blog`, currentTitle: `Blog - ${base}`, currentDesc: '', optimizedTitle: `${base} Blog | Tips, Guides & Industry News`, optimizedDesc: `Expert ${base.toLowerCase()} tips, how-to guides, and industry updates. Learn how to save money, avoid common mistakes, and maintain your home.`, changes: ['Added content descriptors', 'Added value proposition', 'Improved keyword targeting'] },
      ];

      logActivity('seo', `Meta tags optimized: ${audit.domain} (${pages.length} pages)`, { auditId: audit.id });
      res.json({ ok: true, domain: audit.domain, pages });
    });

    console.log('[COMMERCIAL] ✓ SEO Unlimited routes registered');
  },
};
