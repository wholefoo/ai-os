// The hard daily caps on the three PUBLIC, BILLABLE-PER-REQUEST routes actually refuse.
//
// WHY THIS SUITE EXISTS. `.claude/rules/public-cost-endpoints.md` names the invariants for anonymous
// endpoints that spend money per request, and the load-bearing one is an ORDERING claim: the cap is
// evaluated BEFORE the expensive call, so a refused request costs $0. Nothing enforced that. seclint
// cannot: its route-no-auth rule fires only when the handler directly follows the path string, so any
// middleware — including a rate limiter, which is not auth — satisfies it. A source grep cannot
// either, because "the check sits above the await" is a claim about execution order, and reading is
// how this repo has previously convinced itself of things that were not true.
//
// So this suite boots the REAL server and makes REAL requests. That is the only way it means what it
// says.
//
// NOTHING HERE EVER REACHES A PROVIDER. Every request is already over its cap when it arrives — the
// state is seeded so the FIRST request is refused. No assertion depends on a request completing, so
// no paid branch is ever entered. An earlier revision did let one request through and it made a real
// billed model call; the no-spend assertion caught it, and the probe was redesigned (see WINDOW
// below) to prove the same property without a pass-through.
//
// STATE ISOLATION, AND ITS LIMIT. The server boots with AIOS_STATE_SUBDIR pointing at a throwaway
// directory under .magent, because the live `.magent/state/` holds real leads and tickets and a test
// that seeded those files would be destroying operator data to check a 429. That override does NOT
// cover the CRM — `crm.sqlite` sits at .magent/crm.sqlite, outside STATE_DIR — which is the other
// reason no request may be allowed to complete: a successful free audit calls crm.ingestLead against
// the operator's real database.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { assert, done } = require('./test-util');

const ROOT = path.join(__dirname, '..');
const SUBDIR = `state-test-caps-${process.pid}`;
const STATE = path.join(ROOT, '.magent', SUBDIR);
const PORT = 3487;
const TEST_TOKEN = 'cap-suite-token-not-a-real-credential';

// Caps small enough to seed by hand. Each is read as `parseInt(x, 10) || DEFAULT`, so 0 falls back to
// the default — the smallest value that actually takes effect is 1, not 0. (Worth knowing on its own:
// an operator setting a cap to 0 meaning "off" silently gets the default instead.)
const CAPS = {
  FREE_AUDIT_DAILY_MAX: '2',
  FREE_AUDIT_IP_DAILY_MAX: '1',
  SUPPORT_DAILY_MAX: '2',
  SUPPORT_IP_DAILY_MAX: '1',
  WS_CHAT_DAILY_MAX: '2',
  WS_CHAT_SITE_DAILY_MAX: '2',
  WS_CHAT_IP_DAILY_MAX: '1',
};

// Neutralise every credential the parent shell is carrying, BY SHAPE rather than by listing the
// providers — a hand-written list goes stale the first time a provider is added, and it goes stale in
// the direction that spends money.
//
// The sentinel must be NON-EMPTY. Setting these to '' does not work: dotenv treats an empty value as
// absent and refills it from .env (`injected env (47) from .env`). That is not a theory — an earlier
// revision blanked ANTHROPIC_API_KEY with '', dotenv restored the real 108-char key, and the suite
// made a genuine billed model call while its comment claimed no key was configured.
const CREDENTIAL_RE = /(_API_KEY|_API_TOKEN|_API_SECRET|_SECRET|_TOKEN|_PASSWORD|_PASS|_LOGIN)$/;
const SENTINEL = 'disabled-for-test-suite';
function sanitisedEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = CREDENTIAL_RE.test(k) ? SENTINEL : v;
  return { ...env, ...extra };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const seed = (key, value) => fs.writeFileSync(path.join(STATE, `${key}.json`), JSON.stringify(value));
