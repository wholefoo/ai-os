// Renderer test for the Web Studio lead form (contact section → real form on hosted sites,
// mailto fallback otherwise). The endpoint side is exercised by a live boot + POST (see the
// Leads P1 commit body); this covers the deterministic render layer.
const { renderPage, renderSection } = require('../lib/web-studio/pipeline.js');

const { assert, done } = require('./test-util');

const contact = { type: 'contact', heading: 'Talk to us', body: 'We reply fast.', email: 'hi@acme.com' };
const endpoint = 'https://platform.example/api/public/site-lead/site-123';

// --- hosted: real form
const hosted = renderSection(contact, { leadEndpoint: endpoint });
assert(hosted.includes(`action="${endpoint}"`), 'form posts to the platform lead endpoint');
assert(hosted.includes('method="POST"'), 'plain HTML POST (no JS/CORS dependency)');
assert(/name="name"/.test(hosted) && /name="email"/.test(hosted) && /name="message"/.test(hosted), 'name/email/message fields present');
assert(hosted.includes('name="website"') && hosted.includes('tabindex="-1"'), 'honeypot field present and keyboard-skipped');
assert(hosted.includes('id="lead-thanks"') && hosted.includes('target:block'), 'CSS :target thanks message present');
assert(hosted.includes('mailto:hi@acme.com'), 'email kept as secondary contact path');

// --- unhosted/exported: mailto fallback, no form
const fallback = renderSection(contact, {});
assert(!fallback.includes('<form'), 'no form without a lead endpoint');
assert(fallback.includes('mailto:hi@acme.com'), 'mailto fallback preserved');

// --- endpoint threads through renderPage via plan.leadEndpoint
const plan = { siteName: 'Acme', leadEndpoint: endpoint, pages: [] };
const page = { path: '/contact', title: 'Contact', sections: [contact] };
const html = renderPage(page, undefined, plan);
assert(html.includes(`action="${endpoint}"`), 'renderPage threads plan.leadEndpoint into contact sections');

// --- endpoint value is HTML-escaped in the attribute
const evil = renderSection(contact, { leadEndpoint: 'https://x.example/a"><script>alert(1)</script>' });
assert(!evil.includes('<script>alert(1)</script>'), 'lead endpoint is escaped in the action attribute');

// --- per-site leads inbox query (Manage tab backend): filters by meta.siteId via json_extract
const fs = require('fs');
const path = require('path');
const os = require('os');
const crmDb = require('../lib/crm/db.js');
const repo = require('../lib/crm/repo.js');
crmDb.openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leads-inbox-')), 'crm.sqlite'));
const cid = repo.contacts.upsertByEmail({ email: 'buyer@example.com', name: 'Buyer One', is_lead: 1, source: 'site-lead' });
repo.activities.add({ contactId: cid, type: 'site_lead', body: 'Lead from Acme: need a quote', meta: { siteId: 'site-a', page: '/contact' }, author: 'site-form' });
repo.activities.add({ contactId: cid, type: 'site_lead', body: 'Lead from Other: hello', meta: { siteId: 'site-b' }, author: 'site-form' });
repo.activities.add({ contactId: cid, type: 'note', body: 'operator note', meta: { siteId: 'site-a' }, author: 'admin' });
const inbox = repo.activities.leadsForSite('site-a');
assert(inbox.length === 1, `leadsForSite returns only site-a leads, got ${inbox.length}`);
assert(inbox[0].email === 'buyer@example.com' && inbox[0].body.includes('need a quote') && inbox[0].meta.page === '/contact', 'lead row carries contact email, message and page');
assert(repo.activities.leadsForSite('site-c').length === 0, 'unknown site → empty inbox (no cross-site leak)');

done();
