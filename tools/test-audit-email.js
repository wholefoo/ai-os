// Audit → lead email renderer (lib/leads/audit-email.js): deterministic templating over a
// completed audit record — subject/score, worst-areas selection, quick-win capping, the AEO
// callout condition, HTML escaping of lead-supplied names, and completeness validation.
const { assert, done } = require('./test-util');
const { renderAuditLeadEmail, validateAuditForEmail, worstAreas, scoreWord } = require('../lib/leads/audit-email');

const mkAudit = (over = {}) => ({
  id: 'a1', domain: 'acmedental.com', status: 'complete', compositeScore: 58,
  agents: {
    technical: { score: 42 }, content: { score: 55 }, keyword: { score: 70 },
    backlink: { score: 61 }, competitor: { score: 66 }, aeo: { score: 35 },
  },
  quickWins: [
    { action: 'Fix crawler blocking rules', time: '15 min', impact: 'high' },
    { action: 'Submit XML sitemap', time: '10 min', impact: 'medium' },
    { action: 'Add meta descriptions', time: '30 min', impact: 'medium' },
    { action: 'A fourth win that must be cut', time: '5 min', impact: 'low' },
  ],
  ...over,
});

// --- validation
assert(validateAuditForEmail(mkAudit()).length === 0, 'complete audit passes validation');
assert(validateAuditForEmail(null).length === 1, 'missing audit rejected');
assert(validateAuditForEmail(mkAudit({ status: 'running' })).length >= 1, 'incomplete audit rejected');
assert(validateAuditForEmail(mkAudit({ compositeScore: null })).length >= 1, 'scoreless audit rejected');

// --- worst areas: lowest three, ascending
const areas = worstAreas(mkAudit());
assert(areas.length === 3 && areas[0].key === 'aeo' && areas[1].key === 'technical' && areas[2].key === 'content', `worst 3 areas ascending (got ${areas.map((a) => a.key).join(',')})`);
assert(areas[0].label === 'AI-search readiness (AEO)', 'agent keys map to human labels');

// --- score words
assert(scoreWord(80) === 'strong' && scoreWord(60) === 'needs work' && scoreWord(30) === 'weak' && scoreWord(null) === 'not measured', 'score bands word correctly');

// --- render: subject, greeting, caps, AEO callout
const r = renderAuditLeadEmail(mkAudit(), { toName: 'Jane Doe', businessName: 'AI OS Lab' });
assert(r.subject.includes('acmedental.com') && r.subject.includes('58/100'), `subject carries domain + score (${r.subject})`);
assert(/^Hi Jane,/m.test(r.text), 'text greets by first name only');
assert((r.text.match(/^\s+\d\./gm) || []).length === 3 && !r.text.includes('fourth win'), 'quick wins capped at 3');
assert(r.text.includes('AI-search readiness is 35/100') && r.text.includes('ChatGPT'), 'weak AEO triggers the AI-search callout');
assert(r.text.trim().endsWith('— AI OS Lab'), 'signed with the business name');
assert(r.html.includes('58<span') && r.html.includes('acmedental.com') && r.html.includes('<table'), 'html carries score, domain, and the area table');

// --- AEO callout suppressed when strong
const rStrong = renderAuditLeadEmail(mkAudit({ agents: { ...mkAudit().agents, aeo: { score: 85 } } }));
assert(!rStrong.text.includes('AI-search readiness is 85'), 'strong AEO produces no callout');

// --- escaping: lead-supplied name and audit fields can't inject HTML
const rEvil = renderAuditLeadEmail(mkAudit({ domain: 'x.com<script>alert(1)</script>' }), { toName: '<img src=x onerror=1>' });
assert(!rEvil.html.includes('<script>') && !rEvil.html.includes('<img src=x'), 'html output escapes injected markup');
assert(rEvil.html.includes('&lt;script&gt;'), 'escaped entities present instead');

// --- no-name greeting + tone bands
const rNoName = renderAuditLeadEmail(mkAudit({ compositeScore: 82 }));
assert(/^Hi,/m.test(rNoName.text) && rNoName.text.includes('solid foundation'), 'no name → plain greeting; high score → positive tone');
const rLow = renderAuditLeadEmail(mkAudit({ compositeScore: 31 }));
assert(rLow.text.includes('significant issues'), 'low score → urgent tone');

done();