const readState = (key) => {
  const p = path.join(STATE, `${key}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

function request(method, pathname, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method,
        headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* non-JSON body */ } resolve({ status: res.statusCode, json, raw }); });
      },
    );
    req.on('error', reject);
    req.end(payload === null ? undefined : payload);
  });
}

// Anonymous, exactly as a public visitor arrives: no Authorization header.
const postAnon = (pathname, body, headers) => request('POST', pathname, { body, headers });
const errorOf = (r) => (r.json && r.json.error) || r.raw || '';

// Total spend as the SERVER sees it, from the in-memory ledger rather than the file, so the assertion
// cannot conflate "nothing was billed" with "nothing has been flushed yet". `monthly` is the widest of
// the three windows getCostSummary reports, so it is the one that cannot miss an entry this suite
// caused. Reading it needs the operator token; the public routes above deliberately do not use one.
async function spendSoFar() {
  const { json } = await request('GET', '/api/costs', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
  if (!json || !json.monthly) return null;
  return { count: Number(json.monthly.count) || 0, cost: Number(json.monthly.cost) || 0 };
}

function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      // DEMO_MODE=false is load-bearing. Under DEMO_MODE the server SEEDS the cost ledger at boot when
      // it is empty (`if (DEMO_MODE && costLedger.length === 0)`), which would make "the ledger is
      // empty" meaningless as a no-spend signal, and executeAgent short-circuits to canned text so the
      // paid path is never the thing under test.
      //
      // API_TOKEN is set rather than cleared, on purpose. It puts authMiddleware on its PRODUCTION
      // branch, so the three routes below are only reachable anonymously if they are genuinely in the
      // runtime public allowlist. That is the registration point whose omission once 401'd the
      // free-audit lead magnet for every visitor, and it is invisible in a dev-mode test.
      env: sanitisedEnv({ ...CAPS, PORT: String(PORT), AIOS_STATE_SUBDIR: SUBDIR, NODE_ENV: 'test', DEMO_MODE: 'false', API_TOKEN: TEST_TOKEN }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error(`server did not report "running at" within 40s:\n${log}`)); }, 40000);
    const watch = (buf) => {
      log += buf.toString();
      if (log.includes('running at')) { clearTimeout(timer); resolve(child); }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (code ${code}):\n${log}`)); });
  });
}

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((r) => child.once('exit', r));
  child.kill();
  await ended;
};

