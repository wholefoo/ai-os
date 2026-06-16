// dashboard/js/crm.js
// ============================================================
//  CRM dashboard view. Globals from app.js: fetchJSON, escapeHtml, timeAgo.
//  Exposes loadCrm() + onCrmEvent(msg). Inline onclick handlers (crmOpenContact,
//  crmSaveContact, crmAddNote, crmLinkSite) are global function declarations.
//    Phase 1: directory + read-only detail.  Phase 2: edit / notes / link / add.
// ============================================================

const crmState = { wired: false, q: '', flag: '', stage: '', selectedId: null, unassigned: [], _searchTimer: null };

const crmVal = (id) => { const el = document.getElementById(id); return el ? (el.value || '') : ''; };

function loadCrm() {
  if (!crmState.wired) {
    crmState.wired = true;
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('crmRefresh', 'click', crmFetchAndRender);
    on('crmAddBtn', 'click', crmAddContact);
    on('crmStage', 'change', (e) => { crmState.stage = e.target.value; crmLoadList(); });
    const search = document.getElementById('crmSearch');
    if (search) search.addEventListener('input', (e) => {
      crmState.q = e.target.value.trim();
      clearTimeout(crmState._searchTimer);
      crmState._searchTimer = setTimeout(crmLoadList, 250);
    });
    document.querySelectorAll('#crmFlagChips .crm-chip').forEach((btn) => btn.addEventListener('click', () => {
      crmState.flag = btn.getAttribute('data-flag') || '';
      document.querySelectorAll('#crmFlagChips .crm-chip').forEach((x) => x.classList.toggle('crm-chip-active', x === btn));
      crmLoadList();
    }));
  }
  crmFetchAndRender();
}

function crmFetchAndRender() {
  crmLoadStats();
  crmLoadList();
  crmLoadUnassigned();
}

async function crmLoadStats() {
  const s = await fetchJSON('/api/crm/stats');
  const el = document.getElementById('crmStats');
  if (!el || !s || s.error) return;
  const cards = [
    ['Total', s.total, ''], ['Leads', s.leads, 'color:#eab308'],
    ['Clients', s.clients, 'color:#22c55e'], ['License holders', s.licenses, 'color:#a855f7'],
  ];
  el.innerHTML = cards.map(([label, val, style]) =>
    `<div class="crm-stat"><div class="crm-stat-value" style="${style}">${val || 0}</div><div class="crm-stat-label">${label}</div></div>`).join('');
}

async function crmLoadList() {
  const params = new URLSearchParams();
  if (crmState.q) params.set('q', crmState.q);
  if (crmState.flag) params.set('flag', crmState.flag);
  if (crmState.stage) params.set('stage', crmState.stage);
  params.set('limit', '100');
  const data = await fetchJSON('/api/crm/contacts?' + params.toString());
  const el = document.getElementById('crmList');
  if (!el) return;
  const rows = (data && data.rows) || [];
  if (!rows.length) { el.innerHTML = '<div class="empty-state">No contacts match.</div>'; return; }
  el.innerHTML = rows.map((c) => `
    <div class="crm-row ${c.id === crmState.selectedId ? 'active' : ''}" onclick="crmOpenContact('${c.id}')">
      <div style="min-width:0;">
        <div><strong>${escapeHtml(c.name || c.email)}</strong></div>
        <div class="crm-muted">${escapeHtml(c.email)}${c.primary_domain ? ' · ' + escapeHtml(c.primary_domain) : ''}</div>
      </div>
      <div style="text-align:right;white-space:nowrap;">
        ${crmTags(c)}
        <div class="crm-muted">${escapeHtml(c.stage)}${c.audit_score != null ? ' · ' + c.audit_score : ''}</div>
      </div>
    </div>`).join('') + (data.total > rows.length ? `<div class="crm-muted" style="padding:8px;">Showing ${rows.length} of ${data.total}.</div>` : '');
}

