// tools/test-site-lock.js
// The per-site lock that keeps concurrent ingests from silently discarding each other's batches.
//
// Tested under the exact condition it exists for: read shared state, AWAIT, then write. A live
// probe that used ?build=false passed with the lock disabled, because that path has no await between
// read and write — so a check without an await gap cannot tell a lock from no lock. Every race case
// below is run twice: with the lock (must be correct) and without it (must actually lose writes),
// so the test proves it is capable of seeing the bug it guards against.
'use strict';
const assert = require('assert');
const { createSiteLock } = require('../lib/web-studio/site-lock');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noLock = (key, fn) => Promise.resolve().then(fn);

// The ingest route's shape: read the list, await a "build", write the list back.
async function appendLikeIngest(store, lock, item, delay) {
  return lock('site-a', async () => {
    const list = store.list;               // read
    await sleep(delay);                    // the build — the interleaving point
    store.list = [...list, item];          // write
  });
}

(async () => {
  console.log('site-lock');

  await t('WITHOUT a lock, concurrent read-await-write loses writes (proves the test can see the bug)', async () => {
    const store = { list: [] };
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => appendLikeIngest(store, noLock, i, 20 - i * 2)));
    assert.ok(store.list.length < 6, 'no writes were lost even without a lock — this harness cannot detect the race');
  });

  await t('WITH the lock, every concurrent write survives', async () => {
    const store = { list: [] };
    const lock = createSiteLock();
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => appendLikeIngest(store, lock, i, 20 - i * 2)));
    assert.strictEqual(store.list.length, 6, 'lost writes: ' + JSON.stringify(store.list));
  });

  await t('calls for one site run in arrival order', async () => {
    const lock = createSiteLock(); const order = [];
    await Promise.all([30, 5, 15].map((d, i) => lock('s', async () => { await sleep(d); order.push(i); })));
    assert.deepStrictEqual(order, [0, 1, 2], 'ran out of order: ' + order);
  });

  await t('different sites do not wait on each other', async () => {
    const lock = createSiteLock(); const done = [];
    const slow = lock('site-a', async () => { await sleep(60); done.push('a'); });
    const fast = lock('site-b', async () => { await sleep(5); done.push('b'); });
    await Promise.all([slow, fast]);
    assert.deepStrictEqual(done, ['b', 'a'], 'site-b waited behind site-a');
  });

  await t('a failing call rejects for its caller but does not poison the queue', async () => {
    const lock = createSiteLock(); let ran = false;
    const failing = lock('s', async () => { throw new Error('build failed'); });
    const next = lock('s', async () => { ran = true; });
    await assert.rejects(failing, /build failed/);
    await next;
    assert.ok(ran, 'the call after a failure never ran');
  });

  await t('a queued call sees the state the previous one wrote', async () => {
    // Why the route re-reads site.plan INSIDE the lock rather than before it.
    const lock = createSiteLock(); const store = { n: 0 }; const seen = [];
    await Promise.all([0, 1, 2].map(() => lock('s', async () => { seen.push(store.n); await sleep(5); store.n += 1; })));
    assert.deepStrictEqual(seen, [0, 1, 2], 'a queued call read stale state: ' + seen);
  });

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
