// Fixture-driven test of lib/okf + the Web Studio OKF emitter: serialize → parse roundtrip,
// bundle write + validation, path-escape guard, and the generated-site bundle end-to-end.
const fs = require('fs');
const path = require('path');
const os = require('os');

const okf = require('../lib/okf');
const aeoEmit = require('../lib/web-studio/aeo-emit');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };

// --- serialize → parse roundtrip, incl. characters that force YAML quoting
const doc = okf.serializeConcept(
  { type: 'BigQuery Table', title: 'Orders: "big" & risky', description: 'One row per order', resource: 'https://example.com/x?y=1', tags: ['sales', 'rev enue'], timestamp: '2026-07-09T00:00:00Z', custom: 'extra' },
  '# Schema\n\nBody text.'
);
const parsed = okf.parseConcept(doc);
assert(parsed.frontmatter.type === 'BigQuery Table', 'type survives roundtrip');
assert(parsed.frontmatter.title === 'Orders: "big" & risky', `quoted title survives roundtrip, got ${JSON.stringify(parsed.frontmatter.title)}`);
assert(Array.isArray(parsed.frontmatter.tags) && parsed.frontmatter.tags[1] === 'rev enue', 'tags array survives roundtrip');
assert(parsed.frontmatter.custom === 'extra', 'producer-defined extra field survives');
assert(parsed.body.trim().startsWith('# Schema'), 'body preserved');

let threw = false;
try { okf.serializeConcept({ title: 'no type' }, 'x'); } catch { threw = true; }
assert(threw, 'serializeConcept rejects a concept without required `type`');

// --- writeBundle + validateBundle + path-escape guard
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-test-'));
const written = okf.writeBundle(tmp, [
  { relPath: 'index.md', fm: { type: 'Knowledge Bundle', title: 'T' }, body: '# T\n\n- [A](/a/one.md)' },
  { relPath: 'a/one.md', fm: { type: 'Concept', title: 'One' }, body: 'links [back](../index.md)' },
  { relPath: '../escape.md', fm: { type: 'Evil' }, body: 'must not be written' },
]);
assert(written.length === 2 && !written.includes('../escape.md'), 'path-escape blocked, 2 legit files written');
assert(!fs.existsSync(path.join(tmp, '..', 'escape.md')), 'escape file does not exist on disk');
const v1 = okf.validateBundle(tmp);
assert(v1.ok && v1.concepts.length === 2, `valid bundle passes (${JSON.stringify(v1.issues)})`);

fs.writeFileSync(path.join(tmp, 'a', 'bad.md'), '---\ntitle: no type here\n---\nsee [ghost](/nope.md)');
const v2 = okf.validateBundle(tmp);
assert(!v2.ok && v2.issues.some((i) => i.includes('missing required')) && v2.issues.some((i) => i.includes('broken link')), `validator catches missing type + broken link (${JSON.stringify(v2.issues)})`);

// --- Web Studio emitter end-to-end on a realistic plan
const plan = {
  siteName: 'Acme Dental', domain: 'acmedental.com',
  provenance: { generatedAt: '2026-07-09T00:00:00Z' },
  pages: [
    { path: '/', title: 'Home', description: 'Gentle dentistry in Mesa.', sections: [
      { type: 'hero', heading: 'Smile again', subheading: 'Same-week appointments.' },
      { type: 'features', heading: 'Services', items: [{ title: 'Cleanings', body: 'Routine care.' }] },
    ] },
    { path: '/contact', title: 'Contact', description: 'Book a visit.', sections: [{ type: 'contact', heading: 'Visit us', email: 'hi@acmedental.com' }] },
  ],
};
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-site-'));
okf.writeBundle(tmp2, aeoEmit.okfBundle(plan, { '/': { title: 'Acme Dental — Home' } }));
const v3 = okf.validateBundle(tmp2);
assert(v3.ok, `generated-site bundle passes OKF validation (${JSON.stringify(v3.issues)})`);
assert(v3.concepts.length === 4, `4 concepts (index + 2 pages + provenance), got ${v3.concepts.length}`);
const idx = okf.parseConcept(fs.readFileSync(path.join(tmp2, 'index.md'), 'utf8'));
assert(idx.frontmatter.type === 'Website' && idx.frontmatter.resource === 'https://acmedental.com', 'index concept typed Website with resolved resource URL');
const home = okf.parseConcept(fs.readFileSync(path.join(tmp2, 'pages', 'home.md'), 'utf8'));
assert(home.frontmatter.title === 'Acme Dental — Home', 'page concept prefers refined meta title');
assert(home.body.includes('Cleanings'), 'page body carries section content');
assert(aeoEmit.llmsTxt(plan).includes('/knowledge/index.md'), 'llms.txt advertises the knowledge bundle');

console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
