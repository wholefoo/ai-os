# Production hardening and deployment

Read when: touching auth, security headers, rate limits, state persistence, or the deploy path.
The security INVARIANTS (client isolation, `CLIENT_API_ALLOW`, broadcast scoping, untrusted-text
fencing) live in the root `CLAUDE.md` — this file is the configuration around them.

## Production Hardening
- **Auth**: Bearer token via `API_TOKEN` env var; middleware gates all `/api/` routes (except `/api/health`)
- **Security headers**: Helmet with CSP (self + fonts.googleapis + ws/wss), X-Frame-Options, HSTS
- **CORS**: Same-origin only by default in production (the dashboard is served from this origin); set `CORS_ORIGIN` (comma-separated) to allow specific external origins. Dev stays open (`*`).
- **Self-check gate**: `tools/seclint.js` runs as a PostToolUse hook on every edit + the "Security lint" step of the CI "Lint & Boot Check" job; keep the tree at 0 errors. ERROR rules: missing auth on mutating routes, path traversal, shell-string `exec`, and generated-site JSON-LD breakout; `innerHTML`-unescaped is WARN. Run the `/self-check` skill before committing.
- **Rate limiting**: 120 req/min global API; 10 req/min on heavy POST operations (batch, grok, media, browser, clone-url, 3d, vibe-design). Anonymous routes that spend money per request (free audit, helpdesk, site chat) need more than a limiter — see `.claude/rules/public-cost-endpoints.md`.
- **Input validation**: `validateBody()` with type/required/maxLength/oneOf/min/max rules on critical POST endpoints
- **Compression**: gzip via `compression` middleware
- **Request logging**: `morgan` (dev mode to console, production to `access.log`)
- **WebSocket auth**: Token verification on upgrade; heartbeat every 30s drops stale connections
- **Graceful shutdown**: SIGTERM/SIGINT handlers save state to `.magent/state/`, close WS connections, timeout after 5s
- **State persistence**: Auto-save (debounced 2s) of activity log, cost ledger, grok queries, notifications to JSON files in `.magent/state/`
- **Error handling**: Global Express error handler + uncaughtException/unhandledRejection process handlers
- **DEMO_MODE**: Env flag (default true) distinguishing simulated data from real API integrations
- **Health endpoint**: `GET /api/health` returns uptime, memory, version, demo mode, node env
- **Telegram/Slack**: Real HTTP calls to Telegram Bot API and Slack Incoming Webhooks for notifications
- **Client resilience**: WebSocket auto-reconnect with exponential backoff + visible reconnection banner

## Deployment
- **PM2**: `ecosystem.config.js` with auto-restart, log rotation, production env vars
- **Nginx**: `deploy/nginx.conf` with TLS (Let's Encrypt), WS upgrade, static caching, rate limiting, sensitive path blocking
- **Docker**: `Dockerfile` (node:20-alpine) + `docker-compose.yml` with health checks and volume mounts
- **VPS install**: `deploy/install-vps.sh` — one-script provisioning (UFW, Node 20, PM2, Nginx, Certbot)
- **Production binding**: Server binds `127.0.0.1` in production (behind Nginx), `0.0.0.0` in dev

> Ops procedures and the incident table are in `docs/RUNBOOK-vps.md`. On the VPS the app runs as
> `aios` — always `sudo -iu aios pm2 …`; `pm2` as root hits an empty second daemon and a deploy can
> look clean while old code serves.
