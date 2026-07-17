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
  loadPipelinePanel();
  loadSequencesPanel();
  loadBookingsPanel();
  loadProspectingPanel();
}

// ---------- Local Prospecting panel (Google Maps / Business Profile) ----------

let prospectLastRun = null;

async function loadProspectingPanel() {
  const note = document.getElementById('prospectStatusNote');
  if (!note) return;
  let data;
  try { data = await fetchJSON('/api/prospects/runs'); } catch { return; }
  if (!data || data.error) { note.innerHTML = `<span style="color:#f59e0b;">&#9679; ${escapeHtml((data && data.error) || 'Prospecting requires a Business or Enterprise license.')}</span>`; return; }
  note.innerHTML = data.configured
    ? `<span style="color:#22c55e;">&#9679; Provider: ${escapeHtml(data.provider)}</span>${data.runs.length ? ` <span style="color:#888;">&middot; last: &ldquo;${escapeHtml(data.runs[0].keyword)}&rdquo; in ${escapeHtml(data.runs[0].location)} (${data.runs[0].count} found)</span> <a href="#" onclick="showProspectRun('${data.runs[0].id}');return false;" style="font-size:12px;">show</a>` : ''}`
    : '<span style="color:#f59e0b;">&#9679; No provider configured — add DataForSEO credentials or a Google Places API key in Settings &rarr; SEO Agency.</span>';
}

