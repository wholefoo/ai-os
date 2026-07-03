// dashboard/js/web-studio.js
// ============================================================
//  AI Web Studio dashboard view. Talks to /api/web-studio/* (wired into server.js).
//  Globals consumed from app.js: fetchJSON(url,opts), escapeHtml(s), timeAgo(ts).
//  Exposes globals used by app.js: loadWebStudio(), onWebStudioEvent(msg).
//  Inline onclick handlers (wsOpen/wsDelete) are global function declarations.
// ============================================================

const wsState = {
  sites: [], limit: 1, used: 0,
  currentId: null, currentSite: null, files: [], currentFile: null,
  plan: null, tab: 'content',
  editor: null, dirty: false, wired: false, aiEditing: false,
  _monacoConfigured: false, _monacoTries: 0,
};

const WS_PUBLISH_PHASES = {
  build: 'Building the site…',
  deploy: 'Deploying files…',
  vhost: 'Configuring the web server…',
  cert: 'Requesting the TLS certificate…',
  tls: 'Enabling HTTPS…',
};

const WS_MONACO_VS = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';

// ---------- entry / list mode ----------
function loadWebStudio() {
  if (!wsState.wired) {
    wsState.wired = true;
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('wsCreateBtn', 'click', wsCreate);
    on('wsClonePreviewBtn', 'click', wsClonePreview);
    on('wsTrendBtn', 'click', wsTrends);
    on('wsImportZipBtn', 'click', wsImportZip);
    on('wsImportGhBtn', 'click', wsImportGithub);
    on('wsBackBtn', 'click', wsBack);
    on('wsSaveBtn', 'click', wsSave);
    on('wsBuildBtn', 'click', wsBuild);
    on('wsAiEditBtn', 'click', wsAiEdit);
    on('wsRefreshPreview', 'click', wsRefreshPreview);
    on('wsFileList', 'change', (e) => wsLoadFile(e.target.value));
    on('wsTabContent', 'click', () => wsSwitchTab('content'));
    on('wsTabCode', 'click', () => wsSwitchTab('code'));
    on('wsSaveContentBtn', 'click', wsSaveContent);
    on('wsDnsCheckBtn', 'click', wsDnsCheck);
    on('wsSetupHostingBtn', 'click', wsSetupHosting);
    on('wsPublishBtn', 'click', wsPublish);
    on('wsUnpublishBtn', 'click', wsUnpublish);
    on('wsExportZipBtn', 'click', (e) => { e.preventDefault(); wsExportZip(); });
    on('wsExportGhBtn', 'click', wsExportGithub);
    on('wsExportMode', 'change', wsExportModeChange);
    on('wsOptimizeBtn', 'click', wsOptimize);
    on('wsVerifyProvBtn', 'click', wsVerifyProvenance);
    on('wsSecurityScanBtn', 'click', wsRunSecurityScan);
  }
  if (!wsState.currentId) {
    const em = document.getElementById('wsEditorMode'); if (em) em.style.display = 'none';
    const lm = document.getElementById('wsListMode'); if (lm) lm.style.display = 'block';
  }
  wsFetchAndRenderSites();
  wsPopulateBrandKits();
}

