// tools/verify-clone-live.js
// ============================================================
//  Live end-to-end check of the AI Business Clone API against a RUNNING instance.
//
//  Deliberately NOT named test-*.js: tools/test-all.js auto-discovers that prefix, and this suite
//  needs a live server, real credentials, and (with --with-model) real money. It must never run
//  itself in CI.
//
//  What it covers that the unit suites cannot: route registration, the auth and client-surface
//  middleware chain, request/response shapes over real HTTP, state persistence across requests,
//  and — with --with-model — the executeAgent systemOverride path, the interview ASK/EXTRACT loop,
//  and the drafting screens. Those are exactly the layers that unit tests mock away.
//
//  Usage (from the repo root, against your own running instance):
//
//    node tools/verify-clone-live.js                    # free routes only, no model spend
//    node tools/verify-clone-live.js --with-model       # adds ~4 paid calls (a few cents)
//    node tools/verify-clone-live.js --base http://localhost:3000
//
//  Auth: reads API_TOKEN from the environment, else from .env in the repo root. The token is never
//  printed. If your instance authenticates by session cookie instead, pass --cookie "<value>".
//
//  It creates a clone named "LIVE VERIFY — safe to delete" and deletes it at the end, including
//  after a failure, so a botched run does not leave a persona lying around in your dashboard.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('base', process.env.AIOS_BASE || 'http://localhost:3000').replace(/\/$/, '');
const WITH_MODEL = has('with-model');
const COOKIE = flag('cookie', null);

function resolveToken() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN.trim();
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf8').match(/^API_TOKEN=(.*)$/m);
  return m ? m[1].trim() : null;
}
const TOKEN = resolveToken();

if (!TOKEN && !COOKIE) {
  console.error('No credentials. Set API_TOKEN in the environment or .env, or pass --cookie "<session>".');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function check(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; failures.push(label); }
}
const section = (name) => console.log(`\n=== ${name} ===`);

