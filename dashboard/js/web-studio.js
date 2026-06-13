// dashboard/js/web-studio.js
// ============================================================
//  AI Web Studio dashboard view. Talks to /api/web-studio/* (wired into server.js).
//  Globals consumed from app.js: fetchJSON(url,opts), escapeHtml(s), timeAgo(ts).
//  Exposes globals used by app.js: loadWebStudio(), onWebStudioEvent(msg).
//  Inline onclick handlers (wsOpen/wsDelete) are global function declarations.
// ============================================================

const wsState = {
  sites: [], limit: 1, used: 0,
  currentId: null, files: [], currentFile: null,
  editor: null, dirty: false, wired: false,
  _monacoConfigured: false, _monacoTries: 0,
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
  const hint = document.getElementById('wsCreateHint');
  if (brief.length < 10) { if (hint) hint.textContent = 'Add a longer brief (at least 10 characters).'; return; }
  const btn = document.getElementById('wsCreateBtn');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'Generating — the studio team is planning, writing and building your site…';
  const r = await fetchJSON('/api/web-studio/sites', { method: 'POST', body: { name, brief } });
  if (r && r.error) { if (hint) hint.textContent = `Could not create: ${r.error}`; if (btn) btn.disabled = false; return; }
  document.getElementById('wsName').value = '';
  document.getElementById('wsBrief').value = '';
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
  wsState.currentFile = null;
  document.getElementById('wsListMode').style.display = 'none';
  document.getElementById('wsEditorMode').style.display = 'block';
  document.getElementById('wsEditorTitle').textContent = site.name;
  wsSetEditorStatus(site.status);
  wsHint('');
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
  wsSetEditorStatus('building'); wsHint('AI is regenerating the site with your change…');
  const r = await fetchJSON(`/api/web-studio/sites/${wsState.currentId}/ai-edit`, { method: 'POST', body: { instruction } });
  if (r && r.error) { wsHint(`AI edit failed: ${r.error}`); return; }
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

// ---------- live updates from the server ----------
function onWebStudioEvent(msg) {
  const d = (msg && msg.data) || {};
  const id = d.id || d.siteId;
  const view = document.getElementById('view-web-studio');
  if (!view || !view.classList.contains('active')) return;
  const inEditor = document.getElementById('wsEditorMode').style.display !== 'none';
  if (inEditor && id && id === wsState.currentId) {
    if (d.status) wsSetEditorStatus(d.status);
    if (d.phase) wsHint(`Pipeline: ${d.phase}…`);
    if (d.status === 'ready' || d.status === 'gated') { wsHint('Updated.'); wsRefreshPreview(); wsReloadFiles(false); }
    if (d.status === 'failed' || d.status === 'build_failed') wsHint('Build failed.');
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