// Fill the "apply a saved brand kit" picker in the create form from /api/brand-kits.
async function wsPopulateBrandKits() {
  const sel = document.getElementById('wsBrandKit');
  if (!sel) return;
  const data = await fetchJSON('/api/brand-kits');
  const kits = (data && data.kits) || [];
  const cur = sel.value;
  sel.innerHTML = '<option value="">Brand kit: none (or clone a URL below)</option>'
    + kits.map((k) => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

async function wsFetchAndRenderSites() {
  const data = await fetchJSON('/api/web-studio/sites');
  wsRenderSites(data || {});
}

function wsRenderSites(data) {
  wsState.sites = (data && data.sites) || [];
  wsState.limit = data ? data.limit : 1;          // null over the wire == unlimited (Enterprise)
  wsState.used = (data && data.used != null) ? data.used : wsState.sites.length;

  const limitTxt = (wsState.limit == null) ? 'unlimited' : wsState.limit;
  const badge = document.getElementById('wsLimitBadge');
  if (badge) badge.textContent = `${wsState.used} / ${limitTxt} sites`;

  const atLimit = (typeof wsState.limit === 'number') && wsState.used >= wsState.limit;
  const btn = document.getElementById('wsCreateBtn');
  if (btn) btn.disabled = atLimit;
  const hint = document.getElementById('wsCreateHint');
  if (hint) hint.textContent = atLimit ? 'Site limit reached for your plan — upgrade for more sites.' : '';

  const wrap = document.getElementById('wsSites');
  if (!wrap) return;
  if (!wsState.sites.length) {
    wrap.innerHTML = '<div class="empty-state">No sites yet. Describe one above to generate it.</div>';
    return;
  }
  wrap.innerHTML = wsState.sites.map((s) => `
    <div class="ws-site-card">
      <div>
        <div><strong>${escapeHtml(s.name)}</strong> <span class="ws-badge ${s.status}">${escapeHtml(s.status)}</span></div>
        <div class="ws-site-meta">${s.domain ? escapeHtml(s.domain) + ' &middot; ' : ''}${s.redesignedFrom ? 'redesigned from ' + escapeHtml(s.redesignedFrom) + ' &middot; ' : ''}${s.chatEnabled ? '&#128172; chat &middot; ' : ''}${s.lastBuiltAt ? 'built ' + timeAgo(s.lastBuiltAt) : 'created ' + timeAgo(s.createdAt)}</div>
      </div>
      <div class="ws-row">
        <button class="btn" onclick="wsOpen('${s.id}')">Open</button>
        <button class="btn" onclick="wsDelete('${s.id}')">Delete</button>
      </div>
    </div>`).join('');
}

async function wsCreate() {
  const name = (document.getElementById('wsName').value || '').trim();
  const brief = (document.getElementById('wsBrief').value || '').trim();
  const siteType = (document.getElementById('wsType') || {}).value || '';
  const domain = ((document.getElementById('wsCreateDomain') || {}).value || '').trim();
  const cloneUrl = ((document.getElementById('wsCloneUrl') || {}).value || '').trim();
  const brandKitId = ((document.getElementById('wsBrandKit') || {}).value || '').trim();
  const redesignUrl = ((document.getElementById('wsRedesignUrl') || {}).value || '').trim();
  const maintainBranding = (document.getElementById('wsMaintainBranding') || {}).checked !== false;
  const features = {
    enableChat: !!(document.getElementById('wsFeatChat') || {}).checked,
    enableDarkMode: !!(document.getElementById('wsFeatDark') || {}).checked,
    theme: (document.getElementById('wsFeatDark') || {}).checked ? 'glass' : 'default',
    enableMotion: !!(document.getElementById('wsFeatMotion') || {}).checked,
  };
  const hint = document.getElementById('wsCreateHint');
  if (brief.length < 10) { if (hint) hint.textContent = 'Add a longer brief (at least 10 characters).'; return; }
  const btn = document.getElementById('wsCreateBtn');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = redesignUrl ? 'Reusing the existing site’s content + branding, then generating your redesign…' : (brandKitId || cloneUrl) ? 'Applying design + generating your site…' : 'Generating — the studio team is planning, writing and building your site…';
  const r = await fetchJSON('/api/web-studio/sites', { method: 'POST', body: { name, brief, siteType, domain, cloneUrl, brandKitId, redesignUrl, maintainBranding, features } });
  if (r && r.error) { if (hint) hint.textContent = `Could not create: ${r.error}`; if (btn) btn.disabled = false; return; }
  document.getElementById('wsName').value = '';
  document.getElementById('wsBrief').value = '';
  if (document.getElementById('wsCreateDomain')) document.getElementById('wsCreateDomain').value = '';
  if (document.getElementById('wsCloneUrl')) document.getElementById('wsCloneUrl').value = '';
  if (document.getElementById('wsRedesignUrl')) document.getElementById('wsRedesignUrl').value = '';
  ['wsFeatChat', 'wsFeatDark', 'wsFeatMotion'].forEach((id) => { const el = document.getElementById(id); if (el) el.checked = false; });
  const sw = document.getElementById('wsCloneSwatches'); if (sw) sw.innerHTML = '';
  await wsFetchAndRenderSites(); // shows the new "building" site; WS events flip its status
}

async function wsTrends() {
  const topic = ((document.getElementById('wsTrendTopic') || {}).value || '').trim();
  const hint = document.getElementById('wsTrendHint');
  const box = document.getElementById('wsTrendResults');
  if (hint) hint.textContent = 'Fetching trending topics…';
  const r = await fetchJSON(`/api/web-studio/trends${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`);
  if (!r || r.error) { if (hint) hint.textContent = 'Could not fetch trends: ' + ((r && r.error) || 'error'); return; }
  const data = r.data || {};
  const labels = { google_trends: 'Google Trends', reddit: 'Reddit', hacker_news: 'Hacker News', google_news: 'Google News', youtube: 'YouTube', social: 'X / Social' };
  let html = '', total = 0;
  for (const [src, v] of Object.entries(data)) {
    if (!v.items || !v.items.length) continue;
    html += `<div style="margin:6px 0;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary,#9aa);margin-bottom:4px;">${escapeHtml(labels[src] || src)}</div><div style="display:flex;flex-wrap:wrap;gap:6px;">`;
    html += v.items.map((it) => `<button type="button" class="btn ws-trend-item" data-t="${escapeHtml(it.title)}" style="font-size:12px;padding:4px 10px;text-align:left;max-width:100%;">${escapeHtml(it.title.slice(0, 80))}</button>`).join('');
    html += '</div></div>';
    total += v.items.length;
  }
  if (box) { box.innerHTML = html || '<span class="ws-hint">No trending items found.</span>'; box.style.display = 'block'; box.querySelectorAll('.ws-trend-item').forEach((b) => b.addEventListener('click', () => wsAddTrendToBrief(b.getAttribute('data-t')))); }
  if (hint) hint.textContent = total ? `${total} ideas — click any to add it to your brief.` : 'No trending items found.';
}

function wsAddTrendToBrief(text) {
  const ta = document.getElementById('wsBrief');
  if (!ta || !text) return;
  ta.value = (ta.value ? ta.value.trim() + '\n' : '') + `Cover this trending topic: ${text}`;
  ta.focus();
}

async function wsClonePreview() {
  const url = ((document.getElementById('wsCloneUrl') || {}).value || '').trim();
  const hint = document.getElementById('wsCloneHint');
  const sw = document.getElementById('wsCloneSwatches');
  if (!url) { if (hint) hint.textContent = 'Enter a URL to clone its design from.'; return; }
  if (hint) hint.textContent = 'Reading the site…';
  if (sw) sw.innerHTML = '';
  const r = await fetchJSON('/api/web-studio/design-extract', { method: 'POST', body: { url } });
  if (!r || r.error) { if (hint) hint.textContent = 'Could not read that site: ' + ((r && r.error) || 'unknown error'); return; }
  const p = r.profile || {};
  if (sw && Array.isArray(p.swatches)) {
    // Only render strict #rrggbb values — don't depend on the server's guarantee at this DOM sink.
    sw.innerHTML = p.swatches.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).map((c) =>
      `<span title="${escapeHtml(c)}" style="width:16px;height:16px;border-radius:3px;border:1px solid rgba(0,0,0,.2);display:inline-block;background:${escapeHtml(c)};"></span>`).join('');
  }
  const fonts = [p.fonts && p.fonts.display, p.fonts && p.fonts.body].filter(Boolean).join(' / ');
  const secs = (p.sections || []).join(' → ');
  if (hint) hint.textContent = `Captured ${(p.swatches || []).length} colors${fonts ? `, fonts: ${fonts}` : ''}${secs ? `, structure: ${secs}` : ''}. Click Generate to apply.`;
}

async function wsDelete(id) {
  if (!window.confirm('Delete this site? This removes its workspace and any hosting.')) return;
  const r = await fetchJSON(`/api/web-studio/sites/${id}`, { method: 'DELETE' });
  if (r && r.pending) { alert('Deletion queued for approval (Auto-Mode is on). Approve it in Settings → Automation → Pending Approvals.'); return; }
  if (r && r.error) { alert('Delete failed: ' + r.error); return; }
  if (wsState.currentId === id) wsBack();
  await wsFetchAndRenderSites();
}

// ---------- import (host a site as-is) ----------
async function wsImportZip() {
  const fileEl = document.getElementById('wsImportFile');
  const file = fileEl && fileEl.files && fileEl.files[0];
  const hint = document.getElementById('wsImportHint');
  if (!file) { if (hint) hint.textContent = 'Choose a .zip file first.'; return; }
  if (hint) hint.textContent = `Uploading ${file.name}…`;
  // Binary body — can't use fetchJSON (it JSON-stringifies). Raw POST with cookie + Bearer auth.
  const headers = { 'Content-Type': 'application/zip' };
  const token = localStorage.getItem('ai-os-token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let r;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/web-studio/import/archive?name=${encodeURIComponent(file.name.replace(/\.zip$/i, ''))}`,
      { method: 'POST', credentials: 'same-origin', headers, body: buf });
    r = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  } catch (e) { r = { error: e.message }; }
  if (r && r.error) { if (hint) hint.textContent = 'Import failed: ' + r.error; return; }
  if (hint) hint.textContent = 'Importing — the site will appear below and build automatically.';
  fileEl.value = '';
  await wsFetchAndRenderSites();
}

