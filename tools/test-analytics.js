// Fixture-driven test of lib/analytics: parse → classify → store → rollup → query → rotation.
const fs = require('fs');
const path = require('path');
const os = require('os');


const adb = require('../lib/analytics/db.js');
const { ingestOnce, parseLine } = require('../lib/analytics/ingest-logs.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-analytics-'));
const dbPath = path.join(tmp, 'test.sqlite');
const logPath = path.join(tmp, 'access.log');
adb.openDb(dbPath);

// The leaderboard queries below use a 7-day window, so the fixture's log date must be "today" —
// a frozen date turns the suite into a time bomb (it did: hard-coded 08/Jul/2026 started failing
// the moment the calendar passed it). Lines keep the literal 08/Jul/2026 token for readability and
// are re-stamped to today (UTC) at write time.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _now = new Date();
const TODAY = `${String(_now.getUTCDate()).padStart(2, '0')}/${MONTHS[_now.getUTCMonth()]}/${_now.getUTCFullYear()}`;
const stamp = (line) => line.replace(/08\/Jul\/2026/g, TODAY);

const L = [
  // AI bots (various purposes) — incl. a 404 to a bot (kept) and an llms.txt fetch
  '20.171.207.1 - - [08/Jul/2026:04:00:01 +0000] "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0 AppleWebKit/537.36; compatible; GPTBot/1.2; +https://openai.com/gptbot"',
  '20.171.207.1 - - [08/Jul/2026:04:00:02 +0000] "GET /pricing HTTP/1.1" 200 4000 "-" "Mozilla/5.0 (compatible; GPTBot/1.2)"',
  '52.70.1.9 - - [08/Jul/2026:04:01:00 +0000] "GET /docs/hermes HTTP/1.1" 404 150 "-" "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"',
  '54.36.1.1 - - [08/Jul/2026:04:02:00 +0000] "GET /llms.txt HTTP/1.1" 200 900 "-" "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"',
  '13.65.1.1 - - [08/Jul/2026:04:03:00 +0000] "GET /pricing HTTP/1.1" 200 4000 "-" "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)"',
  // Humans: AI referral (chatgpt), utm variant, search, direct; one asset + one classic bot to be dropped
  '1.2.3.4 - - [08/Jul/2026:04:04:00 +0000] "GET /pricing HTTP/1.1" 200 9000 "https://chatgpt.com/" "Mozilla/5.0 (Windows NT 10.0) Chrome/126"',
  '1.2.3.5 - - [08/Jul/2026:04:04:10 +0000] "GET /?utm_source=chatgpt.com HTTP/1.1" 200 9000 "-" "Mozilla/5.0 (Macintosh) Safari/605"',
  '1.2.3.6 - - [08/Jul/2026:04:05:00 +0000] "GET / HTTP/1.1" 200 9000 "https://www.google.com/" "Mozilla/5.0 Chrome/126"',
  '1.2.3.7 - - [08/Jul/2026:04:05:30 +0000] "GET /docs HTTP/1.1" 200 9000 "-" "Mozilla/5.0 Firefox/127"',
  '1.2.3.8 - - [08/Jul/2026:04:06:00 +0000] "GET /js/app.js HTTP/1.1" 200 100 "-" "Mozilla/5.0 Chrome/126"',
  '66.249.66.1 - - [08/Jul/2026:04:06:30 +0000] "GET / HTTP/1.1" 200 9000 "-" "Mozilla/5.0 (compatible; Googlebot/2.1)"',
  // --- real-world lines from the production access log (2026-07-09) ---
  '104.23.190.231 - - [08/Jul/2026:04:07:00 +0000] "GET / HTTP/2.0" 200 17541 "-" "Go-http-client/1.1"', // non-browser client: NOT a pageview
  '172.68.50.242 - - [08/Jul/2026:04:07:10 +0000] "GET /wp-json/gravitysmtp/v1/tests/mock-data?page=x HTTP/1.1" 200 17940 "-" "Mozilla/5.0 (compatible; SecurityResearch/1.0; )"', // scanner soft-200: NOT a pageview
  '172.71.184.10 - - [08/Jul/2026:04:07:20 +0000] "GET /wp-admin/install.php?step=1 HTTP/2.0" 200 1393 "-" "http://example.com/wp-admin/install.php?step=1"', // URL-as-UA scanner: NOT a pageview
  '172.68.50.135 - - [08/Jul/2026:04:07:30 +0000] "GET / HTTP/2.0" 200 17541 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"', // real Mac human: IS a pageview ("Intel" must not trip the blocklist)
  '172.64.217.12 - - [08/Jul/2026:04:07:40 +0000] "GET /dashboard HTTP/1.1" 200 17940 "-" "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; https://zhanzhang.toutiao.com/)"', // AI training bot
  '172.71.167.92 - - [08/Jul/2026:04:07:50 +0000] "GET /robots.txt HTTP/1.1" 301 162 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"', // AI search bot, 301 kept
  '104.23.243.63 - - [08/Jul/2026:04:07:55 +0000] "HEAD /api/health HTTP/2.0" 200 0 "https://x.com/api/health" "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)"', // health check: NOT a pageview
];
fs.writeFileSync(logPath, L.map(stamp).join('\n') + '\n');

