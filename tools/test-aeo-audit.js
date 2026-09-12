// tools/test-aeo-audit.js
// Per-site AEO audit and its "safe auto-fix" proposals.
//
// The load-bearing property is what the fixer REFUSES to do. Every proposal must be derivable from
// the page's own content or from a fact already in the plan; the scorer's biggest levers (FAQ
// format 15pts, answer readiness 10) are exactly the ones where an auto-fix would mean inventing
// questions and answers on a customer's live domain. Those must stay recommendations.
'use strict';
const assert = require('assert');
const A = require('../lib/web-studio/aeo-audit');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};

console.log('aeo-audit');

const doc = ({ title = 'A Reasonable Page Title Of Decent Length', desc = null, body = '', ld = null, h = true } = {}) => `<!doctype html><html><head>
<title>${title}</title>${desc === null ? '' : `<meta name="description" content="${desc}">`}
${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}
</head><body>${h ? '<h1>Heading</h1><h2>Sub</h2><h2>Sub2</h2><h2>Sub3</h2><h3>Deep</h3><h3>Deep2</h3>' : ''}
<main>${body}</main></body></html>`;

const PROSE = '<p>' + 'This page explains the subject in clear complete sentences. '.repeat(20) + '</p>';

// ---------- scoring ------------------------------------------------------------------------------
t('scores a page and returns the 8 dimensions', () => {
  const r = A.auditPage('index.html', doc({ body: PROSE }));
  assert.ok(r.score >= 0 && r.score <= 100, 'score out of range: ' + r.score);
  assert.strictEqual(Object.keys(r.breakdown).length, 8, 'expected 8 dimensions');
  assert.ok('heading_structure' in r.breakdown && 'structured_data' in r.breakdown);
});

t('a rich page scores higher than a bare one', () => {
  const bare = A.auditPage('a.html', '<html><head><title>x</title></head><body><p>short</p></body></html>').score;
  const rich = A.auditPage('b.html', doc({
    desc: 'A description of exactly the right sort of length for a search result, written to sit comfortably inside the hundred and twenty to hundred and sixty band.',
    body: PROSE + '<ul><li>a</li><li>b</li><li>c</li></ul>',
    ld: { '@context': 'https://schema.org', '@type': 'Article', headline: 'x' },
  })).score;
  assert.ok(rich > bare, `rich (${rich}) should beat bare (${bare})`);
});

t('summarises a site and names the weakest dimensions', () => {
  const files = [
    { path: 'index.html', html: doc({ body: PROSE }) },
    { path: 'about/index.html', html: doc({ body: PROSE }) },
  ];
  const { pages, summary } = A.auditSite(files);
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(summary.pages, 2);
  assert.ok(summary.weakest.length > 0, 'no weakest dimensions reported');
  assert.ok(summary.weakest[0].lostPoints >= summary.weakest[summary.weakest.length - 1].lostPoints,
    'weakest list is not sorted by points lost');
  assert.ok(['A', 'B', 'C', 'D'].includes(summary.grade));
});

t('ignores non-HTML files and survives an empty site', () => {
  assert.strictEqual(A.auditSite([{ path: 'styles.css', html: 'body{}' }]).pages.length, 0);
  assert.strictEqual(A.auditSite([]).summary.pages, 0);
  assert.strictEqual(A.auditSite(null).summary.pages, 0);
});

// ---------- fix proposals -------------------------------------------------------------------------
const planWith = (over = {}) => Object.assign({
  siteName: 'Truth Counters',
  pages: [{ path: '/', title: 'Home', description: '' }],
  articles: [],
}, over);

t('proposes a description derived from the page prose when there is none', () => {
  const plan = planWith();
  const files = [{ path: 'index.html', html: doc({ body: PROSE }) }];
  const fixes = A.proposeFixes(plan, A.auditSite(files), files);
  const f = fixes.find((x) => x.field === 'description');
  assert.ok(f, 'no description fix proposed: ' + JSON.stringify(fixes.map((x) => x.id)));
  assert.strictEqual(f.before, '');
  assert.ok(f.after.length >= 40 && f.after.length <= A.DESC_MAX, 'derived description out of band: ' + f.after.length);
  assert.ok(PROSE.includes(f.after.slice(0, 30)), 'the description was not taken from the page prose');
});

