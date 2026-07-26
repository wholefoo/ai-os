// dashboard/js/org.js
// ============================================================
//  Organisation admin panel. Globals from app.js: fetchJSON, escapeHtml, timeAgo, showSettingsToast.
//  Exposes loadOrg(). Inline handlers are global function declarations, matching clones.js.
//
//  This is the surface for what applies ACROSS every clone on an instance rather than to one: the
//  company's own facts and limits (lib/org/profile.js), who is allowed to be here and to spend money
//  commissioning agent work (lib/org/membership.js), who a topic belongs to (lib/org/responsibility.js),
//  and what an employer is allowed to see of a clone that is not their own (lib/org/visibility.js).
//  Every write here is policy for OTHER people's clones, not the operator's own — hence requireAdmin
//  on every route this file calls, and no gating work needed on the nav item: applyRoleGating already
//  hides everything not in CLIENT_VIEWS for role 'client'.
// ============================================================

const orgState = {
  tab: 'company',
  loaded: { company: false, people: false, responsibilities: false, clones: false },
  org: '',
  employees: 0,
  seatLimit: null,
  profile: null,
  members: [],
  inviteInfo: null,   // { email, link, expiresAt } — kept in state, not a toast, because the link is
                       // never emailed and losing it means the operator has to start the invite over
  map: null,
  health: null,
  clones: [],
  selectedCloneId: null,
  drafts: [],
};

// Values must match lib/business-clone/persona.js's enum exactly (org.profile.js normalises through
// it) — anything else is silently dropped on save, which would look like the field refused to stick.
const ORG_PRICING_OPTIONS = [['', '—'], ['none', 'never discuss'], ['ranges', 'ranges only'], ['full', 'full detail']];

function loadOrg() {
  // Every visit re-fetches. The health report in particular is derived from personas that change
  // outside this view, so a cached "every topic has an owner" could be reassuring the owner about a
  // gap that opened since they last looked.
  orgState.loaded = { company: false, people: false, responsibilities: false, clones: false };
  orgState.inviteInfo = null;
  orgRenderTabs();
  // Seat usage in the header comes from the same roster call the People tab uses, so it is fetched
  // up front no matter which tab is showing — otherwise "X of Y seats" would sit blank until the
  // owner happened to open People themselves.
  orgFetchMembers().then(() => { orgRenderWho(); if (orgState.tab === 'people') orgRenderTabBody(); });
  orgEnsureTabData(orgState.tab);
}

function orgTab(tab) {
  orgState.tab = tab;
  orgState.selectedCloneId = null; // leaving "Their clones" collapses whatever draft list was open
  orgState.drafts = [];
  orgRenderTabs();
  orgEnsureTabData(tab);
}

function orgRenderTabs() {
  const el = document.getElementById('orgTabs');
  if (!el) return;
  const TABS = [['company', 'Company'], ['people', 'People'], ['responsibilities', 'Responsibilities'], ['clones', 'Their clones']];
  el.innerHTML = TABS.map(([t, label]) =>
    `<span class="org-tab ${orgState.tab === t ? 'on' : ''}" onclick="orgTab('${t}')">${label}</span>`).join('');
}

function orgRenderWho() {
  const el = document.getElementById('orgWho');
  if (!el) return;
  if (!orgState.org) { el.textContent = ''; return; }
  const seats = orgState.seatLimit == null ? '—' : orgState.seatLimit;
  el.textContent = `${orgState.org} · ${orgState.employees} of ${seats} seat${orgState.seatLimit === 1 ? '' : 's'} used`;
}

/** Lazy per-tab fetch: each tab loads its own data once, on first entry, then re-renders from cache. */
function orgEnsureTabData(tab) {
  if (orgState.loaded[tab]) { orgRenderTabBody(); return; }
  const body = document.getElementById('orgTabBody');
  if (body) body.innerHTML = '<div class="org-muted">Loading…</div>';
  const fetchers = { company: orgFetchProfile, people: orgFetchMembers, responsibilities: orgFetchResponsibilities, clones: orgFetchClones };
  (fetchers[tab] || orgFetchProfile)().then(orgRenderTabBody);
}

