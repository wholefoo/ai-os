module.exports = {
  apps: [
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

    // --- LiveKit Voice Agent Worker ---
    // Real-time avatar pipeline: Deepgram STT → Claude LLM → Cartesia TTS
    {
      name: 'agent-worker',
      script: 'agent-worker/agent.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      node_args: '--experimental-modules',
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: './logs/agent-worker-err.log',
      out_file: './logs/agent-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      kill_timeout: 10000,
    },
  ],
};
