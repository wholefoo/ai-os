// dashboard/js/security.js
// ============================================================
//  Admin-only Security view — report-only mythos-defense self-scans of this AI OS instance.
//  Globals from app.js: fetchJSON, escapeHtml, timeAgo. Operator-only (not in CLIENT_VIEWS;
//  /api/security/* is 403'd for clients server-side).
// ============================================================

const secState = { wired: false, selectedId: null, poll: null };
const SEV_COLOR = { CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#eab308', LOW: '#3b82f6', INFO: '#6b7280' };

function loadSecurity() {
  if (!secState.wired) {
    secState.wired = true;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('secQuickBtn', () => securityRunScan('quick'));
    on('secDeepBtn', () => securityRunScan('deep'));
    on('secRefresh', securityLoadList);
  }
  securityLoadStatus();
  securityLoadList();
}

async function securityLoadStatus() {
  const el = document.getElementById('secStatus');
  if (!el) return;
  const s = await fetchJSON('/api/security/status');
  if (!s) { el.innerHTML = ''; return; }
  if (!s.enabled) {
    el.innerHTML = `<div class="crm-muted">🔒 Security scanner is <strong>off</strong>. ${escapeHtml(s.hint || 'Enable it in Settings → Security.')}</div>`;
  } else if (!s.available) {
    el.innerHTML = `<div style="color:#fca5a5;">⚠ mythos enabled but unavailable: ${escapeHtml(s.reason || '')}</div>`;
  } else {
    el.innerHTML = `<div class="crm-muted">✓ mythos ready · adapter <strong>${escapeHtml(s.adapter || '')}</strong> · semgrep ${s.semgrep ? '✓' : '✗'} · API key ${s.anthropicKey ? '✓' : '✗'}</div>`; // seclint-ok: ternaries yield static glyphs; adapter is escaped
  }
  const ok = !!(s.enabled && s.available);
  ['secQuickBtn', 'secDeepBtn'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = !ok; });
}

function securityToast(msg) { const el = document.getElementById('secMsg'); if (el) el.textContent = msg || ''; }

async function securityRunScan(mode) {
  const r = await fetchJSON('/api/security/scan', { method: 'POST', body: { mode } });
  if (!r || r.error) { securityToast((r && r.error) || 'Could not start scan'); return; }
  securityToast(`${mode === 'deep' ? 'Deep' : 'Quick'} scan started — this can take a few minutes…`);
  securityLoadList();
  securityStartPolling();
}

function securityStartPolling() {
  if (secState.poll) return;
  secState.poll = setInterval(async () => {
    const list = await fetchJSON('/api/security/scans');
    securityRenderList(list);
    if (!(list || []).some((s) => s.status === 'running')) {
      clearInterval(secState.poll); secState.poll = null; securityToast('');
      if (secState.selectedId) securityOpenScan(secState.selectedId);
    }
  }, 4000);
}

async function securityLoadList() {
  const list = await fetchJSON('/api/security/scans');
  securityRenderList(list);
  if ((list || []).some((s) => s.status === 'running')) securityStartPolling();
}

function securityRenderList(list) {
  const el = document.getElementById('securityList');
  if (!el) return;
  list = list || [];
  if (!list.length) { el.innerHTML = '<div class="empty-state">No scans yet. Run a Quick or Deep scan above.</div>'; return; }
  el.innerHTML = list.map((s) => {
    const c = s.counts || {};
    const badge = s.status === 'running' ? '<span class="crm-tag">running…</span>'
      : s.status === 'error' ? '<span class="crm-tag" style="background:#7f1d1d;color:#fff;">error</span>'
        : `<span class="crm-tag">${escapeHtml(s.mode)}</span>`;
    const sev = (c.critical || c.high)
      ? ` · <span style="color:${c.critical ? SEV_COLOR.CRITICAL : SEV_COLOR.HIGH};">${c.critical || 0} crit / ${c.high || 0} high</span>`
      : (s.status === 'complete' ? ' · clean' : '');
    return `<div class="crm-row ${s.id === secState.selectedId ? 'active' : ''}" onclick="securityOpenScan('${s.id}')">
      <div style="min-width:0;">
        <div><strong>${escapeHtml(s.mode)} scan</strong> ${badge}</div>
        <div class="crm-muted">${timeAgo(s.startedAt)} · ${escapeHtml(s.actor || '')}${sev}</div>
      </div>
    </div>`;
  }).join('');
}

