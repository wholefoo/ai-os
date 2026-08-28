// lib/analytics/ingest-logs.js
// ============================================================
//  Nginx access-log ingester — the layer that sees what GA can't. AI crawlers don't run JS,
//  so origin logs are the ONLY place GPTBot/ClaudeBot/PerplexityBot traffic exists. The vhosts
//  set `access_log off` for static assets, so the default combined log is already page-level.
//
//  Mechanics:
//   - Incremental: remembers a byte offset (+ file inode) in the analytics db (ingest_state);
//     each tick reads only the new bytes. Restart-safe, no double counting.
//   - Rotation-aware: inode change or size < offset ⇒ logrotate happened ⇒ start from 0.
//     (Rows written to the rotated-away file between the last tick and rotation are lost —
//     acceptable for analytics; the alternative is chasing .1 files for marginal rows.)
//   - Partial lines: only consumes up to the last '\n'; a half-written tail stays for next tick.
//   - Human rows are kept only for GET+2xx page-shaped paths (assets/API noise dropped);
//     bot rows keep every status — 404s served to AI crawlers are themselves a signal.
//
//  Combined format (has referrer + UA — both required):
//    $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"
//
//  P0 attributes everything to site_id='platform' — the stock combined format has no $host,
//  so per-Web-Studio-site attribution needs a log_format change (P1, deploy + ingester together).
// ============================================================

const fs = require('fs');
const crypto = require('crypto');
const { classifyUA, classifyReferrer } = require('./bots');
const adb = require('./db');

// Two accepted formats, tried in this order (a vhost line would MIS-parse as combined — its
// $host would be read as the IP — so vhost must match first; a combined line can never match
// the vhost regex because it has one fewer field before the timestamp):
//   aios_vhost: example.com 12.34.56.78 - - [08/Jul/2026:04:05:01 +0000] "GET /x HTTP/1.1" 200 5123 "ref" "ua"
//   combined:   12.34.56.78 - - [08/Jul/2026:04:05:01 +0000] "GET /x HTTP/1.1" 200 5123 "ref" "ua"
const VHOST_LINE_RE = /^(\S+) (\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;
const LINE_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// 08/Jul/2026:04:05:01 +0000 → ISO string (null if unparseable).
function parseNginxTime(s) {
  const m = String(s).match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m || !(m[2] in MONTHS)) return null;
  const [, d, mon, y, hh, mm, ss, tz] = m;
  const offMin = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const utcMs = Date.UTC(Number(y), MONTHS[mon], Number(d), Number(hh), Number(mm), Number(ss)) - offMin * 60000;
  return new Date(utcMs).toISOString();
}

const ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|mp4|webm|pdf|zip|txt|xml)(\?|$)/i;
// api/health/favicon + scanner probe paths. The platform is Node and hosted sites are static —
// any .php / wp-* / Joomla path is a vulnerability scanner, and multi-domain catch-all vhosts
// answer them with soft-200s (the homepage), so the 2xx filter alone doesn't drop them.
const SKIP_PATH_RE = /^\/(api|health|favicon)|^\/wp-|\.php(\?|$)|^\/\.|^\/(plugins|administrator|cgi-bin|vendor|phpmyadmin)\//i;

