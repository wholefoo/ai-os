// modules/video-meetings/index.js — Video meeting rooms with AI agents
// Tier: business+ — requires ai-os-commercial license
//
// Video avatar meeting rooms with AI agent participants,
// real-time multi-agent conversations, and meeting management.

module.exports = {
  name: 'video-meetings',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.videoMeetings) {
      console.log('[COMMERCIAL] Skipping video-meetings (requires business+ license)');
      return;
    }

    const { requirePlan, settings, executeAgent, ORG_CHART, MASTER_TENANT_ID } = ctx;

    // GET /api/meetings/capabilities — check if video meetings are available
    app.get('/api/meetings/capabilities', (req, res) => {
      const hasGemini = !!(settings.ai?.gemini_api_key);
      res.json({
        ok: true,
        videoEnabled: hasGemini,
        features: {
          singleAgent: true,
          multiAgent: hasGemini,
          screenShare: true,
          whiteboard: true,
          recording: false, // future
        },
        requiredKeys: hasGemini ? [] : ['GEMINI_API_KEY'],
      });
    });

    // POST /api/meetings/create — create a meeting room
    app.post('/api/meetings/create', requirePlan('pro'), (req, res) => {
      const { participants, topic, mode } = req.body;
      if (!participants || !Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required (agent names)' });
      }
      if (participants.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 participants per meeting' });
      }

      const meetingId = `mtg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const meeting = {
        id: meetingId,
        participants: participants.map(name => {
          const profile = ORG_CHART.departments.flatMap(d => d.employees).find(e => e.name.toLowerCase() === name.toLowerCase());
          return {
            name: profile?.name || name,
            title: profile?.title || 'Custom Agent',
            agent: profile?.agent || 'orchestrator',
            avatar: profile?.avatar || '\u{1F916}',
          };
        }),
        topic: topic || 'General Discussion',
        mode: mode || 'roundtable', // 'single', 'roundtable', 'panel'
        status: 'active',
        createdAt: new Date().toISOString(),
        messages: [],
      };

      // Store in memory for active meetings
      if (!global.activeMeetings) global.activeMeetings = {};
      global.activeMeetings[meetingId] = meeting;

      // Auto-cleanup after 2 hours
      setTimeout(() => { delete global.activeMeetings?.[meetingId]; }, 2 * 60 * 60 * 1000);

      res.json({ ok: true, meeting });
    });

    // POST /api/meetings/:id/message — send a message in a meeting
    app.post('/api/meetings/:id/message', requirePlan('pro'), async (req, res) => {
      const meeting = global.activeMeetings?.[req.params.id];
      if (!meeting) return res.status(404).json({ error: 'Meeting not found or expired' });

      const { text, targetParticipant } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      meeting.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });

      // Determine which participants respond
      const respondents = targetParticipant
        ? meeting.participants.filter(p => p.name.toLowerCase() === targetParticipant.toLowerCase())
        : meeting.mode === 'roundtable' ? meeting.participants : [meeting.participants[0]];

      const responses = [];
      const recentHistory = meeting.messages.slice(-12).map(m => `${m.speaker || m.role}: ${m.content}`).join('\n');

      for (const participant of respondents) {
        try {
          const meetingContext = `You are in a video meeting as ${participant.name} (${participant.title}).
Topic: ${meeting.topic}
Other participants: ${meeting.participants.filter(p => p.name !== participant.name).map(p => `${p.name} (${p.title})`).join(', ')}
Mode: ${meeting.mode}

Stay in character. Be concise — this is a live meeting, not a report. Address others by name when relevant. Respond in 2-4 sentences unless asked for detail.

Recent conversation:
${recentHistory}`;

          const result = await executeAgent(participant.agent, text, meetingContext, req.session.tenantId || MASTER_TENANT_ID);
          const reply = {
            role: 'assistant',
            speaker: participant.name,
            title: participant.title,
            avatar: participant.avatar,
            content: result.content || result.error || 'No response',
            timestamp: new Date().toISOString(),
          };
          meeting.messages.push(reply);
          responses.push(reply);
        } catch (e) {
          responses.push({ speaker: participant.name, content: `[Error: ${e.message}]`, timestamp: new Date().toISOString() });
        }
      }

      res.json({ ok: true, responses });
    });

    // DELETE /api/meetings/:id — end a meeting
    app.delete('/api/meetings/:id', requirePlan('pro'), (req, res) => {
      if (global.activeMeetings?.[req.params.id]) {
        const meeting = global.activeMeetings[req.params.id];
        meeting.status = 'ended';
        delete global.activeMeetings[req.params.id];
        res.json({ ok: true, summary: `Meeting ended. ${meeting.messages.length} messages exchanged.` });
      } else {
        res.status(404).json({ error: 'Meeting not found' });
      }
    });

    // GET /api/meetings/:id — get meeting state
    app.get('/api/meetings/:id', requirePlan('pro'), (req, res) => {
      const meeting = global.activeMeetings?.[req.params.id];
      if (!meeting) return res.status(404).json({ error: 'Meeting not found or expired' });
      res.json({ ok: true, meeting });
    });

    console.log('[COMMERCIAL] ✓ Video Meetings routes registered');
  },
};
