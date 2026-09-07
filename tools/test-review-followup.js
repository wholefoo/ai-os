'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const createInviteQueue = require('../lib/account-invites');
const { serverSource, readRepoFile } = require('./test-util');
const source = serverSource();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-review-test-'));
function load(context, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0);
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
}
function route(context, url) {
  let handler;
  context.app = { post: (p, ...handlers) => { handler = handlers.at(-1); } };
  const start = source.indexOf(`app.post('${url}'`);
  assert(start >= 0);
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
  return handler;
}
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } }; }
(async () => {
  let queue;
  try {
    const user = { email: 'buyer@example.invalid', plan: 'business' };
    let sends = 0, persist = true, delivery = false, lastMail;
    const options = { filename: path.join(tmp, 'invites.sqlite'), findUser: () => user,
      persistUsers: () => persist, newToken: () => 'synthetic-test-token', publicUrl: () => 'https://portal.example.invalid',
      emailConfig: () => ({}), report: () => {}, send: async mail => { sends++; lastMail = mail; return { ok: delivery }; } };
    queue = createInviteQueue(options);
    queue.enqueue('receipt', user.email);
    queue.enqueue('receipt', user.email);
    persist = false;
    await queue.drain();
    assert.equal(sends, 0, 'Never email an unpersisted setup token');
    persist = true;
    await queue.drain(Date.now() + 86400000);
    assert.equal(sends, 1);
    assert.match(lastMail.text, /https:\/\/portal.example.invalid\/set-password\?token=/);
    assert.equal(lastMail.transactional, true);
    queue.close();
    queue = createInviteQueue(options);
    delivery = true;
    await queue.drain(Date.now() + 86400000);
    assert.equal(sends, 2, 'Failed delivery survives a queue restart');
    queue.enqueue('receipt', user.email);
    await queue.drain(Date.now() + 86400000);
    assert.equal(sends, 2, 'Delivered receipt is not sent again');
    user.passwordHash = 'already-set';
    queue.enqueue('second-receipt', user.email);
    await queue.drain(Date.now() + 86400000);
    assert.equal(sends, 2, 'Existing passwords never get a new setup invitation');
    queue.close(); queue = null;
    console.log('ok: persistent invite retries, deduplication, existing passwords, token persistence');

    const noop = () => {};
    let calls = 0, saves = true;
    const action = { id: 'a', kind: 'action', type: 'test', status: 'executing' };
    const context = vm.createContext({ console, Date, setImmediate, loadState: () => [action],
      saveState: () => saves, requireAdmin: noop, requireHuman: noop, heavyLimiter: noop,
      logActivity: noop, broadcast: noop, ACTION_EXECUTORS: { test: async () => { calls++; } } });
    const recovery = source.indexOf("const pendingApprovals = loadState('pending_approvals'");
    vm.runInContext(source.slice(recovery, source.indexOf('// Oversight ledger', recovery)), context);
    assert.equal(action.status, 'interrupted');
    load(context, 'executeApprovedAction');
    const reconcile = route(context, '/api/approvals/:id/reconcile');
    const retry = route(context, '/api/approvals/:id/retry');
    let res = response();
    await retry({ params: { id: 'a' }, body: {}, session: { email: 'operator' } }, res);
    assert.equal(res.statusCode, 409); assert.equal(calls, 0);
    const req = { params: { id: 'a' }, body: { outcome: 'not-completed', note: 'Checked external provider history' }, session: { email: 'operator' } };
    saves = false; res = response(); reconcile(req, res);
    assert.equal(res.statusCode, 503); assert.equal(action.status, 'interrupted');
    saves = true; res = response(); reconcile(req, res);
    assert.equal(action.status, 'failed'); assert.equal(calls, 0, 'Reconciliation itself does not execute');
    res = response(); await retry({ ...req, body: {} }, res);
    assert.equal(res.statusCode, 200); assert.equal(calls, 1); assert.equal(action.status, 'approved');
    res = response(); reconcile(req, res); assert.equal(res.statusCode, 409);
    console.log('ok: restart recovery, no automatic replay, durable human reconciliation and working retry');

    const update = require('../lib/deploy/nginx-policy');
    const original = 'server {\n  server_name custom.example;\n  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;\n}\n';
    const changed = update(original);
    assert.equal(changed, original.replace('microphone=()', 'microphone=(self)'));
    assert.equal(update(changed), changed);
    assert.throws(() => update('server {}'), /No recognized/);
    console.log('ok: nginx change is targeted, repeatable and refuses an unknown policy');

    const archive = Buffer.alloc(2048); archive.write('index.html'); archive.write('00000000002', 124); archive.write('0', 156); archive.write('ok', 512);
    const commands = [];
    const worker = vm.createContext({ Buffer, module: { exports: {} }, process: { platform: 'linux', getuid: () => 1001, env: { AIOS_BUILD_BACKEND: 'bubblewrap' } },
      require: name => name === 'child_process' ? { execFile: (file, args, options, done) => { commands.push({ file, args, options }); done(null, archive, Buffer.from('')); } } : require(name) });
    vm.runInContext(readRepoFile('lib/web-studio/isolated-build.js'), worker);
    fs.mkdirSync(path.join(tmp, 'site'));
    fs.writeFileSync(path.join(tmp, 'site/package.json'), '{}');
    await worker.module.exports.isolatedBuild(path.join(tmp, 'site'), 1000);
    assert.equal(commands[0].file, '/usr/bin/systemd-run');
    for (const flag of ['--property=MemoryMax=768M', '--property=TasksMax=128', '--property=RuntimeMaxSec=1', '--unshare-all', '--clearenv']) assert(commands[0].args.includes(flag), flag);
    assert.equal(commands.at(-1).file, '/usr/bin/systemctl');
    assert.equal(commands.at(-1).args[1], 'stop');
    assert.equal(fs.readFileSync(path.join(tmp, 'site/dist/index.html'), 'utf8'), 'ok');
    console.log('ok: non-Docker worker resource constraints, sandbox and cleanup invocation');

    const readiness = vm.createContext({ URL, process: { env: {} }, stripe: {}, STRIPE_WEBHOOK_SECRET: '',
      emailLib: require('../lib/email'), settings: { email: { provider: 'resend', from_email: 'sender@example.invalid' } }, ACTIVE_TIER: 'enterprise' });
    load(readiness, 'accountInviteOrigin'); load(readiness, 'managedOfferActive');
    assert.equal(readiness.managedOfferActive(), false);
    readiness.STRIPE_WEBHOOK_SECRET = 'synthetic';
    readiness.process.env.AIOS_PUBLIC_URL = 'https://portal.example.invalid';
    assert.equal(readiness.managedOfferActive(), false, 'A provider label without credentials does not enable checkout');
    readiness.settings.email.resend_api_key = 'synthetic';
    assert.equal(readiness.managedOfferActive(), true);
    for (const url of ['http://portal.example.invalid', 'https://', 'https://user:pass@portal.example.invalid', 'https://portal.example.invalid/other']) {
      readiness.process.env.AIOS_PUBLIC_URL = url;
      assert.equal(readiness.managedOfferActive(), false, url);
    }
    console.log('ok: checkout requires webhook, email credentials and a valid HTTPS account origin');

    let flushes = 0;
    const cost = vm.createContext({ costLedger: [{ id: 'usage' }], scheduleAutoSave: () => { flushes++; } });
    load(cost, 'attributeUsage'); cost.attributeUsage({ usageId: 'usage' }, { clientId: 'buyer' });
    assert.equal(flushes, 1); assert.equal(cost.costLedger[0].clientId, 'buyer');
    const config = JSON.parse(readRepoFile('.fallowrc.json'));
    assert(config.ignoreUnresolvedImports.includes('../commercial/**'));
    console.log('ok: attribution schedules persistence and public CI handles absent commercial imports');
  } finally {
    if (queue) queue.close();
    assert.equal(path.dirname(tmp), os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