async function securityOpenScan(id) {
  secState.selectedId = id;
  const s = await fetchJSON(`/api/security/scan/${id}`);
  const el = document.getElementById('securityDetail');
  if (!el) return;
  if (!s || s.error) { el.innerHTML = '<div class="empty-state">Could not load scan.</div>'; return; }
  if (s.status === 'running') { el.innerHTML = '<div class="empty-state">Scan running… findings appear when it completes.</div>'; return; }
  if (s.status === 'error') { el.innerHTML = `<div style="color:#fca5a5;">Scan failed: ${escapeHtml(s.error || '')}</div>`; return; }
  const c = s.counts || {};
  const findings = (s.findings || []).map((f) => `<div class="seo-finding" style="display:flex;gap:8px;align-items:start;margin:6px 0;">
    <span class="seo-finding-severity" style="background:${SEV_COLOR[f.severity] || '#6b7280'};color:#fff;padding:1px 7px;border-radius:6px;font-size:11px;font-weight:600;">${escapeHtml(f.severity || '')}</span>
    <div><strong>${escapeHtml(f.title || '')}</strong><br><span class="crm-muted">${escapeHtml(f.vulnClass || '')}${f.file ? ' · ' + escapeHtml(f.file) : ''}${(f.cwe && f.cwe.length) ? ' · ' + escapeHtml(f.cwe.join(', ')) : ''}</span></div>
  </div>`).join('');
  const tm = s.threatModel ? `<details style="margin-top:10px;"><summary class="crm-muted">Threat model (STRIDE)</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;">${escapeHtml(JSON.stringify(s.threatModel, null, 2).slice(0, 4000))}</pre></details>` : '';
  const audit = s.audit ? `<details style="margin-top:10px;"><summary class="crm-muted">Dependency audit</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;">${escapeHtml((s.audit.out || s.audit.error || '').slice(0, 4000))}</pre></details>` : '';
  el.innerHTML = `
    <div class="ws-row" style="justify-content:space-between;align-items:start;">
      <h3 class="panel-title" style="margin:0;">${escapeHtml(s.mode)} scan — ${escapeHtml(s.status)}</h3>
      <span class="crm-muted">${s.durationSeconds ? Math.round(s.durationSeconds) + 's' : ''}</span>
    </div>
    <div class="crm-muted" style="margin:6px 0 12px;">${timeAgo(s.startedAt)} · ${escapeHtml(s.actor || '')}${s.patchRecommendations ? ' · ' + s.patchRecommendations + ' patch recommendation(s) (on a copy — not applied)' : ''}</div>
    ${c.total != null ? `<div style="margin-bottom:10px;">Findings: <strong>${c.total || 0}</strong> — <span class="sev-critical">${c.critical || 0} critical</span>, <span class="sev-high">${c.high || 0} high</span>, ${c.medium || 0} medium, ${c.low || 0} low · unresolved ${c.unresolved || 0}</div>` : ''}
    ${findings || (s.mode === 'deep' ? '<div class="crm-muted">No code findings.</div>' : '')}
    ${tm}${audit}
  `;
  document.querySelectorAll('#securityList .crm-row').forEach((r) => r.classList.remove('active'));
  const row = document.querySelector(`#securityList .crm-row[onclick*="${id}"]`);
  if (row) row.classList.add('active');
}

// Live push updates (wired into app.js WS handler if desired).
function onSecurityEvent(/* msg */) {
  const view = document.getElementById('view-security');
  if (!view || !view.classList.contains('active')) return;
  securityLoadList();
  if (secState.selectedId) securityOpenScan(secState.selectedId);
}