function orgRenderTabBody() {
  const body = document.getElementById('orgTabBody');
  if (!body) return;
  if (orgState.tab === 'company') body.innerHTML = orgCompanyHtml();
  else if (orgState.tab === 'people') body.innerHTML = orgPeopleHtml();
  else if (orgState.tab === 'responsibilities') body.innerHTML = orgResponsibilitiesHtml();
  else body.innerHTML = orgCloneHtml();
}

// --- fetchers ----------------------------------------------------------------
// fetchJSON returns [] for a failed GET (never {error}) — every fetcher here checks for that
// shape explicitly rather than trusting `res.error`, or a dead network would render as an empty org.

async function orgFetchProfile() {
  const res = await fetchJSON('/api/org/profile');
  if (!res || Array.isArray(res) || res.error) { showSettingsToast((res && res.error) || 'Could not load the company profile', true); return; }
  orgState.org = res.org || orgState.org;
  orgState.profile = res.profile;
  orgState.loaded.company = true;
}

async function orgFetchMembers() {
  const res = await fetchJSON('/api/org/members');
  if (!res || Array.isArray(res) || res.error) { showSettingsToast((res && res.error) || 'Could not load your people', true); return; }
  orgState.org = res.org || orgState.org;
  orgState.members = res.members || [];
  orgState.employees = res.employees || 0;
  orgState.seatLimit = (res.seatLimit === undefined) ? null : res.seatLimit;
  orgState.loaded.people = true;
}

async function orgFetchResponsibilities() {
  const res = await fetchJSON('/api/org/responsibilities');
  if (!res || Array.isArray(res) || res.error) { showSettingsToast((res && res.error) || 'Could not load the responsibility map', true); return; }
  orgState.org = res.org || orgState.org;
  orgState.map = res.map;
  orgState.health = res.health;
  orgState.loaded.responsibilities = true;
}

async function orgFetchClones() {
  const res = await fetchJSON('/api/org/clones');
  if (!res || Array.isArray(res) || res.error) { showSettingsToast((res && res.error) || 'Could not load your team’s clones', true); return; }
  orgState.clones = res.clones || [];
  orgState.loaded.clones = true;
}

