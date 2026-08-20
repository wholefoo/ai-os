// tools/test-clone-onboarding-ui.js
// ============================================================
//  The three onboarding buttons in dashboard/js/clones.js: accept / dismiss / resume.
//
//  WHY THIS SUITE EXISTS. All three carried the same invariant as a COPY-PASTED COMMENT —
//  "MERGE, never replace. A response that omits the disclosure must not blank the one we already
//  hold — an empty consent screen is worse than no consent screen, because it still has a button."
//  A rule stated three times in prose and enforced nowhere can drift in two of the three copies
//  without anything going red. It is now stated once in `clOnboardingPost` and pinned here.
//
//  This is the CONSENT surface, and it is the least exercisable code in the dashboard: the buttons
//  need an authenticated session, and per the project handoff this class of control has never been
//  clicked across several sessions of rewiring. "A DOM check passes on a button that does nothing",
//  so these assertions drive the real functions and read the real state rather than matching source
//  text. Same VM approach as test-clone-persona-ui.js — no jsdom, no server.
//
//  THE ASSERTION THAT EARNS ITS PLACE is 'dismiss shows NO success toast when the POST fails'.
//  The obvious way to factor these three (shared helper, then each caller does its own extra work)
//  puts dismiss's "Set aside" toast AFTER the shared call — so on an error the user gets the error
//  toast AND a cheerful confirmation that something was set aside when nothing was. The helper has
//  to report success, and this is the test that says so.
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assert, done } = require('./test-util');

const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'clones.js'), 'utf8');

/**
 * A fresh sandboxed copy of the view per case — these handlers mutate module-level `clState`, so a
 * shared context would let one case's state leak into the next and turn a real failure green.
 *
 * `reply` maps a request URL to its response, so a case can fail the onboarding POST while still
 * letting the templates fetch succeed (or observe that it was never attempted at all).
 */
function sandbox(reply) {
  const toasts = [];
  const requests = [];
  const detail = { innerHTML: '' };
  const ctx = {
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    timeAgo: () => 'now',
    capitalize: (s) => s,
    fetchJSON: async (url, opts) => { requests.push({ url, method: (opts && opts.method) || 'GET' }); return reply(url); },
    showSettingsToast: (msg, isError) => toasts.push({ msg: String(msg), isError: !!isError }),
    document: { getElementById: (id) => (id === 'clDetail' ? detail : null) },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const state = () => vm.runInContext('clState', ctx);
  return { ctx, toasts, requests, detail, state };
}

/** The shape the server sends back before anyone has consented. */
const PENDING = { status: 'pending', disclosureAccepted: false, disclosure: { version: 2, points: ['a', 'b', 'c', 'd'] } };

const posted = (requests, action) =>
  requests.some((r) => r.url === `/api/clones/onboarding/${action}` && r.method === 'POST');
const fetchedTemplates = (requests) => requests.some((r) => r.url === '/api/clones/templates');

(async () => {
  // --- accept: the happy path, and the invariant the comment used to carry three times ----------
  {
    const s = sandbox((url) => (url === '/api/clones/templates' ? { templates: [{ id: 't1' }] } : { status: 'in_progress', disclosureAccepted: true }));
    s.state().onboarding = { ...PENDING };
    await s.ctx.clAcceptDisclosure();

    assert(posted(s.requests, 'accept'), 'accept POSTs to the accept endpoint');
    assert(s.state().onboarding.status === 'in_progress', 'the response is applied');

    // THE INVARIANT. The reply above deliberately omits `disclosure`. If this ever fails, the merge
    // became a replace and the consent screen renders with no disclosure text and a live button.
    assert(s.state().onboarding.disclosure && s.state().onboarding.disclosure.points.length === 4,
      'MERGE, not replace — a field the response omits survives');
    assert(fetchedTemplates(s.requests), 'accept loads the templates it is about to need');
    assert(s.toasts.length === 0, 'a successful accept says nothing — the screen changing is the feedback');
  }

  // --- accept: a failed POST must not touch state ------------------------------------------------
  {
    const s = sandbox(() => ({ error: 'server said no' }));
    s.state().onboarding = { ...PENDING };
    await s.ctx.clAcceptDisclosure();

    assert(s.state().onboarding.status === 'pending', 'a failed accept leaves the record untouched');
    assert(s.state().onboarding.disclosureAccepted === false, 'and consent is NOT recorded locally');
    assert(s.toasts.length === 1 && s.toasts[0].isError, 'exactly one toast, and it is the error');
    assert(!fetchedTemplates(s.requests), 'a failed accept does not go on to load templates');
  }

  // --- dismiss: success confirms, and does NOT load templates ------------------------------------
  {
    const s = sandbox(() => ({ status: 'dismissed' }));
    s.state().onboarding = { ...PENDING };
    await s.ctx.clDismissOnboarding();

    assert(posted(s.requests, 'dismiss'), 'dismiss POSTs to the dismiss endpoint');
    assert(s.state().onboarding.status === 'dismissed', 'the dismissal is applied');
    assert(s.toasts.length === 1 && !s.toasts[0].isError && /set aside/i.test(s.toasts[0].msg),
      'dismiss confirms in words, because unlike accept the screen barely changes');
    assert(!fetchedTemplates(s.requests),
      'dismiss does NOT load templates — nothing is about to be built, and this difference is why the three are not one function');
  }

  // --- dismiss: THE ONE THAT CATCHES THE OBVIOUS BAD REFACTOR ------------------------------------
  {
    const s = sandbox(() => ({ error: 'server said no' }));
    s.state().onboarding = { ...PENDING };
    await s.ctx.clDismissOnboarding();

    assert(s.toasts.length === 1, 'exactly ONE toast on a failed dismiss — not the error plus a success');
    assert(s.toasts[0].isError, 'and the one toast is the error');
    assert(!s.toasts.some((t) => /set aside/i.test(t.msg)),
      'NOTHING was set aside, so nothing may claim it was — a helper that runs the caller\'s tail on the failure path fails here');
    assert(s.state().onboarding.status === 'pending', 'and the record is untouched');
  }

  // --- resume: same shape as accept, different endpoint ------------------------------------------
  {
    const s = sandbox((url) => (url === '/api/clones/templates' ? { templates: [{ id: 't1' }] } : { status: 'in_progress' }));
    s.state().onboarding = { ...PENDING, status: 'dismissed' };
    await s.ctx.clResumeOnboarding();

    assert(posted(s.requests, 'resume'), 'resume POSTs to the resume endpoint');
    assert(s.state().onboarding.status === 'in_progress', 'picking it back up clears the dismissal');
    assert(s.state().onboarding.disclosure, 'and resume merges too');
    assert(fetchedTemplates(s.requests), 'resume loads templates, like accept');
  }

  // --- all three re-render, because the button that was clicked has to disappear -----------------
  for (const [label, fn] of [['accept', 'clAcceptDisclosure'], ['dismiss', 'clDismissOnboarding'], ['resume', 'clResumeOnboarding']]) {
    const s = sandbox(() => ({ status: 'in_progress', disclosureAccepted: true }));
    s.state().onboarding = { ...PENDING };
    s.detail.innerHTML = 'STALE';
    await s.ctx[fn]();
    assert(s.detail.innerHTML !== 'STALE', `${label} re-renders — otherwise the consent screen stays on screen after consent`);
  }

  done();
})();
