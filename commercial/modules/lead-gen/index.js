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

    const { broadcast, heavyLimiter } = ctx;

    // --- Lead Pipeline Data ---
    const leadPipeline = {
      leads: [
        { id: 'lead-1', company: 'TechFlow Inc', contact: 'Sarah Chen', role: 'VP Engineering', platform: 'linkedin', status: 'enriched', score: 92, achievement: 'Scaled team from 5 to 40 engineers in 18 months', outreach: 'personalized', sentAt: new Date(Date.now() - 2 * 86400000).toISOString(), openedAt: new Date(Date.now() - 1.5 * 86400000).toISOString(), repliedAt: null },
        { id: 'lead-2', company: 'DataVerse AI', contact: 'Marcus Johnson', role: 'CTO', platform: 'linkedin', status: 'replied', score: 88, achievement: 'Led $15M Series A funding round', outreach: 'personalized', sentAt: new Date(Date.now() - 5 * 86400000).toISOString(), openedAt: new Date(Date.now() - 4.5 * 86400000).toISOString(), repliedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
        { id: 'lead-3', company: 'CloudScale Systems', contact: 'Emily Rodriguez', role: 'Head of Product', platform: 'linkedin', status: 'sent', score: 85, achievement: 'Launched product to 100K users in first quarter', outreach: 'personalized', sentAt: new Date(Date.now() - 1 * 86400000).toISOString(), openedAt: null, repliedAt: null },
        { id: 'lead-4', company: 'NeuralPath Labs', contact: 'James Park', role: 'CEO', platform: 'email', status: 'scraped', score: 79, achievement: 'YC W24 batch, raised $3.2M seed', outreach: null, sentAt: null, openedAt: null, repliedAt: null },
        { id: 'lead-5', company: 'QuantumLeap SaaS', contact: 'Aisha Patel', role: 'Director of Growth', platform: 'linkedin', status: 'enriched', score: 91, achievement: 'Grew ARR from $2M to $8M in one year', outreach: 'draft', sentAt: null, openedAt: null, repliedAt: null },
        { id: 'lead-6', company: 'MetaForge Analytics', contact: 'David Kim', role: 'VP Sales', platform: 'email', status: 'scraped', score: 73, achievement: 'Built enterprise sales team generating $50M pipeline', outreach: null, sentAt: null, openedAt: null, repliedAt: null },
      ],
      campaigns: [
        { id: 'camp-1', name: 'AI Startup Founders', target: 'CEOs/CTOs at AI startups (Series A-B)', leads: 24, sent: 18, opened: 12, replied: 4, status: 'active' },
        { id: 'camp-2', name: 'SaaS Growth Leaders', target: 'Growth/Marketing leads at $2-10M ARR SaaS', leads: 31, sent: 22, opened: 15, replied: 6, status: 'active' },
        { id: 'camp-3', name: 'Enterprise DevTool Buyers', target: 'VP Eng at 500+ employee companies', leads: 15, sent: 0, opened: 0, replied: 0, status: 'draft' },
      ],
    };

    // --- Marketing Hub Data ---
    const marketingHub = {
      pipelines: [
        { id: 'mkt-1', name: 'YouTube → Multi-Platform', source: 'youtube', status: 'active', outputs: ['linkedin', 'x-twitter', 'email', 'blog'], lastRun: new Date(Date.now() - 3600000).toISOString(), totalRuns: 18, conversions: { linkedin: 34, twitter: 52, email: 89, blog: 12 } },
        { id: 'mkt-2', name: 'Blog → Social Distribution', source: 'blog', status: 'active', outputs: ['linkedin', 'x-twitter', 'threads', 'newsletter'], lastRun: new Date(Date.now() - 7200000).toISOString(), totalRuns: 42, conversions: { linkedin: 156, twitter: 203, threads: 67, newsletter: 412 } },
        { id: 'mkt-3', name: 'Podcast → Content Atoms', source: 'podcast', status: 'paused', outputs: ['audiogram', 'quote-cards', 'blog', 'x-twitter'], lastRun: new Date(Date.now() - 72 * 3600000).toISOString(), totalRuns: 8, conversions: { audiogram: 5, quotes: 24, blog: 3, twitter: 18 } },
      ],
      channels: [
        { id: 'ch-linkedin', name: 'LinkedIn', followers: 2847, posts30d: 22, engagement: 4.8, growth: '+12%' },
        { id: 'ch-twitter', name: 'X / Twitter', followers: 5231, posts30d: 45, engagement: 2.1, growth: '+8%' },
        { id: 'ch-email', name: 'Email List', followers: 1203, posts30d: 8, engagement: 38.2, growth: '+15%' },
        { id: 'ch-blog', name: 'Blog', followers: null, posts30d: 6, engagement: null, growth: '+22%' },
      ],
      contentQueue: [
        { id: 'cq-1', title: 'AI OS Architecture Deep-Dive', channel: 'linkedin', status: 'scheduled', scheduledFor: new Date(Date.now() + 3600000).toISOString(), type: 'carousel' },
        { id: 'cq-2', title: 'Thread: 5 Lessons from Building Multi-Agent Systems', channel: 'x-twitter', status: 'scheduled', scheduledFor: new Date(Date.now() + 7200000).toISOString(), type: 'thread' },
        { id: 'cq-3', title: 'Weekly Newsletter: Agentic Workflows', channel: 'email', status: 'draft', scheduledFor: null, type: 'newsletter' },
        { id: 'cq-4', title: 'Vibe Design: From Sketch to UI in 30s', channel: 'linkedin', status: 'generating', scheduledFor: null, type: 'video' },
      ],
    };

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
      broadcast({ event: 'lead_update', data: lead });
      // Simulate enrichment
      setTimeout(() => {
        lead.status = 'enriched';
        lead.contact = 'AI-Discovered Contact';
        lead.achievement = 'Notable achievement discovered via enrichment';
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