function crmTags(c) {
  return `${c.is_lead ? '<span class="crm-tag lead">Lead</span> ' : ''}${c.is_client ? '<span class="crm-tag client">Client</span> ' : ''}${c.is_license ? '<span class="crm-tag license">License</span>' : ''}`;
}

const CRM_STAGES = ['lead', 'audited', 'onboarding', 'customer', 'churned'];

async function crmOpenContact(id) {
  crmState.selectedId = id;
  const data = await fetchJSON(`/api/crm/contacts/${id}`);
  const el = document.getElementById('crmDetail');
  if (!el) return;
  if (!data || data.error || !data.contact) { el.innerHTML = '<div class="empty-state">Could not load contact.</div>'; return; }
  const c = data.contact;
  const ro = (k, v) => (v || v === 0) ? `<div class="crm-detail-row"><span class="crm-muted">${k}</span><span>${escapeHtml(String(v))}</span></div>` : '';
  const date = (v) => { try { return v ? new Date(v).toLocaleDateString() : ''; } catch { return v || ''; } };
  const stageOpts = CRM_STAGES.map((s) => `<option value="${s}" ${c.stage === s ? 'selected' : ''}>${s}</option>`).join('');
  const linkOpts = crmState.unassigned.map((s) => `<option value="${s.id}">${escapeHtml(s.name || s.domain || s.id)}${s.domain ? ' (' + escapeHtml(s.domain) + ')' : ''}</option>`).join('');

  el.innerHTML = `
    <div class="ws-row" style="justify-content:space-between;align-items:start;">
      <h3 class="panel-title" style="margin:0;">${escapeHtml(c.name || c.email)}</h3>
      <span>${crmTags(c)} <span class="crm-tag">${escapeHtml(c.stage)}</span></span>
    </div>

    <div style="display:grid;gap:8px;margin:10px 0;">
      <div class="ws-row" style="gap:8px;">
        <input class="settings-input" id="cfName" placeholder="Name" value="${escapeHtml(c.name || '')}" style="flex:1;" />
        <input class="settings-input" id="cfCompany" placeholder="Company" value="${escapeHtml(c.company || '')}" style="flex:1;" />
      </div>
      <div class="ws-row" style="gap:8px;">
        <select class="settings-input" id="cfStage" style="max-width:150px;">${stageOpts}</select>
        <input class="settings-input" id="cfOwner" placeholder="Owner" value="${escapeHtml(c.owner || '')}" style="max-width:130px;" />
        <input class="settings-input" id="cfTags" placeholder="tags, comma separated" value="${escapeHtml((c.tags || []).join(', '))}" style="flex:1;" />
        <button class="btn btn-primary" onclick="crmSaveContact('${c.id}')">Save</button>
      </div>
    </div>

    ${ro('Email', c.email)}
    ${ro('Plan', c.plan)}
    ${ro('Audit score', c.audit_score)}
    ${ro('Primary domain', c.primary_domain)}
    ${ro('Purchased', date(c.purchased_at))}
    ${ro('Support expires', date(c.support_expires_at))}
    ${ro('Source', c.source)}
    ${ro('Created', c.created_at ? timeAgo(c.created_at) : '')}

    <h3 class="panel-title" style="margin-top:14px;">Sites (${data.sites.length})</h3>
    ${data.sites.length ? data.sites.map((s) => `<div class="crm-detail-row"><span>${escapeHtml(s.name || s.domain || s.id)}</span><span class="crm-muted">${escapeHtml(s.domain || '')} ${s.url ? `· <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">open</a>` : ''}</span></div>`).join('') : '<div class="crm-muted">No linked sites.</div>'}
    ${crmState.unassigned.length ? `<div class="ws-row" style="gap:8px;margin-top:8px;">
      <select class="settings-input" id="cfLinkSite" style="flex:1;"><option value="">Link an unassigned site…</option>${linkOpts}</select>
      <button class="btn" onclick="crmLinkSite('${c.id}')">Link</button>
    </div>` : ''}

    <h3 class="panel-title" style="margin-top:14px;">Activity (${data.activities.length})</h3>
    <div class="ws-row" style="gap:8px;margin-bottom:8px;">
      <input class="settings-input" id="cfNote" placeholder="Add a note…" style="flex:1;" onkeydown="if(event.key==='Enter')crmAddNote('${c.id}')" />
      <button class="btn" onclick="crmAddNote('${c.id}')">Add note</button>
    </div>
    ${data.activities.length ? data.activities.map((a) => `<div class="crm-act"><strong>${escapeHtml(a.type)}</strong> · <span class="crm-muted">${timeAgo(a.created_at)}</span>${a.author ? ' · ' + escapeHtml(a.author) : ''}${a.body ? '<br>' + escapeHtml(a.body) : ''}</div>`).join('') : '<div class="crm-muted">No activity yet.</div>'}
  `;
  document.querySelectorAll('#crmList .crm-row').forEach((r) => r.classList.remove('active'));
  const row = document.querySelector(`#crmList .crm-row[onclick*="${id}"]`);
  if (row) row.classList.add('active');
}