// Credential-probe SHAPES — deliberately not a list of filenames, because the next scanner will
// try a name nobody wrote down.
//
// This is checked BEFORE the bot branch, and that ordering is the whole point: `classifyUA` is a
// substring match on the User-Agent, which is ATTACKER-CONTROLLED. Real logs from this deployment
// show `Claude-User` and `ChatGPT-User` fetching `/phpinfo.php`, `/credentials.json` and
// `/firebase-adminsdk.json` — requests no AI crawler makes. Because the bot branch returned early,
// those spoofed scans were recorded as live AI retrieval and inflated the metric roughly SEVENFOLD
// (8,076 "live" hits, of which 222 were genuine platform page fetches).
//
// Scans are RECORDED, not dropped: being probed is real signal. They get kind:'scan', which the
// rollup writer ignores (it gates on kind === 'bot'), so they stay out of bot_hits/bot_page while
// remaining queryable in events_raw for security review.
const SCANNER_PATH_RE = new RegExp([
  '(^|/)\\.[a-z]',                                   // /.env  /.git/config  /backend/.env
  '^/@',                                             // /@fs/... Vite path-traversal probes
  '\\.php($|\\?)',                                   // any PHP on a Node/static host
  '^/wp-',                                           // WordPress
  '^/(plugins|administrator|cgi-bin|vendor|phpmyadmin|actuator)(/|$)',
  '\\.(env|key|pem|pfx|p12|sql|bak|old|tfstate)($|\\?)',   // /sendgrid.env /server.key /terraform.tfstate
  // root-anchored generic config names scanners try verbatim
  '^/(env|config|settings|keys?|secrets?|credentials?|backup)\\.(json|ya?ml|txt|xml)($|\\?)',
  // keyword + a config-ish extension, so a legitimate article like /blog/secrets-of-x is untouched
  '/[^/]*(credential|secret|serviceaccount|service-account|adminsdk|privatekey|passwd)[^/]*\\.[a-z0-9]+($|\\?)',
].join('|'), 'i');

// Daily-rotating salt: HMAC(secret, YYYY-MM-DD). Deterministic within a day (restart-safe
// uniques) but unlinkable across days without the secret, which never leaves the process env.
function visitorHash(secret, ip, ua, day) {
  const salt = crypto.createHmac('sha256', String(secret || 'ai-os')).update(day).digest();
  return crypto.createHmac('sha256', salt).update(`${ip}|${ua}`).digest('hex').slice(0, 24);
}

