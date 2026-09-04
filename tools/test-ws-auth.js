// WebSocket auth accepts the Authorization header and the session cookie, and REJECTS a token in
// the query string — SOC 2 gap-list item 7 (CC6.6).
//
// Why a rejection and not just "stop reading it": a URL is logged by nginx, by any proxy, and by
// the browser's history, so a bearer credential there leaks with nobody misbehaving. Rejecting a
// query token even when it is valid is what makes the old habit visibly stop working instead of
// silently continuing to leak. This suite reads server.js as text (repo convention — no suite
// boots the server) and pins the shape; the live probe that proves the behaviour is in the commit.
const { assert, done, serverSource, readRepoFile } = require('./test-util');

const src = serverSource();
const verify = src.slice(src.indexOf('function wsCredential('), src.indexOf("cb(false, 401, 'Unauthorized');") + 40);
assert(verify.length > 100, 'wsCredential + verifyClient located');
assert(/authorization/.test(verify) && /Bearer/.test(verify), 'the Authorization: Bearer header is an accepted channel');
assert(/ai-os-session=/.test(verify), 'the session cookie is an accepted channel');
assert(!/searchParams\.get\('token'\)/.test(verify), "verifyClient no longer READS ?token= as a credential");
assert(/searchParams\.has\('token'\)/.test(verify), 'a ?token= in the URL is detected...');
assert(/WebSocket rejected: token in query string/.test(verify), '...logged to the activity log...');
assert(/wsHasQueryToken\(info\.req\)\)\s*\{[\s\S]*?return cb\(false, 401/.test(verify), '...and REJECTED with 401 (before any credential is even examined)');
const rejectAt = verify.indexOf('wsHasQueryToken(info.req))');
const openAt = verify.indexOf('if (!API_TOKEN) return cb(true)');
assert(rejectAt !== -1 && openAt !== -1 && rejectAt < openAt, 'the query-token rejection runs even when API_TOKEN is unset — the no-auth dev mode does not re-open the URL channel');

// The connection handler stamps role/email from the SAME resolver, so verifyClient and the
// broadcast scoping cannot disagree about who a socket belongs to.
const conn = src.slice(src.indexOf("wss.on('connection'"), src.indexOf('function wsClientCanReceive'));
assert(/wsCredential\(req\)/.test(conn), 'the connection handler uses wsCredential');
assert(!/qtoken|searchParams/.test(conn), 'the connection handler has no query-string token path left');
assert(/cred\.kind === 'api-token'[\s\S]*ws\.role = 'admin'/.test(conn), 'API token → admin socket');
assert(/cred\.session[\s\S]*ws\.email = cred\.session\.email/.test(conn), 'session → role + email stamped for broadcast scoping');
assert(/else if \(API_TOKEN\) \{ ws\.role = 'user'; \}/.test(conn), 'authenticated-but-unresolvable falls to least privilege, as before');

// The dashboard client no longer builds a ?token= URL (it never could — the cookie is httpOnly).
const app = readRepoFile('dashboard/js/app.js');
// Comments stripped: the explanatory comment there names the old ?token= habit, and that is prose.
const setup = app.slice(app.indexOf('function setupWebSocket()'), app.indexOf('ws.onmessage')).replace(/^\s*\/\/.*$/gm, '');
assert(!/token=/.test(setup) && !/document\.cookie/.test(setup), 'setupWebSocket connects with a bare URL — no ?token=, no cookie read');

// Nothing else in the repo still constructs a ?token= WebSocket URL.
assert(!/WebSocket\([^)]*token=/.test(app), 'no other WebSocket(...token=) construction in app.js');

done();
