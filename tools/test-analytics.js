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
];
fs.writeFileSync(logPath, L.join('\n') + '\n');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };

// --- pass 1: full ingest
let botEvents = 0;
const r1 = ingestOnce({ logPath, secret: 'test', onBotEvent: () => botEvents++ });
assert(r1.events === 9, `9 events stored (5 bot + 4 human), got ${r1.events}`);
assert(botEvents === 5, `5 bot SSE callbacks, got ${botEvents}`);

// --- idempotency: nothing new
const r2 = ingestOnce({ logPath, secret: 'test' });
assert(r2.events === 0, 'second pass ingests nothing (offset held)');

// --- append + partial line handling
fs.appendFileSync(logPath, '9.9.9.9 - - [08/Jul/2026:05:00:00 +0000] "GET /new HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n8.8.8.8 - - [08/Jul/2026:05:00:01 +0000] "GET /partial HTT');
const r3 = ingestOnce({ logPath, secret: 'test' });
assert(r3.events === 1, `appended complete line ingested, partial held back, got ${r3.events}`);
fs.appendFileSync(logPath, 'P/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n');
const r4 = ingestOnce({ logPath, secret: 'test' });
assert(r4.events === 1, `completed partial line ingested on next tick, got ${r4.events}`);

// --- rotation (truncate simulates copytruncate)
fs.writeFileSync(logPath, '7.7.7.7 - - [08/Jul/2026:06:00:00 +0000] "GET /after-rotate HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"\n');
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

const s = adb.summary('platform', 7);
assert(s.botHits === 5, `summary botHits 5, got ${s.botHits}`);
assert(s.pageviews === 7, `summary pageviews 7 (4 + new + partial + rotate; asset+Googlebot dropped), got ${s.pageviews}`);
assert(s.referrers.find((x) => x.class === 'ai' && x.count === 2), `2 AI-referred humans (referrer + utm), got ${JSON.stringify(s.referrers)}`);
assert(s.aiReferrers.find((x) => x.engine === 'ChatGPT' && x.count === 2), 'both AI referrals attributed to ChatGPT');

const live = adb.recentBotEvents('platform', 10);
assert(live.length === 5 && live[0].bot === 'ChatGPT-User', `live feed: 5 rows newest-first, got ${live.length}/${live[0] && live[0].bot}`);

// --- visitor hash: same day+ip+ua stable; different day differs
const l1 = parseLine(L[5], { secret: 's' });
const l1b = parseLine(L[5], { secret: 's' });
const otherDay = parseLine(L[5].replace('08/Jul', '09/Jul'), { secret: 's' });
assert(l1.visitorHash === l1b.visitorHash, 'visitor hash deterministic within a day');
assert(l1.visitorHash !== otherDay.visitorHash, 'visitor hash rotates across days');

console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