async function wsImportGithub() {
  const url = ((document.getElementById('wsImportRepo') || {}).value || '').trim();
  const token = ((document.getElementById('wsImportToken') || {}).value || '').trim();
  const hint = document.getElementById('wsImportHint');
  if (!url) { if (hint) hint.textContent = 'Enter a GitHub repo URL (https://github.com/owner/repo).'; return; }
  if (hint) hint.textContent = 'Cloning the repo…';
  const r = await fetchJSON('/api/web-studio/import/github', { method: 'POST', body: { url, token } });
  if (r && r.error) { if (hint) hint.textContent = 'Import failed: ' + r.error; return; }
  if (hint) hint.textContent = 'Importing — the site will appear below and build automatically.';
  document.getElementById('wsImportRepo').value = '';
  document.getElementById('wsImportToken').value = '';
  await wsFetchAndRenderSites();
}

// ---------- editor mode ----------
async function wsOpen(id) {
  const site = wsState.sites.find((s) => s.id === id);
  if (!site) return;
  wsState.currentId = id;
  wsState.currentSite = site;
  wsState.currentFile = null;
  document.getElementById('wsListMode').style.display = 'none';
  document.getElementById('wsEditorMode').style.display = 'block';
  document.getElementById('wsEditorTitle').textContent = site.name;
  wsSetEditorStatus(site.status);
  wsHint('');
  wsRenderPublishState(site);
  wsRenderProvenance(site);
  wsRenderSecurity(site);
  wsRefreshPreview();
  await wsReloadFiles(true);
  await wsLoadContent();
  wsSwitchTab('content');
}

