// dashboard/js/access.js
// ============================================================
//  Admin-only "Access & Keys" view — the operator surface for the account and key routes that
//  landed 2026-09-03..06 with no UI: accounts (disable / enable / revoke sessions / deletion
//  request / export), scoped service keys (mint / rotate / revoke), retention (pending purges,
//  run now) and the provenance keyring (status / rotate / revoke).
//  Globals from app.js: fetchJSON, escapeHtml, timeAgo, showModal, closeModal. Operator-only
//  (not in CLIENT_VIEWS; every route here is requireAdmin server-side, and the decisions are
//  requireHuman — an API-token session sees 403s, which this view surfaces verbatim).
// ============================================================

const accessState = { wired: false, me: null };

function loadAccess() {
  if (!accessState.wired) {
    accessState.wired = true;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('accRefresh', accessLoadAll);
    on('accMintBtn', accessMintKey);
    on('accPurgeBtn', accessRunPurge);
    on('accProvRotateBtn', accessRotateProvenance);
    const users = document.getElementById('accUsers'); if (users) users.addEventListener('click', accessOnUserClick);
    const keys = document.getElementById('accKeys'); if (keys) keys.addEventListener('click', accessOnKeyClick);
    const prov = document.getElementById('accProvKeys'); if (prov) prov.addEventListener('click', accessOnProvClick);
  }
  accessLoadAll();
}

function accessMsg(text, isError) {
  const el = document.getElementById('accMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#fca5a5' : '';
}

async function accessLoadAll() {
  accessMsg('');
  const me = await fetchJSON('/api/auth/me');
  accessState.me = me && me.email ? me.email.toLowerCase() : null;
  await Promise.all([accessLoadUsers(), accessLoadKeys(), accessLoadRetention(), accessLoadProvenance()]);
}

// --- Accounts -------------------------------------------------------------------------------------
async function accessLoadUsers() {
  const el = document.getElementById('accUsers');
  if (!el) return;
  const d = await fetchJSON('/api/admin/users');
  const users = (d && d.users) || [];
  if (!users.length) { el.innerHTML = '<div class="empty-state">No accounts.</div>'; return; }
  const rows = users.map((u) => {
    const status = u.deletionRequestedAt ? 'deletion pending' : (u.disabled ? 'disabled' : (u.pendingSetup ? 'awaiting setup' : 'active'));
    const isMe = accessState.me && String(u.email).toLowerCase() === accessState.me;
    const act = isMe ? '<span class="crm-muted">this is you</span>' : [
      u.disabled ? `<button class="btn btn-sm" data-act="enable" data-email="${escapeHtml(u.email)}">Enable</button>` : `<button class="btn btn-sm" data-act="disable" data-email="${escapeHtml(u.email)}">Disable</button>`,
      `<button class="btn btn-sm" data-act="revoke" data-email="${escapeHtml(u.email)}">Revoke sessions</button>`,
      u.deletionRequestedAt ? `<button class="btn btn-sm" data-act="cancel-deletion" data-email="${escapeHtml(u.email)}">Cancel deletion</button>` : `<button class="btn btn-sm btn-danger" data-act="request-deletion" data-email="${escapeHtml(u.email)}">Request deletion</button>`,
      `<button class="btn btn-sm" data-act="export" data-email="${escapeHtml(u.email)}">Export data</button>`,
    ].join(' ');
    return `<div class="crm-row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;"><strong>${escapeHtml(u.email)}</strong><div class="crm-muted">${escapeHtml(u.role)} · ${escapeHtml(u.plan || '—')} · created ${escapeHtml((u.createdAt || '').slice(0, 10) || '—')}</div></div>
      <span class="crm-tag">${escapeHtml(status)}</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${act}</div>
    </div>`;
  }).join('');
  el.innerHTML = rows; // seclint-ok: every interpolation above is escapeHtml()'d or encodeURIComponent()'d
}

async function accessOnUserClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const email = btn.dataset.email, act = btn.dataset.act;
  if (act === 'export') { window.open(`/api/admin/users/${encodeURIComponent(email)}/export`, '_blank', 'noopener'); return; } // the route serves an attachment
  const confirmText = { disable: `Disable ${email}? Their sessions end now.`, 'request-deletion': `Request deletion of ${email}? The account is disabled now and purged after 30 days.`, revoke: `Revoke every session for ${email}?` }[act];
  if (confirmText && !window.confirm(confirmText)) return;
  const path = { enable: 'enable', disable: 'disable', revoke: 'revoke-sessions', 'request-deletion': 'request-deletion', 'cancel-deletion': 'cancel-deletion' }[act];
  const r = await fetchJSON(`/api/admin/users/${encodeURIComponent(email)}/${path}`, { method: 'POST', body: {} });
  if (!r || r.error) { accessMsg((r && r.error) || 'Request failed', true); return; }
  accessMsg(act === 'request-deletion' ? `Deletion requested — purge due ${(r.dueAt || '').slice(0, 10)}, ${r.revokedSessions} session(s) revoked.` : `${act} done${typeof r.revokedSessions === 'number' ? ` — ${r.revokedSessions} session(s) revoked` : ''}.`);
  accessLoadUsers(); accessLoadRetention();
}