async function runProspectSearch() {
  const btn = document.getElementById('prospectSearchBtn');
  const keyword = crmVal('prospectKeyword').trim();
  const location = crmVal('prospectLocation').trim();
  if (!keyword || !location) { alert('Enter a niche keyword and a location.'); return; }
  btn.disabled = true; btn.textContent = 'Searching…';
  document.getElementById('prospectResults').innerHTML = '<div class="empty-state">Searching Google Business listings' + (document.getElementById('prospectEnrich').checked ? ' and checking websites for emails (can take ~30s)' : '') + '…</div>';
  try {
    const r = await fetchJSON('/api/prospects/search', {
      method: 'POST',
      body: { keyword, location, limit: Number(crmVal('prospectLimit')) || 20, enrich: document.getElementById('prospectEnrich').checked },
    });
    if (!r.ok) throw new Error(r.error || 'search failed');
    prospectLastRun = r.run;
    renderProspects(r.run);
    loadProspectingPanel();
  } catch (e) {
    document.getElementById('prospectResults').innerHTML = `<div class="empty-state" style="color:#ef4444;">Search failed: ${escapeHtml(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = '🔍 Search'; }
}

async function showProspectRun(id) {
  try {
    const r = await fetchJSON(`/api/prospects/runs/${id}`);
    if (r.ok) { prospectLastRun = r.run; renderProspects(r.run); }
  } catch {}
}

function renderProspects(run) {
  const box = document.getElementById('prospectResults');
  if (!box) return;
  if (!run.prospects.length) { box.innerHTML = '<div class="empty-state">No businesses found — try a broader keyword or area.</div>'; return; }
  const rows = run.prospects.map((p) => {
    const siteCell = !p.website
      ? '<span style="color:#22c55e;font-weight:700;">NO WEBSITE</span>'
      : (/facebook|instagram|linktr/i.test(p.website)
        ? `<span style="color:#f59e0b;font-weight:600;">social only</span>`
        : `<a href="${escapeHtml(p.website)}" target="_blank" rel="noopener" style="color:#3b82f6;">${escapeHtml(p.website.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30))}</a>`);
    return `
    <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
      <td style="padding:6px;"><input type="checkbox" class="prospect-pick" value="${escapeHtml(p.placeId)}" ${p.email ? 'checked' : ''} ${p.ingested ? 'disabled' : ''}></td>
      <td style="padding:6px;font-weight:600;">${p.mapsUrl ? `<a href="${escapeHtml(p.mapsUrl)}" target="_blank" rel="noopener" style="color:inherit;">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}${p.ingested ? ' <span style="color:#22c55e;font-size:11px;">✓ in CRM</span>' : ''}<div style="font-size:11px;color:#888;font-weight:400;">${escapeHtml(p.category || '')}</div></td>
      <td style="padding:6px;font-size:12px;">${p.rating != null ? `${p.rating}★ <span style="color:#888;">(${p.reviews})</span>` : '<span style="color:#666;">—</span>'}</td>
      <td style="padding:6px;font-size:12px;">${siteCell}</td>
      <td style="padding:6px;font-size:12px;">${escapeHtml(p.phone || '—')}</td>
      <td style="padding:6px;font-size:12px;">${p.email ? escapeHtml(p.email) : '<span style="color:#666;">call-first</span>'}</td>
      <td style="padding:6px;"><span title="${escapeHtml((p.reasons || []).join(' · '))}" style="font-weight:700;color:${p.score >= 70 ? '#22c55e' : p.score >= 45 ? '#f59e0b' : '#888'};">${p.score}</span></td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div style="font-size:12px;color:#888;margin-bottom:8px;">${run.count} found &middot; <b style="color:#22c55e;">${run.noWebsite} without websites</b> &middot; ${run.withEmail} with emails &middot; via ${escapeHtml(run.provider)}. Score = managed-website fit (hover for reasons).</div>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;"><th style="padding:6px;"></th><th style="padding:6px;">Business</th><th style="padding:6px;">Rating</th><th style="padding:6px;">Website</th><th style="padding:6px;">Phone</th><th style="padding:6px;">Email</th><th style="padding:6px;">Fit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
      <button class="btn btn-sm btn-primary" onclick="ingestProspects()">Add selected to CRM</button>
      <span style="font-size:11px;color:#888;">Only prospects with an email become contacts; the rest stay here as call-first leads. Nothing is auto-emailed.</span>
    </div>`;
}

async function ingestProspects() {
  if (!prospectLastRun) return;
  const picked = Array.from(document.querySelectorAll('.prospect-pick:checked:not(:disabled)')).map((c) => c.value);
  if (!picked.length) { alert('Select at least one prospect.'); return; }
  const r = await fetchJSON('/api/prospects/ingest', { method: 'POST', body: { runId: prospectLastRun.id, placeIds: picked } });
  if (r && r.error) { alert(r.error); return; }
  alert(`${r.added} added to CRM${r.skippedNoEmail ? ` — ${r.skippedNoEmail} had no public email and stay here as call-first leads` : ''}.`);
  showProspectRun(prospectLastRun.id);
  crmLoadStats(); crmLoadList(); loadPipelinePanel();
}

// ---------- Pipeline (kanban) panel ----------

const STAGE_LABELS = { lead: 'Lead', audited: 'Audited', onboarding: 'Onboarding', customer: 'Customer', churned: 'Churned' };
const STAGE_COLORS = { lead: '#3b82f6', audited: '#8b5cf6', onboarding: '#f59e0b', customer: '#22c55e', churned: '#6b7280' };

function togglePipeline() {
  const board = document.getElementById('crmPipeline');
  const btn = document.getElementById('crmPipelineToggle');
  const hidden = board.style.display === 'none';
  board.style.display = hidden ? 'grid' : 'none';
  btn.textContent = hidden ? 'Hide' : 'Show';
  try { localStorage.setItem('crm-pipeline-hidden', hidden ? '' : '1'); } catch {}
}

async function loadPipelinePanel() {
  const board = document.getElementById('crmPipeline');
  if (!board) return;
  try { if (localStorage.getItem('crm-pipeline-hidden')) { board.style.display = 'none'; const b = document.getElementById('crmPipelineToggle'); if (b) b.textContent = 'Show'; } } catch {}
  let data;
  try { data = await fetchJSON('/api/crm/pipeline'); } catch { return; }
  if (!data || !data.stages) return;

  board.innerHTML = data.stages.map((stage) => {
    const rows = data.columns[stage] || [];
    const total = (data.byStage && data.byStage[stage]) || 0;
    const cards = rows.map((c) => `
      <div class="crm-kanban-card" draggable="true" data-contact="${c.id}" data-stage="${stage}"
           onclick="crmOpenContact('${c.id}')"
           style="border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:8px 10px;margin-bottom:6px;cursor:grab;background:rgba(255,255,255,.02);">
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.name || c.email)}</div>
        <div style="font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.company || c.primary_domain || c.email)}</div>
      </div>`).join('');
    return `
      <div class="crm-kanban-col" data-stage="${stage}" style="min-width:160px;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px;min-height:120px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${STAGE_COLORS[stage] || '#888'};"></span>
          <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${STAGE_LABELS[stage] || stage}</span>
          <span style="font-size:11px;color:#888;margin-left:auto;">${total}</span>
        </div>
        ${cards || '<div style="font-size:11px;color:#666;text-align:center;padding:12px 0;">—</div>'}
        ${total > rows.length ? `<div style="font-size:11px;color:#666;text-align:center;">+${total - rows.length} more (use the stage filter)</div>` : ''}
      </div>`;
  }).join('');

  // HTML5 drag & drop: cards are sources, columns are targets. A drop PATCHes the stage —
  // the server validates against the canonical set and logs a stage_change activity.
  board.querySelectorAll('.crm-kanban-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: card.dataset.contact, from: card.dataset.stage }));
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  board.querySelectorAll('.crm-kanban-col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.style.borderColor = 'rgba(79,70,229,.6)'; });
    col.addEventListener('dragleave', () => { col.style.borderColor = 'rgba(255,255,255,.06)'; });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.style.borderColor = 'rgba(255,255,255,.06)';
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const to = col.dataset.stage;
      if (!payload || !payload.id || payload.from === to) return;
      const r = await fetchJSON(`/api/crm/contacts/${payload.id}`, { method: 'PATCH', body: { stage: to } });
      if (r && r.error) alert(r.error);
      loadPipelinePanel();
      crmLoadStats();
      crmLoadList();
    });
  });
}