async function crmSaveContact(id) {
  const body = {
    name: crmVal('cfName'), company: crmVal('cfCompany'), stage: crmVal('cfStage'), owner: crmVal('cfOwner'),
    tags: crmVal('cfTags').split(',').map((t) => t.trim()).filter(Boolean),
  };
  const r = await fetchJSON(`/api/crm/contacts/${id}`, { method: 'PATCH', body });
  if (r && r.error) return;
  crmOpenContact(id); crmLoadList(); crmLoadStats();
}

async function crmAddNote(id) {
  const text = crmVal('cfNote').trim();
  if (!text) return;
  const r = await fetchJSON(`/api/crm/contacts/${id}/notes`, { method: 'POST', body: { body: text } });
  if (r && r.error) return;
  crmOpenContact(id);
}

async function crmLinkSite(id) {
  const siteId = crmVal('cfLinkSite');
  if (!siteId) return;
  const r = await fetchJSON(`/api/crm/contacts/${id}/link-site`, { method: 'POST', body: { siteId } });
  if (r && r.error) return;
  await crmLoadUnassigned();
  crmOpenContact(id);
  crmLoadList(); crmLoadStats();
}

async function crmAddContact() {
  const email = window.prompt('New contact email:');
  if (!email) return;
  const name = window.prompt('Name (optional):') || '';
  const r = await fetchJSON('/api/crm/contacts', { method: 'POST', body: { email, name } });
  if (r && r.error) { window.alert('Could not add: ' + r.error); return; }
  crmFetchAndRender();
  if (r.contact) crmOpenContact(r.contact.id);
}

async function crmLoadUnassigned() {
  const data = await fetchJSON('/api/crm/unassigned-sites');
  const sites = (data && data.sites) || [];
  crmState.unassigned = sites;
  const el = document.getElementById('crmUnassigned');
  const cnt = document.getElementById('crmUnassignedCount');
  if (cnt) cnt.textContent = `(${sites.length})`;
  if (!el) return;
  if (!sites.length) { el.innerHTML = '<span class="crm-muted">All hosted sites are linked to a contact.</span>'; return; }
  el.innerHTML = sites.map((s) => `<div class="crm-detail-row"><span>${escapeHtml(s.name || s.id)}</span><span class="crm-muted">${escapeHtml(s.domain || 'no domain')} · ${escapeHtml(s.status || '')}</span></div>`).join('')
    + '<div class="crm-muted" style="margin-top:6px;">Open a contact to link a site to it.</div>';
}

function onCrmEvent(msg) {
  const view = document.getElementById('view-crm');
  if (!view || !view.classList.contains('active')) return;
  crmLoadStats();
  crmLoadList();
  if (crmState.selectedId) crmOpenContact(crmState.selectedId);
}
