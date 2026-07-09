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

// 12.34.56.78 - - [08/Jul/2026:04:05:01 +0000] "GET /pricing HTTP/1.1" 200 5123 "https://chatgpt.com/" "Mozilla/5.0 ..."
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
const SKIP_PATH_RE = /^\/(api|health|favicon)/;

// Daily-rotating salt: HMAC(secret, YYYY-MM-DD). Deterministic within a day (restart-safe
// uniques) but unlinkable across days without the secret, which never leaves the process env.
function visitorHash(secret, ip, ua, day) {
  const salt = crypto.createHmac('sha256', String(secret || 'ai-os')).update(day).digest();
  return crypto.createHmac('sha256', salt).update(`${ip}|${ua}`).digest('hex').slice(0, 24);
}

// Parse one combined-format line → event object | null (not interesting / unparseable).
function parseLine(line, { secret } = {}) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, ip, timeLocal, method, rawPath, statusStr, ref, ua] = m;
  const ts = parseNginxTime(timeLocal);
  if (!ts) return null;
  const status = Number(statusStr);
  const path = rawPath.split('?')[0].slice(0, 500);

  const bot = classifyUA(ua);
  if (bot) {
    // Every AI-bot request is signal, including 404s and robots.txt/llms.txt fetches.
    return { ts, kind: 'bot', engine: bot.engine, bot: bot.bot, purpose: bot.purpose, path, status };
  }

  // Humans: pageviews only — GET, 2xx, page-shaped path.
  if (method !== 'GET' || status < 200 || status >= 300) return null;
  if (ASSET_RE.test(rawPath) || SKIP_PATH_RE.test(path)) return null;
  // Other (non-AI) crawlers: skip so Googlebot doesn't inflate "pageviews".
  if (/bot|crawler|spider|crawling|slurp|httpclient|python-requests|curl\/|wget\//i.test(ua)) return null;
  const utm = (rawPath.match(/[?&]utm_source=([^&\s"]+)/i) || [])[1];
  const refc = classifyReferrer(ref, utm && decodeURIComponent(utm));
  return {
    ts, kind: 'human', path, status,
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
function ingestOnce({ logPath, secret, siteId = 'platform', onBotEvent } = {}) {
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
    if (ev) { ev.siteId = siteId; events.push(ev); }
  }
  adb.insertEvents(events);
  adb.setState(stateKey, JSON.stringify({ ino, offset: offset + consumed }));
  if (onBotEvent) for (const ev of events) if (ev.kind === 'bot') { try { onBotEvent(ev); } catch { /* listener must not kill ingest */ } }
  return { events: events.length, consumed };
}

// Boot-time loop: tick every intervalMs; nightly raw prune. Silent no-op while the log file
// doesn't exist (dev boxes) — starts working the moment it appears.
function startIngest({ logPath, secret, intervalMs = 30000, onBotEvent, log = () => {} } = {}) {
  let lastPrune = 0;
  const tick = () => {
    try {
      const r = ingestOnce({ logPath, secret, onBotEvent });
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
