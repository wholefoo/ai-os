// dashboard/js/crm.js
// ============================================================
//  CRM dashboard view — Phase 1 (read-only). Globals from app.js: fetchJSON, escapeHtml,
//  timeAgo. Exposes loadCrm() + onCrmEvent(msg). Inline onclick handler crmOpenContact
//  is a global function declaration.
// ============================================================

const crmState = { wired: false, q: '', flag: '', stage: '', selectedId: null, _searchTimer: null };

function loadCrm() {
  if (!crmState.wired) {
    crmState.wired = true;
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('crmRefresh', 'click', crmFetchAndRender);
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
    ['Total', s.total, ''],
    ['Leads', s.leads, 'color:#eab308'],
    ['Clients', s.clients, 'color:#22c55e'],
    ['License holders', s.licenses, 'color:#a855f7'],
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
        ${c.is_lead ? '<span class="crm-tag lead">Lead</span> ' : ''}${c.is_client ? '<span class="crm-tag client">Client</span> ' : ''}${c.is_license ? '<span class="crm-tag license">License</span>' : ''}
        <div class="crm-muted">${escapeHtml(c.stage)}${c.audit_score != null ? ' · ' + c.audit_score : ''}</div>
      </div>
    </div>`).join('') + (data.total > rows.length ? `<div class="crm-muted" style="padding:8px;">Showing ${rows.length} of ${data.total}.</div>` : '');
}

async function crmOpenContact(id) {
  crmState.selectedId = id;
  const data = await fetchJSON(`/api/crm/contacts/${id}`);
  const el = document.getElementById('crmDetail');
  if (!el) return;
  if (!data || data.error || !data.contact) { el.innerHTML = '<div class="empty-state">Could not load contact.</div>'; return; }
  const c = data.contact;
  const field = (k, v) => (v || v === 0) ? `<div class="crm-detail-row"><span class="crm-muted">${k}</span><span>${escapeHtml(String(v))}</span></div>` : '';
  const date = (v) => { try { return v ? new Date(v).toLocaleDateString() : ''; } catch { return v || ''; } };
  el.innerHTML = `
    <h3 class="panel-title">${escapeHtml(c.name || c.email)}</h3>
    <div style="margin-bottom:10px;">
      ${c.is_lead ? '<span class="crm-tag lead">Lead</span> ' : ''}${c.is_client ? '<span class="crm-tag client">Client</span> ' : ''}${c.is_license ? '<span class="crm-tag license">License</span> ' : ''}
      <span class="crm-tag">${escapeHtml(c.stage)}</span>
    </div>
    ${field('Email', c.email)}
    ${field('Company', c.company)}
    ${field('Plan', c.plan)}
    ${field('Audit score', c.audit_score)}
    ${field('Primary domain', c.primary_domain)}
    ${field('Purchased', date(c.purchased_at))}
    ${field('Support expires', date(c.support_expires_at))}
    ${field('Source', c.source)}
    ${field('Created', c.created_at ? timeAgo(c.created_at) : '')}
    <h3 class="panel-title" style="margin-top:14px;">Sites (${data.sites.length})</h3>
    ${data.sites.length ? data.sites.map((s) => `<div class="crm-detail-row"><span>${escapeHtml(s.name || s.domain || s.id)}</span><span class="crm-muted">${escapeHtml(s.domain || '')} ${s.url ? `· <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">open</a>` : ''}</span></div>`).join('') : '<div class="crm-muted">No linked sites.</div>'}
    <h3 class="panel-title" style="margin-top:14px;">Activity (${data.activities.length})</h3>
    ${data.activities.length ? data.activities.map((a) => `<div class="crm-act"><strong>${escapeHtml(a.type)}</strong> · <span class="crm-muted">${timeAgo(a.created_at)}</span>${a.body ? '<br>' + escapeHtml(a.body) : ''}</div>`).join('') : '<div class="crm-muted">No activity yet.</div>'}
  `;
  document.querySelectorAll('#crmList .crm-row').forEach((r) => r.classList.remove('active'));
  const row = document.querySelector(`#crmList .crm-row[onclick*="${id}"]`);
  if (row) row.classList.add('active');
}

async function crmLoadUnassigned() {
  const data = await fetchJSON('/api/crm/unassigned-sites');
  const el = document.getElementById('crmUnassigned');
  const cnt = document.getElementById('crmUnassignedCount');
  if (!el) return;
  const sites = (data && data.sites) || [];
  if (cnt) cnt.textContent = `(${sites.length})`;
  if (!sites.length) { el.innerHTML = '<span class="crm-muted">All hosted sites are linked to a contact.</span>'; return; }
  el.innerHTML = sites.map((s) => `<div class="crm-detail-row"><span>${escapeHtml(s.name || s.id)}</span><span class="crm-muted">${escapeHtml(s.domain || 'no domain')} · ${escapeHtml(s.status || '')}</span></div>`).join('')
    + '<div class="crm-muted" style="margin-top:6px;">Manual linking arrives in the next CRM update.</div>';
}

function onCrmEvent(msg) {
  const view = document.getElementById('view-crm');
  if (!view || !view.classList.contains('active')) return;
  crmLoadStats();
  crmLoadList();
}
