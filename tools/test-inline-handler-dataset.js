// tools/test-inline-handler-dataset.js
// ============================================================
//  An inline handler that reads `this.dataset.X` from an element that does not CARRY `data-x`.
//
//  WHY THIS EXISTS — it shipped, and it broke the Skills panel for users.
//
//      <div class="skill-card" data-skill-file="foo.md" onclick="executeSkill(this.dataset.skillFile)">
//        ...
//        <button onclick="event.stopPropagation(); executeSkill(this.dataset.skillFile)">Launch</button>
//      </div>
//
//  In an inline handler `this` is the element the HANDLER sits on. On the nested button that is the
//  BUTTON, which has no `data-*`, so it read `undefined`. Worse, `event.stopPropagation()` also
//  killed the card's correct handler, so the whole card was dead. The failure was SILENT: it fetched
//  `/api/skills/undefined` (404) and then threw on `filename.replace(...)` inside an async function
//  — an unhandled rejection, which logs to console and shows the user nothing.
//
//  WHY A DETECTOR AND NOT JUST THE FIX. A hand-written browser check DID run over this panel and
//  passed, because it selected `[data-skill-file]` elements and clicked those — the broken button is
//  not one, so it was invisible to the selector. The check confirmed the elements already believed
//  in. Only a rule that starts from the HANDLERS finds it.
//
//  THE FIX SHAPE: read from the owner, not from `this` —
//      this.closest('[data-skill-file]').dataset.skillFile
// ============================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'dashboard', 'js');
let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };

/** camelCase dataset key -> the data-* attribute name it reads. */
const attrFor = (prop) => 'data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/**
 * Find inline handlers that read `this.dataset.X` on a tag lacking the matching `data-x`.
 * Deliberately ignores `this.closest(...).dataset.X`, which is the correct fix shape.
 */
/**
 * Inline these handlers before scanning: they are BUILT IN VARIABLES, not written literally.
 *
 *     const action = isReference ? 'openSkillReference(this.dataset.skillFile)' : 'executeSkill(...)';
 *     ... onclick="event.stopPropagation(); ${action}"
 *
 * THE FIRST DRAFT OF THIS FILE SKIPPED THIS AND WAS USELESS. Mutation-testing it against the real
 * bug — restoring the shipped code — the suite still PASSED, because the attribute contained only
 * `${action}` and the regex found no `this.dataset`. A detector that cannot see the shape it was
 * written for reports clean, which is indistinguishable from a clean repo. Resolve the variables.
 */
function expandStringConsts(src) {
  let out = src;
  // `const x = '...'` / `let x = "..."`, including ternaries of two string literals.
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*([^;\n]*'[^']*'[^;\n]*);/g)) {
    const [, name, expr] = m;
    if (!/this\.dataset\./.test(expr)) continue;
    out = out.split('${' + name + '}').join(expr);
  }
  return out;
}

function findBrokenHandlers(rawSrc) {
  const src = expandStringConsts(rawSrc);
  const out = [];
  const re = /<(\w+)([^>]*?)\son(?:click|change|input|submit)="([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const [, tag, attrs, handler] = m;
    for (const d of handler.matchAll(/(^|[^.\w])this\.dataset\.(\w+)/g)) {
      const prop = d[2];
      if (!attrs.includes(attrFor(prop))) {
        out.push({ tag, prop, attr: attrFor(prop), handler: handler.slice(0, 70) });
      }
    }
  }
  return out;
}

// --- The rule must FIRE on the exact shape that shipped. --------------------------------------
ok('FLAGS a nested handler reading this.dataset.X without the attribute', () => {
  const src = '<div class="card" data-skill-file="a.md" onclick="run(this.dataset.skillFile)">'
    + '<button onclick="event.stopPropagation(); run(this.dataset.skillFile)">Launch</button></div>';
  const found = findBrokenHandlers(src);
  assert.strictEqual(found.length, 1, `expected exactly the nested button, got ${JSON.stringify(found)}`);
  assert.strictEqual(found[0].tag, 'button');
});

ok('does NOT flag a handler whose element carries the attribute', () => {
  const src = '<button data-skill-file="a.md" onclick="run(this.dataset.skillFile)">Go</button>';
  assert.deepStrictEqual(findBrokenHandlers(src), []);
});

ok('does NOT flag the CORRECT fix shape (this.closest(...).dataset.X)', () => {
  const src = '<div data-skill-file="a.md"><button onclick="run(this.closest(\'[data-skill-file]\').dataset.skillFile)">Go</button></div>';
  assert.deepStrictEqual(findBrokenHandlers(src), []);
});

// THE SHAPE THAT ACTUALLY SHIPPED: the handler lives in a variable, not in the attribute.
// This test is the reason expandStringConsts() exists — without it the detector passed against the
// real bug, which is the whole point of mutation-testing a guard before trusting it.
ok('FLAGS the INTERPOLATED form — handler built in a const, not written literally', () => {
  const src = [
    "const action = isReference ? 'openSkillReference(this.dataset.skillFile)' : 'executeSkill(this.dataset.skillFile)';",
    '`<div class="card" data-skill-file="${f}" onclick="${action}">',
    '  <button class="run" onclick="event.stopPropagation(); ${action}">Launch</button>',
    '</div>`',
  ].join('\n');
  const found = findBrokenHandlers(src);
  assert.ok(found.length > 0, 'the nested button must be flagged even though the handler is a variable');
  assert.ok(found.some((h) => h.tag === 'button'), `expected the button, got ${JSON.stringify(found)}`);
});

ok('handles multi-word dataset keys (data-audit-id <-> auditId)', () => {
  const bad = '<button onclick="go(this.dataset.auditId)">x</button>';
  const good = '<button data-audit-id="1" onclick="go(this.dataset.auditId)">x</button>';
  assert.strictEqual(findBrokenHandlers(bad).length, 1);
  assert.deepStrictEqual(findBrokenHandlers(good), []);
});

// --- The repo must be clean. ------------------------------------------------------------------
ok('no dashboard script has an inline handler reading a dataset key its element lacks', () => {
  const offenders = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
    for (const hit of findBrokenHandlers(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
      offenders.push(`${f}: <${hit.tag}> reads this.dataset.${hit.prop} but has no ${hit.attr} — ${hit.handler}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Inline handler(s) reading a dataset key the element does not carry:\n  ${offenders.join('\n  ')}\n\n`
    + "`this` in an inline handler is the element the HANDLER sits on. If the data-* lives on a\n"
    + "parent, read it from the owner instead: this.closest('[data-x]').dataset.x");
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