async function api(method, route, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers.Cookie = `ai-os-session=${COOKIE}`;
  else headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

/** Fail loudly and early when the instance is not reachable or not authenticating. */
async function preflight() {
  section('Preflight');
  let health;
  try {
    health = await fetch(BASE + '/api/health').then((r) => r.status);
  } catch (e) {
    console.error(`\nCannot reach ${BASE} — is the server running?\n  ${e.message}`);
    process.exit(2);
  }
  check(health === 200, `instance reachable at ${BASE}`);

  const probe = await api('GET', '/api/clones');
  if (probe.status === 401 || probe.status === 403) {
    console.error(`\nAuthenticated as nobody (${probe.status}). The credential was rejected.`);
    console.error('If this instance uses session login, pass --cookie with a valid ai-os-session value.');
    process.exit(2);
  }
  check(probe.status === 200, `authenticated (GET /api/clones -> ${probe.status})`);
  check(Array.isArray(probe.json && probe.json.clones), 'the clone list is an array');
}

async function run() {
  await preflight();

  let cloneId = null;
  try {
    section('Create + read');
    const created = await api('POST', '/api/clones', { name: 'LIVE VERIFY — safe to delete' });
    check(created.status === 200 && created.json.ok, `create returns ok (${created.status})`);
    cloneId = created.json.clone && created.json.clone.id;
    check(!!cloneId, 'create returns a clone id');
    if (!cloneId) return;
    check(created.json.clone.status === 'interviewing', 'a new clone starts in interviewing');
    check(created.json.clone.completeness === 0, 'a new clone is 0% complete');
    check(created.json.clone.usable === false, 'a new clone is not usable');

    const listed = await api('GET', '/api/clones');
    check(listed.json.clones.some((c) => c.id === cloneId), 'the new clone appears in the list (state persisted across requests)');

    const detail = await api('GET', `/api/clones/${cloneId}`);
    check(detail.status === 200 && !!detail.json.persona, 'detail returns the full persona');
    check(!!detail.json.promptFingerprint, 'detail returns a prompt fingerprint');
    check(Array.isArray(detail.json.transcript), 'detail returns a transcript array');

    const prompt = await api('GET', `/api/clones/${cloneId}/prompt`);
    check(prompt.status === 200 && /drafting as/i.test(prompt.json.prompt || ''), 'the owner can read the compiled prompt');
    check(/Hard limits/.test(prompt.json.prompt || ''), 'the compiled prompt carries the boundaries block');

    section('Refusals before the clone is ready');
    const earlyChat = await api('POST', `/api/clones/${cloneId}/chat`, { message: 'hello' });
    check(earlyChat.status === 400, `an unready clone refuses to chat (${earlyChat.status})`);
    check(Array.isArray(earlyChat.json.blockers) && earlyChat.json.blockers.length > 0, 'and says what is blocking it');

    const earlyActivate = await api('POST', `/api/clones/${cloneId}/status`, { status: 'active' });
    check(earlyActivate.status === 400, `an unusable clone cannot be activated (${earlyActivate.status})`);

    const earlyDraft = await api('POST', `/api/clones/${cloneId}/drafts`, { inbound: 'Do you install?' });
    check(earlyDraft.status === 400, `an unready clone refuses to draft (${earlyDraft.status})`);

    section('Scoping');
    const missing = await api('GET', '/api/clones/does-not-exist-at-all');
    check(missing.status === 404, `an unknown clone id is 404, never another client's record (${missing.status})`);
    const missingDraft = await api('POST', `/api/clones/${cloneId}/drafts/nope/review`, { verdict: 'approved' });
    check(missingDraft.status === 404, `an unknown draft id is 404 (${missingDraft.status})`);

    section('Bad input');
    const noAnswer = await api('POST', `/api/clones/${cloneId}/interview/answer`, { answer: '   ' });
    check(noAnswer.status === 400, `a blank interview answer is rejected (${noAnswer.status})`);
    const badStatus = await api('POST', `/api/clones/${cloneId}/status`, { status: 'banana' });
    check(badStatus.status === 400, `an unknown status is rejected (${badStatus.status})`);

    if (!WITH_MODEL) {
      section('Model-backed steps SKIPPED');
      console.log('  Re-run with --with-model to exercise the interview loop, the systemOverride');
      console.log('  path, and the drafting screens. Those make real, paid model calls.');
    } else {
      section('Interview (paid)');
      const q = await api('POST', `/api/clones/${cloneId}/interview/next`);
      check(q.status === 200 && !!q.json.question, `interview/next returns a question (${q.status})`);
      check(q.json.dimension === 'identity', `the first question targets identity (got ${q.json.dimension})`);
      check(q.json.generated === true, 'the question came from the model, not the seed fallback (systemOverride path works)');
      console.log(`       Q: ${String(q.json.question).slice(0, 120)}`);

      const answer = 'My name is Dana Whitfield. I run Whitfield Dental Supply — we sell and install '
        + 'dental equipment for independent practices. Eighteen years now.';
      const ans = await api('POST', `/api/clones/${cloneId}/interview/answer`, { answer });
      check(ans.status === 200, `interview/answer returns ok (${ans.status})`);
      check(ans.json.extracted === true, 'the answer was extracted into structured fields');
      const id = (ans.json.persona || {}).identity || {};
      console.log(`       extracted: ${JSON.stringify(id)}`);
      check(/dana/i.test(id.ownerName || ''), `ownerName extracted (got ${id.ownerName})`);
      check(id.yearsExperience === 18, `yearsExperience extracted as a number (got ${id.yearsExperience})`);
      check(ans.json.progress.overall > 0, `progress advanced to ${ans.json.progress && ans.json.progress.overall}%`);

      const after = await api('GET', `/api/clones/${cloneId}`);
      check(after.json.transcript.length === 2, `both turns are in the transcript (got ${after.json.transcript.length})`);

      section('Drafting screens (paid)');
      // Give the clone just enough persona to be usable, so the drafting screens can be exercised
      // without walking the entire interview. This writes boundaries directly, which is exactly
      // what the inbound screen reads.
      await api('POST', `/api/clones/${cloneId}/interview/answer`, {
        answer: 'Never say "lowest price anywhere". Never promise next-day delivery. Always send me '
          + 'anything about a contract dispute personally. Supplier margins are confidential. '
          + 'You can quote price ranges but never an exact figure.',
      });
      const ready = await api('GET', `/api/clones/${cloneId}`);
      console.log(`       completeness now ${ready.json.completeness}%, usable=${ready.json.usable}`);

      if (!ready.json.usable) {
        console.log('       (persona still below the usability bar — drafting checks skipped;');
        console.log('        this is the interview needing more turns, not a route failure)');
      } else {
        const escalated = await api('POST', `/api/clones/${cloneId}/drafts`, {
          inbound: 'We need to talk about the contract dispute on our March order.',
        });
        check(escalated.status === 200, `a boundary-tripping message still returns 200 (${escalated.status})`);
        check(escalated.json.draft.status === 'escalated', 'it is ESCALATED, not drafted');
        check(escalated.json.draft.text === '', 'and no text was generated — the paid call was skipped');
        check(escalated.json.draft.escalationReasons.length > 0, 'the owner is told why');

        const drafted = await api('POST', `/api/clones/${cloneId}/drafts`, {
          inbound: 'Hi — do you install the chairs you sell? Ours arrives Tuesday.',
        });
        check(drafted.status === 200 && !!drafted.json.draft.text, `an ordinary message is drafted (${drafted.status})`);
        check(drafted.json.draft.status === 'pending', 'the draft awaits review');
        check(typeof drafted.json.draft.cost === 'number', 'the draft records its cost');
        check(!!drafted.json.draft.promptFingerprint, 'the draft records the prompt that produced it');
        console.log(`       draft: ${String(drafted.json.draft.text).slice(0, 160)}`);

        const review = await api('POST', `/api/clones/${cloneId}/drafts/${drafted.json.draft.id}/review`, {
          verdict: 'edited', finalText: 'Yes — we install everything we sell.', note: 'too long',
        });
        check(review.status === 200, `review accepted (${review.status})`);
        check(review.json.draft.status === 'edited', 'the verdict is recorded');
        check(review.json.draft.text !== review.json.draft.finalText, 'both the original and the rewrite are kept — that diff is the P4 signal');
        check(review.json.metrics.edited >= 1, 'clone metrics updated');

        const twice = await api('POST', `/api/clones/${cloneId}/drafts/${drafted.json.draft.id}/review`, { verdict: 'approved' });
        check(twice.status === 400, `a draft cannot be reviewed twice (${twice.status})`);
      }
    }
  } finally {
    // Always clean up, including after a mid-run failure — a verification run must not leave a
    // persona sitting in someone's dashboard.
    if (cloneId) {
      section('Cleanup');
      const del = await api('DELETE', `/api/clones/${cloneId}`);
      check(del.status === 200, 'the verification clone was deleted');
      const gone = await api('GET', `/api/clones/${cloneId}`);
      check(gone.status === 404, 'and is really gone');
    }
  }
}

run()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed${WITH_MODEL ? '' : ' (model-backed steps skipped — use --with-model)'}`);
    if (fail) {
      console.log('\nFailures:');
      failures.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error('\nVerification crashed:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