const { assert, done } = require('./test-util');

// --- pass 1: full ingest
let botEvents = 0;
const r1 = ingestOnce({ logPath, secret: 'test', onBotEvent: () => botEvents++ });
assert(r1.events === 12, `12 events stored (7 bot + 5 human), got ${r1.events}`);
assert(botEvents === 7, `7 bot SSE callbacks, got ${botEvents}`);

// --- idempotency: nothing new
const r2 = ingestOnce({ logPath, secret: 'test' });
assert(r2.events === 0, 'second pass ingests nothing (offset held)');

// --- append + partial line handling
fs.appendFileSync(logPath, stamp('9.9.9.9 - - [08/Jul/2026:05:00:00 +0000] "GET /new HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n8.8.8.8 - - [08/Jul/2026:05:00:01 +0000] "GET /partial HTT'));
const r3 = ingestOnce({ logPath, secret: 'test' });
assert(r3.events === 1, `appended complete line ingested, partial held back, got ${r3.events}`);
fs.appendFileSync(logPath, 'P/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n');
const r4 = ingestOnce({ logPath, secret: 'test' });
assert(r4.events === 1, `completed partial line ingested on next tick, got ${r4.events}`);

// --- rotation (truncate simulates copytruncate)
fs.writeFileSync(logPath, stamp('7.7.7.7 - - [08/Jul/2026:06:00:00 +0000] "GET /after-rotate HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n'));
const r5 = ingestOnce({ logPath, secret: 'test' });
assert(r5.events === 1, `post-rotation line ingested from offset 0, got ${r5.events}`);

// --- queries
const lb = adb.botLeaderboard('platform', 7);
const gpt = lb.find((x) => x.bot === 'GPTBot');
assert(gpt && gpt.count === 2 && gpt.purpose === 'training', `GPTBot leaderboard: 2 training hits (${JSON.stringify(gpt)})`);
assert(lb.find((x) => x.bot === 'ChatGPT-User' && x.purpose === 'live'), 'ChatGPT-User classified live');
assert(lb.find((x) => x.bot === 'ClaudeBot').count === 1, 'ClaudeBot 404 still counted (bot 404s are signal)');

const heat = adb.crawlHeat('platform', 7);
assert(heat.find((h) => h.path === '/pricing' && h.count === 2), `/pricing crawl heat = 2 (GPTBot + ChatGPT-User), got ${JSON.stringify(heat)}`);
assert(heat.find((h) => h.path === '/llms.txt'), 'llms.txt fetch tracked');

assert(lb.find((x) => x.bot === 'Bytespider' && x.purpose === 'training'), 'Bytespider classified training');
assert(lb.find((x) => x.bot === 'OAI-SearchBot' && x.purpose === 'search'), 'OAI-SearchBot 301 counted as search hit');

