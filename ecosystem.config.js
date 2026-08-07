// PM2 process definitions. The voice agent-worker is registered only when its
// prerequisites exist — otherwise PM2 crash-loops on missing deps/keys forever.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');

const apps = [
  // --- Main AI OS Server ---
  {
    name: 'ai-os',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      DEMO_MODE: 'true',
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      DEMO_MODE: 'false',
    },
    error_file: './logs/ai-os-err.log',
    out_file: './logs/ai-os-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    kill_timeout: 5000,
    listen_timeout: 8000,
    min_uptime: 5000,
    max_restarts: 10,
  },
];

// --- LiveKit Voice Agent Worker (optional) ---
// Real-time avatar pipeline: Deepgram STT → LLM → Cartesia TTS.
// Requires its own install (cd agent-worker && npm ci --omit=dev) plus API keys.
// `npm ci`, not `npm install`: agent-worker has had a committed package-lock.json since DEP-02, and
// its five @livekit/* deps used to be pinned to `latest` — no upper bound at all, so a major
// breaking release would install silently on any fresh box. ci installs exactly the pinned tree.
const voiceKeysConfigured = process.env.LIVEKIT_URL
  && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
  && process.env.DEEPGRAM_API_KEY && process.env.CARTESIA_API_KEY;
const voiceDepsInstalled = fs.existsSync(path.join(__dirname, 'agent-worker', 'node_modules', '@livekit', 'agents'));

if (voiceKeysConfigured && voiceDepsInstalled) {
  apps.push({
    name: 'agent-worker',
    script: 'agent-worker/agent.js',
    args: 'start', // LiveKit Agents CLI subcommand — without it the worker prints usage and exits
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: './logs/agent-worker-err.log',
    out_file: './logs/agent-worker-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    kill_timeout: 10000,
    min_uptime: 5000,
    max_restarts: 10,
    restart_delay: 5000,
  });
} else {
  const missing = [];
  if (!voiceKeysConfigured) missing.push('LIVEKIT_URL + LiveKit/Deepgram/Cartesia keys in .env');
  if (!voiceDepsInstalled) missing.push('agent-worker dependencies (cd agent-worker && npm ci --omit=dev)');
  console.log(`[PM2] agent-worker skipped — missing: ${missing.join(' + ')}`);
}

module.exports = { apps };
