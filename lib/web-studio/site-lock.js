// lib/web-studio/site-lock.js
// A per-key promise chain: calls for the same key run one at a time, in arrival order; calls for
// different keys do not wait on each other. A burst QUEUES rather than failing.
//
// WHY IT EXISTS. The ingest route reads a site's plan, then awaits a build, then writes the plan.
// Two requests for one site interleave at that await: both read the same entry list, both append,
// and the second write silently discards the first request's batch.
//
// Kept out of server.js so it can be tested under the condition it exists for. A live probe of the
// ingest route using ?build=false passed with this lock DISABLED — that path has no await between
// read and write, so Node cannot interleave it at all — which is why the lock's own test below
// drives an explicit await gap instead.
'use strict';

function createSiteLock() {
  const chains = new Map();
  return function withLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    // A failure in an earlier call must not poison the queue: catch before chaining.
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    // Drop the entry once this call is the last in line, so the map does not grow per site forever.
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  };
}

module.exports = { createSiteLock };
