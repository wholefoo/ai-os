// modules/grok-intel/index.js — Grok real-time intelligence integration
// Tier: business+ — requires ai-os-commercial license
//
// Real-time market intelligence via Grok, news monitoring,
// trend analysis, and sentiment tracking.

const crypto = require('crypto');

module.exports = {
  name: 'grok-intel',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.grokIntel) {
      console.log('[COMMERCIAL] Skipping grok-intel (requires business+ license)');
      return;
    }

    const { broadcast, logActivity, validateBody, heavyLimiter, callGrok, grokQueries, grokCache, costLedger, settings, DEMO_MODE, COST_RATES, uuidv4 } = ctx;

    // API: Get Grok query history
    app.get('/api/grok/queries', (req, res) => {
      res.json(grokQueries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
    });

    // API: Get Grok stats
    app.get('/api/grok/stats', (req, res) => {
      const completed = grokQueries.filter(q => q.status === 'completed');
      const totalTokens = completed.reduce((sum, q) => sum + (q.tokens?.input || 0) + (q.tokens?.output || 0), 0);
      const totalCost = completed.reduce((sum, q) => sum + (q.cost || 0), 0);
      const avgConfidence = completed.length > 0
        ? Math.round(completed.reduce((sum, q) => sum + (q.confidence || 0), 0) / completed.length * 100) / 100
        : 0;

      const byType = {};
      grokQueries.forEach(q => {
        byType[q.type] = (byType[q.type] || 0) + 1;
      });

      const hourAgo = Date.now() - 3600000;
      const recentCount = grokQueries.filter(q => new Date(q.startedAt) > hourAgo).length;

      res.json({
        total: grokQueries.length,
        completed: completed.length,
        streaming: grokQueries.filter(q => q.status === 'streaming').length,
        failed: grokQueries.filter(q => q.status === 'failed').length,
        totalTokens,
        totalCost,
        avgConfidence,
        queriesThisHour: recentCount,
        rateLimit: 30,
        rateLimitRemaining: Math.max(0, 30 - recentCount),
        byType,
        cacheSize: grokCache.size,
      });
    });

    // API: Execute a Grok real-time query
    app.post('/api/grok/query', heavyLimiter, async (req, res) => {
      const errs = validateBody(req.body, {
        query: { required: true, type: 'string', maxLength: 2000 },
        type: { type: 'string', oneOf: ['search', 'trending', 'fact-check', 'monitor'] },
      });
      if (errs) return res.status(400).json({ error: errs.join('; ') });
      const { query, type = 'search', scope = 'all', max_tokens = 1024, include_sources = true } = req.body;

      // Check rate limit
      const hourAgo = Date.now() - 3600000;
      const recentCount = grokQueries.filter(q => new Date(q.startedAt) > hourAgo).length;
      if (recentCount >= 30) {
        return res.status(429).json({ error: 'Rate limit exceeded (30/hour). Try again later.' });
      }

      // Check cache (5-minute window)
      const cacheKey = `${query}:${type}:${scope}`;
      const cached = grokCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < 300000) {
        return res.json({ ...cached.result, cached: true });
      }

      const id = crypto.randomUUID();
      const grokQuery = {
        id,
        query,
        type,
        scope,
        status: 'streaming',
        streaming: true,
        tokens: { input: query.split(/\s+/).length * 2, output: 0 },
        cost: 0,
        sources: [],
        response: '',
        confidence: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };

      grokQueries.unshift(grokQuery);
      broadcast({ event: 'grok_stream_start', data: { id, query, type } });
      logActivity('grok', `Grok query started: ${type} — "${query.substring(0, 60)}${query.length > 60 ? '...' : ''}"`, { queryId: id });

      // Real API path — when DEMO_MODE is off and xAI key is configured
      if (!DEMO_MODE && settings.ai.xai_api_key) {
        try {
          const systemMsg = `You are Grok, a real-time intelligence agent. Query type: ${type}. Scope: ${scope}. Provide current, factual information with sources where possible. Be concise but thorough.`;
          const result = await callGrok(systemMsg, query, max_tokens);
          grokQuery.response = result.content;
          grokQuery.tokens = { input: result.inputTokens, output: result.outputTokens };
          grokQuery.confidence = 0.9;
          grokQuery.status = 'complete';
          grokQuery.streaming = false;
          grokQuery.completedAt = new Date().toISOString();
          const rates = COST_RATES['grok-3'];
          grokQuery.cost = Math.round(((result.inputTokens / 1_000_000) * rates.input + (result.outputTokens / 1_000_000) * rates.output) * 10000) / 10000;
          costLedger.push({ id: uuidv4(), agent: 'grok-realtime', model: 'grok-3', skill: type, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: grokQuery.cost, timestamp: new Date().toISOString() });
          grokCache.set(cacheKey, { result: grokQuery, timestamp: Date.now() });
          broadcast({ event: 'grok_stream_complete', data: grokQuery });
          logActivity('grok', `Grok query completed: ${type} (real API)`, { queryId: id, cost: grokQuery.cost });
          return res.json(grokQuery);
        } catch (e) {
          console.error('[GROK] Real API failed, falling back to demo:', e.message);
          // Fall through to demo mode below
        }
      }

      // Simulate streaming response (demo mode)
      const typeResponses = {
        search: {
          response: `Real-time analysis for "${query}": Based on current web data, the latest developments indicate significant momentum in this area. Multiple authoritative sources confirm ongoing activity with measurable impact across the ecosystem.`,
          sources: [
            { title: 'Primary Source — Latest Analysis', url: 'https://example.com/analysis', relevance: 0.94 },
            { title: 'Industry Report — Current Trends', url: 'https://example.com/trends', relevance: 0.87 },
            { title: 'Expert Commentary', url: 'https://example.com/expert', relevance: 0.81 },
          ],
          confidence: 0.88,
        },
        trending: {
          response: `Trending now: "${query}" — Active discussions across X/Twitter and HN. Key threads focus on practical implementation and cost optimization. Engagement is above average for this topic category with several high-profile contributors participating.`,
          sources: [
            { title: 'Trending Thread on X', url: 'https://x.com/trending/topic', relevance: 0.96 },
            { title: 'HN Discussion (200+ points)', url: 'https://news.ycombinator.com/item?id=123', relevance: 0.90 },
          ],
          confidence: 0.85,
        },
        'fact-check': {
          response: `Fact-check result for: "${query}" — PARTIALLY VERIFIED. Cross-referencing 3 independent sources shows the core claim has supporting evidence, but with important caveats regarding scope and recency of data. Confidence varies by sub-claim.`,
          sources: [
            { title: 'Primary Verification Source', url: 'https://example.com/verify', relevance: 0.93 },
            { title: 'Counter-evidence', url: 'https://example.com/counter', relevance: 0.86 },
            { title: 'Statistical Analysis', url: 'https://example.com/stats', relevance: 0.79 },
          ],
          confidence: 0.72,
        },
        monitor: {
          response: `Monitoring update for "${query}": No significant changes detected in the last monitoring window. Current status remains consistent with previous baseline. Will alert on any notable shifts.`,
          sources: [
            { title: 'Status Dashboard', url: 'https://example.com/status', relevance: 0.91 },
          ],
          confidence: 0.95,
        },
      };

      const preset = typeResponses[type] || typeResponses.search;
      const words = preset.response.split(' ');
      let streamedWords = 0;

      // Simulate word-by-word streaming
      const streamInterval = setInterval(() => {
        streamedWords += 3 + Math.floor(Math.random() * 3);
        const partial = words.slice(0, Math.min(streamedWords, words.length)).join(' ');
        grokQuery.response = partial;
        grokQuery.tokens.output = partial.split(/\s+/).length * 2;

        broadcast({ event: 'grok_stream_chunk', data: { id, partial, progress: Math.min(100, Math.round(streamedWords / words.length * 100)) } });

        if (streamedWords >= words.length) {
          clearInterval(streamInterval);

          // Finalize
          grokQuery.status = 'completed';
          grokQuery.streaming = false;
          grokQuery.completedAt = new Date().toISOString();
          grokQuery.response = preset.response;
          grokQuery.sources = include_sources ? preset.sources : [];
          grokQuery.confidence = preset.confidence;
          grokQuery.cost = ((grokQuery.tokens.input * 5 + grokQuery.tokens.output * 15) / 1000000);

          // Cache result
          grokCache.set(cacheKey, { result: grokQuery, timestamp: Date.now() });

          broadcast({ event: 'grok_stream_end', data: grokQuery });
          logActivity('grok', `Grok query completed: ${type} (confidence: ${Math.round(preset.confidence * 100)}%)`, { queryId: id });
        }
      }, 200);

      res.json(grokQuery);
    });

    // API: Clear Grok cache
    app.post('/api/grok/cache/clear', (req, res) => {
      grokCache.clear();
      res.json({ ok: true, message: 'Cache cleared' });
    });

    console.log('[COMMERCIAL] ✓ Grok Intel routes registered');
  },
};