const s = adb.summary('platform', 7);
assert(s.botHits === 7, `summary botHits 7, got ${s.botHits}`);
assert(s.pageviews === 8, `summary pageviews 8 (5 + new + partial + rotate; assets/crawlers/scanners dropped), got ${s.pageviews}`);
assert(s.referrers.find((x) => x.class === 'ai' && x.count === 2), `2 AI-referred humans (referrer + utm), got ${JSON.stringify(s.referrers)}`);
assert(s.aiReferrers.find((x) => x.engine === 'ChatGPT' && x.count === 2), 'both AI referrals attributed to ChatGPT');

const live = adb.recentBotEvents('platform', 10);
assert(live.length === 7 && live[0].bot === 'OAI-SearchBot', `live feed: 7 rows newest-first, got ${live.length}/${live[0] && live[0].bot}`);

// --- visitor hash: same day+ip+ua stable; different day differs
const l1 = parseLine(L[5], { secret: 's' });
const l1b = parseLine(L[5], { secret: 's' });
const otherDay = parseLine(L[5].replace('08/Jul', '09/Jul'), { secret: 's' });
assert(l1.visitorHash === l1b.visitorHash, 'visitor hash deterministic within a day');
assert(l1.visitorHash !== otherDay.visitorHash, 'visitor hash rotates across days');

// --- P2: vhost-format lines attribute to the owning site; combined lines stay 'platform'
const resolveSite = (host) => (host === 'acmedental.com' ? 'site-acme' : null);
fs.appendFileSync(logPath, [
  // aios_vhost format (host first) — client site traffic
  'acmedental.com 20.171.207.1 - - [08/Jul/2026:07:00:00 +0000] "GET /pricing HTTP/1.1" 200 4000 "-" "Mozilla/5.0 (compatible; GPTBot/1.2)"',
  'www.acmedental.com 1.2.3.4 - - [08/Jul/2026:07:00:10 +0000] "GET / HTTP/2.0" 200 9000 "https://chatgpt.com/" "Mozilla/5.0 (Windows NT 10.0) Chrome/126"',
  // vhost format but an unknown host → platform bucket
  'unknown-host.example 5.6.7.8 - - [08/Jul/2026:07:00:20 +0000] "GET / HTTP/1.1" 200 9000 "-" "Mozilla/5.0 (compatible; ClaudeBot/1.0)"',
  // old combined format still parses (no host) → platform bucket
  '9.9.9.9 - - [08/Jul/2026:07:00:30 +0000] "GET /legacy HTTP/1.1" 200 1 "-" "Mozilla/5.0 (compatible; PerplexityBot/1.0)"',
].map(stamp).join('\n') + '\n');
const r6 = ingestOnce({ logPath, secret: 'test', resolveSite });
assert(r6.events === 4, `vhost pass ingested 4 events, got ${r6.events}`);
const acmeBots = adb.botLeaderboard('site-acme', 7);
assert(acmeBots.length === 1 && acmeBots[0].bot === 'GPTBot', `GPTBot attributed to site-acme (${JSON.stringify(acmeBots)})`);
const acmeSum = adb.summary('site-acme', 7);
assert(acmeSum.pageviews === 1 && acmeSum.aiReferrers.length === 1, `www. host normalized onto site-acme; human AI referral counted (${acmeSum.pageviews}/${JSON.stringify(acmeSum.aiReferrers)})`);
const platBots = adb.botLeaderboard('platform', 7);
assert(platBots.find((x) => x.bot === 'ClaudeBot' && x.count === 2), 'unknown vhost host fell back to platform (ClaudeBot 1+1)');
assert(platBots.find((x) => x.bot === 'PerplexityBot' && x.count === 2), 'combined-format line still parses into platform (PerplexityBot 1+1)');
assert(!platBots.find((x) => x.bot === 'GPTBot' && x.count > 2), 'site-attributed GPTBot hit did NOT leak into the platform bucket');

done();
