// CSRF posture — SOC 2 gap item 14. The item said "add CSRF protection"; the honest finding was that
// three independent properties already stop it, none of them was pinned, and a fourth (an
// origin check that does not depend on the browser) was cheap. This suite pins all four, so a
// future edit cannot quietly reopen one — e.g. a `sameSite: 'none'` for an embed, or an
// `express.urlencoded()` mounted globally for a form.
const { assert, done, serverSource } = require('./test-util');
const { crossSiteCookieMutation } = require('../lib/security/csrf');

// --- 1. the guard's logic, exhaustively on fixtures ---------------------------------------------------
const OWN = 'aiosorchestrationlab.com';
const req = (method, headers = {}) => ({ method, headers, host: OWN });
const COOKIE = 'ai-os-session=abc123; other=1';
const evil = 'https://evil.example';
const same = `https://${OWN}`;

assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: evil })) !== null, 'cookie + cross-site Origin + POST → refused');
for (const m of ['PUT', 'PATCH', 'DELETE']) assert(crossSiteCookieMutation(req(m, { cookie: COOKIE, origin: evil })) !== null, `${m} is a mutation too`);
assert(crossSiteCookieMutation(req('GET', { cookie: COOKIE, origin: evil })) === null, 'GET is never refused (reads are not mutations; Lax sends the cookie on navigations by design)');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: same })) === null, 'same-origin POST passes');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: `HTTPS://${OWN.toUpperCase()}` })) === null, 'origin host comparison is case-insensitive');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE })) === null, 'no Origin header (non-browser client, curl) passes — a browser always sends Origin on a cross-site POST');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: '' })) === null, 'empty Origin passes (treated as absent)');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: 'null' })) !== null, 'Origin: null (sandboxed iframe, data: URL, redirect chain) is REFUSED — it is not this host');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: 'not a url' })) !== null, 'an unparseable Origin is refused, not waved through');
assert(crossSiteCookieMutation(req('POST', { origin: evil })) === null, 'no cookie → nothing ambient to ride on → passes (the login POST itself must work from anywhere)');
assert(crossSiteCookieMutation(req('POST', { cookie: 'other=1; ai-os-sessionx=nope', origin: evil })) === null, 'a cookie that merely starts with the session name is not the session cookie');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, authorization: 'Bearer tok', origin: evil })) === null, 'Bearer present → exempt (a token is not ambient; a cross-site page cannot attach it)');
assert(crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: `https://${OWN}:8443` })) !== null, 'a different port is a different origin');
const r = crossSiteCookieMutation(req('POST', { cookie: COOKIE, origin: evil }));
assert(/evil\.example/.test(r.reason) && new RegExp(OWN).test(r.reason), 'the reason names both the offending origin and this host');

// --- 2. the posture that already existed, pinned ------------------------------------------------------
const src = serverSource();
const cookieSets = src.match(/res\.cookie\('ai-os-session'[^\n]*\n?[^\n]*\n?[^\n]*\n?[^\n]*/g) || [];
assert(cookieSets.length === 3, `the session cookie is set in exactly 3 places (found ${cookieSets.length})`);
for (const c of cookieSets) {
  assert(/httpOnly: true/.test(c) && /sameSite: 'lax'/.test(c) && /secure: process\.env\.NODE_ENV === 'production'/.test(c), 'every set is httpOnly + SameSite=Lax + secure in production');
}
assert(!/sameSite: 'none'/.test(src), 'no SameSite=None anywhere');
assert(/process\.env\.NODE_ENV === 'production' \? false : '\*'/.test(src), 'CORS is CLOSED in production unless CORS_ORIGIN is set');
const urlencodedLines = src.split('\n').filter((l) => /express\.urlencoded\(/.test(l));
assert(urlencodedLines.length === 2 && urlencodedLines.every((l) => /\/api\/public\//.test(l)), 'form-encoded bodies are parsed ONLY on the two /api/public routes (no session there); everything else is JSON-only, so a plain HTML form cannot reach a session route with a body');
assert(!/app\.use\(express\.urlencoded/.test(src), 'no global urlencoded parser');

// --- 3. the guard is mounted, after auth, on the API ---------------------------------------------------
const authAt = src.indexOf("app.use('/api/', authMiddleware);");
const guardAt = src.indexOf("app.use('/api/', require('./lib/security/csrf').sameOriginGuard(");
// Between them sits the service-key scope guard (2026-09-05); the property is ORDER — auth, then scope,
// then origin — and that nothing route-shaped is mounted before the origin guard.
const between = src.slice(authAt, guardAt);
assert(authAt !== -1 && guardAt !== -1 && guardAt > authAt && !/app\.(get|post|put|delete|patch)\(/.test(between), 'sameOriginGuard is mounted on /api/ after authMiddleware, with no ROUTE mounted in between');
assert(/Refused: cross-site cookie request/.test(src.slice(guardAt, guardAt + 400)), 'refusals are written to the activity log');

// --- 4. state-changing GET routes: exactly the two that are safe by construction -----------------------
// (Lax still sends the cookie on top-level GET navigations, so a GET that mutates is the one CSRF
// shape the cookie flag does not cover. Pin the count so a new one has to be argued here.)
const lines = src.split('\n');
const mutatingGets = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^app\.get\('([^']+)'/);
  if (!m) continue;
  let end = i + 1;
  // A route body ends at the next top-level declaration: another route, a (possibly async) function,
  // or a top-level const. The first draft missed `async function` and ran the approvals GET into the
  // executeApprovedAction helper beneath it, reporting a mutation the route does not perform.
  for (; end < lines.length; end++) if (/^app\.(get|post|put|delete|patch)\(|^(async )?function |^const [A-Za-z_]+ = (async )?\(/.test(lines[end])) break;
  const body = lines.slice(i, end).join('\n');
  if (/saveState\(|sessions\.set\(|users\.push\(|persistEnrollments\(\)/.test(body)) mutatingGets.push(m[1]);
}
assert(JSON.stringify(mutatingGets) === JSON.stringify(['/api/stripe/success', '/api/public/email/unsubscribe']),
  `state-changing GET routes are exactly the two argued safe (Stripe-verified redirect; email-link unsubscribe): ${JSON.stringify(mutatingGets)}`);

done();
