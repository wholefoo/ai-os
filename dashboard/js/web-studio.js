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
    on('wsBackBtn', 'click', wsBack);
    on('wsSaveBtn', 'click', wsSave);
    on('wsBuildBtn', 'click', wsBuild);
    on('wsAiEditBtn', 'click', wsAiEdit);
    on('wsRefreshPreview', 'click', wsRefreshPreview);
    on('wsFileList', 'change', (e) => wsLoadFile(e.target.value));
    on('wsDnsCheckBtn', 'click', wsDnsCheck);
    on('wsSetupHostingBtn', 'click', wsSetupHosting);
    on('wsPublishBtn', 'click', wsPublish);
    on('wsUnpublishBtn', 'click', wsUnpublish);
  }
  if (!wsState.currentId) {
    const em = document.getElementById('wsEditorMode'); if (em) em.style.display = 'none';
    const lm = document.getElementById('wsListMode'); if (lm) lm.style.display = 'block';
  }
  wsFetchAndRenderSites();
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
        <div class="ws-site-meta">${s.domain ? escapeHtml(s.domain) + ' &middot; ' : ''}${s.lastBuiltAt ? 'built ' + timeAgo(s.lastBuiltAt) : 'created ' + timeAgo(s.createdAt)}</div>
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
  const hint = document.getElementById('wsCreateHint');
  if (brief.length < 10) { if (hint) hint.textContent = 'Add a longer brief (at least 10 characters).'; return; }
  const btn = document.getElementById('wsCreateBtn');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'Generating — the studio team is planning, writing and building your site…';
  const r = await fetchJSON('/api/web-studio/sites', { method: 'POST', body: { name, brief, siteType, domain } });
  if (r && r.error) { if (hint) hint.textContent = `Could not create: ${r.error}`; if (btn) btn.disabled = false; return; }
  document.getElementById('wsName').value = '';
  document.getElementById('wsBrief').value = '';
  if (document.getElementById('wsCreateDomain')) document.getElementById('wsCreateDomain').value = '';
  await wsFetchAndRenderSites(); // shows the new "building" site; WS events flip its status
}

async function wsDelete(id) {
  if (!window.confirm('Delete this site? This removes its workspace and any hosting.')) return;
  await fetchJSON(`/api/web-studio/sites/${id}`, { method: 'DELETE' });
  if (wsState.currentId === id) wsBack();
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
  wsRefreshPreview();
  await wsReloadFiles(true);
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
      if (wsState.aiEditing) { wsState.aiEditing = false; wsHint('Updated by AI.'); wsReloadFiles(false); }
    }
    if (d.status === 'failed' || d.status === 'build_failed') wsHint('Build failed.');
    // web_studio_site carries the full site object (has d.id) — reflect publish-state changes live.
    if (d.id === wsState.currentId) { wsState.currentSite = d; wsRenderPublishState(d); }
  } else if (!inEditor) {
    wsFetchAndRenderSites();
  }
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
