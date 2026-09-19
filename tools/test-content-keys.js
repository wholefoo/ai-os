// tools/test-content-keys.js
// The `content` service-key scope: an n8n publishing workflow gets a credential that reaches Web
// Studio content routes and nothing else, optionally confined to one site.
//
// Why this exists instead of handing n8n the API_TOKEN: that token is the ADMIN credential. The
// standalone hub gave its ingest API its own token; the equivalent here is a scoped service key.
//
// The cases that matter are the ways a scoped credential usually leaks: reads (every other scope may
// GET anything), sibling routes, another site's id, encoded paths, and ROTATION silently dropping
// the binding — which would turn a one-site key into an every-site key during routine maintenance.
const { assert, done, serverSource } = require('./test-util');
const K = require('../lib/security/service-keys');

const SITE = '9fffb97a-6623-4c14-a2d0-a8601f6e8526';
const OTHER = 'ebb1a8a5-0bbc-4527-b2f0-7f930434ce15';
const bound = { scope: 'content', siteId: SITE };
const unbound = { scope: 'content', siteId: null };
const allow = (k, m, p) => K.decideScope(k, m, p).allow;

// --- the routes it may reach -----------------------------------------------------------------------
for (const [m, p] of [
  ['POST', `/api/web-studio/sites/${SITE}/ingest`],
  ['POST', `/api/web-studio/sites/${SITE}/articles`],
  ['PUT', `/api/web-studio/sites/${SITE}/articles/my-post`],
  ['DELETE', `/api/web-studio/sites/${SITE}/articles/my-post`],
  ['GET', `/api/web-studio/sites/${SITE}/articles`],
  ['POST', `/api/web-studio/sites/${SITE}/build`],
  ['POST', `/api/web-studio/sites/${SITE}/ingest?build=false`],
]) assert(allow(bound, m, p), `content key may ${m} ${p}`);

// --- reads are confined too, unlike every other scope ----------------------------------------------
for (const p of ['/api/crm/contacts', '/api/admin/service-keys', '/api/settings', '/api/users',
  `/api/web-studio/sites/${SITE}`, `/api/web-studio/sites/${SITE}/plan`, '/api/web-studio/sites']) {
  assert(!allow(bound, 'GET', p), 'content key must NOT read ' + p);
}
assert(allow({ scope: 'read' }, 'GET', '/api/crm/contacts'), 'control: a read key CAN read the CRM, so the confinement is specific to content');

// --- sibling Web Studio routes that mutate a site are out of scope ---------------------------------
for (const p of [`/api/web-studio/sites/${SITE}/publish`, `/api/web-studio/sites/${SITE}/unpublish`,
  `/api/web-studio/sites/${SITE}/adopt`, `/api/web-studio/sites/${SITE}/domain`,
  `/api/web-studio/sites/${SITE}/file`, `/api/web-studio/sites/${SITE}/ai-edit`]) {
  assert(!allow(bound, 'POST', p), 'content key must NOT reach ' + p);
}

// --- the site binding ------------------------------------------------------------------------------
assert(!allow(bound, 'POST', `/api/web-studio/sites/${OTHER}/ingest`), 'a bound key cannot ingest into another site');
assert(!allow(bound, 'GET', `/api/web-studio/sites/${OTHER}/articles`), 'a bound key cannot read another site');
assert(allow(unbound, 'POST', `/api/web-studio/sites/${OTHER}/ingest`), 'an explicitly unbound content key reaches any site (a deliberate choice)');
assert(!allow(bound, 'POST', `/api/web-studio/sites/${encodeURIComponent(OTHER)}/ingest`), 'percent-encoding the id does not slip past the binding');
assert(!allow(bound, 'POST', '/api/web-studio/sites/%E0%A4%A/ingest'), 'a malformed encoding is refused, not thrown');

// --- path games ------------------------------------------------------------------------------------
assert(!allow(bound, 'POST', `/api/web-studio/sites/${SITE}/ingest/../../admin/service-keys`), 'dot segments do not escape the route');
assert(!allow(bound, 'POST', `/api/web-studio/sites/${SITE}/articles/a/b`), 'an extra segment is not an article route');
assert(!allow(bound, 'POST', `/api/web-studio/sites/${SITE}/ingestx`), 'a prefix match is not a route match');

// --- validation ------------------------------------------------------------------------------------
const v = K.validateNew({ label: 'n8n oregon', scope: 'content', siteId: SITE });
assert(!v.error && v.siteId === SITE, 'a content key can be minted bound to a site');
assert(K.validateNew({ label: 'x', scope: 'admin', siteId: SITE }).error, 'a site binding on an admin key is refused, not silently stored');
assert(K.validateNew({ label: 'x', scope: 'agent', siteId: SITE }).error, 'a site binding on an agent key is refused');
assert(K.validateNew({ label: 'x', scope: 'content', siteId: '../../etc' }).error, 'a malformed site id is refused');
assert(K.validateNew({ label: 'x', scope: 'content' }).siteId === null, 'omitting siteId mints an explicitly unbound key');

const { key } = K.createKey({ id: 'k1', ...v, createdBy: 'admin@x' });
assert(key.siteId === SITE, 'the binding is stored on the record');
assert(K.publicView(key).siteId === SITE, 'the admin view shows the binding');
assert(!JSON.stringify(K.publicView(key)).includes(key.tokenHash), 'publicView still never carries the hash');

// --- the server side: rotation and minting ---------------------------------------------------------
const src = serverSource();
const rot = src.slice(src.indexOf("app.post('/api/admin/service-keys/:id/rotate'"));
const rotCall = rot.slice(0, rot.indexOf('\n'));
// Bounded by the NEXT route, not the first "});" — the route's own early returns
// (`res.status(404).json({ ... });`) contain that sequence, and cutting there excluded createKey
// entirely, so the first version of this assertion failed against correct code.
const nextRoute = rot.indexOf('\napp.', 1);
const rotBody = rot.slice(0, nextRoute > 0 ? nextRoute : 3000);
assert(rotBody.includes('createKey('), 'the rotation route body was located (guards against a slice that misses it)');
assert(/createKey\(\{[^}]*siteId: old\.siteId/.test(rotBody),
  'ROTATION CARRIES THE SITE BINDING — dropping it would turn a one-site key into an every-site key');
assert(rotCall.includes('requireHuman'), 'rotation still requires a human');

const mint = src.slice(src.indexOf('const v = serviceKeys.validateNew(req.body'));
assert(/v\.siteId && !webStudioSites\.some\(\(s\) => s\.id === v\.siteId\)/.test(mint.slice(0, 600)),
  'minting refuses a binding to a site that does not exist');

done('content-keys');