// ---------- Appointments panel ----------

async function loadBookingsPanel() {
  const list = document.getElementById('bookingList');
  if (!list) return;
  let data;
  try { data = await fetchJSON('/api/bookings'); } catch { return; }
  const ups = (data && data.upcoming) || [];
  if (!ups.length) {
    list.innerHTML = '<div class="empty-state">No upcoming appointments. Add a booking section to a site (rebuild it) and bookings appear here.</div>';
    return;
  }
  list.innerHTML = ups.slice(0, 30).map((b) => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:8px;">
      <span style="font-size:20px;">📅</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">${escapeHtml(b.date)} at ${escapeHtml(b.time)} — ${escapeHtml(b.name || b.email)}</div>
        <div style="font-size:12px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(b.email)}${b.note ? ' · ' + escapeHtml(b.note) : ''}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="cancelBooking('${b.id}')" title="Cancel (emails the visitor)">Cancel</button>
    </div>`).join('');
}

async function cancelBooking(id) {
  if (!confirm('Cancel this appointment? The visitor will be notified by email.')) return;
  const r = await fetchJSON(`/api/bookings/${id}/cancel`, { method: 'PUT' });
  if (r && r.error) alert(r.error);
  loadBookingsPanel();
}

// ---------- Email Sequences panel ----------

async function loadSequencesPanel() {
  const list = document.getElementById('seqList');
  if (!list) return;
  if (!document.querySelector('#seqSteps .seq-step-row')) addSeqStepRow(); // always at least one editable step
  let data;
  try { data = await fetchJSON('/api/email/sequences'); } catch { return; }
  const note = document.getElementById('seqStatusNote');
  if (note) {
    note.innerHTML = data.configured
      ? `<span style="color:#22c55e;">&#9679; Sender configured</span>${data.suppressed ? ` <span style="color:#888;">&middot; ${data.suppressed} unsubscribed</span>` : ''}`
      : '<span style="color:#f59e0b;">&#9679; No sender configured — sequences can be drafted but not enabled. Set it up in Settings &rarr; Email Sending.</span>';
  }
  const seqs = data.sequences || [];
  if (!seqs.length) { list.innerHTML = '<div class="empty-state">No sequences yet — draft one below (or let the marketing agent write it).</div>'; return; }
  list.innerHTML = seqs.map((s) => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:8px;">
      <div class="schedule-toggle ${s.enabled ? 'active' : ''}" onclick="toggleSequence('${s.id}', ${s.enabled ? 'false' : 'true'})" title="${s.enabled ? 'Click to pause' : 'Click to enable'}"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;">${escapeHtml(s.name)} <span style="font-weight:400;color:#888;">(${s.steps} step${s.steps === 1 ? '' : 's'} &middot; ${escapeHtml(s.trigger)})</span></div>
        <div style="font-size:12px;color:#999;">${s.enrolled} enrolled &middot; ${s.active} active &middot; ${s.completed} completed &middot; ${s.sent} emails sent</div>
      </div>
      <button class="btn btn-sm" onclick="testSequence('${s.id}')" title="Send step 1 to your own email">Test</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSequence('${s.id}')" title="Delete (stops active enrollments)">&#128465;</button>
    </div>`).join('');
}

function addSeqStepRow(step = {}) {
  const wrap = document.getElementById('seqSteps');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'seq-step-row';
  row.style.cssText = 'border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px;margin-bottom:6px;';
  row.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
      <input type="number" min="0" max="2160" class="settings-input seq-delay" value="${Number(step.delayHours) || 0}" title="Delay (hours) after the previous step" style="width:90px;">
      <span style="font-size:11px;color:#888;align-self:center;">hours delay</span>
      <input type="text" class="settings-input seq-subject" placeholder="Subject — {{first_name}} and {{site}} work" value="${(step.subject || '').replace(/"/g, '&quot;')}" style="flex:1;min-width:200px;">
      <button class="btn btn-sm" onclick="this.closest('.seq-step-row').remove()" title="Remove step">&times;</button>
    </div>
    <textarea class="settings-input seq-body" rows="4" placeholder="Plain-text email body. An unsubscribe footer is added automatically.">${escapeHtml(step.body || '')}</textarea>`;
  wrap.appendChild(row);
}

function readSeqSteps() {
  return Array.from(document.querySelectorAll('#seqSteps .seq-step-row')).map((row) => ({
    delayHours: Number(row.querySelector('.seq-delay')?.value) || 0,
    subject: row.querySelector('.seq-subject')?.value || '',
    body: row.querySelector('.seq-body')?.value || '',
  })).filter((s) => s.subject.trim() || s.body.trim());
}

async function draftSequenceAI() {
  const goal = crmVal('seqGoal').trim();
  if (!goal) { alert('Describe the goal first — e.g. "convert dental-site leads into consult bookings".'); return; }
  const btn = document.getElementById('seqDraftBtn');
  btn.disabled = true; btn.textContent = 'Drafting…';
  try {
    const r = await fetchJSON('/api/email/sequences/draft', { method: 'POST', body: { goal } });
    if (!r.ok) { alert(r.error || 'Draft failed'); return; }
    document.getElementById('seqName').value = r.draft.name || goal;
    document.getElementById('seqSteps').innerHTML = '';
    (r.draft.steps || []).forEach((s) => addSeqStepRow(s));
  } catch (e) { alert(`Draft failed: ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = '✨ AI Draft'; }
}

async function createSequence() {
  const steps = readSeqSteps();
  const name = crmVal('seqName').trim();
  if (!name || !steps.length) { alert('A name and at least one step (subject + body) are required.'); return; }
  const r = await fetchJSON('/api/email/sequences', { method: 'POST', body: { name, trigger: crmVal('seqTrigger') || 'all-leads', steps } });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('seqName').value = '';
  document.getElementById('seqGoal').value = '';
  document.getElementById('seqSteps').innerHTML = '';
  addSeqStepRow();
  loadSequencesPanel();
}

async function toggleSequence(id, enable) {
  const r = await fetchJSON(`/api/email/sequences/${id}`, { method: 'PUT', body: { enabled: enable === true || enable === 'true' } });
  if (r && r.error) alert(r.error);
  loadSequencesPanel();
}

async function deleteSequence(id) {
  if (!confirm('Delete this sequence? Active enrollments will be stopped.')) return;
  const r = await fetchJSON(`/api/email/sequences/${id}`, { method: 'DELETE' });
  if (r && r.error) alert(r.error);
  loadSequencesPanel();
}

async function testSequence(id) {
  const to = prompt('Send a test of step 1 to which email address?');
  if (!to) return;
  const r = await fetchJSON(`/api/email/sequences/${id}/test`, { method: 'POST', body: { to } });
  alert(r.ok ? `Test sent via ${r.provider}. Check the inbox (and spam folder).` : `Test failed: ${r.error}`);
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

    ${crmManagedActions(c, data)}

    <h3 class="panel-title" style="margin-top:14px;">Sites (${data.sites.length})</h3>
    ${data.sites.length ? data.sites.map((s) => `<div class="crm-detail-row"><span>${escapeHtml(s.name || s.domain || s.id)}</span><span class="crm-muted">${escapeHtml(s.domain || '')} ${s.url ? `· <a href="${escapeHtml(crmSafeUrl(s.url))}" target="_blank" rel="noopener">open</a>` : ''}</span></div>`).join('') : '<div class="crm-muted">No linked sites.</div>'}
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

// ---------- Phase 4: managed-client operator actions ----------
// Rendered into the detail panel only for a real managed client (data.managed, derived
// server-side from the user's role/managedPurchases). Same wiring pattern as the rest of CRM.
function crmManagedActions(c, data) {
  const m = data.managed;
  if (!m || !m.isClient) return '';
  const planOpts = ['business', 'enterprise'].map((p) => `<option value="${p}" ${c.plan === p ? 'selected' : ''}>${p}</option>`).join('');
  const onboard = m.hasPassword
    ? '<span class="crm-muted">Account active (password set)</span>'
    : `<button class="btn" onclick="crmResendInvite('${c.id}')">${m.pendingInvite ? 'Resend' : 'Send'} set-password invite</button> <span class="crm-muted">${m.pendingInvite ? 'invite pending' : 'not invited yet'}</span>`;
  return `
    <h3 class="panel-title" style="margin-top:14px;">Managed client <span class="crm-muted" style="font-weight:400;">· ${m.purchases} purchase${m.purchases === 1 ? '' : 's'}</span></h3>
    <div style="display:grid;gap:8px;">
      <div class="ws-row" style="gap:8px;align-items:center;"><span class="crm-muted" style="min-width:74px;">Onboarding</span>${onboard}</div>
      <div class="ws-row" style="gap:8px;align-items:center;"><span class="crm-muted" style="min-width:74px;">Plan</span>
        <select class="settings-input" id="cmPlan" style="max-width:150px;">${planOpts}</select>
        <button class="btn" onclick="crmChangePlan('${c.id}')">Change</button></div>
      <div class="ws-row" style="gap:8px;align-items:center;"><span class="crm-muted" style="min-width:74px;">Billing</span>
        <button class="btn" onclick="crmBillingLink('${c.id}')">Generate billing / renewal link</button></div>
      <div class="ws-row" style="gap:8px;align-items:center;"><span class="crm-muted" style="min-width:74px;">Security</span>
        <button class="btn" onclick="crmSecurityAssessment('${c.id}')">Run security assessment</button></div>
      <div id="cmResult" style="word-break:break-all;font-size:13px;margin-top:2px;"></div>
    </div>`;
}

// Only allow http(s) links to be clickable — never javascript:/data: schemes from stored contact data.
function crmSafeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : '#'; }
function crmShowResult(html) { const el = document.getElementById('cmResult'); if (el) el.innerHTML = html; }
function crmResultErr(msg) { crmShowResult(`<span style="color:#fca5a5;">${escapeHtml(msg)}</span>`); }
function crmResultLink(label, url) {
  return `<div class="crm-muted" style="margin-bottom:4px;">${escapeHtml(label)}</div><input class="settings-input" style="width:100%;" readonly value="${escapeHtml(url)}" onclick="this.select()" />`;
}

async function crmResendInvite(id) {
  const r = await fetchJSON(`/api/crm/contacts/${id}/resend-invite`, { method: 'POST', body: {} });
  if (!r || r.error) return crmResultErr((r && r.error) || 'Failed to issue invite');
  let exp = ''; try { exp = ' (expires ' + new Date(r.expiresAt).toLocaleDateString() + ')'; } catch {}
  crmShowResult(crmResultLink('Set-password link' + exp + ' — send to the client:', r.link));
}

async function crmChangePlan(id) {
  const plan = crmVal('cmPlan');
  const r = await fetchJSON(`/api/crm/contacts/${id}/change-plan`, { method: 'POST', body: { plan } });
  if (!r || r.error) return crmResultErr((r && r.error) || 'Failed to change plan');
  crmOpenContact(id); crmLoadList();
}

async function crmBillingLink(id) {
  const r = await fetchJSON(`/api/crm/contacts/${id}/billing-link`, { method: 'POST', body: {} });
  if (!r || r.error) return crmResultErr((r && r.error) || 'Failed to generate link');
  const label = (r.kind === 'portal' ? 'Stripe billing portal link:' : 'Renewal link:') + (r.note ? ' (' + r.note + ')' : '');
  crmShowResult(crmResultLink(label, r.url));
}

async function crmSecurityAssessment(id) {
  crmShowResult('<span class="crm-muted">Scanning the client’s sites… this can take a moment.</span>');
  const r = await fetchJSON(`/api/crm/contacts/${id}/security-assessment`, { method: 'POST', body: {} });
  if (!r || r.error) return crmResultErr((r && r.error) || 'Assessment failed');
  const a = r.assessment || {}; const t = a.totals || {};
  const verdict = a.siteCount ? (a.ok ? '<span style="color:#22c55e;">PASS</span>' : '<span style="color:#ef4444;">ACTION NEEDED</span>') : '—';
  const rows = (a.sites || []).map((s) => `<div class="crm-muted" style="margin:2px 0;">${escapeHtml(s.name || s.id)}${s.domain ? ' · ' + escapeHtml(s.domain) : ''} — ${s.available ? `${s.counts.error} error · ${s.counts.warning} warn` : 'unscanned'}</div>`).join('');
  crmShowResult(`<div>Security assessment ${verdict} — ${a.siteCount || 0} site(s): <strong>${t.error || 0}</strong> error · ${t.warning || 0} warn · ${t.info || 0} info. Logged to the timeline; the client sees it under Site Security.</div>${rows}`);
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