// Content-provenance panel: the signed sidecar's summary + a verify action. Reads site.provenance
// (persisted on the site object). Honest framing — this is OUR Ed25519 credential, not C2PA.
function wsRenderProvenance(site) {
  const body = document.getElementById('wsProvenanceBody');
  const btn = document.getElementById('wsVerifyProvBtn');
  const vh = document.getElementById('wsProvVerifyHint');
  if (vh) vh.textContent = '';
  const p = site && site.provenance;
  if (!p) {
    if (body) body.textContent = 'No provenance record — imported sites, or sites built before provenance was enabled, carry none.';
    if (btn) btn.style.display = 'none';
    return;
  }
  const models = (p.models || []).filter((m) => m && m.model).map((m) => `${escapeHtml(m.agent)}: ${escapeHtml(m.model)}`).join(', ');
  const kid = (p.credential && p.credential.signature && p.credential.signature.public_key_id) || '—';
  if (body) body.innerHTML =
    `<div><span class="ws-badge ready">AI-generated &middot; signed</span></div>`
    + `<div style="margin-top:6px;font-size:13px;line-height:1.6;">`
    + `<div>Generator: ${escapeHtml(p.generator || 'AI OS Web Studio')}</div>`
    + `<div>Generated: ${escapeHtml(p.generatedAt || '—')}</div>`
    + (models ? `<div>Models: ${models}</div>` : '')
    + (p.designClonedFrom ? `<div>Design source: ${escapeHtml(p.designClonedFrom)}</div>` : '')
    + `<div>Key id: <code style="font-size:11px;">${escapeHtml(kid)}</code></div>`
    + `<div style="margin-top:4px;color:var(--text-secondary,#9aa);">Ed25519-signed sidecar at <code>/.well-known/aios-provenance.json</code> (C2PA-vocabulary-aligned; verifiable by AI OS via key-to-domain, not a C2PA Content Credentials check).</div>`
    + `</div>`;
  if (btn) btn.style.display = p.credential ? '' : 'none';
}

// Security panel: the report-only semgrep scan of the built output (reads site.security). The publish
// gate scans automatically; "Scan now" runs an on-demand re-scan. Findings only — nothing is patched.
function wsRenderSecurity(site) {
  const body = document.getElementById('wsSecurityBody');
  if (!body) return;
  const s = site && site.security;
  if (!s) { body.textContent = 'Not scanned yet — the publish gate scans the built output automatically, or scan now.'; return; }
  if (!s.available) { body.innerHTML = `<span style="color:var(--warning,#eab308);">Scanner unavailable${s.reason ? ' — ' + escapeHtml(s.reason) : ''}.</span> Publishing is not blocked.`; return; } // seclint-ok: s.reason is escaped inside the ternary
  const c = s.counts || {};
  const clean = !(c.error || c.warning || c.info);
  const head = clean
    ? '<span class="ws-badge ready">clean</span>'
    : `<span class="ws-badge ${c.error ? 'failed' : 'gated'}">${c.error || 0} error · ${c.warning || 0} warn · ${c.info || 0} info</span>`;
  const list = (s.findings || []).slice(0, 12).map((f) => {
    const col = f.severity === 'ERROR' ? '#ef4444' : (f.severity === 'WARNING' ? 'var(--warning,#eab308)' : '#6b7280');
    return `<div style="margin:4px 0;font-size:12px;"><span style="color:${col};font-weight:600;">${escapeHtml(f.severity || '')}</span> ${escapeHtml(f.title || '')}${f.file ? ` <code style="font-size:11px;">${escapeHtml(f.file)}${f.line ? ':' + f.line : ''}</code>` : ''}</div>`;
  }).join('');
  body.innerHTML = `<div>${head} <span class="ws-hint">scanned ${escapeHtml(s.scannedAt || '')}</span></div>` // seclint-ok: head is trusted server-derived markup (numeric counts); scannedAt escaped
    + (list || '<div class="ws-hint" style="margin-top:4px;">No findings.</div>')
    + ((s.findings || []).length > 12 ? `<div class="ws-hint">…and ${s.findings.length - 12} more</div>` : '');
}

async function wsRunSecurityScan() {
  const site = wsState.currentSite;
  const hint = document.getElementById('wsSecurityHint');
  if (!site) return;
  if (hint) hint.textContent = 'Scanning…';
  const r = await fetchJSON(`/api/web-studio/sites/${site.id}/security-scan`, { method: 'POST' });
  if (!r || r.error) { if (hint) hint.textContent = (r && r.error) || 'Scan failed.'; return; }
  if (hint) hint.textContent = '';
  site.security = r.security;
  wsRenderSecurity(site);
  wsRenderPublishState(site);
}

async function wsVerifyProvenance() {
  const site = wsState.currentSite;
  const vh = document.getElementById('wsProvVerifyHint');
  if (!site || !site.provenance || !site.provenance.credential) return;
  if (vh) vh.textContent = 'Verifying…';
  const r = await fetchJSON('/api/provenance/verify', { method: 'POST', body: { credential: site.provenance.credential } });
  if (r && r.error) { if (vh) vh.textContent = 'Verify failed: ' + r.error; return; }
  if (vh) vh.textContent = r.signature_valid
    ? `✓ Signature valid${r.key_trusted_for_origin ? ', key trusted for this origin' : ''}.`
    : `✗ Signature invalid (${(r.reasons || []).join('; ')}).`;
}

async function wsReloadFiles(openFirst) {
  if (!wsState.currentId) return;
  const data = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/files`);
  const files = (data && data.files) || [];
  wsState.files = files;
  const sel = document.getElementById('wsFileList');
  const keep = sel.value;
  sel.innerHTML = files.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  if (!files.length) { document.getElementById('wsCurrentFile').textContent = 'No files'; return; }
  let next = (!openFirst && files.includes(keep)) ? keep : (files.find((f) => f.endsWith('index.astro')) || files[0]);
  sel.value = next;
  wsLoadFile(next);
}

async function wsLoadFile(p) {
  if (!p || !wsState.currentId) return;
  const data = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/file?path=${encodeURIComponent(p)}`);
  const content = (data && typeof data.content === 'string') ? data.content
    : (data && data.error ? `/* ${data.error} */` : '');
  document.getElementById('wsCurrentFile').textContent = p;
  wsGetEditor((ed) => {
    if (!ed._fallback && window.monaco) {
      const m = ed.getModel(); if (m) window.monaco.editor.setModelLanguage(m, wsLangForFile(p));
    }
    ed.setValue(content);
    wsState.currentFile = p;
    wsState.dirty = false;
  });
}