// --- Service keys ----------------------------------------------------------------------------------
async function accessLoadKeys() {
  const el = document.getElementById('accKeys');
  if (!el) return;
  const d = await fetchJSON('/api/admin/service-keys');
  const keys = (d && d.keys) || [];
  const master = document.getElementById('accMasterNote');
  if (master) master.textContent = d && d.masterTokenConfigured ? 'A master API_TOKEN is configured. Prefer a scoped key per automation; actions still on the master token appear in the activity log as service@api-token.' : '';
  if (!keys.length) { el.innerHTML = '<div class="empty-state">No service keys yet. Mint one above.</div>'; return; }
  el.innerHTML = keys.map((k) => `<div class="crm-row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;"><strong>${escapeHtml(k.label)}</strong><div class="crm-muted">scope <strong>${escapeHtml(k.scope)}</strong> · created ${escapeHtml((k.createdAt || '').slice(0, 10))}${k.expiresAt ? ` · expires ${escapeHtml(k.expiresAt.slice(0, 10))}` : ''} · last used ${k.lastUsedAt ? escapeHtml(timeAgo(k.lastUsedAt)) : 'never'}${k.rotatedFrom ? ' · rotated' : ''}</div></div>
      <span class="crm-tag"${k.revoked ? ' style="background:#7f1d1d;color:#fff;"' : ''}>${k.revoked ? 'revoked' : 'active'}</span>
      <div style="display:flex;gap:6px;">${k.revoked ? '' : `<button class="btn btn-sm" data-act="rotate" data-id="${escapeHtml(k.id)}" data-label="${escapeHtml(k.label)}">Rotate</button> <button class="btn btn-sm btn-danger" data-act="revoke" data-id="${escapeHtml(k.id)}" data-label="${escapeHtml(k.label)}">Revoke</button>`}</div>
    </div>`).join(''); // seclint-ok: every interpolation is escapeHtml()'d
}

function accessShowTokenOnce(token, key, extra) {
  showModal('Service key — copy it now', `
    <p>${escapeHtml(extra || '')} This token is shown <strong>once</strong>. Only its hash is stored; it cannot be recovered.</p>
    <p><strong>${escapeHtml(key.label)}</strong> · scope <strong>${escapeHtml(key.scope)}</strong>${key.expiresAt ? ` · expires ${escapeHtml(key.expiresAt.slice(0, 10))}` : ''}</p>
    <textarea class="form-input" readonly style="width:100%;height:72px;font-family:monospace;" onclick="this.select()">${escapeHtml(token)}</textarea>
    <p class="crm-muted">Use it as <code>Authorization: Bearer &lt;token&gt;</code>.</p>`, [{ label: 'Done', class: 'btn-primary', action: closeModal }]);
}

async function accessMintKey() {
  const label = (document.getElementById('accKeyLabel') || {}).value || '';
  const scope = (document.getElementById('accKeyScope') || {}).value || 'read';
  const days = (document.getElementById('accKeyDays') || {}).value || '';
  const r = await fetchJSON('/api/admin/service-keys', { method: 'POST', body: { label, scope, expiresInDays: days || undefined } });
  if (!r || r.error) { accessMsg((r && r.error) || 'Could not mint key', true); return; }
  const lbl = document.getElementById('accKeyLabel'); if (lbl) lbl.value = '';
  accessShowTokenOnce(r.token, r.key, 'Minted.');
  accessLoadKeys();
}

async function accessOnKeyClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id, label } = btn.dataset;
  if (act === 'revoke') {
    if (!window.confirm(`Revoke "${label}"? Anything using it stops working now.`)) return;
    const r = await fetchJSON(`/api/admin/service-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
    if (!r || r.error) { accessMsg((r && r.error) || 'Revoke failed', true); return; }
    accessMsg(`Revoked "${label}".`); accessLoadKeys();
  } else if (act === 'rotate') {
    if (!window.confirm(`Rotate "${label}"? A new token is issued and the old one is revoked in the same step.`)) return;
    const r = await fetchJSON(`/api/admin/service-keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: {} });
    if (!r || r.error) { accessMsg((r && r.error) || 'Rotate failed', true); return; }
    accessShowTokenOnce(r.token, r.key, 'Rotated — the previous token is revoked.');
    accessLoadKeys();
  }
}

