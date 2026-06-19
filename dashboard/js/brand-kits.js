// dashboard/js/brand-kits.js
// Brand Kits view — save a reusable design profile from a URL (palette/fonts/section structure),
// optionally own it by a CRM contact, then apply it when generating a Web Studio site instead of
// re-cloning. Mirrors web-studio.js conventions: wired-once listeners, shared fetchJSON (returns an
// error object, never throws), escapeHtml at every DOM sink.
const bkState = { wired: false, kits: [], contacts: [] };

function loadBrandKits() {
  if (!bkState.wired) {
    bkState.wired = true;
    const el = document.getElementById('bkCreateBtn');
    if (el) el.addEventListener('click', bkCreate);
  }
  bkFetchContacts();
  bkFetchAndRender();
}

async function bkFetchContacts() {
  const sel = document.getElementById('bkContact');
  if (!sel) return;
  const data = await fetchJSON('/api/crm/contacts?limit=200');
  bkState.contacts = (data && data.contacts) || [];
  sel.innerHTML = '<option value="">No owner (unassigned)</option>'
    + bkState.contacts.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.email || c.id)}</option>`).join('');
}

async function bkFetchAndRender() {
  const data = await fetchJSON('/api/brand-kits');
  bkState.kits = (data && data.kits) || [];
  bkRender();
}

function bkContactName(id) {
  const c = bkState.contacts.find((x) => x.id === id);
  return c ? (c.name || c.email || id) : null;
}

function bkRender() {
  const wrap = document.getElementById('bkList');
  if (!wrap) return;
  if (!bkState.kits.length) { wrap.innerHTML = '<div class="empty-state">No brand kits yet. Save one from a URL above.</div>'; return; }
  wrap.innerHTML = bkState.kits.map((k) => {
    const t = (k.design && k.design.tokens) || {};
    const sw = [t.brand, t.accent, t.ink, t.paper].filter((c) => /^#[0-9a-fA-F]{6}$/.test(c || ''));
    const owner = k.contactId ? bkContactName(k.contactId) : null;
    const chips = sw.map((c) => `<span title="${c}" style="width:18px;height:18px;border-radius:4px;border:1px solid #0003;background:${c};display:inline-block;"></span>`).join('');
    return `<div class="ws-site-card">
      <div>
        <div><strong>${escapeHtml(k.name)}</strong></div>
        <div class="ws-site-meta">${k.sourceUrl ? escapeHtml(k.sourceUrl) : ''}${owner ? ' &middot; owner: ' + escapeHtml(owner) : ''}</div>
        <div style="display:inline-flex;gap:4px;margin-top:6px;">${chips}</div>
      </div>
      <div class="ws-row">
        <button class="btn" onclick="bkDelete('${k.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function bkCreate() {
  const name = ((document.getElementById('bkName') || {}).value || '').trim();
  const url = ((document.getElementById('bkUrl') || {}).value || '').trim();
  const contactId = ((document.getElementById('bkContact') || {}).value || '').trim();
  const hint = document.getElementById('bkHint');
  if (!url) { if (hint) hint.textContent = 'Enter a URL to extract the design from.'; return; }
  const btn = document.getElementById('bkCreateBtn'); if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'Reading the site and extracting its design…';
  const r = await fetchJSON('/api/brand-kits', { method: 'POST', body: { name, url, contactId: contactId || null } });
  if (btn) btn.disabled = false;
  if (r && r.error) { if (hint) hint.textContent = 'Could not save: ' + r.error; return; }
  if (hint) hint.textContent = 'Saved.';
  ['bkName', 'bkUrl'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  await bkFetchAndRender();
}

async function bkDelete(id) {
  if (!window.confirm('Delete this brand kit? Sites already built keep their design.')) return;
  const r = await fetchJSON(`/api/brand-kits/${id}`, { method: 'DELETE' });
  if (r && r.error) { alert('Delete failed: ' + r.error); return; }
  await bkFetchAndRender();
}
