// modules/lead-gen/index.js — Lead generation and pipeline management
// Tier: business+ — requires ai-os-commercial license
//
// Lead pipeline (scrape, enrich, outreach), campaign management,
// marketing hub (pipelines, channels, content queue).

module.exports = {
  name: 'lead-gen',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.leadGen) {
      console.log('[COMMERCIAL] Skipping lead-gen (requires business+ license)');
      return;
    }

    const { broadcast, heavyLimiter, loadState, saveState } = ctx;

    // --- Lead Pipeline Data (persisted to disk) ---
    const leadPipeline = loadState('lead_pipeline', { leads: [], campaigns: [] });

    // --- Marketing Hub Data (persisted to disk) ---
    const marketingHub = loadState('marketing_hub', { pipelines: [], channels: [], contentQueue: [] });

    // --- Lead Routes ---

    app.get('/api/leads', (req, res) => {
      res.json(leadPipeline.leads);
    });

    app.get('/api/leads/stats', (req, res) => {
      const l = leadPipeline.leads;
      res.json({
        total: l.length,
        scraped: l.filter(x => x.status === 'scraped').length,
        enriched: l.filter(x => x.status === 'enriched').length,
        sent: l.filter(x => x.status === 'sent').length,
        replied: l.filter(x => x.status === 'replied').length,
        avgScore: Math.round(l.reduce((s, x) => s + x.score, 0) / l.length),
        openRate: l.filter(x => x.sentAt).length ? Math.round(l.filter(x => x.openedAt).length / l.filter(x => x.sentAt).length * 100) : 0,
        replyRate: l.filter(x => x.sentAt).length ? Math.round(l.filter(x => x.repliedAt).length / l.filter(x => x.sentAt).length * 100) : 0,
        campaigns: leadPipeline.campaigns.length,
      });
    });

    app.get('/api/leads/campaigns', (req, res) => {
      res.json(leadPipeline.campaigns);
    });

    app.post('/api/leads/scrape', heavyLimiter, (req, res) => {
      const { company, role, platform } = req.body;
      const lead = {
        id: `lead-${Date.now()}`,
        company: company || 'Unknown',
        contact: 'Discovering...',
        role: role || 'Decision Maker',
        platform: platform || 'linkedin',
        status: 'scraped',
        score: Math.floor(Math.random() * 20) + 70,
        achievement: null,
        outreach: null, sentAt: null, openedAt: null, repliedAt: null,
      };
      leadPipeline.leads.unshift(lead);
      saveState('lead_pipeline', leadPipeline);
      broadcast({ event: 'lead_update', data: lead });
      // Simulate enrichment
      setTimeout(() => {
        lead.status = 'enriched';
        lead.contact = 'AI-Discovered Contact';
        lead.achievement = 'Notable achievement discovered via enrichment';
        saveState('lead_pipeline', leadPipeline);
        broadcast({ event: 'lead_update', data: lead });
      }, 4000);
      res.json(lead);
    });

    app.post('/api/leads/:id/outreach', (req, res) => {
      const lead = leadPipeline.leads.find(l => l.id === req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      lead.outreach = 'personalized';
      lead.status = 'sent';
      lead.sentAt = new Date().toISOString();
      saveState('lead_pipeline', leadPipeline);
      broadcast({ event: 'lead_update', data: lead });
      res.json(lead);
    });

    // --- Marketing Hub Routes ---

    app.get('/api/marketing/pipelines', (req, res) => {
      res.json(marketingHub.pipelines);
    });

    app.get('/api/marketing/channels', (req, res) => {
      res.json(marketingHub.channels);
    });

    app.get('/api/marketing/queue', (req, res) => {
      res.json(marketingHub.contentQueue);
    });

    app.get('/api/marketing/stats', (req, res) => {
      const totalFollowers = marketingHub.channels.reduce((s, c) => s + (c.followers || 0), 0);
      const totalPosts = marketingHub.channels.reduce((s, c) => s + c.posts30d, 0);
      res.json({
        totalFollowers,
        totalPosts30d: totalPosts,
        activePipelines: marketingHub.pipelines.filter(p => p.status === 'active').length,
        queuedContent: marketingHub.contentQueue.length,
        avgEngagement: (marketingHub.channels.filter(c => c.engagement).reduce((s, c) => s + c.engagement, 0) / marketingHub.channels.filter(c => c.engagement).length).toFixed(1),
        channels: marketingHub.channels.length,
      });
    });

    app.post('/api/marketing/queue', (req, res) => {
      const { title, channel, type } = req.body;
      const item = {
        id: `cq-${Date.now()}`,
        title: title || 'Untitled Content',
        channel: channel || 'linkedin',
        status: 'draft',
        scheduledFor: null,
        type: type || 'post',
      };
      marketingHub.contentQueue.unshift(item);
      saveState('marketing_hub', marketingHub);
      broadcast({ event: 'marketing_update', data: item });
      res.json(item);
    });

    console.log('[COMMERCIAL] ✓ Lead Gen routes registered');

    // ── Product Factory ──────────────────────────────────────────────
    if (!ctx.features.productFactory) {
      console.log('[COMMERCIAL] Skipping product-factory (requires business+ license)');
      return;
    }

    const { productFactory } = ctx;

    app.get('/api/products', (req, res) => {
      res.json(productFactory.products);
    });

    app.get('/api/products/stats', (req, res) => {
      const p = productFactory.products;
      const published = p.filter(x => x.status === 'published');
      res.json({
        total: p.length,
        published: published.length,
        draft: p.filter(x => x.status === 'draft').length,
        generating: p.filter(x => x.status === 'generating').length,
        totalRevenue: published.reduce((s, x) => s + x.revenue, 0),
        totalSales: published.reduce((s, x) => s + x.sales, 0),
        avgRating: published.filter(x => x.rating).length ? (published.reduce((s, x) => s + (x.rating || 0), 0) / published.filter(x => x.rating).length).toFixed(1) : null,
        platforms: { etsy: published.filter(x => x.platform === 'etsy').length, gumroad: published.filter(x => x.platform === 'gumroad').length },
      });
    });

    app.get('/api/products/templates', (req, res) => {
      res.json(productFactory.templates);
    });

    app.post('/api/products', (req, res) => {
      const { name, type, platform, price, template, features } = req.body;
      const product = {
        id: `prod-${Date.now()}`,
        name: name || 'Untitled Product',
        type: type || 'spreadsheet',
        platform: platform || 'etsy',
        status: 'generating',
        price: price || 9.99,
        sales: 0, revenue: 0, rating: null,
        createdAt: new Date().toISOString(),
        template: template || null,
        features: features || [],
      };
      productFactory.products.unshift(product);
      broadcast({ event: 'product_update', data: product });
      // Simulate generation
      setTimeout(() => {
        product.status = 'draft';
        broadcast({ event: 'product_update', data: product });
      }, 5000);
      res.json(product);
    });

    console.log('[COMMERCIAL] ✓ Product Factory routes registered');
  },
};