(async () => {
  fs.mkdirSync(STATE, { recursive: true });
  let child = null;
  try {
    // Seed each route to exactly its cap over the trailing 24h the handlers count on. Every seed also
    // carries a ~30h row, which must NOT count — see the WINDOW section for why that matters.
    seed('free_audit_log', [
      { email: 'a@example.com', domain: 'a.test', ip: '9.9.9.9', createdAt: hoursAgo(1), source: 'free-audit' },
      { email: 'b@example.com', domain: 'b.test', ip: '9.9.9.9', createdAt: hoursAgo(2), source: 'free-audit' },
      { email: 'c@example.com', domain: 'c.test', ip: '3.3.3.3', createdAt: hoursAgo(30), source: 'free-audit' },
    ]);
    seed('contact_tickets', [{
      id: 'seed-ticket', email: 'seed@example.com', subject: 's', ip: '9.9.9.9', createdAt: hoursAgo(3),
      messages: [
        { role: 'user', at: hoursAgo(1), ip: '9.9.9.9', text: 'one' },
        { role: 'user', at: hoursAgo(2), ip: '9.9.9.9', text: 'two' },
        { role: 'user', at: hoursAgo(30), ip: '3.3.3.3', text: 'outside the window' },
      ],
    }]);
    seed('web_studio_sites', [{
      id: 'site-cap-test', name: 'Cap Test', status: 'built', chatEnabled: true, createdAt: hoursAgo(50),
      knowledge: [{ path: '/', title: 'Home', description: 'd', text: 'Some baked site knowledge.' }],
    }]);
    seed('web_studio_chat_log', [
      { siteId: 'site-cap-test', ip: '9.9.9.9', at: hoursAgo(1) },
      { siteId: 'site-cap-test', ip: '9.9.9.9', at: hoursAgo(2) },
      { siteId: 'site-cap-test', ip: '3.3.3.3', at: hoursAgo(30) },
    ]);
    seed('cost-ledger', []);

    child = await boot();

    // Prove the isolation before trusting anything below: had the override silently fallen back to
    // 'state', every assertion here would be running against live operator data.
    assert(fs.existsSync(path.join(STATE, 'free_audit_log.json')),
      'the server booted against the throwaway state dir, not the live .magent/state');

    // --- 1. free audit — global daily cap -----------------------------------------------------
    const audit = await postAnon('/api/seo/free-audit', { domain: 'new-domain.test', email: 'fresh@example.com', name: 'Fresh' });
    assert(audit.status !== 401, 'free-audit is reachable anonymously under production-style auth (it is in the runtime public allowlist)');
    assert(audit.status === 429, `free-audit refuses once the global daily cap is reached (got ${audit.status})`);
    assert(/reached its daily limit/i.test(errorOf(audit)), 'free-audit names the GLOBAL cap as the reason, so a caller can tell a cap from an outage');

    // --- 2. AI helpdesk — global daily cap ----------------------------------------------------
    const support = await postAnon('/api/support/contact', { email: 'visitor@example.com', subject: 'hi', message: 'Please help.' });
    assert(support.status !== 401, 'helpdesk is reachable anonymously under production-style auth');
    assert(support.status === 429, `helpdesk refuses once the global daily cap is reached (got ${support.status})`);

    // --- 3. generated-site chat — global daily cap --------------------------------------------
    const chat = await postAnon('/api/web-studio/sites/site-cap-test/chat', { question: 'What do you sell?' });
    assert(chat.status !== 401, 'site chat is reachable anonymously under production-style auth');
    assert(chat.status === 429, `site chat refuses once the global daily cap is reached (got ${chat.status})`);

    // --- 4. THE POINT: none of that spent anything --------------------------------------------
    // A cap enforced AFTER the paid call would satisfy every assertion above and still bill for each
    // request. The ledger is what makes that difference observable rather than assumed.
    const ledger = readState('cost-ledger') || [];
    assert(Array.isArray(ledger) && ledger.length === 0,
      `no cost-ledger entry was written for any refused request (found ${Array.isArray(ledger) ? ledger.length : '?'})`);
    const spend = await spendSoFar();
    assert(spend && spend.count === 0 && spend.cost === 0,
      `and the server's own in-memory cost summary agrees: nothing billed (${spend ? `${spend.count} calls / $${spend.cost}` : 'no summary — /api/costs unreachable'})`);

    // --- 5. WINDOW: the two caps discriminate, which proves the 24h arithmetic -----------------
    // This is the boundary probe, and it deliberately does NOT let a request through.
    //
    // Seed three rows aged 30h from one IP (outside the window) plus ONE row aged 1h from another.
    // Global cap is 2, per-IP cap is 1. If the 30h rows were counted, the in-window total would be 4
    // and the GLOBAL cap would refuse first. If they are correctly excluded, the total is 1 — under
    // the global cap — and the request is refused by the PER-IP cap instead.
    //
    // So the identity of the refusing cap is the assertion: the per-IP message proves both that stale
    // rows were excluded and that in-window rows were counted, without any request reaching a vendor.
    await stop(child);
    seed('free_audit_log', [
      { email: 'old1@example.com', domain: 'o1.test', ip: '7.7.7.7', createdAt: hoursAgo(30), source: 'free-audit' },
      { email: 'old2@example.com', domain: 'o2.test', ip: '7.7.7.7', createdAt: hoursAgo(40), source: 'free-audit' },
      { email: 'old3@example.com', domain: 'o3.test', ip: '7.7.7.7', createdAt: hoursAgo(50), source: 'free-audit' },
      { email: 'recent@example.com', domain: 'r.test', ip: '5.5.5.5', createdAt: hoursAgo(1), source: 'free-audit' },
    ]);
    child = await boot();
    const perIp = await postAnon('/api/seo/free-audit', { domain: 'other.test', email: 'rotated@example.com' }, { 'X-Forwarded-For': '5.5.5.5' });
    assert(perIp.status === 429, `free-audit still refuses a rotated email from an IP at its daily cap (got ${perIp.status})`);
    assert(/limit for today/i.test(errorOf(perIp)),
      `the PER-IP cap is what refuses — so rows older than 24h were excluded from the global count, and in-window rows were counted (got: ${errorOf(perIp)})`);

    // And still nothing billed, across every request this suite made.
    const spendAfter = await spendSoFar();
    assert(spendAfter && spendAfter.count === 0 && spendAfter.cost === 0,
      `no request in this suite billed anything (${spendAfter ? `${spendAfter.count} calls / $${spendAfter.cost}` : 'no summary'})`);
  } catch (e) {
    assert(false, `suite error: ${e && e.message}`);
  } finally {
    await stop(child);
    fs.rmSync(STATE, { recursive: true, force: true });
  }
  done();
})();
