// modules/youtube-intel/index.js — YouTube video analysis with Claude Vision
// Tier: business+ — requires ai-os-commercial license
//
// Analyzes YouTube videos: metadata extraction, frame capture,
// transcript extraction, Claude Vision analysis, and insight synthesis.

module.exports = {
  name: 'youtube-intel',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.youtubeIntel) {
      console.log('[COMMERCIAL] Skipping youtube-intel (requires business+ license)');
      return;
    }

    const { broadcast, logActivity, uuidv4, saveState,
            ytAnalyses, costLedger, settings, DEMO_MODE, BASE, COST_RATES,
            YT_ANALYSIS_DIR, fs, path, callAnthropic, OPUS_MODEL,
            generateYTVideoInfo, generateYTTranscript, generateYTFrames,
            generateYTVisualAnalysis, generateYTSummary, generateYTInsights,
            runRealYouTubeAnalysis } = ctx;

    // POST /api/youtube/analyze — start a YouTube video analysis
    app.post('/api/youtube/analyze', ctx.requireAdmin, async (req, res) => {
      const { url, frameInterval, analysisType } = req.body;
      if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

      // Validate YouTube URL
      const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
      if (!ytMatch) return res.status(400).json({ error: 'Invalid YouTube URL — must be a youtube.com or youtu.be link' });

      const videoId = ytMatch[1];
      const analysisId = uuidv4();
      const interval = frameInterval || 10; // seconds between frames
      const type = analysisType || 'full'; // full, visual-only, transcript-only

      const analysis = {
        id: analysisId,
        videoId,
        url: url.trim(),
        status: 'processing',
        type,
        frameInterval: interval,
        startedAt: new Date().toISOString(),
        completedAt: null,
        videoInfo: null,
        transcript: null,
        frames: [],
        visualAnalysis: [],
        summary: null,
        insights: null,
      };

      ytAnalyses.push(analysis);
      broadcast({ event: 'yt_analysis_started', data: { id: analysisId, videoId } });
      logActivity('youtube', `Video analysis started: ${videoId}`, { analysisId, type });

      // Real YouTube analysis pipeline
      if (!DEMO_MODE && settings.ai.anthropic_api_key) {
        runRealYouTubeAnalysis(analysis, analysisId, interval, type).catch(e => {
          console.error('[YOUTUBE] Real analysis failed:', e.message);
          analysis.status = 'complete';
          analysis.completedAt = new Date().toISOString();
          analysis.summary = { overview: `Analysis failed: ${e.message}`, keyTopics: [], contentType: 'Error', technicalLevel: 'N/A', actionability: 'N/A' };
          analysis.insights = [{ type: 'extraction', insight: `Pipeline error: ${e.message}. Ensure yt-dlp and ffmpeg are installed on the server.`, confidence: 1.0 }];
          saveState('yt_analyses', ytAnalyses);
          broadcast({ event: 'yt_analysis_complete', data: { id: analysisId, videoId: analysis.videoId } });
        });
      }
      else if (DEMO_MODE) {
        // Simulate the analysis pipeline
        const steps = [
          { delay: 1500, status: 'fetching_info', msg: 'Fetching video metadata...' },
          { delay: 3000, status: 'extracting_frames', msg: `Extracting frames every ${interval}s...` },
          { delay: 5000, status: 'transcribing', msg: 'Extracting transcript...' },
          { delay: 7000, status: 'analyzing_frames', msg: 'Claude Vision analyzing frames...' },
          { delay: 9500, status: 'synthesizing', msg: 'Synthesizing visual + transcript analysis...' },
          { delay: 11000, status: 'complete', msg: 'Analysis complete' },
        ];

        steps.forEach(step => {
          setTimeout(() => {
            analysis.status = step.status;
            broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: step.status, msg: step.msg } });

            if (step.status === 'complete') {
              analysis.completedAt = new Date().toISOString();
              analysis.videoInfo = generateYTVideoInfo(videoId);
              analysis.transcript = generateYTTranscript();
              analysis.frames = generateYTFrames(interval);
              analysis.visualAnalysis = generateYTVisualAnalysis(analysis.frames);
              analysis.summary = generateYTSummary(analysis);
              analysis.insights = generateYTInsights(analysis);
              saveState('yt_analyses', ytAnalyses);
              broadcast({ event: 'yt_analysis_complete', data: { id: analysisId, videoId } });
              logActivity('youtube', `Video analysis complete: ${videoId}`, { analysisId });

              // Track cost
              const inputTokens = 15000 + analysis.frames.length * 2000;
              const outputTokens = 5000 + analysis.frames.length * 500;
              const rates = COST_RATES['opus-4.8-high'];
              costLedger.push({
                id: uuidv4(), agent: 'youtube-analyzer', model: 'opus-4.8-high', skill: 'video-analysis',
                inputTokens, outputTokens,
                cost: Math.round(((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output) * 10000) / 10000,
                timestamp: new Date().toISOString(),
              });
            }
          }, step.delay);
        });
      }

      res.json({ ok: true, analysisId, videoId, type });
    });

    // GET /api/youtube/analyses — list all analyses
    app.get('/api/youtube/analyses', ctx.requireAdmin, (req, res) => {
      res.json(ytAnalyses.map(a => ({
        id: a.id, videoId: a.videoId, url: a.url, status: a.status, type: a.type,
        startedAt: a.startedAt, completedAt: a.completedAt,
        title: a.videoInfo?.title || null,
        duration: a.videoInfo?.duration || null,
        frameCount: a.frames?.length || 0,
      })));
    });

    // GET /api/youtube/analysis/:id — full analysis detail
    app.get('/api/youtube/analysis/:id', ctx.requireAdmin, (req, res) => {
      const analysis = ytAnalyses.find(a => a.id === req.params.id);
      if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
      res.json(analysis);
    });

    console.log('[COMMERCIAL] ✓ YouTube Intel routes registered');
  },
};