// --- Retention -------------------------------------------------------------------------------------
async function accessLoadRetention() {
  const el = document.getElementById('accRetention');
  if (!el) return;
  const d = await fetchJSON('/api/admin/retention');
  const pending = (d && d.pending) || [];
  if (!pending.length) { el.innerHTML = `<div class="empty-state">No deletion requests pending. The purge job runs daily at 03:20 server time; accounts are purged ${Number(d && d.graceDays) || 30} days after a request.</div>`; return; }
  el.innerHTML = pending.map((p) => `<div class="crm-row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <div style="flex:1;"><strong>${escapeHtml(p.email)}</strong><div class="crm-muted">requested ${escapeHtml((p.requestedAt || '').slice(0, 10))} by ${escapeHtml(p.requestedBy || '—')} · purge due ${escapeHtml((p.dueAt || '').slice(0, 10))}</div></div>
      <span class="crm-tag"${p.due ? ' style="background:#7f1d1d;color:#fff;"' : ''}>${p.due ? 'due now' : 'in grace period'}</span>
    </div>`).join(''); // seclint-ok: escaped
  const held = (d && d.heldSites) || [];
  if (held.length) el.innerHTML += `<div style="margin-top:8px;color:#fbbf24;">Hosted sites held for the gated delete: ${held.map((h) => `${escapeHtml(h.email)} (${h.sites.map(escapeHtml).join(', ')})`).join('; ')}</div>`; // seclint-ok: escaped
}

async function accessRunPurge() {
  if (!window.confirm('Run the retention purge now? Only accounts past their 30-day grace are removed.')) return;
  const r = await fetchJSON('/api/admin/retention/run', { method: 'POST', body: {} });
  if (!r || r.error) { accessMsg((r && r.error) || 'Purge failed', true); return; }
  accessMsg(`Purge run: ${(r.purged || []).length} account(s) removed${(r.held || []).length ? `, ${r.held.length} with hosted sites held` : ''}.`);
  accessLoadUsers(); accessLoadRetention();
}

// --- Provenance keyring ------------------------------------------------------------------------------
async function accessLoadProvenance() {
  const el = document.getElementById('accProvKeys');
  const status = document.getElementById('accProvStatus');
  if (!el || !status) return;
  const d = await fetchJSON('/api/admin/provenance');
  if (!d) { status.innerHTML = ''; el.innerHTML = ''; return; }
  if (d.missing) {
    status.innerHTML = `<div style="color:#fca5a5;">⚠ <strong>Signing key MISSING</strong> since ${escapeHtml((d.missing.since || '').slice(0, 19))}. Expected: ${escapeHtml((d.missing.expectedKids || []).join(', '))}. Nothing was regenerated. Restore <code>.magent/provenance/ed25519-priv.pem</code> from backup, or rotate below to mint a new key (already-published sites keep verifying under the old one).</div>`;
  } else {
    const signingText = d.signing ? '✓ signing on' : '✗ signing off'; // a constant, not data
    status.innerHTML = `<div class="crm-muted">${escapeHtml(signingText)} · current key <code>${escapeHtml((d.current_kid || '—').split('#').pop())}</code> · source ${escapeHtml(d.source || '')}</div>`;
  }
  const keys = d.keys || [];
  if (!keys.length) { el.innerHTML = '<div class="empty-state">No keys in the keyring yet.</div>'; return; }
  el.innerHTML = keys.map((k) => `<div class="crm-row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;"><code>${escapeHtml(k.kid.split('#').pop())}</code><div class="crm-muted">created ${escapeHtml((k.created_at || '').slice(0, 10))}${k.retired_at ? ` · retired ${escapeHtml(k.retired_at.slice(0, 10))}` : ''}${k.revoked_at ? ` · revoked ${escapeHtml(k.revoked_at.slice(0, 10))}` : ''}${k.reason ? ` · ${escapeHtml(k.reason)}` : ''}</div></div>
      <span class="crm-tag"${k.status === 'revoked' ? ' style="background:#7f1d1d;color:#fff;"' : ''}>${escapeHtml(k.status)}</span>
      <div>${k.status === 'retired' ? `<button class="btn btn-sm btn-danger" data-act="revoke" data-kid="${escapeHtml(k.kid)}">Revoke</button>` : ''}</div>
    </div>`).join(''); // seclint-ok: escaped
}

async function accessRotateProvenance() {
  const reason = window.prompt('Reason for rotating the provenance signing key (recorded in the keyring):', '');
  if (reason === null) return;
  const revokeCurrent = window.confirm('Also REVOKE the current key (compromise)? OK = revoke, Cancel = retire normally (already-published sites keep verifying).');
  const r = await fetchJSON('/api/admin/provenance/rotate', { method: 'POST', body: { reason, revokeCurrent } });
  if (!r || r.error) { accessMsg((r && r.error) || 'Rotate failed', true); return; }
  accessMsg(`Rotated. New key ${r.kid.split('#').pop()}; previous ${revokeCurrent ? 'REVOKED' : 'retired'}. Rebuild sites to re-sign them under the new key.`);
  accessLoadProvenance();
}

async function accessOnProvClick(e) {
  const btn = e.target.closest('button[data-act="revoke"]');
  if (!btn) return;
  const reason = window.prompt(`Revoke key ${btn.dataset.kid.split('#').pop()}? Sidecars signed under it will verify but be reported as NOT trusted. Reason:`, '');
  if (reason === null) return;
  const r = await fetchJSON('/api/admin/provenance/revoke', { method: 'POST', body: { kid: btn.dataset.kid, reason } });
  if (!r || r.error) { accessMsg((r && r.error) || 'Revoke failed', true); return; }
  accessMsg('Key revoked.'); accessLoadProvenance();
}
