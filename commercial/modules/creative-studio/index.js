// modules/creative-studio/index.js — Creative Studio department
// Tier: business+ — requires ai-os-commercial license
//
// Media production, vibe design, 3D rendering (Blender MCP),
// and Omni multimodal generation routes.

module.exports = {
  name: 'creative-studio',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.creativeStudio) {
      console.log('[COMMERCIAL] Skipping creative-studio (requires business+ license)');
      return;
    }

    const { broadcast, logActivity, heavyLimiter, requireAdmin, uuidv4,
            costLedger, settings, DEMO_MODE, COST_RATES, GEMINI_OMNI_MODEL,
            callGemini, generateOmniResult } = ctx;

    // ---------------------------------------------------------------
    // In-memory data
    // ---------------------------------------------------------------

    const mediaProductions = [
      {
        id: 'media-1',
        title: 'Weekly PR Summary Video',
        type: 'remotion',
        status: 'completed',
        template: 'pr-recap',
        duration: '2:34',
        resolution: '1920x1080',
        params: { repo: 'ai-os', period: 'weekly', style: 'minimal' },
        output: '.magent/artifacts/media/pr-recap-w21.mp4',
        createdAt: new Date(Date.now() - 172800000).toISOString(),
        completedAt: new Date(Date.now() - 170000000).toISOString(),
        cost: 0.00,
        engine: 'remotion-local',
      },
      {
        id: 'media-2',
        title: 'Product Demo: Dashboard Tour',
        type: 'video',
        status: 'completed',
        template: 'product-demo',
        duration: '1:45',
        resolution: '1920x1080',
        params: { scenes: 5, avatar: 'professional', music: 'ambient' },
        output: '.magent/artifacts/media/demo-dashboard-v2.mp4',
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        completedAt: new Date(Date.now() - 82000000).toISOString(),
        cost: 0.45,
        engine: 'google-vids',
      },
      {
        id: 'media-3',
        title: '3D Office Environment',
        type: '3d',
        status: 'completed',
        template: 'scene-generation',
        resolution: '2048x2048',
        params: { prompt: 'Modern tech office with holographic displays', lighting: 'dramatic', style: 'photorealistic' },
        output: '.magent/artifacts/media/office-3d-render.png',
        createdAt: new Date(Date.now() - 43200000).toISOString(),
        completedAt: new Date(Date.now() - 40000000).toISOString(),
        cost: 0.12,
        engine: 'blender-mcp',
      },
      {
        id: 'media-4',
        title: 'Social Ad Variations (Batch)',
        type: 'remotion',
        status: 'queued',
        template: 'social-ad',
        resolution: '1080x1080',
        params: { variations: 12, platform: 'instagram', cta: 'Learn More' },
        output: null,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        completedAt: null,
        cost: 0.00,
        engine: 'remotion-local',
      },
    ];

    const mediaTemplates = [
      { id: 'pr-recap', name: 'PR Recap Video', engine: 'remotion', duration: '2-3min', params: ['repo', 'period', 'style'] },
      { id: 'product-demo', name: 'Product Demo', engine: 'google-vids', duration: '1-3min', params: ['scenes', 'avatar', 'music'] },
      { id: 'social-ad', name: 'Social Ad Generator', engine: 'remotion', duration: '15-30s', params: ['variations', 'platform', 'cta'] },
      { id: 'scene-generation', name: '3D Scene', engine: 'blender-mcp', duration: 'N/A', params: ['prompt', 'lighting', 'style'] },
      { id: 'explainer', name: 'Explainer Video', engine: 'google-vids', duration: '3-5min', params: ['topic', 'audience', 'tone'] },
      { id: 'data-viz', name: 'Data Visualization', engine: 'remotion', duration: '30-60s', params: ['dataset', 'chart_type', 'animation'] },
    ];

    const vibeDesign = {
      projects: [
        { id: 'vd-1', name: 'SaaS Landing Page', method: 'prompt', status: 'completed', screens: 4, style: 'minimal-tech', inputs: { prompt: 'Modern SaaS landing with gradient hero, feature cards, pricing table' }, heatmap: true, interactions: 12, createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), completedAt: new Date(Date.now() - 1.8 * 86400000).toISOString() },
        { id: 'vd-2', name: 'Mobile Onboarding Flow', method: 'sketch', status: 'completed', screens: 5, style: 'playful', inputs: { sketch: 'onboarding-sketch.png' }, heatmap: true, interactions: 8, createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), completedAt: new Date(Date.now() - 4.7 * 86400000).toISOString() },
        { id: 'vd-3', name: 'Dashboard Redesign', method: 'voice', status: 'iterating', screens: 3, style: 'data-dense', inputs: { voice: 'I need a dashboard with real-time metrics, dark mode, and a sidebar nav' }, heatmap: false, interactions: 6, createdAt: new Date(Date.now() - 1 * 86400000).toISOString(), completedAt: null },
        { id: 'vd-4', name: 'E-commerce Product Page', method: 'url', status: 'generating', screens: 0, style: 'luxe', inputs: { url: 'https://reference-store.com/product' }, heatmap: false, interactions: 0, createdAt: new Date().toISOString(), completedAt: null },
      ],
      controls: {
        density: { min: 0, max: 100, default: 50 },
        hue: { min: 0, max: 360, default: 240 },
        roundness: { min: 0, max: 100, default: 60 },
        spacing: { min: 0, max: 100, default: 50 },
      },
    };

    const blender3d = {
      scenes: [
        { id: '3d-1', name: 'Futuristic Office', status: 'rendered', engine: 'blender-mcp', resolution: '2048x2048', style: 'photorealistic', lighting: 'dramatic', objects: 12, renderTime: '4m 23s', fileSize: '8.4 MB', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), prompt: 'Modern tech office with holographic displays and ambient lighting' },
        { id: '3d-2', name: 'Product Showcase', status: 'rendered', engine: 'blender-mcp', resolution: '4096x4096', style: 'studio', lighting: 'three-point', objects: 3, renderTime: '2m 11s', fileSize: '12.1 MB', createdAt: new Date(Date.now() - 7 * 86400000).toISOString(), prompt: 'Sleek SaaS product box floating on dark gradient with reflections' },
        { id: '3d-3', name: 'Abstract Data Viz', status: 'rendering', engine: 'blender-mcp', resolution: '1920x1080', style: 'abstract', lighting: 'neon', objects: 48, renderTime: null, fileSize: null, createdAt: new Date(Date.now() - 3600000).toISOString(), prompt: 'Abstract 3D bar chart rising from dark surface with glowing edges' },
        { id: '3d-4', name: 'Hero Background', status: 'queued', engine: 'blender-mcp', resolution: '3840x2160', style: 'gradient-mesh', lighting: 'ambient', objects: 0, renderTime: null, fileSize: null, createdAt: new Date().toISOString(), prompt: 'Organic mesh gradient background with floating geometric shapes' },
      ],
      presets: [
        { id: 'preset-studio', name: 'Studio Lighting', lighting: 'three-point', style: 'clean' },
        { id: 'preset-dramatic', name: 'Dramatic', lighting: 'dramatic', style: 'cinematic' },
        { id: 'preset-neon', name: 'Neon Glow', lighting: 'neon', style: 'cyberpunk' },
        { id: 'preset-natural', name: 'Natural', lighting: 'hdri', style: 'photorealistic' },
      ],
    };

    // ---------------------------------------------------------------
    // Media Production routes (4 routes)
    // ---------------------------------------------------------------

    app.get('/api/media/productions', (req, res) => {
      res.json(mediaProductions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    });

    app.get('/api/media/templates', (req, res) => {
      res.json(mediaTemplates);
    });

    app.get('/api/media/stats', (req, res) => {
      const completed = mediaProductions.filter(p => p.status === 'completed');
      const totalCost = completed.reduce((sum, p) => sum + (p.cost || 0), 0);
      const byEngine = {};
      mediaProductions.forEach(p => { byEngine[p.engine] = (byEngine[p.engine] || 0) + 1; });
      const byType = {};
      mediaProductions.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });

      res.json({
        total: mediaProductions.length,
        completed: completed.length,
        queued: mediaProductions.filter(p => p.status === 'queued').length,
        rendering: mediaProductions.filter(p => p.status === 'rendering').length,
        totalCost,
        byEngine,
        byType,
        templates: mediaTemplates.length,
      });
    });

    app.post('/api/media/produce', heavyLimiter, (req, res) => {
      const { title, template, params = {} } = req.body;
      if (!title || !template) return res.status(400).json({ error: 'Title and template required' });

      const tmpl = mediaTemplates.find(t => t.id === template);
      const id = require('crypto').randomUUID();
      const production = {
        id,
        title,
        type: tmpl ? (tmpl.engine === 'blender-mcp' ? '3d' : 'remotion') : 'video',
        status: 'queued',
        template,
        resolution: params.resolution || '1920x1080',
        params,
        output: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        cost: 0,
        engine: tmpl?.engine || 'remotion-local',
      };

      mediaProductions.unshift(production);
      broadcast({ event: 'media_update', data: production });
      logActivity('media', `Media production queued: ${title} (${template})`, { productionId: id });

      // Simulate rendering
      setTimeout(() => {
        production.status = 'rendering';
        broadcast({ event: 'media_update', data: production });
      }, 1000);

      setTimeout(() => {
        production.status = 'completed';
        production.completedAt = new Date().toISOString();
        production.output = `.magent/artifacts/media/${template}-${Date.now()}.mp4`;
        production.cost = Math.random() * 0.5;
        production.duration = `${Math.floor(Math.random() * 3) + 1}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
        broadcast({ event: 'media_update', data: production });
        logActivity('media', `Media production completed: ${title}`);
      }, 6000);

      res.json(production);
    });

    // ---------------------------------------------------------------
    // Vibe Design Studio routes (5 routes)
    // ---------------------------------------------------------------

    app.get('/api/vibe-design/projects', (req, res) => {
      res.json(vibeDesign.projects);
    });

    app.get('/api/vibe-design/stats', (req, res) => {
      const p = vibeDesign.projects;
      res.json({
        totalProjects: p.length,
        completed: p.filter(x => x.status === 'completed').length,
        iterating: p.filter(x => x.status === 'iterating').length,
        generating: p.filter(x => x.status === 'generating').length,
        totalScreens: p.reduce((s, x) => s + x.screens, 0),
        heatmapsGenerated: p.filter(x => x.heatmap).length,
        avgInteractions: Math.round(p.reduce((s, x) => s + x.interactions, 0) / p.length),
      });
    });

    app.get('/api/vibe-design/controls', (req, res) => {
      res.json(vibeDesign.controls);
    });

    app.post('/api/vibe-design/projects', heavyLimiter, (req, res) => {
      const { name, method, style, prompt } = req.body;
      const project = {
        id: `vd-${Date.now()}`,
        name: name || 'Untitled Design',
        method: method || 'prompt',
        status: 'generating',
        screens: 0,
        style: style || 'modern',
        inputs: { prompt: prompt || '' },
        heatmap: false,
        interactions: 0,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      vibeDesign.projects.unshift(project);
      broadcast({ event: 'vibe_design_update', data: project });
      setTimeout(() => {
        project.status = 'iterating';
        project.screens = Math.floor(Math.random() * 4) + 2;
        broadcast({ event: 'vibe_design_update', data: project });
      }, 4000);
      res.json(project);
    });

    app.post('/api/vibe-design/:id/heatmap', (req, res) => {
      const project = vibeDesign.projects.find(p => p.id === req.params.id);
      if (!project) return res.status(404).json({ error: 'Not found' });
      project.heatmap = true;
      const heatmapData = {
        zones: [
          { x: 20, y: 15, intensity: 0.95, label: 'Hero CTA' },
          { x: 50, y: 35, intensity: 0.78, label: 'Feature section' },
          { x: 50, y: 55, intensity: 0.65, label: 'Social proof' },
          { x: 50, y: 75, intensity: 0.82, label: 'Pricing table' },
          { x: 80, y: 10, intensity: 0.45, label: 'Navigation' },
        ],
        prediction: 'Users most likely to focus on Hero CTA (95%) and Pricing (82%). Consider moving social proof above the fold.',
      };
      res.json(heatmapData);
    });

    // ---------------------------------------------------------------
    // 3D Production (Blender MCP) routes (4 routes)
    // ---------------------------------------------------------------

    app.get('/api/3d/scenes', (req, res) => {
      res.json(blender3d.scenes);
    });

    app.get('/api/3d/stats', (req, res) => {
      const s = blender3d.scenes;
      res.json({
        total: s.length,
        rendered: s.filter(x => x.status === 'rendered').length,
        rendering: s.filter(x => x.status === 'rendering').length,
        queued: s.filter(x => x.status === 'queued').length,
        totalObjects: s.reduce((sum, x) => sum + x.objects, 0),
        presets: blender3d.presets.length,
      });
    });

    app.get('/api/3d/presets', (req, res) => {
      res.json(blender3d.presets);
    });

    app.post('/api/3d/scenes', heavyLimiter, (req, res) => {
      const { name, prompt, style, lighting, resolution } = req.body;
      const scene = {
        id: `3d-${Date.now()}`,
        name: name || 'Untitled Scene',
        status: 'queued',
        engine: 'blender-mcp',
        resolution: resolution || '2048x2048',
        style: style || 'photorealistic',
        lighting: lighting || 'dramatic',
        objects: 0,
        renderTime: null,
        fileSize: null,
        createdAt: new Date().toISOString(),
        prompt: prompt || '',
      };
      blender3d.scenes.unshift(scene);
      broadcast({ event: '3d_update', data: scene });
      setTimeout(() => {
        scene.status = 'rendering';
        scene.objects = Math.floor(Math.random() * 20) + 3;
        broadcast({ event: '3d_update', data: scene });
      }, 2000);
      setTimeout(() => {
        scene.status = 'rendered';
        scene.renderTime = `${Math.floor(Math.random() * 5) + 1}m ${Math.floor(Math.random() * 59)}s`;
        scene.fileSize = `${(Math.random() * 15 + 2).toFixed(1)} MB`;
        broadcast({ event: '3d_update', data: scene });
      }, 8000);
      res.json(scene);
    });

    // ---------------------------------------------------------------
    // Omni multimodal generation routes (2 routes)
    // ---------------------------------------------------------------

    app.post('/api/omni/generate', requireAdmin, async (req, res) => {
      const { type, prompt, inputs } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

      const validTypes = ['video', 'image', 'audio', 'thumbnail', 'social-clip'];
      const outputType = validTypes.includes(type) ? type : 'video';

      const jobId = uuidv4();
      const job = {
        id: jobId,
        type: outputType,
        prompt,
        inputs: inputs || {},
        status: 'processing',
        progress: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
        result: null,
      };

      logActivity('omni', `Omni ${outputType} generation started`, { jobId, prompt: prompt.substring(0, 80) });
      broadcast({ event: 'omni_job_started', data: { id: jobId, type: outputType } });

      if (!DEMO_MODE && settings.ai.gemini_api_key) {
        // Real Gemini generation
        (async () => {
          broadcast({ event: 'omni_job_progress', data: { id: jobId, progress: 30, status: 'generating', msg: `Sending to Gemini Omni for ${outputType} generation...` } });
          try {
            const result = await callGemini(
              `You are a creative content generator. Generate a detailed ${outputType} concept based on the user's prompt. Describe what the ${outputType} would contain, its structure, style, and key elements. Be specific and production-ready.`,
              prompt, 2048
            );
            broadcast({ event: 'omni_job_progress', data: { id: jobId, progress: 80, status: 'finalizing', msg: 'Finalizing output...' } });

            job.progress = 100;
            job.status = 'complete';
            job.completedAt = new Date().toISOString();
            job.result = {
              prompt, model: GEMINI_OMNI_MODEL, watermark: 'SynthID', generatedAt: new Date().toISOString(),
              content: result.content,
              preview: `Generated ${outputType} concept — ${result.content.substring(0, 100)}...`,
              inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            };

            const rates = COST_RATES['gemini-omni'];
            const cost = (result.inputTokens / 1_000_000) * rates.input + (result.outputTokens / 1_000_000) * rates.output;
            costLedger.push({ id: uuidv4(), agent: `omni-${outputType}`, model: 'gemini-omni', skill: `${outputType}-generation`, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: Math.round(cost * 10000) / 10000, timestamp: new Date().toISOString() });

            broadcast({ event: 'omni_job_complete', data: { id: jobId, type: outputType, result: job.result } });
            logActivity('omni', `Omni ${outputType} complete (real)`, { jobId });
          } catch (e) {
            job.status = 'error';
            broadcast({ event: 'omni_job_complete', data: { id: jobId, type: outputType, result: { preview: `Error: ${e.message}`, prompt } } });
          }
        })();
      } else if (DEMO_MODE) {
        // Simulate progressive generation
        const steps = [
          { progress: 20, status: 'analyzing', msg: 'Analyzing input modalities...' },
          { progress: 45, status: 'composing', msg: `Composing ${outputType} elements...` },
          { progress: 70, status: 'rendering', msg: `Rendering ${outputType} output...` },
          { progress: 90, status: 'finalizing', msg: 'Applying SynthID watermark & quality check...' },
          { progress: 100, status: 'complete', msg: 'Generation complete' },
        ];

        steps.forEach((step, i) => {
          setTimeout(() => {
            job.progress = step.progress;
            job.status = step.status;
            broadcast({ event: 'omni_job_progress', data: { id: jobId, ...step } });

            if (step.progress === 100) {
              job.status = 'complete';
              job.completedAt = new Date().toISOString();
              job.result = generateOmniResult(outputType, prompt);
              broadcast({ event: 'omni_job_complete', data: { id: jobId, type: outputType, result: job.result } });
              logActivity('omni', `Omni ${outputType} complete: ${prompt.substring(0, 50)}`, { jobId });

              // Track cost
              const inputTokens = 2000 + Math.floor(Math.random() * 5000);
              const outputTokens = outputType === 'video' ? 50000 + Math.floor(Math.random() * 100000) : 10000 + Math.floor(Math.random() * 20000);
              const rates = COST_RATES['gemini-omni'];
              const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
              costLedger.push({
                id: uuidv4(), agent: `omni-${outputType}`, model: 'gemini-omni', skill: `${outputType}-generation`,
                inputTokens, outputTokens, cost: Math.round(cost * 10000) / 10000, timestamp: new Date().toISOString(),
              });
            }
          }, (i + 1) * 1500);
        });
      }

      res.json({ ok: true, jobId, type: outputType, status: 'processing' });
    });

    app.get('/api/omni/job/:id', requireAdmin, (req, res) => {
      // In demo mode, return simulated status from broadcast events
      res.json({ ok: true, message: 'Job status available via WebSocket events' });
    });

    console.log('[COMMERCIAL] ✓ Creative Studio routes registered');
  },
};
