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
      // Log files
      error_file: './logs/ai-os-err.log',
      out_file: './logs/ai-os-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 8000,
      // Auto-restart on crash, but not on clean exit
      min_uptime: 5000,
      max_restarts: 10,
    },

    // --- Hermes MCP Server (persistent background worker) ---
    // Uncomment when Hermes is ready for deployment
    // {
    //   name: 'hermes-mcp',
    //   script: 'hermes/server.js',
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '256M',
    //   env_production: {
    //     NODE_ENV: 'production',
    //     PORT: 8420,
    //   },
    //   error_file: './logs/hermes-err.log',
    //   out_file: './logs/hermes-out.log',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   merge_logs: true,
    //   kill_timeout: 10000,
    // },
  ],
};
