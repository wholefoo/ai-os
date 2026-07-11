// n8n PM2 launch config — canonical source for the hand-managed file on the VPS.
// Usage:
//   cp deploy/n8n-ecosystem.config.example.js /home/aios/n8n-ecosystem.config.js
//   # edit N8N_HOST / WEBHOOK_URL for your domain
//   sudo -iu aios pm2 start /home/aios/n8n-ecosystem.config.js && sudo -iu aios pm2 save
//
// Hard-won settings (2026-07-11, after an 86-restart "crash loop" that wasn't a crash):
// - max_memory_restart '2G': n8n idles at ~400-600MB. A cap at or below that (the 512M default
//   borrowed from the ai-os app) makes PM2 SIGINT it every ~12 minutes, forever. The shutdowns
//   are graceful, so the logs look healthy — only the ↺ restart counter gives it away.
// - exec_mode 'fork' is REQUIRED and must be explicit: setting `instances` at all flips PM2's
//   default to cluster mode, which wraps n8n in Node cluster IPC and can break its webhook
//   handling and SQLite locking under load.
// - N8N_DIAGNOSTICS_ENABLED 'false': kills the PostHog telemetry (and its deprecation-warning
//   log spam) — consistent with the platform's no-third-party-phone-home posture.
// - No N8N_BASIC_AUTH_* vars: removed in n8n 1.0 and silently ignored since. The editor is
//   protected by n8n's own user-management login — verify a login screen appears at /n8n
//   from a private browser window; if it doesn't, create the owner account immediately.
module.exports = {
  apps: [{
    name: 'n8n',
    script: '/usr/bin/n8n',
    cwd: '/home/aios',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      N8N_USER_FOLDER: '/home/aios/.n8n',      // workflows + credentials DB — survives restarts/re-creates
      N8N_HOST: 'yourdomain.com',
      N8N_PORT: 5678,
      N8N_PROTOCOL: 'https',
      N8N_PATH: '/n8n/',
      WEBHOOK_URL: 'https://yourdomain.com/n8n/',
      N8N_DIAGNOSTICS_ENABLED: 'false',
    },
  }],
};