// --- list/text helpers ---------------------------------------------------
// One entry per line, round-tripping exactly — mirrors clones.js's list fields, and matters for the
// same reason: a boundary list is something an owner audits by eye, not something worth a fancier
// tag-input widget.
function orgTextToList(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
function orgListToText(arr) {
  return (arr || []).join('\n');
}

// --- Tab 1: Company -----------------------------------------------------

function orgCompanyHtml() {
  const p = orgState.profile || { identity: {}, boundaries: {} };
  const i = p.identity || {};
  const b = p.boundaries || {};
  const pricingOpts = ORG_PRICING_OPTIONS.map(([v, t]) =>
    `<option value="${escapeHtml(v)}" ${(b.pricingDisclosure || '') === v ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

  return `
    <div class="org-note">
      These facts and limits apply to EVERY clone on this instance, not just one. The company's
      limits are added on top of each person's own — an employee can add stricter limits for
      themselves, but nothing here can be removed by them. Identity facts only fill in blanks: if
      someone has already described the business in their own words during their own interview,
      that stays theirs and this never overwrites it.
    </div>

    <h4 style="margin:16px 0 6px;">Who you are</h4>
    <div class="org-muted" style="margin:4px 0 3px;">Business name</div>
    <input id="orgIdentityBusinessName" type="text" style="width:100%;" value="${escapeHtml(i.businessName)}">
    <div class="org-muted" style="margin:10px 0 3px;">Industry</div>
    <input id="orgIdentityIndustry" type="text" style="width:100%;" value="${escapeHtml(i.industry)}">
    <div class="org-muted" style="margin:10px 0 3px;">What the business does</div>
    <textarea id="orgIdentityWhatTheyDo" rows="3" style="width:100%;">${escapeHtml(i.whatTheyDo)}</textarea>

    <h4 style="margin:18px 0 6px;">Limits everyone shares</h4>
    <div class="org-grid-2">
      <div>
        <div class="org-muted" style="margin:4px 0 3px;">Never say (one per line)</div>
        <textarea id="orgBoundaryNeverSay" rows="4" style="width:100%;">${escapeHtml(orgListToText(b.neverSay))}</textarea>
      </div>
      <div>
        <div class="org-muted" style="margin:4px 0 3px;">Never promise (one per line)</div>
        <textarea id="orgBoundaryNeverPromise" rows="4" style="width:100%;">${escapeHtml(orgListToText(b.neverPromise))}</textarea>
      </div>
      <div>
        <div class="org-muted" style="margin:4px 0 3px;">Always yours to handle (one per line)</div>
        <textarea id="orgBoundaryRequiresHuman" rows="4" style="width:100%;">${escapeHtml(orgListToText(b.requiresHuman))}</textarea>
      </div>
      <div>
        <div class="org-muted" style="margin:4px 0 3px;">Confidential (one per line)</div>
        <textarea id="orgBoundaryConfidentialTopics" rows="4" style="width:100%;">${escapeHtml(orgListToText(b.confidentialTopics))}</textarea>
      </div>
    </div>

    <div class="org-muted" style="margin:14px 0 3px;">Pricing</div>
    <select id="orgBoundaryPricingDisclosure" style="max-width:260px;">${pricingOpts}</select>
    <div class="org-muted" style="margin:14px 0 3px;">On competitors</div>
    <input id="orgBoundaryCompetitorPolicy" type="text" style="width:100%;" value="${escapeHtml(b.competitorPolicy)}">

    <div style="margin-top:16px;">
      <button class="btn btn-primary" onclick="orgSaveProfile()">Save company profile</button>
    </div>`;
}

async function orgSaveProfile() {
  const val = (id) => ((document.getElementById(id) || {}).value || '');
  const profile = {
    identity: {
      businessName: val('orgIdentityBusinessName').trim(),
      industry: val('orgIdentityIndustry').trim(),
      whatTheyDo: val('orgIdentityWhatTheyDo').trim(),
    },
    boundaries: {
      neverSay: orgTextToList(val('orgBoundaryNeverSay')),
      neverPromise: orgTextToList(val('orgBoundaryNeverPromise')),
      requiresHuman: orgTextToList(val('orgBoundaryRequiresHuman')),
      confidentialTopics: orgTextToList(val('orgBoundaryConfidentialTopics')),
      pricingDisclosure: val('orgBoundaryPricingDisclosure'),
      competitorPolicy: val('orgBoundaryCompetitorPolicy').trim(),
    },
  };

  const res = await fetchJSON('/api/org/profile', { method: 'PUT', body: { profile } });
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not save the company profile', true);
  orgState.profile = res.profile;
  orgState.loaded.company = true;
  orgRenderTabBody();
  showSettingsToast('Company profile saved');
}

// --- Tab 2: People --------------------------------------------------------

function orgPeopleHtml() {
  const rows = (orgState.members || []).map(orgMemberRowHtml).join('') || '<div class="org-empty">Nobody here yet.</div>';
  const inviteResult = orgState.inviteInfo ? `
    <div class="org-note" style="margin-top:10px;">
      Invite ready for <strong>${escapeHtml(orgState.inviteInfo.email)}</strong>. This link is not
      emailed automatically — send it yourself. It works once and expires ${escapeHtml(orgDateLabel(orgState.inviteInfo.expiresAt))}.
      <div style="margin-top:6px;">
        <input type="text" readonly style="width:100%;" value="${escapeHtml(orgState.inviteInfo.link)}" onclick="this.select()">
      </div>
    </div>` : '';

  return `
    <div class="org-row" style="flex-direction:column;align-items:stretch;gap:8px;">
      <div class="org-muted">Invite someone to join. They get their own clone and sign in with the link below once you send it to them.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="orgInviteName" type="text" placeholder="Name" style="max-width:200px;flex:1;">
        <input id="orgInviteEmail" type="text" placeholder="Email" style="max-width:260px;flex:1;">
        <button class="btn btn-primary" onclick="orgSubmitInvite()">Invite</button>
      </div>
      ${inviteResult}
    </div>
    ${rows}`;
}

/** A plain date rather than "in 7 days" — a deadline you have to hand to someone else should not
 *  keep shifting under whoever is reading it later. */
function orgDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function orgMemberRowHtml(m) {
  const tag = m.isOwner
    ? '<span class="org-tag" style="color:#22c55e;border-color:#22c55e;">owner</span>'
    : '<span class="org-tag">employee</span>';
  const pending = m.invitePending ? '<span class="org-tag" style="color:#eab308;border-color:#eab308;">invite pending</span>' : '';

  // The owner gets no controls at all — the server refuses self-offboarding and there is nothing to
  // grant them that they do not already have, so a button here would just be one that always 400s.
  const controls = m.isOwner ? '' : `
    <div style="margin-top:8px;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
        <input type="checkbox" ${m.cloneDispatch ? 'checked' : ''} onchange="orgToggleDispatch('${escapeHtml(m.email)}', this.checked)">
        May commission agent work
      </label>
      <div class="org-muted" style="font-size:11px;margin:2px 0 8px 22px;">Having a clone and letting it spend money commissioning work from agents are different permissions. This one starts off.</div>
      <button class="btn" onclick="orgRemoveMember('${escapeHtml(m.email)}')">Remove</button>
    </div>`;

  return `
    <div class="org-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
        <div>
          <strong>${escapeHtml(m.name || m.email)}</strong>
          <div class="org-muted">${escapeHtml(m.email)}</div>
        </div>
        <div style="display:flex;gap:6px;">${tag}${pending}</div>
      </div>
      ${controls}
    </div>`;
}

async function orgSubmitInvite() {
  const name = ((document.getElementById('orgInviteName') || {}).value || '').trim();
  const email = ((document.getElementById('orgInviteEmail') || {}).value || '').trim();
  if (!email) return showSettingsToast('Enter an email address first', true);

  const res = await fetchJSON('/api/org/members', { method: 'POST', body: { name, email } });
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not send that invite', true);

  // The link is the whole point of this response — kept in state, not a toast, until the operator
  // does something else on this tab. A toast that vanishes in three seconds is how a single-use
  // credential gets lost and the invite has to be redone.
  orgState.inviteInfo = { email: (res.member && res.member.email) || email, link: res.link, expiresAt: res.expiresAt };
  await orgFetchMembers();
  orgRenderWho();
  orgRenderTabBody();
  showSettingsToast('Invite created — copy the link below to send it');
}

async function orgToggleDispatch(email, enabled) {
  const res = await fetchJSON(`/api/org/members/${encodeURIComponent(email)}/dispatch`, { method: 'PUT', body: { enabled } });
  if (!res || res.error) showSettingsToast((res && res.error) || 'Could not change that permission', true);
  await orgFetchMembers();
  orgRenderTabBody();
}

async function orgRemoveMember(email) {
  if (!confirm(`Remove ${email}? Their account and their clone's persona are deleted. Any work their clone produced for the business is kept as a company record, with the persona detached from it.`)) return;
  const res = await fetchJSON(`/api/org/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not remove that person', true);
  await orgFetchMembers();
  orgRenderWho();
  orgRenderTabBody();
  showSettingsToast('Removed');
}

// --- Tab 3: Responsibilities ----------------------------------------------

function orgResponsibilitiesHtml() {
  const areas = (orgState.map && orgState.map.areas) || [];
  return `
    <div class="org-note">
      A persona holds the TOPIC — "contract disputes are not mine to answer." This map holds whose
      they are. Kept separate, a reorganisation means editing one map, not going through every
      person's persona one at a time.
    </div>
    ${orgHealthHtml()}
    <h4 style="margin:16px 0 6px;">Areas</h4>
    <div id="orgAreasList">${areas.map(orgAreaRowHtml).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="btn" onclick="orgAddArea()">+ Add area</button>
      <button class="btn btn-primary" onclick="orgSaveResponsibilities()">Save</button>
    </div>`;
}

/** The reason the map is central rather than per-persona: this is deliberately the loudest part of
 *  the tab, above the editor, because a gap or an overlap is a routing failure in production, not a
 *  data-entry nicety. */
function orgHealthHtml() {
  const h = orgState.health || { areas: 0, overlaps: [], gaps: [], unknownHandlers: [] };
  const boxes = [];
  if ((h.gaps || []).length) {
    boxes.push(`<div class="org-bad"><strong>No one is assigned to: ${h.gaps.map(escapeHtml).join(', ')}.</strong><br>These are topics somebody's clone will refuse to handle, and then hand off to nobody in particular.</div>`);
  }
  if ((h.overlaps || []).length) {
    boxes.push(`<div class="org-warn">${h.overlaps.map((o) =>
      `Claimed twice: <strong>${escapeHtml(o.topic)}</strong> — ${(o.areas || []).map((a) => escapeHtml(a.handler)).join(' and ')}.`).join('<br>')}</div>`);
  }
  if ((h.unknownHandlers || []).length) {
    boxes.push(`<div class="org-warn">${h.unknownHandlers.map((u) =>
      `${escapeHtml(u.area)} routes to ${escapeHtml(u.handler)}${u.field === 'backup' ? ' (backup)' : ''}, who is not in this organisation.`).join('<br>')}</div>`);
  }
  if (!boxes.length) return '<div class="org-ok">Every escalation topic has an owner.</div>';
  return boxes.join('');
}

function orgAreaRowHtml(a, idx) {
  return `
    <div class="org-row" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:6px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="orgAreaName-${idx}" type="text" placeholder="Area name" style="flex:1;min-width:150px;" value="${escapeHtml(a.name)}">
        <input id="orgAreaHandler-${idx}" type="text" placeholder="Handler email" style="flex:1;min-width:180px;" value="${escapeHtml(a.handler)}">
        <input id="orgAreaBackup-${idx}" type="text" placeholder="Backup email (optional)" style="flex:1;min-width:180px;" value="${escapeHtml(a.backup)}">
      </div>
      <textarea id="orgAreaTopics-${idx}" rows="2" placeholder="Topics, one per line" style="width:100%;">${escapeHtml(orgListToText(a.topics))}</textarea>
      <div style="display:flex;gap:8px;">
        <input id="orgAreaNote-${idx}" type="text" placeholder="Note (optional)" style="flex:1;" value="${escapeHtml(a.note)}">
        <button class="btn" onclick="orgRemoveArea(${idx})">Remove</button>
      </div>
    </div>`;
}

/**
 * Reads every area row out of the DOM. Called before add, remove AND save — the rows on screen are
 * the source of truth for anything the owner has typed but not yet saved, and rebuilding the list
 * from stale state instead would silently discard it the moment someone clicks "+ Add area".
 */
function orgCollectMap() {
  const rows = document.querySelectorAll('#orgAreasList .org-row');
  const prior = (orgState.map && orgState.map.areas) || [];
  const areas = Array.from(rows).map((row) => {
    const idx = row.dataset.idx;
    const val = (id) => ((document.getElementById(id) || {}).value || '');
    return {
      id: (prior[idx] && prior[idx].id) || '',
      name: val(`orgAreaName-${idx}`).trim(),
      handler: val(`orgAreaHandler-${idx}`).trim(),
      backup: val(`orgAreaBackup-${idx}`).trim(),
      topics: orgTextToList(val(`orgAreaTopics-${idx}`)),
      note: val(`orgAreaNote-${idx}`).trim(),
    };
  });
  return { ownerEmail: (orgState.map && orgState.map.ownerEmail) || '', areas, updatedAt: (orgState.map && orgState.map.updatedAt) || null };
}

function orgAddArea() {
  orgState.map = orgCollectMap();
  orgState.map.areas.push({ id: '', name: '', handler: '', backup: '', topics: [], note: '' });
  orgRenderTabBody();
}

function orgRemoveArea(idx) {
  orgState.map = orgCollectMap();
  orgState.map.areas.splice(idx, 1);
  orgRenderTabBody();
}

async function orgSaveResponsibilities() {
  const map = orgCollectMap();
  const res = await fetchJSON('/api/org/responsibilities', { method: 'PUT', body: { map } });
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not save the responsibility map', true);
  orgState.map = res.map;
  orgState.health = res.health;
  orgRenderTabBody();
  showSettingsToast('Responsibility map saved');
}

// --- Tab 4: Their clones ---------------------------------------------------
// This endpoint is deliberately redacted server-side (lib/org/visibility.js's allowlist) — it carries
// the correspondence, not the person. Rendered fields mirror exactly what employerDraftView returns;
// nothing here should be assumed beyond that allowlist.

function orgCloneHtml() {
  const note = `<div class="org-note">You can see what your employees' clones have produced for the business. You cannot see their persona — their voice, their opinions and their own limits stay theirs.</div>`;
  if (!orgState.clones.length) return note + '<div class="org-empty">No employee clones yet.</div>';
  return note + orgState.clones.map(orgCloneCardHtml).join('');
}

function orgCloneCardHtml(c) {
  const open = orgState.selectedCloneId === c.cloneId;
  const m = c.metrics || {};
  return `
    <div class="org-card">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;cursor:pointer;" onclick="orgOpenClone('${escapeHtml(c.cloneId)}')">
        <div>
          <strong>${escapeHtml(c.personName || c.person)}</strong>
          <div class="org-muted">${escapeHtml(c.name)}${c.role ? ` · ${escapeHtml(c.role)}` : ''}</div>
        </div>
        <span class="org-tag">${escapeHtml(c.status)}</span>
      </div>
      <div class="org-muted" style="margin-top:6px;">${Number(c.completeness) || 0}% known · persona v${Number(c.personaVersion) || 0} · updated ${timeAgo(c.updatedAt)}</div>
      <div class="org-muted" style="margin-top:4px;">${m.draftsProduced || 0} drafts · ${m.approved || 0} approved · ${m.edited || 0} edited · ${m.rejected || 0} rejected</div>
      ${open ? orgCloneDraftsHtml() : ''}
    </div>`;
}

// The click target that opens a card is its header row, not the whole card — once expanded, clicking
// inside a draft's textarea must not bubble up and re-toggle the very panel it is inside.
async function orgOpenClone(id) {
  if (orgState.selectedCloneId === id) { orgState.selectedCloneId = null; orgState.drafts = []; orgRenderTabBody(); return; }
  const res = await fetchJSON(`/api/org/clones/${id}/drafts`);
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not load their drafts', true);
  orgState.selectedCloneId = id;
  orgState.drafts = res.drafts || [];
  orgRenderTabBody();
}

function orgCloneDraftsHtml() {
  if (!orgState.drafts.length) return '<div class="org-empty" style="margin-top:10px;">No drafts yet.</div>';
  return `<div style="margin-top:10px;border-top:1px dashed var(--border,#2a2a3a);padding-top:10px;">${orgState.drafts.map(orgDraftRowHtml).join('')}</div>`;
}

function orgDraftRowHtml(d) {
  const warn = (d.blocked || (d.violations || []).length)
    ? `<div class="org-warn">${d.blocked ? '<strong>This crossed a line.</strong><br>' : ''}${(d.violations || []).map((v) => escapeHtml(`${v.kind}: "${v.phrase}"`)).join('<br>')}</div>` : '';
  const esc = (d.escalationReasons || []).length
    ? `<div class="org-bad">${(d.escalationReasons || []).map(escapeHtml).join('<br>')}</div>` : '';
  return `
    <div style="border:1px solid var(--border,#2a2a3a);border-radius:8px;padding:10px;margin-bottom:8px;">
      <div class="org-muted">${timeAgo(d.createdAt)} · ${escapeHtml(d.channel)} · ${escapeHtml(d.status)}${d.cost ? ` · $${Number(d.cost).toFixed(4)}` : ''}</div>
      <div style="margin:6px 0;"><em>${escapeHtml(d.inbound)}</em></div>
      ${warn}${esc}
      <textarea rows="4" style="width:100%;" readonly>${escapeHtml(d.finalText || d.text || '')}</textarea>
      ${d.note ? `<div class="org-muted" style="margin-top:4px;">${escapeHtml(d.note)}</div>` : ''}
    </div>`;
}
