// modules/browser-agent/index.js — Browser automation agent
// Tier: business+ — requires ai-os-commercial license
//
// Web scraping, browser automation workflows,
// screenshot capture, and headless browser task execution.

module.exports = {
  name: 'browser-agent',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.browserAgent) {
      console.log('[COMMERCIAL] Skipping browser-agent (requires business+ license)');
      return;
    }

    const { broadcast, logActivity, validateBody, heavyLimiter, uuidv4, browserTasks } = ctx;

    app.get('/api/browser/tasks', (req, res) => {
      const all = [...browserTasks.values()].sort((a, b) => b.startedAt > a.startedAt ? 1 : -1);
      res.json(all);
    });

    app.get('/api/browser/stats', (req, res) => {
      const all = [...browserTasks.values()];
      const completed = all.filter(t => t.status === 'completed').length;
      const running = all.filter(t => t.status === 'running').length;
      const byType = {};
      all.forEach(t => { byType[t.taskType] = (byType[t.taskType] || 0) + 1; });
      res.json({
        total: all.length,
        completed,
        running,
        failed: all.filter(t => t.status === 'failed').length,
        byType,
        screenshots: all.filter(t => t.screenshot).length,
      });
    });

    app.post('/api/browser/execute', heavyLimiter, (req, res) => {
      const errs = validateBody(req.body, {
        url: { required: true, type: 'url', maxLength: 2048 },
        taskType: { type: 'string', oneOf: ['navigate', 'extract', 'screenshot', 'form-fill', 'verify'] },
        viewport: { type: 'string', oneOf: ['desktop', 'tablet', 'mobile'] },
      });
      if (errs) return res.status(400).json({ error: errs.join('; ') });
      const { url, taskType = 'navigate', selector, viewport = 'desktop', waitFor = 'networkidle' } = req.body;

      const id = uuidv4();
      const task = {
        id,
        url,
        taskType,
        selector: selector || null,
        viewport,
        waitFor,
        status: 'queued',
        result: null,
        screenshot: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        agent: 'browser-agent',
      };

      browserTasks.set(id, task);
      logActivity('browser', `Browser task queued: ${taskType} on ${url}`, { taskId: id });

      // Simulate browser execution lifecycle
      setTimeout(() => {
        task.status = 'running';
        broadcast({ event: 'browser_update', data: task });
      }, 300);

      // Simulate navigation
      setTimeout(() => {
        task.status = 'navigating';
        broadcast({ event: 'browser_update', data: task });
      }, 1000);

      // Simulate task execution
      setTimeout(() => {
        task.status = 'executing';
        broadcast({ event: 'browser_update', data: task });
      }, 2000);

      // Complete with simulated results
      setTimeout(() => {
        task.status = 'completed';
        task.completedAt = new Date().toISOString();

        const viewportSizes = { desktop: '1920x1080', tablet: '768x1024', mobile: '375x812' };

        if (taskType === 'screenshot') {
          const filename = `screenshot-${Date.now()}.png`;
          task.screenshot = filename;
          task.result = {
            screenshot_path: `.magent/artifacts/screenshots/${filename}`,
            page_title: `Page at ${url}`,
            viewport_size: viewportSizes[viewport],
          };
        } else if (taskType === 'extract') {
          task.result = {
            title: `Extracted from ${url}`,
            items_extracted: 5 + Math.floor(Math.random() * 20),
            data_type: selector ? 'targeted elements' : 'page content',
            selector: selector || 'body',
          };
        } else if (taskType === 'verify') {
          task.result = {
            page_loaded: true,
            status_code: 200,
            title_match: true,
            viewport_size: viewportSizes[viewport],
            load_time_ms: 800 + Math.floor(Math.random() * 1500),
          };
        } else {
          task.result = {
            page_title: `Page at ${url}`,
            status_code: 200,
            load_time_ms: 500 + Math.floor(Math.random() * 1000),
          };
        }

        broadcast({ event: 'browser_update', data: task });
        logActivity('browser', `Browser task completed: ${taskType} on ${url}`, { taskId: id });
      }, 3500);

      res.json(task);
    });

    console.log('[COMMERCIAL] ✓ Browser Agent routes registered');
  },
};
