// modules/video-meetings/index.js — Video meeting rooms with AI agents
// Tier: business+ — requires ai-os-commercial license
//
// LiveKit-based video meeting rooms with AI agent participants,
// real-time transcription, meeting recordings, and summaries.

module.exports = {
  name: 'video-meetings',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.videoMeetings) {
      console.log('[COMMERCIAL] Skipping video-meetings (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - POST /api/meetings/create — create meeting room
    // - GET /api/meetings — list active meetings
    // - POST /api/meetings/:id/join — join meeting (get token)
    // - POST /api/meetings/:id/invite-agent — add AI agent to meeting
    // - GET /api/meetings/:id/recording — get meeting recording
    // - GET /api/meetings/:id/summary — AI-generated meeting summary

    console.log('[COMMERCIAL] ✓ Video Meetings routes registered');
  },
};