t('trims an over-long description at a word boundary', () => {
  const long = 'x'.split('').concat(Array(40).fill('word')).join(' ') + ' end';
  const plan = planWith({ pages: [{ path: '/', title: 'Home Page Title That Is Fine', description: long }] });
  const files = [{ path: 'index.html', html: doc({ desc: long, body: PROSE }) }];
  const f = A.proposeFixes(plan, A.auditSite(files), files).find((x) => x.id.endsWith(':long'));
  assert.ok(f, 'no trim proposed for a ' + long.length + '-char description');
  assert.ok(f.after.length <= A.DESC_MAX, 'trim did not bring it into band');
  assert.ok(!/\s$/.test(f.after) && !f.after.endsWith(','), 'did not trim cleanly: ' + JSON.stringify(f.after.slice(-20)));
  assert.ok(long.startsWith(f.after.slice(0, 30)), 'trimmed text is not a prefix of the original');
});

t('appends the site name to a too-short title — and never invents words', () => {
  const plan = planWith({ pages: [{ path: '/', title: 'Home', description: 'x'.repeat(130) }] });
  const files = [{ path: 'index.html', html: doc({ title: 'Home', desc: 'x'.repeat(130), body: PROSE }) }];
  const f = A.proposeFixes(plan, A.auditSite(files), files).find((x) => x.field === 'title');
  assert.ok(f, 'no title fix proposed');
  assert.strictEqual(f.after, 'Home | Truth Counters');
  assert.ok(f.after.startsWith(f.before), 'the original title was altered rather than extended');
});

t('does NOT append the site name when it is already in the title', () => {
  const plan = planWith({ pages: [{ path: '/', title: 'Home | Truth Counters', description: 'x'.repeat(130) }] });
  const files = [{ path: 'index.html', html: doc({ title: 'Home | Truth Counters', body: PROSE }) }];
  assert.ok(!A.proposeFixes(plan, A.auditSite(files), files).some((x) => x.field === 'title'),
    'proposed appending a site name that is already there');
});

t('flags a title trim for review rather than applying it quietly', () => {
  const longTitle = 'An Extremely Long Page Title That Goes Well Beyond The Sixty Character Guidance';
  const plan = planWith({ pages: [{ path: '/', title: longTitle, description: 'x'.repeat(130) }] });
  const files = [{ path: 'index.html', html: doc({ title: longTitle, body: PROSE }) }];
  const f = A.proposeFixes(plan, A.auditSite(files), files).find((x) => x.field === 'title');
  assert.ok(f && f.review === true, 'a lossy title trim was not marked for review');
});

t('REFUSES to rewrite a bespoke short description it did not derive', () => {
  // A hand-written description that is NOT a prefix of the prose must be left alone: extending it
  // would be rewriting a human's copy.
  const plan = planWith({ pages: [{ path: '/', title: 'A Perfectly Fine Page Title Here', description: 'Bespoke marketing copy.' }] });
  const files = [{ path: 'index.html', html: doc({ desc: 'Bespoke marketing copy.', body: PROSE }) }];
  const f = A.proposeFixes(plan, A.auditSite(files), files).find((x) => x.id.endsWith(':short'));
  assert.ok(!f, 'proposed rewriting bespoke copy: ' + JSON.stringify(f && f.after));
});

t('never proposes a fix for FAQ, structured data or answer readiness', () => {
  const plan = planWith();
  const files = [{ path: 'index.html', html: doc({ body: PROSE }) }];
  const fixes = A.proposeFixes(plan, A.auditSite(files), files);
  for (const f of fixes) {
    assert.ok(['title', 'description', 'excerpt'].includes(f.field),
      'proposed an auto-fix outside the safe set (' + f.field + ') — inventing content is not a fix');
  }
});

t('proposes nothing for a page that has no plan entity', () => {
  const plan = planWith();
  const files = [{ path: 'orphan/index.html', html: doc({ body: PROSE }) }];
  assert.strictEqual(A.proposeFixes(plan, A.auditSite(files), files).length, 0);
});

t('maps article files back to article records', () => {
  const plan = planWith({
    articles: [{ slug: 'one', title: 'One', excerpt: '', html: '<p>x</p>' }],
  });
  const files = [{ path: 'article/one/index.html', html: doc({ body: PROSE }) }];
  const f = A.proposeFixes(plan, A.auditSite(files), files).find((x) => x.target === 'article');
  assert.ok(f, 'an article page produced no fix');
  assert.strictEqual(f.field, 'excerpt', 'an article description maps to its excerpt');
  assert.strictEqual(f.index, 0);
});