// Parse one access-log line (aios_vhost or combined) → event object | null. The event carries
// `host` (null on combined lines) so the caller can attribute it to a hosted site.
function parseLine(line, { secret } = {}) {
  let host = null, ip, timeLocal, method, rawPath, statusStr, ref, ua;
  const vm = VHOST_LINE_RE.exec(line);
  if (vm) {
    [, host, ip, timeLocal, method, rawPath, statusStr, ref, ua] = vm;
    host = String(host).toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '') || null;
    if (host === '-') host = null; // $host can be '-' on malformed requests
  } else {
    const m = LINE_RE.exec(line);
    if (!m) return null;
    [, ip, timeLocal, method, rawPath, statusStr, ref, ua] = m;
  }
  const ts = parseNginxTime(timeLocal);
  if (!ts) return null;
  const status = Number(statusStr);
  const path = rawPath.split('?')[0].slice(0, 500);

  const bot = classifyUA(ua);
  if (bot) {
    // A credential probe is a scan whatever the UA claims — see SCANNER_PATH_RE. `purpose` is set
    // to NULL rather than carried over on purpose: it is the field meaning "this was a real AI
    // retrieval", and a query filtering `purpose='live'` WITHOUT also filtering kind would
    // otherwise re-introduce exactly the bug this fixes. (That query has already been written once,
    // by me, while investigating this.) The claimed engine/bot are kept — knowing WHAT it
    // impersonated is the forensic value.
    if (SCANNER_PATH_RE.test(path)) {
      return { ts, host, kind: 'scan', engine: bot.engine, bot: bot.bot, purpose: null, path, status };
    }
    // Every genuine AI-bot request is signal, including 404s and robots.txt/llms.txt fetches.
    return { ts, host, kind: 'bot', engine: bot.engine, bot: bot.bot, purpose: bot.purpose, path, status };
  }

  // Humans: pageviews only — GET, 2xx, page-shaped path.
  if (method !== 'GET' || status < 200 || status >= 300) return null;
  if (ASSET_RE.test(rawPath) || SKIP_PATH_RE.test(path)) return null;
  // Humans present as browsers: require the Mozilla/ prefix real browsers have carried for 30
  // years. Drops Go-http-client, python-requests, curl, URL-as-UA scanners, and one-off research
  // crawlers (ShopifyIntelResearch, monitor-telegram-clone, ...) that a token blocklist can't keep
  // up with. Real-log finding: these were the top source of phantom "pageviews".
  if (!ua.startsWith('Mozilla/')) return null;
  // Mozilla-prefixed non-AI crawlers/tools: skip so Googlebot & co. don't inflate pageviews.
  if (/bot|crawler|spider|crawling|slurp|research|monitor|scan\b|watch\/|httpclient|python-requests|curl\/|wget\/|headless/i.test(ua)) return null;
  const utm = (rawPath.match(/[?&]utm_source=([^&\s"]+)/i) || [])[1];
  const refc = classifyReferrer(ref, utm && decodeURIComponent(utm));
  return {
    ts, host, kind: 'human', path, status,
    ref: (ref && ref !== '-') ? ref.slice(0, 300) : null,
    refClass: refc.class, engine: refc.engine || null,
    visitorHash: visitorHash(secret, ip, ua, ts.slice(0, 10)),
  };
}

// Read new bytes since the stored offset, handling rotation. Returns raw chunk + new offset.
function readNewBytes(logPath) {
  let st;
  try { st = fs.statSync(logPath); } catch { return null; }  // no log file (dev box) → no-op
  const stateKey = `log:${logPath}`;
  let prev = { ino: null, offset: 0 };
  try { prev = JSON.parse(adb.getState(stateKey) || '{}'); } catch { /* fresh */ }
  let offset = Number(prev.offset) || 0;
  if (prev.ino !== undefined && prev.ino !== null && String(prev.ino) !== String(st.ino)) offset = 0; // rotated (new inode)
  if (st.size < offset) offset = 0;                                                                  // truncated/copytruncate
  if (st.size === offset) { adb.setState(stateKey, JSON.stringify({ ino: st.ino, offset })); return { chunk: '', offset, stateKey, ino: st.ino }; }

  const len = Math.min(st.size - offset, 8 * 1024 * 1024);  // cap a burst at 8MB per tick
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(logPath, 'r');
  try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
  return { chunk: buf.toString('utf8'), offset, stateKey, ino: st.ino };
}

// One ingest pass. Returns { events, consumed } (0s when idle). Exported for tests —
// tests point it at a fixture file with a throwaway db.
function ingestOnce({ logPath, secret, siteId = 'platform', resolveSite, onBotEvent } = {}) {
  const r = readNewBytes(logPath);
  if (!r) return { events: 0, consumed: 0 };
  const { chunk, offset, stateKey, ino } = r;
  if (!chunk) return { events: 0, consumed: 0 };

  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl === -1) return { events: 0, consumed: 0 };          // half-written line — wait
  const complete = chunk.slice(0, lastNl);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1;

  const events = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    const ev = parseLine(line, { secret });
    if (ev) {
      // Vhost-format lines carry the serving host — attribute to the Web Studio site that owns
      // that domain; everything else (combined lines, the platform's own domains, unknown hosts)
      // falls back to the default bucket.
      ev.siteId = (ev.host && typeof resolveSite === 'function' && resolveSite(ev.host)) || siteId;
      delete ev.host;
      events.push(ev);
    }
  }
  adb.insertEvents(events);
  adb.setState(stateKey, JSON.stringify({ ino, offset: offset + consumed }));
  if (onBotEvent) for (const ev of events) if (ev.kind === 'bot') { try { onBotEvent(ev); } catch { /* listener must not kill ingest */ } }
  return { events: events.length, consumed };
}

// Boot-time loop: tick every intervalMs; nightly raw prune. Silent no-op while the log file
// doesn't exist (dev boxes) — starts working the moment it appears.
function startIngest({ logPath, secret, intervalMs = 30000, resolveSite, onBotEvent, log = () => {} } = {}) {
  let lastPrune = 0;
  const tick = () => {
    try {
      const r = ingestOnce({ logPath, secret, resolveSite, onBotEvent });
      if (r.events) log(`[analytics] ingested ${r.events} event(s)`);
      if (Date.now() - lastPrune > 86400000) { lastPrune = Date.now(); const n = adb.pruneRaw(30); if (n) log(`[analytics] pruned ${n} raw event(s)`); }
    } catch (e) { log(`[analytics] ingest error: ${e.message}`); }
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();
  return timer;
}

module.exports = { startIngest, ingestOnce, parseLine };
