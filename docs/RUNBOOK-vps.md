# VPS Runbook — deploys, PM2, nginx, incidents

Hard-won operational knowledge for the production VPS (`/opt/ai-os`, app user `aios`, PM2 apps
`ai-os` / `agent-worker` / `n8n`, nginx in front, Cloudflare in front of nginx). Every entry here
was learned from a real incident — read the "why" lines before improvising.

## Standard deploy

```bash
cd /opt/ai-os && sudo -u aios git pull origin master
cd /opt/ai-os/commercial && sudo -u aios git pull origin master   # SEPARATE repo — two pushes = two pulls
sudo -iu aios pm2 restart ai-os --update-env
```

- **Always pull as `aios`.** A single root-run pull leaves root-owned objects in `.git/objects`
  and every later aios pull fails with "insufficient permission for adding an object".
  Fix: `sudo chown -R aios:aios /opt/ai-os` (and `/opt/ai-os/commercial`), then re-pull.
- **PM2 always via a login shell: `sudo -iu aios pm2 …`** — plain `sudo -u aios pm2 …` resolves
  the wrong Node binary and dies with `spawn /usr/bin/node EACCES`, and if that happens after a
  `pm2 kill` the site is DOWN until you rerun with `-iu`.
- Front-end changes may be cached by Cloudflare — if a deploy "doesn't show up", purge CF.
- Agent prompt files (`.claude/agents/*.md`) are read per-call — a pull alone updates them, no restart.

## PM2 gotchas

- **Group membership changes (e.g. `usermod -aG adm aios`) need a full daemon restart**, not an
  app restart: `pm2 save && pm2 kill && pm2 resurrect` (login shell!). Supplementary groups are
  inherited from the daemon, which keeps its groups from when it started.
- **`max_memory_restart` below an app's baseline = an invisible restart loop.** n8n idles at
  ~400–600MB; a 512M cap SIGINT'd it every ~12 min for 86 "graceful" restarts that looked healthy
  in logs. Only the ↺ counter gives it away. n8n's canonical config:
  `deploy/n8n-ecosystem.config.example.js` → `/home/aios/n8n-ecosystem.config.js` (2G cap,
  explicit `exec_mode: 'fork'` — setting `instances` alone silently flips PM2 to cluster mode,
  which breaks n8n webhooks/SQLite).
- After any process-list change: `sudo -iu aios pm2 save` so a reboot resurrects the good state.

## nginx / analytics attribution

- `log_format aios_vhost` lives in `/etc/nginx/conf.d/aios-logformat.conf`
  (source: `deploy/aios-logformat.conf`). It is http-level — it cannot go in a server block.
- The platform vhost AND every `aios-site-*` vhost need
  `access_log /var/log/nginx/access.log aios_vhost;` — new site vhosts get it from
  `deploy/hosting/site-vhost.sh`; the templates in `deploy/` are the canonical source.
- **Never `sed -i` files in `sites-enabled/`** — they are symlinks and sed -i replaces the link
  with a detached copy. Edit `sites-available/` and reload.
- Docs sub-pages need `try_files $uri $uri.html =404;` in the `/docs/` location (alias does no
  .html fallback → production-only 404s that local Express testing can never reproduce).
- Always `sudo nginx -t && sudo systemctl reload nginx`; the `listen ... http2` deprecation
  warnings are cosmetic (pending template modernization to `http2 on;`).
- The analytics ingester needs read access to the log: `sudo usermod -aG adm aios` + the PM2
  daemon-restart dance above. Verify with `sudo -u aios head -1 /var/log/nginx/access.log`.

## Quick health checks

```bash
sudo -iu aios pm2 ls                                   # all online, ↺ not climbing
curl -sI https://aiosorchestrationlab.com/api/health   # HTTP/2 200
sudo -u aios node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/opt/ai-os/.magent/analytics.sqlite');console.log(db.prepare('SELECT kind,COUNT(*) n FROM events_raw GROUP BY kind').all())"
tail -3 /var/log/nginx/access.log                      # lines should START with a hostname (vhost format)
```

## Incident patterns seen in production

| Symptom | Actual cause | Fix |
|---|---|---|
| `git pull` → "insufficient permission … .git/objects" | a past root-run pull | chown -R aios, re-pull |
| `spawn /usr/bin/node EACCES` from pm2 | non-login `sudo -u` shell | rerun with `sudo -iu aios` |
| App restarts every ~12 min, logs look graceful | `max_memory_restart` under baseline | raise cap (check `pm2 describe <app>`) |
| Deployed JS/CSS not visible on prod | Cloudflare cache | purge CF |
| /docs/<page> 404 only in prod | nginx alias, no .html fallback | try_files line (see above) |
| AI crawlers absent from analytics for days | Cloudflare "block AI scrapers" toggle | check CF Security → Bots |
| Log lines still IP-first after vhost rollout | lines predate the reload, or a vhost lacks the access_log line | `grep -rn aios_vhost /etc/nginx/sites-available/` |