// ---------- applying ---------------------------------------------------------------------------------
t('applies only the selected fixes and does not mutate the input plan', () => {
  const plan = planWith();
  const files = [{ path: 'index.html', html: doc({ body: PROSE }) }];
  const fixes = A.proposeFixes(plan, A.auditSite(files), files);
  const snapshot = JSON.stringify(plan);
  const { plan: next, applied } = A.applyFixes(plan, fixes, [fixes[0].id]);
  assert.strictEqual(JSON.stringify(plan), snapshot, 'the input plan was mutated');
  assert.strictEqual(applied.filter((a) => a.ok).length, 1);
  assert.notStrictEqual(next.pages[0].description, plan.pages[0].description, 'the fix did not take effect');
});

t('applies nothing when nothing is selected', () => {
  const plan = planWith();
  const files = [{ path: 'index.html', html: doc({ body: PROSE }) }];
  const fixes = A.proposeFixes(plan, A.auditSite(files), files);
  assert.strictEqual(A.applyFixes(plan, fixes, []).applied.length, 0);
  assert.strictEqual(A.applyFixes(plan, fixes, null).applied.length, 0);
});

t('REFUSES a fix whose target changed since the audit — no silent overwrite', () => {
  const plan = planWith();
  const files = [{ path: 'index.html', html: doc({ body: PROSE }) }];
  const fixes = A.proposeFixes(plan, A.auditSite(files), files);
  // Someone edited the description between the audit and the apply.
  const edited = planWith({ pages: [{ path: '/', title: 'Home', description: 'A human wrote this in the meantime.' }] });
  const { plan: next, applied } = A.applyFixes(edited, fixes, [fixes[0].id]);
  assert.strictEqual(applied[0].ok, false, 'overwrote newer copy');
  assert.ok(/changed since the audit/.test(applied[0].reason), 'no explanation: ' + applied[0].reason);
  assert.strictEqual(next.pages[0].description, 'A human wrote this in the meantime.', 'the newer value was lost');
});

// A fix that leaves the value outside the band it is fixing is not a fix. The sentence-boundary
// trimmer originally returned max+1 characters when a sentence ended exactly at the limit, so a
// 160-char cap produced a 161-char description that still scored as too long.
t('no proposed description ever exceeds the maximum', () => {
  const body = '<p>' + 'This is a complete sentence of about the right length. '.repeat(12) + '</p>';
  for (const len of [150, 158, 159, 160, 161, 162, 400]) {
    const desc = 'w'.repeat(len);
    const plan = planWith({ pages: [{ path: '/', title: 'A Perfectly Fine Page Title Here', description: desc }] });
    const files = [{ path: 'index.html', html: doc({ desc, body }) }];
    for (const f of A.proposeFixes(plan, A.auditSite(files), files)) {
      if (f.field !== 'description') continue;
      assert.ok(f.after.length <= A.DESC_MAX,
        `proposed a ${f.after.length}-char description (max ${A.DESC_MAX}) for a ${len}-char input`);
    }
  }
});

t('trimToSentence prefers a sentence end and never exceeds max', () => {
  const s = 'First sentence here and it runs on a while. Second sentence follows it. Third one trails off';
  for (let max = 40; max <= 120; max += 7) {
    const out = A.trimToSentence(s, max);
    assert.ok(out.length <= max, `returned ${out.length} for max ${max}`);
    assert.ok(s.startsWith(out), 'not a prefix at max=' + max);
  }
  // `min` is what stops it cutting at the FIRST full stop and returning a uselessly short
  // description; with the default min (60) a sentence ending at 42 is correctly rejected.
  assert.ok(A.trimToSentence(s, 60, 20).endsWith('.'), 'did not cut at the sentence end: ' + A.trimToSentence(s, 60, 20));
  assert.strictEqual(A.trimToSentence(s, 60, 20), 'First sentence here and it runs on a while.');
  assert.ok(!A.trimToSentence(s, 60).endsWith('.'),
    'cut at a 42-char sentence end despite a 60-char minimum — that is a too-short description');
});

t('trimToSentence is not fooled by an initial into cutting at "J."', () => {
  const s = 'Written by J. R. Smith and it continues for a good while after that point indeed';
  const out = A.trimToSentence(s, 50);
  assert.ok(!/\bJ\.$/.test(out) && !/\bR\.$/.test(out), 'cut at an initial: ' + JSON.stringify(out));
});

t('trimToWord never cuts mid-word and never lengthens', () => {
  const s = 'alpha beta gamma delta epsilon';
  for (let n = 5; n < s.length + 5; n++) {
    const out = A.trimToWord(s, n);
    assert.ok(out.length <= Math.max(n, s.length), 'grew');
    if (out !== s) assert.ok(s.startsWith(out), 'not a prefix at n=' + n);
  }
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
