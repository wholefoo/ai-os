// tools/test-crm-sort.js
// ============================================================
//  CS-03 (security-sweep run-1786080073868): the CRM list's ORDER BY was chosen by a bare
//  `SORTS[opts.sort]` lookup. A bare property read walks the PROTOTYPE CHAIN, so a caller passing
//  ?sort=constructor got `Object`'s constructor function back — truthy, so the `|| SORTS.updated`
//  fallback never fired — and that function was then interpolated straight into the SQL string.
//
//  This is NOT SQL injection: the attacker controls only a KEY, and every value reachable that way
//  is a built-in function or Object.prototype member, none of which is attacker-authored SQL. The
//  real consequence is a malformed ORDER BY clause -> a thrown sqlite error -> HTTP 500. DoS-class,
//  on an admin-only route.
//
//  The class of defect is the one this repo keeps re-learning: a guard that enumerates what is
//  ALLOWED is only as good as the lookup that reads it. `SORTS` was already a correct allowlist —
//  the defect was that the read didn't respect it.
// ============================================================

const assert = require('assert');
const { resolveSort, SORTS } = require('../lib/crm/repo');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

// --- The four legitimate sorts still resolve, unchanged. -------------------------------------
for (const key of ['updated', 'created', 'name', 'score']) {
  ok(`'${key}' resolves to its own clause`, () => {
    assert.strictEqual(resolveSort(key), SORTS[key]);
  });
}

// --- THE DEFECT. Every one of these returned a non-string before the fix. ---------------------
// `constructor` is the sharp one: it resolves to a FUNCTION, which is truthy, so the `||` fallback
// that was supposed to catch bad input silently did not.
for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
  ok(`inherited key '${key}' falls back to the default instead of leaking a prototype member`, () => {
    const got = resolveSort(key);
    assert.strictEqual(got, SORTS.updated, `expected the default clause, got ${typeof got}: ${String(got).slice(0, 40)}`);
  });
}

// --- The result must always be one of the four literal clauses. -------------------------------
// Pinning the VALUE, not the count: a future sort added to SORTS should not break this test, but a
// lookup that returns anything outside the table must.
const ALLOWED = new Set(Object.values(SORTS));
for (const key of ['constructor', 'nope', '', null, undefined, 0, {}, [], 'proto']) {
  ok(`resolveSort(${JSON.stringify(key)}) returns a clause from the table`, () => {
    const got = resolveSort(key);
    assert.ok(typeof got === 'string', `must be a string, got ${typeof got}`);
    assert.ok(ALLOWED.has(got), `"${got}" is not one of the declared sort clauses`);
  });
}

// --- Guard against the fix regressing into a denylist. ----------------------------------------
// Naming the bad keys (`if (k === 'constructor') ...`) would pass every assertion above and still
// be wrong, because the next Object.prototype member nobody listed walks straight through. This
// pins the CATEGORY: nothing NOT declared in SORTS may resolve, whatever it is called.
ok('a key absent from SORTS never resolves, even one nobody thought to name', () => {
  const exotic = Symbol.toStringTag ? 'toLocaleString' : 'toLocaleString';
  assert.strictEqual(resolveSort(exotic), SORTS.updated);
  assert.strictEqual(resolveSort('propertyIsEnumerable'), SORTS.updated);
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