async function wsSave() {
  if (!wsState.currentId || !wsState.currentFile || !wsState.editor) return false;
  const content = wsState.editor.getValue();
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/file`,
    { method: 'PUT', body: { path: wsState.currentFile, content } });
  if (r && r.error) { wsHint(`Save failed: ${r.error}`); return false; }
  wsState.dirty = false; wsHint('Saved.');
  return true;
}

async function wsBuild() {
  if (wsState.currentFile) { const ok = await wsSave(); if (ok === false) return; }
  wsSetEditorStatus('building'); wsHint('Building…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/build`, { method: 'POST', body: {} });
  if (r && r.ok) { wsSetEditorStatus(r.status || 'ready'); wsHint('Built.'); wsRefreshPreview(); }
  else { wsSetEditorStatus('build_failed'); wsHint('Build failed — check the build log on the server.'); }
}

async function wsAiEdit() {
  const ta = document.getElementById('wsAiInstruction');
  const instruction = (ta.value || '').trim();
  if (instruction.length < 4) { wsHint('Describe the change first.'); return; }
  wsState.aiEditing = true;
  wsSetEditorStatus('building'); wsHint('AI is regenerating the site with your change…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/ai-edit`, { method: 'POST', body: { instruction } });
  if (r && r.error) { wsState.aiEditing = false; wsHint(`AI edit failed: ${r.error}`); return; }
  ta.value = '';
  // the web_studio_site WS event flips status; we refresh preview + files when it reports ready
}

function wsBack() {
  const em = document.getElementById('wsEditorMode'); if (em) em.style.display = 'none';
  const lm = document.getElementById('wsListMode'); if (lm) lm.style.display = 'block';
  wsState.currentId = null;
  wsFetchAndRenderSites();
}

function wsRefreshPreview() {
  if (!wsState.currentId) return;
  const f = document.getElementById('wsPreview');
  if (f) f.src = `/api/web-studio/sites/${wsState.currentId}/preview/index.html?t=${Date.now()}`;
}

function wsSetEditorStatus(status) {
  const el = document.getElementById('wsEditorStatus');
  if (!el) return;
  el.textContent = status || '';
  el.className = 'ws-badge ' + (status || '');
}
function wsHint(t) { const el = document.getElementById('wsEditorHint'); if (el) el.textContent = t || ''; }

// ---------- publish / custom domain ----------
function wsPublishHint(t) { const el = document.getElementById('wsPublishHint'); if (el) el.textContent = t || ''; }

function wsRenderPublishState(site) {
  const dom = document.getElementById('wsDomain');
  const unpub = document.getElementById('wsUnpublishBtn');
  const link = document.getElementById('wsLiveLink');
  const httpLink = document.getElementById('wsHttpLink');
  const pub = document.getElementById('wsPublishBtn');
  if (!dom) return;
  if (site.domain && document.activeElement !== dom) dom.value = site.domain;
  const isPub = !!(site.published && site.url);
  const isHosted = !!(site.hostingSetup && site.domain);
  if (unpub) unpub.style.display = isPub ? '' : 'none';
  if (link) {
    if (isPub) { link.style.display = ''; link.href = site.url; link.textContent = `Open ${site.domain} ↗`; }
    else { link.style.display = 'none'; }
  }
  if (httpLink) {
    if (isHosted && !isPub) { httpLink.style.display = ''; httpLink.href = `http://${site.domain}`; httpLink.textContent = `Open http://${site.domain} ↗`; }
    else { httpLink.style.display = 'none'; }
  }
  if (pub) pub.textContent = isPub ? 'Re-publish' : 'Publish with TLS';
  if (isPub) wsPublishHint(`Live (HTTPS) at ${site.url}`);
  else if (isHosted) wsPublishHint(`HTTP hosting live at http://${site.domain}. Publish to add HTTPS.`);
  else if (site.status === 'publish_failed') wsPublishHint('Publish failed: ' + (site.publishError || 'see server logs.'));
  else if (site.security && site.security.available && site.security.counts && site.security.counts.error > 0) wsPublishHint(`⚠ ${site.security.counts.error} error-severity security finding(s) — resolve before publishing if the gate is set to block.`);
}

async function wsSetupHosting() {
  const domain = (document.getElementById('wsDomain').value || '').trim();
  if (!domain) { wsPublishHint('Enter a domain first.'); return; }
  wsPublishHint('Setting up HTTP hosting…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/domain`, { method: 'POST', body: { domain } });
  if (r && r.error) { wsPublishHint('Hosting setup failed: ' + r.error); return; }
  wsPublishHint(r.served ? `Live over HTTP at http://${domain}` : `nginx configured for ${domain} — build to serve content (404 until then).`);
}

async function wsDnsCheck() {
  const domain = (document.getElementById('wsDomain').value || '').trim();
  if (!domain) { wsPublishHint('Enter a domain first.'); return; }
  wsPublishHint('Checking DNS…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/dns-check?domain=${encodeURIComponent(domain)}`);
  if (r && r.error) { wsPublishHint('DNS check: ' + r.error); return; }
  if (r && r.ok) {
    wsPublishHint('DNS OK' + (r.warning ? ' — ' + r.warning : (r.found && r.found.length ? ` — ${domain} → ${r.found.join(', ')}` : '')));
  } else {
    wsPublishHint('DNS not ready: ' + ((r && r.reason) || 'the domain does not point here yet.'));
  }
}

async function wsPublish() {
  const domain = (document.getElementById('wsDomain').value || '').trim();
  if (!domain) { wsPublishHint('Enter a domain to publish to.'); return; }
  if (!window.confirm(`Publish this site to ${domain} with HTTPS?\n\nMake sure ${domain}'s DNS A record already points to this server.`)) return;
  wsPublishHint('Starting publish…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/publish`, { method: 'POST', body: { domain } });
  if (r && r.pending) { wsPublishHint('Publish queued for approval (Auto-Mode is on) — approve it in Settings → Automation.'); return; }
  if (r && r.error) { wsPublishHint('Cannot publish: ' + r.error); return; }
  wsPublishHint('Publishing — building, deploying and issuing TLS… this can take a minute or two.');
}

async function wsUnpublish() {
  if (!window.confirm('Take this site offline? The TLS certificate is kept so re-publishing is fast.')) return;
  wsPublishHint('Unpublishing…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/unpublish`, { method: 'POST', body: {} });
  if (r && r.error) { wsPublishHint('Unpublish failed: ' + r.error); return; }
  wsPublishHint('Taken offline.');
}

// ---------- export (download ZIP / push to GitHub) ----------
function wsExportHint(t) { const el = document.getElementById('wsExportHint'); if (el) el.textContent = t || ''; }

function wsExportModeChange() {
  const isNew = ((document.getElementById('wsExportMode') || {}).value || 'new') === 'new';
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('wsExportRepoName', isNew);
  show('wsExportPrivateWrap', isNew);
  show('wsExportRepoUrl', !isNew);
}

async function wsExportZip() {
  if (!wsState.currentId) return;
  wsExportHint('Preparing ZIP…');
  try {
    const res = await fetch(`/api/web-studio/sites/${wsState.currentId}/export.zip`);
    if (!res.ok) { let e = {}; try { e = await res.json(); } catch {} wsExportHint('Export failed: ' + (e.error || res.status)); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const name = (((wsState.currentSite || {}).name) || 'site').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
    const a = document.createElement('a');
    a.href = url; a.download = name + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    wsExportHint(`Downloaded ${name}.zip.`);
  } catch (e) { wsExportHint('Export failed: ' + e.message); }
}

async function wsExportGithub() {
  if (!wsState.currentId) return;
  const mode = (document.getElementById('wsExportMode') || {}).value || 'new';
  const token = ((document.getElementById('wsExportToken') || {}).value || '').trim();
  if (!token) { wsExportHint('A GitHub token (repo scope) is required.'); return; }
  const body = { mode, token };
  if (mode === 'new') {
    body.repoName = ((document.getElementById('wsExportRepoName') || {}).value || '').trim();
    body.private = !!(document.getElementById('wsExportPrivate') || {}).checked;
    if (!body.repoName) { wsExportHint('Enter a name for the new repo.'); return; }
  } else {
    body.repoUrl = ((document.getElementById('wsExportRepoUrl') || {}).value || '').trim();
    if (!body.repoUrl) { wsExportHint('Enter the existing repo URL.'); return; }
  }
  wsExportHint('Pushing to GitHub — creating commit…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/export/github`, { method: 'POST', body });
  document.getElementById('wsExportToken').value = ''; // clear the token field either way
  if (r && r.pending) { wsExportHint('GitHub push queued for approval (Auto-Mode is on). Approve it in Settings → Automation — you will re-enter the token there.'); return; }
  if (r && r.error) { wsExportHint('Export failed: ' + r.error); return; }
  const el = document.getElementById('wsExportHint');
  if (el) {
    el.textContent = `Pushed ${r.files} files to ${r.owner}/${r.repo} (branch ${r.branch}). `;
    if (r.commitUrl) el.innerHTML += `<a href="${escapeHtml(r.commitUrl)}" target="_blank" rel="noopener">View commit ↗</a> · <a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener">Open repo ↗</a>`;
  }
}

// ---------- optimize with AI OS (AEO score + agent suggestions) ----------
async function wsOptimize() {
  if (!wsState.currentId) return;
  const hint = document.getElementById('wsOptimizeHint');
  const box = document.getElementById('wsOptimizeResult');
  if (hint) hint.textContent = 'Scoring the built site + asking an AI OS agent…';
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/optimize`, { method: 'POST', body: {} });
  if (!r || r.error) { if (hint) hint.textContent = 'Could not optimize: ' + ((r && r.error) || 'error'); return; }
  const a = r.aeo || {};
  if (hint) hint.textContent = `AEO Readiness ${a.score}/100 (grade ${a.grade})${r.model ? ` · suggestions by ${r.model}` : ''}.`;
  const col = a.score >= 80 ? '#10b981' : a.score >= 50 ? '#f59e0b' : '#ef4444';
  let html = `<div style="font-size:28px;font-weight:700;color:${col};">${a.score}<span style="font-size:14px;color:var(--text-muted,#9aa);font-weight:400;">/100 &middot; grade ${escapeHtml(a.grade || '')}</span></div>`;
  if (r.crawlers && r.crawlers.blocked && r.crawlers.blocked.length) {
    html += `<div class="ws-hint" style="color:#ef4444;margin-top:4px;">&#9888; AI crawlers blocked in robots.txt: ${r.crawlers.blocked.map(escapeHtml).join(', ')}</div>`;
  }
  if (Array.isArray(a.recommendations) && a.recommendations.length) {
    html += '<div style="margin-top:8px;"><strong>Weak areas:</strong><ul style="margin:4px 0 0 18px;">'
      + a.recommendations.map((x) => `<li>${escapeHtml(x.area)} (${x.current}/${x.max}) &mdash; ${escapeHtml(x.tip)}</li>`).join('') + '</ul></div>';
  }
  if (r.suggestions) {
    html += `<div style="margin-top:10px;"><strong>AI OS suggestions:</strong><div style="white-space:pre-wrap;font-size:13px;margin-top:4px;line-height:1.5;">${escapeHtml(r.suggestions)}</div></div>`;
  }
  if (box) { box.innerHTML = html; box.style.display = 'block'; }
}

// ---------- live updates from the server ----------
function onWebStudioEvent(msg) {
  const ev = msg && msg.event;
  const d = (msg && msg.data) || {};
  const id = d.id || d.siteId;
  const view = document.getElementById('view-web-studio');
  if (!view || !view.classList.contains('active')) return;
  const inEditor = document.getElementById('wsEditorMode').style.display !== 'none';

  if (ev === 'web_studio_publish') {
    if (inEditor && id === wsState.currentId) wsPublishHint(WS_PUBLISH_PHASES[d.phase] || `${d.phase}…`);
    return;
  }

  if (inEditor && id && id === wsState.currentId) {
    if (d.status) wsSetEditorStatus(d.status);
    if (d.phase) wsHint(`Pipeline: ${d.phase}…`);
    if (d.status === 'ready' || d.status === 'gated') {
      wsRefreshPreview();
      // Only reload source files when an AI edit rewrote them — never clobber unsaved edits
      // on a plain build/publish completion.
      if (wsState.aiEditing) { wsState.aiEditing = false; wsHint('Updated by AI.'); wsReloadFiles(false); wsLoadContent(); }
    }
    if (d.status === 'failed' || d.status === 'build_failed') wsHint('Build failed.');
    // web_studio_site carries the full site object (has d.id) — reflect publish-state changes live.
    if (d.id === wsState.currentId) { wsState.currentSite = d; wsRenderPublishState(d); wsRenderProvenance(d); wsRenderSecurity(d); }
  } else if (!inEditor) {
    wsFetchAndRenderSites();
  }
}

// ---------- no-code Content editor (edit the plan's text -> re-render) ----------
function wsSwitchTab(tab) {
  wsState.tab = tab;
  const isContent = tab === 'content';
  const pane = document.getElementById('wsContentPane');
  const mon = document.getElementById('wsMonaco');
  const saveBtn = document.getElementById('wsSaveContentBtn');
  const cur = document.getElementById('wsCurrentFile');
  if (pane) pane.style.display = isContent ? '' : 'none';
  if (mon) mon.style.display = isContent ? 'none' : '';
  if (saveBtn) saveBtn.style.display = isContent ? '' : 'none';
  if (cur) cur.style.display = isContent ? 'none' : '';
  const tc = document.getElementById('wsTabContent'); if (tc) tc.classList.toggle('ws-tab-active', isContent);
  const tk = document.getElementById('wsTabCode'); if (tk) tk.classList.toggle('ws-tab-active', !isContent);
  if (!isContent) {
    // Code tab: open a file if none is loaded, then force Monaco to remeasure now that its
    // container is visible (creating Monaco in a hidden/zero-height box leaves it blank).
    if (!wsState.currentFile) { const sel = document.getElementById('wsFileList'); if (sel && sel.value) wsLoadFile(sel.value); }
    setTimeout(() => { if (wsState.editor && wsState.editor.layout) wsState.editor.layout(); }, 60);
  }
}

async function wsLoadContent() {
  wsState.plan = null;
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/content`);
  wsState.plan = (r && r.plan) || null;
  wsRenderContentForm(wsState.plan);
}

function wsCField(label, path, value, multiline) {
  const v = escapeHtml(value == null ? '' : value);
  const input = multiline
    ? `<textarea class="settings-input" rows="2" data-path="${path}">${v}</textarea>`
    : `<input type="text" class="settings-input" data-path="${path}" value="${v}" />`;
  return `<div class="ws-cfield"><label>${escapeHtml(label)}</label>${input}</div>`;
}

function wsRenderContentForm(plan) {
  const pane = document.getElementById('wsContentPane');
  if (!pane) return;
  if (!plan || !Array.isArray(plan.pages)) {
    pane.innerHTML = '<div class="empty-state">No editable content for this site yet (it predates the content editor, or was hand-edited in Code). Use the Code tab, or regenerate the site.</div>';
    return;
  }
  const out = [];
  out.push('<div class="ws-cgroup"><div class="ws-cgroup-title">Site</div>');
  out.push(wsCField('Brand / site name', 'siteName', plan.siteName));
  out.push(wsCField('Footer', 'footer', plan.footer));
  (plan.nav || []).forEach((n, i) => out.push(wsCField(`Nav label ${i + 1}`, `nav.${i}.label`, n.label)));
  out.push('</div>');
  (plan.pages || []).forEach((page, i) => {
    out.push(`<div class="ws-cgroup"><div class="ws-cgroup-title">Page: ${escapeHtml(page.title || page.path || '/')}</div>`);
    out.push(wsCField('Page title (SEO)', `pages.${i}.title`, page.title));
    out.push(wsCField('Page description (SEO)', `pages.${i}.description`, page.description, true));
    (page.sections || []).forEach((s, j) => {
      const base = `pages.${i}.sections.${j}`;
      out.push(`<div class="ws-cfield" style="border-top:1px dashed var(--border,#2a2a3a);padding-top:8px;margin-top:8px;"><label>${escapeHtml((s.type || 'section').toUpperCase())}</label></div>`);
      if (s.heading != null) out.push(wsCField('Heading', `${base}.heading`, s.heading));
      if (s.subheading != null) out.push(wsCField('Subheading', `${base}.subheading`, s.subheading, true));
      if (s.type === 'hero' || s.type === 'cta') {
        out.push(wsCField('Button text', `${base}.cta.label`, (s.cta || {}).label));
        out.push(wsCField('Button link', `${base}.cta.href`, (s.cta || {}).href));
      }
      if (s.type === 'features') (s.items || []).forEach((it, k) => {
        out.push(wsCField(`Feature ${k + 1} title`, `${base}.items.${k}.title`, it.title));
        out.push(wsCField(`Feature ${k + 1} text`, `${base}.items.${k}.body`, it.body, true));
      });
      if (s.type === 'prose') {
        if (Array.isArray(s.paragraphs)) s.paragraphs.forEach((p, k) => out.push(wsCField(`Paragraph ${k + 1}`, `${base}.paragraphs.${k}`, p, true)));
        else out.push(wsCField('Body', `${base}.body`, s.body, true));
      }
      if (s.type === 'contact') {
        out.push(wsCField('Body', `${base}.body`, s.body, true));
        out.push(wsCField('Email', `${base}.email`, s.email));
      }
    });
    out.push('</div>');
  });
  pane.innerHTML = out.join('');
}

function wsSetByPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[k] == null) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function wsCollectContent() {
  const plan = JSON.parse(JSON.stringify(wsState.plan || {}));
  document.querySelectorAll('#wsContentPane [data-path]').forEach((el) => {
    wsSetByPath(plan, el.getAttribute('data-path'), el.value);
  });
  return plan;
}

async function wsSaveContent() {
  if (!wsState.plan) { wsHint('No editable content — use the Code tab.'); return; }
  const plan = wsCollectContent();
  wsHint('Saving content & rebuilding…'); wsSetEditorStatus('building');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/content`, { method: 'PUT', body: { plan } });
  if (r && r.error) { wsHint('Save failed: ' + r.error); wsSetEditorStatus('build_failed'); return; }
  wsState.plan = plan;
  wsSetEditorStatus(r.status || 'ready');
  wsHint('Saved & rebuilt.');
  wsRefreshPreview();
}

// ---------- Monaco (lazy) with a textarea fallback ----------
function wsLangForFile(p) {
  if (/\.astro$/.test(p)) return 'html';
  if (/\.css$/.test(p)) return 'css';
  if (/\.(mjs|cjs|js)$/.test(p)) return 'javascript';
  if (/\.json$/.test(p)) return 'json';
  if (/\.md$/.test(p)) return 'markdown';
  if (/\.ts$/.test(p)) return 'typescript';
  return 'plaintext';
}

function wsEnsureMonaco(cb) {
  if (window.monaco && window.monaco.editor) { cb(); return; }
  if (window.require && typeof window.require.config === 'function') {
    if (!wsState._monacoConfigured) {
      window.require.config({ paths: { vs: WS_MONACO_VS } });
      wsState._monacoConfigured = true;
    }
    window.require(['vs/editor/editor.main'], () => cb(), () => wsFallbackEditor(cb));
    return;
  }
  if (wsState._monacoTries++ > 25) { wsFallbackEditor(cb); return; } // ~4s, then degrade gracefully
  setTimeout(() => wsEnsureMonaco(cb), 150);
}

function wsFallbackEditor(cb) {
  if (!wsState.editor) {
    const host = document.getElementById('wsMonaco');
    host.innerHTML = '<textarea id="wsFallbackTa" style="width:100%;height:100%;min-height:380px;border:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;padding:8px;background:#1e1e1e;color:#eee;resize:none;"></textarea>';
    const ta = document.getElementById('wsFallbackTa');
    ta.addEventListener('input', () => { wsState.dirty = true; });
    wsState.editor = {
      _fallback: true,
      getValue: () => ta.value,
      setValue: (v) => { ta.value = v == null ? '' : v; },
      getModel: () => null,
    };
  }
  cb(wsState.editor);
}

function wsGetEditor(cb) {
  if (wsState.editor) { cb(wsState.editor); return; }
  wsEnsureMonaco(() => {
    if (wsState.editor) { cb(wsState.editor); return; } // fallback already created one
    if (window.monaco && window.monaco.editor) {
      wsState.editor = window.monaco.editor.create(document.getElementById('wsMonaco'), {
        value: '', language: 'html', theme: 'vs-dark', automaticLayout: true,
        minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false,
      });
      wsState.editor.onDidChangeModelContent(() => { wsState.dirty = true; });
    }
    cb(wsState.editor);
  });
}
