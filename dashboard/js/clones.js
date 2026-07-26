// dashboard/js/clones.js
// ============================================================
//  AI Business Clone view. Globals from app.js: fetchJSON, escapeHtml, timeAgo, showSettingsToast.
//  Exposes loadClones(). Inline handlers are global function declarations, matching crm.js.
//
//  A clone is NOT an agent, and the copy here has to keep saying so. An agent is function-first
//  with a personality applied so its output reads well; a clone is person-first, where the persona
//  IS the product. So this view talks about interviewing, expertise and limits — never about
//  configuring capabilities — and it lives in its own nav entry rather than inside Agents.
//  See lib/business-clone/README.md.
// ============================================================

const clState = { wired: false, list: [], selectedId: null, tab: 'interview', detail: null, drafts: [], proposals: [], evidence: null, templates: [], onboarding: null, dispatch: null, limit: 1, tier: '', busy: false, editing: false };

// The editable shape of a persona, mirroring lib/business-clone/persona.js. Enum options must match
// that module's constants — a value it does not recognise is silently dropped on save, which would
// look to the owner like the field simply refused to stick.
//
// Object lists (FAQ, opinions, trade-offs) are edited as one line per entry with pipe-separated
// parts. Not elegant, but it round-trips exactly and an owner can see the whole set at once, which
// matters more here than input polish: this screen exists so someone can audit what their clone
// believes about them and correct it in one pass.
const CL_SCALE = [['', '—'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']];
const CL_FIELDS = {
  identity: [
    { k: 'ownerName', label: 'Name', type: 'text' },
    { k: 'role', label: 'Role', type: 'text' },
    { k: 'businessName', label: 'Business', type: 'text' },
    { k: 'industry', label: 'Industry', type: 'text' },
    { k: 'location', label: 'Location', type: 'text' },
    { k: 'yearsExperience', label: 'Years in the trade', type: 'number' },
    { k: 'whatTheyDo', label: 'What the business does, in your words', type: 'textarea' },
  ],
  voice: [
    { k: 'formality', label: 'Formality (1 casual – 5 formal)', type: 'select', options: CL_SCALE },
    { k: 'directness', label: 'Directness (1 diplomatic – 5 blunt)', type: 'select', options: CL_SCALE },
    { k: 'warmth', label: 'Warmth (1 clinical – 5 very warm)', type: 'select', options: CL_SCALE },
    { k: 'humor', label: 'Humour', type: 'select', options: [['', '—'], ['none', 'none'], ['dry', 'dry'], ['warm', 'warm'], ['playful', 'playful']] },
    { k: 'sentenceLength', label: 'Sentence length', type: 'select', options: [['', '—'], ['short', 'short'], ['varied', 'varied'], ['long', 'long']] },
    { k: 'greeting', label: 'Opens with', type: 'text' },
    { k: 'signoff', label: 'Signs off with', type: 'text' },
    { k: 'signaturePhrases', label: 'Phrases you actually use', type: 'list' },
    { k: 'avoidPhrases', label: 'Language you would never use', type: 'list' },
    { k: 'vocabulary', label: 'Characteristic vocabulary', type: 'list' },
  ],
  expertise: [
    { k: 'domains', label: 'Expert in', type: 'list' },
    { k: 'methodologies', label: 'How you work', type: 'list' },
    { k: 'credentials', label: 'Credentials', type: 'list' },
    { k: 'strongOpinions', label: 'Strong opinions', type: 'objlist', parts: ['claim', 'rationale'] },
    { k: 'faq', label: 'Questions you answer constantly', type: 'objlist', parts: ['question', 'answer'] },
  ],
  decisionStyle: [
    { k: 'priorities', label: 'What you protect, most important first', type: 'list' },
    { k: 'tradeoffRules', label: 'Trade-offs you make', type: 'objlist', parts: ['when', 'prefer', 'over'] },
    { k: 'riskPosture', label: 'Risk posture', type: 'select', options: [['', '—'], ['conservative', 'conservative'], ['balanced', 'balanced'], ['aggressive', 'aggressive']] },
    { k: 'escalationTriggers', label: 'Always handle personally', type: 'list' },
  ],
  boundaries: [
    { k: 'neverSay', label: 'Never say', type: 'list' },
    { k: 'neverPromise', label: 'Never promise', type: 'list' },
    { k: 'requiresHuman', label: 'Always yours to handle', type: 'list' },
    { k: 'confidentialTopics', label: 'Confidential', type: 'list' },
    { k: 'pricingDisclosure', label: 'Pricing', type: 'select', options: [['', '—'], ['none', 'never discuss'], ['ranges', 'ranges only'], ['full', 'full detail']] },
    { k: 'competitorPolicy', label: 'On competitors', type: 'text' },
  ],
};
const CL_DIM_LABELS = {
  identity: 'Who they are', voice: 'How they sound', expertise: 'What they know',
  decisionStyle: 'How they decide', boundaries: 'Limits',
};

function loadClones() {
  if (!clState.wired) {
    clState.wired = true;
    const btn = document.getElementById('clNewBtn');
    if (btn) btn.addEventListener('click', clCreate);
  }
  clFetchList();
}

async function clFetchList() {
  // Templates come along for the ride: the create form can render immediately after this, and a
  // role picker that renders before its options have arrived is an empty dropdown.
  const [data, onb, tpl] = await Promise.all([
    fetchJSON('/api/clones'),
    fetchJSON('/api/clones/onboarding'),
    clState.templates.length ? Promise.resolve(null) : fetchJSON('/api/clones/templates'),
  ]);
  clState.list = (data && data.clones) || [];
  clState.limit = (data && data.limit) != null ? data.limit : 1;
  clState.tier = (data && data.tier) || '';
  clState.onboarding = (onb && !onb.error) ? onb : null;
  if (tpl && tpl.templates) clState.templates = tpl.templates;
  clRenderList();
  if (clState.selectedId && clState.list.some((c) => c.id === clState.selectedId)) clOpen(clState.selectedId);
  else if (!clState.list.length) clRenderEmptyDetail();
}

function clRenderList() {
  const el = document.getElementById('clList');
  const lim = document.getElementById('clLimit');
  if (lim) {
    const shown = clState.limit === null || clState.limit === undefined ? '' : (clState.limit > 999 ? '∞' : clState.limit);
    lim.textContent = `${clState.list.length} of ${shown}${clState.tier ? ` · ${clState.tier}` : ''}`;
  }
  if (!el) return;
  if (!clState.list.length) {
    el.innerHTML = '<div class="cl-empty">No clones yet.<br><span class="cl-muted">Create one, then answer its questions.</span></div>';
    return;
  }
  el.innerHTML = clState.list.map((c) => `
    <div class="cl-card ${c.id === clState.selectedId ? 'active' : ''}" onclick="clOpen('${escapeHtml(c.id)}')">
      <div class="cl-name">
        <span>${escapeHtml(c.name)}</span>
        <span class="cl-tag ${c.status === 'active' ? 'active-s' : escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
      </div>
      <div class="cl-bar"><i style="width:${Math.max(0, Math.min(100, Number(c.completeness) || 0))}%"></i></div>
      <div class="cl-muted" style="margin-top:6px;">${Number(c.completeness) || 0}% known${c.usable ? '' : ' · not ready yet'}</div>
    </div>`).join('');
}

/**
 * The starting state. Which of three things you see depends on where onboarding actually is:
 * the disclosure if it has not been accepted (or has changed since it was), the create form once
 * it has, and a plain prompt if you dismissed it and came back anyway.
 */
function clRenderEmptyDetail() {
  const d = document.getElementById('clDetail');
  if (!d) return;
  const o = clState.onboarding;

  if (o && !o.disclosureAccepted) { d.innerHTML = clDisclosureHtml(o); return; }
  if (o && o.status === 'dismissed') {
    d.innerHTML = `<div class="cl-empty">You set this aside for later.<br>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="clResumeOnboarding()">Pick it back up</button></div>`;
    return;
  }
  d.innerHTML = clCreateFormHtml();
}

/** The disclosure. Shown BEFORE the first question, because that is when it can still inform a choice. */
function clDisclosureHtml(o) {
  const disc = (o && o.disclosure) || null;
  // Refuse to render a consent screen with nothing to consent to. If the disclosure did not arrive,
  // say so and offer a retry rather than showing an "I understand" button over an empty panel.
  if (!disc || !(disc.points || []).length) {
    return `<div class="cl-empty">Could not load what you are agreeing to.<br>
      <span class="cl-muted">Nothing has started. Reload and try again.</span><br>
      <button class="btn" style="margin-top:12px;" onclick="clFetchList()">Retry</button></div>`;
  }
  const points = (disc.points || []).map((p) => `
    <div style="margin:14px 0;">
      <div style="font-weight:600;">${escapeHtml(p.heading)}</div>
      <div class="cl-muted" style="margin-top:2px;">${escapeHtml(p.body)}</div>
    </div>`).join('');

  return `<div style="max-width:640px;">
    <h3 style="margin:0 0 4px;">${escapeHtml(disc.title)}</h3>
    <div class="cl-muted">Building a clone means telling it how you think. Here is exactly what that involves.</div>
    ${points}
    <div style="display:flex;gap:8px;margin-top:18px;">
      <button class="btn btn-primary" onclick="clAcceptDisclosure()">I understand — start</button>
      <button class="btn" onclick="clDismissOnboarding()">Not now</button>
    </div>
  </div>`;
}

/** Create form. Replaces the old prompt() chain — a role choice deserves to show what it means. */
function clCreateFormHtml() {
  const opts = (clState.templates || []).map((t) =>
    `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)} — ${escapeHtml(t.description)}</option>`).join('');
  return `<div style="max-width:560px;">
    <h3 style="margin:0 0 4px;">Build a clone</h3>
    <div class="cl-muted">You will be interviewed. Answer in your own words — quotes and examples are worth far more than descriptions.</div>

    <div class="cl-muted" style="margin:14px 0 3px;">Whose clone is this?</div>
    <input id="clNewName" type="text" style="width:100%;" placeholder="Dana — Whitfield Dental">

    <div class="cl-muted" style="margin:14px 0 3px;">What is their role?</div>
    <select id="clNewRole" style="width:100%;">${opts}</select>
    <div class="cl-muted" style="font-size:11px;margin-top:4px;">This changes which questions get asked, and in what order. It never fills anything in for them.</div>

    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="btn btn-primary" onclick="clSubmitCreate()">Start the interview</button>
      ${clState.list.length ? '' : '<button class="btn" onclick="clDismissOnboarding()">Later</button>'}
    </div>
  </div>`;
}

async function clAcceptDisclosure() {
  const res = await fetchJSON('/api/clones/onboarding/accept', { method: 'POST', body: {} });
  if (res && res.error) return showSettingsToast(res.error, true);
  // MERGE, never replace. A response that omits the disclosure must not blank the one we already
  // hold — an empty consent screen is worse than no consent screen, because it still has a button.
  clState.onboarding = { ...(clState.onboarding || {}), ...res };
  await clEnsureTemplates();
  clRenderEmptyDetail();
}

async function clDismissOnboarding() {
  const res = await fetchJSON('/api/clones/onboarding/dismiss', { method: 'POST', body: {} });
  if (res && res.error) return showSettingsToast(res.error, true);
  // MERGE, never replace. A response that omits the disclosure must not blank the one we already
  // hold — an empty consent screen is worse than no consent screen, because it still has a button.
  clState.onboarding = { ...(clState.onboarding || {}), ...res };
  clRenderEmptyDetail();
  showSettingsToast('Set aside — pick it up whenever');
}

async function clResumeOnboarding() {
  const res = await fetchJSON('/api/clones/onboarding/resume', { method: 'POST', body: {} });
  if (res && res.error) return showSettingsToast(res.error, true);
  // MERGE, never replace. A response that omits the disclosure must not blank the one we already
  // hold — an empty consent screen is worse than no consent screen, because it still has a button.
  clState.onboarding = { ...(clState.onboarding || {}), ...res };
  await clEnsureTemplates();
  clRenderEmptyDetail();
}

async function clEnsureTemplates() {
  if (clState.templates.length) return;
  const t = await fetchJSON('/api/clones/templates');
  clState.templates = (t && t.templates) || [];
}

/** The "+ New clone" button: show the create form rather than a stack of native prompts. */
async function clCreate() {
  await clEnsureTemplates();
  clState.selectedId = null;
  clRenderList();
  const d = document.getElementById('clDetail');
  if (d) d.innerHTML = clCreateFormHtml();
}

async function clSubmitCreate() {
  const nameEl = document.getElementById('clNewName');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) return showSettingsToast('Give the clone a name first', true);
  const templateId = (document.getElementById('clNewRole') || {}).value || '';

  const res = await fetchJSON('/api/clones', { method: 'POST', body: { name, templateId } });
  if (res && res.error) return showSettingsToast(res.error, true);
  clState.selectedId = res.clone.id;
  clState.tab = 'interview';
  await clFetchList();
  showSettingsToast('Created — the interview starts now');
}

async function clOpen(id) {
  clState.selectedId = id;
  clRenderList();
  const detail = await fetchJSON(`/api/clones/${id}`);
  if (!detail || detail.error) return showSettingsToast((detail && detail.error) || 'Could not load that clone', true);
  clState.detail = detail;
  if (clState.tab === 'drafts') await clFetchDrafts();
  if (clState.tab === 'direct') await clFetchDispatches();
  clRenderDetail();
}

function clTab(tab) {
  clState.tab = tab;
  clState.editing = false; // leaving the persona tab abandons an unsaved correction rather than
                           // silently resurrecting the form when the owner comes back to it
  if (tab === 'drafts') { clFetchDrafts().then(clRenderDetail); return; }
  if (tab === 'direct') { clFetchDispatches().then(clRenderDetail); return; }
  clRenderDetail();
}

async function clFetchDispatches() {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/dispatches`);
  clState.dispatch = (res && !res.error) ? res : { dispatches: [], agents: [], allowed: false, cap: null };
}

async function clFetchDrafts() {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/drafts`);
  clState.drafts = (res && res.drafts) || [];
}

function clRenderDetail() {
  const d = document.getElementById('clDetail');
  const c = clState.detail;
  if (!d || !c) return;

  const dims = c.progress && c.progress.byDimension ? c.progress.byDimension : {};
  const dimCards = Object.entries(dims).map(([name, v]) => `
    <div class="cl-dim">
      <div class="cl-dim-label">${escapeHtml(name.replace(/([A-Z])/g, ' $1'))}</div>
      <div class="cl-dim-score">${Number(v.score) || 0}%</div>
    </div>`).join('');

  const blockers = (c.blockers || []).length
    ? `<div class="cl-esc"><strong>Not ready to work yet.</strong><br>${(c.blockers || []).map(escapeHtml).join('<br>')}</div>`
    : '';

  const TAB_LABELS = { prompt: 'What it was told', evolve: 'What it learned', direct: 'Direct an agent' };
  const tabs = ['interview', 'persona', 'prompt', 'drafts', 'direct', 'evolve']
    .map((t) => `<span class="cl-tab ${clState.tab === t ? 'on' : ''}" onclick="clTab('${t}')">${TAB_LABELS[t] || capitalize(t)}</span>`)
    .join('');

  d.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
      <div>
        <h3 style="margin:0 0 4px;">${escapeHtml(c.name)}</h3>
        <div class="cl-muted">${Number(c.completeness) || 0}% known · persona v${Number(c.personaVersion) || 0} · ${Number(c.promptTokens) || 0} tokens per call · updated ${timeAgo(c.updatedAt)}</div>
      </div>
      <div style="display:flex;gap:6px;">
        ${c.usable && c.status !== 'active' ? `<button class="btn btn-primary" onclick="clSetStatus('active')">Put to work</button>` : ''}
        ${c.status === 'active' ? `<button class="btn" onclick="clSetStatus('paused')">Pause</button>` : ''}
        ${c.status === 'paused' ? `<button class="btn" onclick="clSetStatus('ready')">Resume</button>` : ''}
        <button class="btn" onclick="clDelete()">Delete</button>
      </div>
    </div>
    ${blockers}
    <div class="cl-dims">${dimCards}</div>
    <div class="cl-tabs">${tabs}</div>
    <div id="clTabBody"></div>`;

  const body = document.getElementById('clTabBody');
  if (clState.tab === 'interview') body.innerHTML = clInterviewHtml(c);
  else if (clState.tab === 'persona') body.innerHTML = clState.editing ? clPersonaFormHtml(c.persona || {}) : clPersonaHtml(c.persona || {});
  else if (clState.tab === 'prompt') { body.innerHTML = '<div class="cl-muted">Loading…</div>'; clLoadPrompt(); }
  else if (clState.tab === 'evolve') { body.innerHTML = '<div class="cl-muted">Loading…</div>'; clLoadEvolve(); }
  else if (clState.tab === 'direct') body.innerHTML = clDispatchHtml();
  else body.innerHTML = clDraftsHtml();
}

function clInterviewHtml(c) {
  const turns = (c.transcript || []).slice(-12);
  const lastQ = [...(c.transcript || [])].reverse().find((t) => t.role === 'interviewer');
  const answered = (c.transcript || []).length && (c.transcript || [])[(c.transcript || []).length - 1].role === 'owner';

  if (c.progress && c.progress.complete) {
    return `<div class="cl-esc" style="border-left-color:#22c55e;background:rgba(34,197,94,.08);">
      The interview has covered everything it needs. You can keep answering to sharpen it, or put the clone to work.</div>
      ${clTranscriptHtml(turns)}`;
  }

  return `
    ${lastQ && !answered ? `<div class="cl-q">${escapeHtml(lastQ.text)}</div>
      <textarea id="clAnswer" rows="5" style="width:100%;" placeholder="Answer in your own words. Quotes and examples are worth more than descriptions."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-primary" onclick="clSubmitAnswer()">Send answer</button>
        <button class="btn" onclick="clNextQuestion()">Skip this one</button>
      </div>`
      : `<div class="cl-muted" style="margin-bottom:10px;">Ready for the next question.</div>
      <button class="btn btn-primary" onclick="clNextQuestion()">Ask me something</button>`}
    ${clTranscriptHtml(turns)}`;
}

function clTranscriptHtml(turns) {
  if (!turns.length) return '';
  return `<h4 style="margin:18px 0 8px;">Conversation</h4>` + turns.map((t) => `
    <div class="cl-turn ${t.role === 'owner' ? 'owner' : 'interviewer'}">
      <div class="cl-muted" style="margin-bottom:3px;">${t.role === 'owner' ? 'You' : 'Interviewer'}</div>
      ${escapeHtml(t.text)}
    </div>`).join('');
}

/** Render the persona so the owner can audit what their clone believes about them. */
function clPersonaHtml(p) {
  const section = (title, rows) => {
    const real = rows.filter(Boolean);
    return real.length ? `<h4 style="margin:16px 0 6px;">${title}</h4>${real.join('')}` : '';
  };
  const line = (label, v) => (v || v === 0) ? `<div class="cl-detail-row" style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--border,#2a2a3a);font-size:13px;"><span class="cl-muted">${label}</span><span style="text-align:right;">${escapeHtml(v)}</span></div>` : '';
  const list = (label, arr) => (arr && arr.length) ? `<div style="padding:6px 0;"><div class="cl-muted">${label}</div><div>${arr.map((x) => `<span class="cl-tag" style="margin:3px 4px 0 0;display:inline-block;">${escapeHtml(typeof x === 'string' ? x : (x.claim || x.question || x.when || ''))}</span>`).join('')}</div></div>` : '';

  const i = p.identity || {}, v = p.voice || {}, e = p.expertise || {}, ds = p.decisionStyle || {}, b = p.boundaries || {};
  const scale = (n) => (n ? `${n} / 5` : '');

  const html = [
    section('Who they are', [line('Name', i.ownerName), line('Role', i.role), line('Business', i.businessName), line('Industry', i.industry), line('Years', i.yearsExperience), line('What the business does', i.whatTheyDo)]),
    section('How they sound', [line('Formality', scale(v.formality)), line('Directness', scale(v.directness)), line('Warmth', scale(v.warmth)), line('Humour', v.humor), line('Sign-off', v.signoff), list('Phrases they use', v.signaturePhrases), list('Never uses', v.avoidPhrases)]),
    section('What they know', [list('Expert in', e.domains), list('Methods', e.methodologies), list('Strong opinions', e.strongOpinions), list('Answers on file', e.faq)]),
    section('How they decide', [list('Protects, in order', ds.priorities), list('Trade-offs', ds.tradeoffRules), line('Risk posture', ds.riskPosture), list('Always escalates', ds.escalationTriggers)]),
    section('Limits', [list('Never says', b.neverSay), list('Never promises', b.neverPromise), list('Always yours to handle', b.requiresHuman), list('Confidential', b.confidentialTopics), line('Pricing', b.pricingDisclosure)]),
  ].filter(Boolean).join('');

  const edit = '<div style="margin:14px 0;"><button class="btn" onclick="clEditPersona()">Correct this</button> <span class="cl-muted">Fix anything your clone has wrong about you.</span></div>';
  return edit + (html || '<div class="cl-empty">Nothing learned yet — answer some interview questions, or correct it directly.</div>');
}

// --- persona correction form ------------------------------------------------

/** One line per entry, parts separated by " | ". Round-trips exactly; see CL_FIELDS. */
function clObjListToText(arr, parts) {
  return (arr || []).map((o) => parts.map((p) => String(o[p] || '')).join(' | ')).join('\n');
}
function clTextToObjList(text, parts) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const bits = line.split('|').map((b) => b.trim());
    const out = {};
    parts.forEach((p, i) => { out[p] = bits[i] || ''; });
    return out;
  });
}

function clFieldHtml(dim, f, value) {
  const id = `clF-${dim}-${f.k}`;
  const lbl = `<div class="cl-muted" style="margin:10px 0 3px;">${escapeHtml(f.label)}</div>`;
  if (f.type === 'select') {
    const opts = f.options.map(([v, t]) =>
      `<option value="${escapeHtml(v)}" ${String(value == null ? '' : value) === v ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    return `${lbl}<select id="${id}" style="width:100%;">${opts}</select>`;
  }
  if (f.type === 'textarea') return `${lbl}<textarea id="${id}" rows="3" style="width:100%;">${escapeHtml(value || '')}</textarea>`;
  if (f.type === 'list') return `${lbl}<textarea id="${id}" rows="3" style="width:100%;" placeholder="One per line">${escapeHtml((value || []).join('\n'))}</textarea>`;
  if (f.type === 'objlist') {
    return `${lbl}<div class="cl-muted" style="font-size:11px;margin-bottom:3px;">One per line: ${escapeHtml(f.parts.join(' | '))}</div>`
      + `<textarea id="${id}" rows="4" style="width:100%;">${escapeHtml(clObjListToText(value, f.parts))}</textarea>`;
  }
  const t = f.type === 'number' ? 'number' : 'text';
  return `${lbl}<input id="${id}" type="${t}" style="width:100%;" value="${escapeHtml(value == null ? '' : value)}">`;
}

function clPersonaFormHtml(p) {
  const sections = Object.entries(CL_FIELDS).map(([dim, fields]) => {
    const body = fields.map((f) => clFieldHtml(dim, f, (p[dim] || {})[f.k])).join('');
    return `<h4 style="margin:18px 0 4px;">${escapeHtml(CL_DIM_LABELS[dim])}</h4>${body}`;
  }).join('');

  return `<div class="cl-muted" style="margin-bottom:6px;">Saving replaces the whole persona, so anything you clear here is genuinely removed — that is the point: it is how you take back something your clone should never have learned. Values outside the allowed range are dropped rather than stored.</div>
    ${sections}
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="btn btn-primary" onclick="clSavePersona()">Save corrections</button>
      <button class="btn" onclick="clCancelPersona()">Cancel</button>
    </div>`;
}

function clEditPersona() { clState.editing = true; clRenderDetail(); }
function clCancelPersona() { clState.editing = false; clRenderDetail(); }

async function clSavePersona() {
  const val = (dim, k) => { const el = document.getElementById(`clF-${dim}-${k}`); return el ? el.value : ''; };
  const persona = {};
  for (const [dim, fields] of Object.entries(CL_FIELDS)) {
    persona[dim] = {};
    for (const f of fields) {
      const raw = val(dim, f.k);
      if (f.type === 'list') persona[dim][f.k] = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'objlist') persona[dim][f.k] = clTextToObjList(raw, f.parts);
      else if (f.type === 'number') persona[dim][f.k] = raw === '' ? null : Number(raw);
      else persona[dim][f.k] = raw;
    }
  }

  const res = await fetchJSON(`/api/clones/${clState.selectedId}/persona`, { method: 'PUT', body: { persona } });
  if (res && res.error) return showSettingsToast(res.error, true);

  clState.editing = false;
  await clOpen(clState.selectedId);
  await clFetchList();
  showSettingsToast(`Saved — persona v${res.personaVersion}, ${res.progress ? res.progress.overall : '?'}% known`);
}

async function clLoadPrompt() {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/prompt`);
  const body = document.getElementById('clTabBody');
  if (!body) return;
  if (!res || res.error || !res.prompt) { body.innerHTML = '<div class="cl-empty">Could not load the prompt.</div>'; return; }
  body.innerHTML = `<div class="cl-muted" style="margin-bottom:8px;">This is exactly what your clone is told before it writes anything. Fingerprint <code>${escapeHtml(res.fingerprint || '')}</code>.</div>
    <div class="cl-pre">${escapeHtml(res.prompt)}</div>`;
}

// "Left for you" was right when the owner was the only person here. With a responsibility map an
// escalation usually belongs to someone specific, and saying whose it is IS the routing.
function clEscalationLead(d) {
  const routes = (d.routedTo || []).filter((r) => r && r.handler && !r.unclaimed);
  if (d.routeUnclaimed || !routes.length) return 'Left for you.';
  const names = [...new Set(routes.map((r) => r.handler))];
  return escapeHtml(names.length === 1 ? `Left for ${names[0]}.` : `Left for ${names.join(' and ')}.`);
}

function clDraftsHtml() {
  const newBox = `
    <div style="border:1px solid var(--border,#2a2a3a);border-radius:10px;padding:12px;margin-bottom:14px;">
      <div class="cl-muted" style="margin-bottom:6px;">Paste a customer message and see what your clone would write. It drafts only — nothing is sent.</div>
      <textarea id="clInbound" rows="3" style="width:100%;" placeholder="Hi — do you install the chairs you sell?"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
        <select id="clChannel" style="max-width:160px;">
          <option value="email">Email reply</option>
          <option value="chat">Chat reply</option>
          <option value="comment">Public comment</option>
          <option value="internal">Internal note</option>
        </select>
        <button class="btn btn-primary" onclick="clNewDraft()">Draft it</button>
      </div>
    </div>`;

  if (!clState.drafts.length) return newBox + '<div class="cl-empty">No drafts yet.</div>';

  return newBox + clState.drafts.map((d) => {
    if (d.status === 'escalated') {
      return `<div class="cl-draft">
        <div class="cl-muted">${timeAgo(d.createdAt)} · ${escapeHtml(d.channel)}</div>
        <div style="margin:6px 0;"><em>${escapeHtml(d.inbound)}</em></div>
        <div class="cl-esc"><strong>${clEscalationLead(d)}</strong><br>${(d.escalationReasons || []).map(escapeHtml).join('<br>')}</div>
      </div>`;
    }
    const warn = d.blocked || (d.violations || []).length
      ? `<div class="cl-warn"><strong>${d.blocked ? 'This crosses a line you set.' : 'Worth a look.'}</strong><br>${(d.violations || []).map((v) => escapeHtml(`${v.kind}: "${v.phrase}"`)).join('<br>')}</div>` : '';
    const actions = d.status === 'pending'
      ? `<div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-primary" onclick="clReview('${escapeHtml(d.id)}','approved')">Good as is</button>
          <button class="btn" onclick="clReview('${escapeHtml(d.id)}','edited')">Save my edit</button>
          <button class="btn" onclick="clReview('${escapeHtml(d.id)}','rejected')">Reject</button>
        </div>`
      : `<div class="cl-muted" style="margin-top:8px;">You marked this <strong>${escapeHtml(d.status)}</strong> ${timeAgo(d.reviewedAt)}.</div>`;

    return `<div class="cl-draft">
      <div class="cl-muted">${timeAgo(d.createdAt)} · ${escapeHtml(d.channel)} · $${(Number(d.cost) || 0).toFixed(4)}</div>
      <div style="margin:6px 0;"><em>${escapeHtml(d.inbound)}</em></div>
      ${warn}
      <textarea id="clDraftText-${escapeHtml(d.id)}" rows="6" style="width:100%;" ${d.status === 'pending' ? '' : 'readonly'}>${escapeHtml(d.finalText || d.text)}</textarea>
      ${actions}
    </div>`;
  }).join('');
}

// --- directing an agent -----------------------------------------------------
// The clone commissions work; the agent does it and stays itself. Everything here is a request —
// the approval gate decides whether it runs now or waits for the owner, and the result comes back
// as text to read, never as something sent.
function clDispatchHtml() {
  const st = clState.dispatch || { dispatches: [], agents: [], allowed: false, cap: null };

  if (!st.allowed) {
    return `<div class="cl-esc"><strong>Not enabled for this account.</strong><br>Your clone can draft for you, but commissioning work from an agent is a separate permission. Ask the account owner to turn it on.</div>`;
  }

  const options = (st.agents || []).map((a) =>
    `<option value="${escapeHtml(a.name)}">${escapeHtml(a.label)} — ${escapeHtml(a.does)}</option>`).join('');
  const cap = st.cap ? `<span class="cl-muted">${st.cap.used} of ${st.cap.cap} today</span>` : '';

  const form = `
    <div style="border:1px solid var(--border,#2a2a3a);border-radius:10px;padding:12px;margin-bottom:14px;">
      <div class="cl-muted" style="margin-bottom:6px;">Ask an agent to do a piece of work for you. Your clone briefs it on who you are and what you will not claim — the agent does its own job. Results come back here for you to read.</div>
      <select id="clDispatchAgent" style="width:100%;margin-bottom:8px;">${options}</select>
      <textarea id="clDispatchTask" rows="3" style="width:100%;" placeholder="What do you want done?"></textarea>
      <textarea id="clDispatchContext" rows="2" style="width:100%;margin-top:6px;" placeholder="Anything to work from (optional) — pasted notes, a customer message, data"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
        <button class="btn btn-primary" onclick="clDispatch()">Commission it</button>
        ${cap}
      </div>
    </div>`;

  if (!st.dispatches.length) return form + '<div class="cl-empty">Nothing commissioned yet.</div>';

  return form + st.dispatches.map((d) => {
    const head = `<div class="cl-muted">${timeAgo(d.createdAt)} · ${escapeHtml(d.agent || 'unknown')}${d.cost ? ` · $${Number(d.cost).toFixed(4)}` : ''}</div>`;

    if (d.status === 'refused') {
      return `<div class="cl-draft">${head}
        <div style="margin:6px 0;"><em>${escapeHtml(d.task)}</em></div>
        <div class="cl-esc"><strong>${clEscalationLead(d)}</strong><br>${(d.refusalReasons || []).map(escapeHtml).join('<br>')}</div>
      </div>`;
    }
    if (d.status === 'pending') {
      return `<div class="cl-draft">${head}
        <div style="margin:6px 0;"><em>${escapeHtml(d.task)}</em></div>
        <div class="cl-warn"><strong>Waiting for your approval.</strong><br>${escapeHtml((d.gateDecision && d.gateDecision.reason) || 'Queued.')} Approve it in Approvals.</div>
      </div>`;
    }
    if (d.status === 'failed') {
      return `<div class="cl-draft">${head}
        <div style="margin:6px 0;"><em>${escapeHtml(d.task)}</em></div>
        <div class="cl-warn"><strong>It did not finish.</strong><br>${escapeHtml(d.error || 'no reason given')}</div>
      </div>`;
    }
    return `<div class="cl-draft">${head}
      <div style="margin:6px 0;"><em>${escapeHtml(d.task)}</em></div>
      <textarea rows="10" style="width:100%;" readonly>${escapeHtml(d.output || (d.status === 'running' ? 'Working…' : ''))}</textarea>
    </div>`;
  }).join('');
}

async function clDispatch() {
  const agent = (document.getElementById('clDispatchAgent') || {}).value || '';
  const task = ((document.getElementById('clDispatchTask') || {}).value || '').trim();
  const context = (document.getElementById('clDispatchContext') || {}).value || '';
  if (!task) return showSettingsToast('Say what you want done first', true);

  // fetchJSON stringifies `body` itself — passing a string here would send a JSON-encoded string
  // and the route would see no agent and no task.
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/dispatch`, {
    method: 'POST',
    body: { agent, task, context },
  });
  if (!res || res.error) return showSettingsToast((res && res.error) || 'Could not commission that', true);
  if (res.pending) showSettingsToast('Queued for your approval');
  else if (res.dispatch && res.dispatch.status === 'refused') showSettingsToast('Your clone refused this one');
  await clFetchDispatches();
  clRenderDetail();
}

// --- evolution --------------------------------------------------------------

async function clLoadEvolve() {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/proposals`);
  const body = document.getElementById('clTabBody');
  if (!body) return;
  if (!res || res.error) { body.innerHTML = '<div class="cl-empty">Could not load this.</div>'; return; }
  clState.proposals = res.proposals || [];
  clState.evidence = res.evidence || { count: 0, needed: 3, enough: false };
  body.innerHTML = clEvolveHtml();
}

function clChangeHtml(c) {
  const where = `${escapeHtml(c.dimension)} · ${escapeHtml(c.field)}`;
  if (c.kind === 'value') {
    return `<div class="cl-detail-row" style="display:block;padding:8px 0;border-bottom:1px dashed var(--border,#2a2a3a);">
      <div class="cl-muted" style="font-size:11px;">${where}</div>
      <div><span style="text-decoration:line-through;opacity:.6;">${escapeHtml(c.from || '(nothing)')}</span> → <strong>${escapeHtml(c.to || '(nothing)')}</strong></div>
    </div>`;
  }
  const add = (c.added || []).map((x) => `<span class="cl-tag" style="color:#22c55e;border-color:#22c55e;margin:3px 4px 0 0;display:inline-block;">+ ${escapeHtml(x)}</span>`).join('');
  const rem = (c.removed || []).map((x) => `<span class="cl-tag" style="color:#ef4444;border-color:#ef4444;margin:3px 4px 0 0;display:inline-block;">− ${escapeHtml(x)}</span>`).join('');
  return `<div class="cl-detail-row" style="display:block;padding:8px 0;border-bottom:1px dashed var(--border,#2a2a3a);">
    <div class="cl-muted" style="font-size:11px;">${where}</div><div>${add}${rem}</div></div>`;
}

function clEvolveHtml() {
  const ev = clState.evidence || {};
  const pending = (clState.proposals || []).find((p) => p.status === 'pending');
  const decided = (clState.proposals || []).filter((p) => p.status !== 'pending');

  const intro = `<div class="cl-muted" style="margin-bottom:10px;">When you edit a draft, the gap between what your clone wrote and what you actually sent shows where it has you wrong. It reads those edits and proposes changes — it never changes itself.</div>`;

  const evidenceLine = `<div class="cl-muted" style="margin-bottom:12px;">${Number(ev.count) || 0} reviewed draft${ev.count === 1 ? '' : 's'} since the last change${ev.enough ? '' : ` · ${ev.needed} needed`}</div>`;

  const action = pending ? '' : (ev.enough
    ? `<button class="btn btn-primary" onclick="clRunEvolve()">Analyse my edits</button>`
    : `<button class="btn" disabled title="Edit or reject a few more drafts first">Analyse my edits</button>`);

  const pendingHtml = pending ? `
    <div class="cl-draft" style="border-color:var(--brand,#4f46e5);">
      <div class="cl-muted">${timeAgo(pending.createdAt)} · from ${pending.evidenceCount} of your edits</div>
      <p style="margin:8px 0;">${escapeHtml(pending.rationale || '')}</p>
      <h4 style="margin:12px 0 4px;">What would change</h4>
      ${(pending.changes || []).map(clChangeHtml).join('')}
      ${(pending.refused || []).length ? `<div class="cl-warn"><strong>Declined automatically:</strong><br>${pending.refused.map((r) => escapeHtml(`${r.field}: ${r.reason}`)).join('<br>')}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary" onclick="clDecide('${escapeHtml(pending.id)}','accept')">Apply these</button>
        <button class="btn" onclick="clDecide('${escapeHtml(pending.id)}','reject')">Discard</button>
      </div>
    </div>` : '';

  const history = decided.length ? `<h4 style="margin:18px 0 6px;">Earlier</h4>` + decided.map((p) => `
    <div class="cl-draft">
      <div class="cl-muted">${timeAgo(p.decidedAt || p.createdAt)} · <strong>${escapeHtml(p.status)}</strong> · ${(p.changes || []).length} change${(p.changes || []).length === 1 ? '' : 's'}</div>
      <div style="margin-top:4px;">${escapeHtml(p.rationale || '')}</div>
    </div>`).join('') : '';

  return intro + evidenceLine + action + pendingHtml + history;
}

async function clRunEvolve() {
  if (clState.busy) return;
  clState.busy = true;
  showSettingsToast('Reading your edits…');
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/evolve`, { method: 'POST', body: {} });
  clState.busy = false;
  if (res && res.error) return showSettingsToast(res.error, true);
  if (res && res.noChanges) {
    showSettingsToast('Nothing clear enough to propose yet');
    await clLoadEvolve();
    // The rationale explains WHY nothing was proposed, which is more useful than an empty panel.
    const body = document.getElementById('clTabBody');
    if (body && res.rationale) body.insertAdjacentHTML('afterbegin', `<div class="cl-esc">${escapeHtml(res.rationale)}</div>`);
    return;
  }
  await clLoadEvolve();
}

async function clDecide(pid, decision) {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/proposals/${pid}/decide`, { method: 'POST', body: { decision } });
  if (res && res.error) {
    showSettingsToast(res.error, true);
    // The server may have DECIDED the proposal even while refusing the request — a stale one is
    // discarded on the spot. Refresh either way, so the panel never keeps offering an Apply button
    // for something that no longer exists to apply.
    await clLoadEvolve();
    return;
  }
  await clOpen(clState.selectedId);
  await clFetchList();
  clState.tab = 'evolve';
  await clLoadEvolve();
  showSettingsToast(decision === 'accept' ? 'Applied — your clone updated' : 'Discarded');
}

// --- actions ---------------------------------------------------------------

async function clNextQuestion() {
  if (clState.busy) return;
  clState.busy = true;
  showSettingsToast('Thinking of a question…');
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/interview/next`, { method: 'POST', body: {} });
  clState.busy = false;
  if (res && res.error) return showSettingsToast(res.error, true);
  await clOpen(clState.selectedId);
}

async function clSubmitAnswer() {
  const el = document.getElementById('clAnswer');
  const answer = el ? el.value.trim() : '';
  if (!answer) return showSettingsToast('Write an answer first', true);
  if (clState.busy) return;
  clState.busy = true;
  showSettingsToast('Listening…');
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/interview/answer`, { method: 'POST', body: { answer } });
  clState.busy = false;
  if (res && res.error) return showSettingsToast(res.error, true);
  if (res && res.extracted === false) showSettingsToast('Recorded, but nothing concrete could be pulled from that answer', true);
  await clOpen(clState.selectedId);
  await clFetchList();
  clNextQuestion();
}

async function clSetStatus(status) {
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/status`, { method: 'POST', body: { status } });
  if (res && res.error) return showSettingsToast(res.error, true);
  await clFetchList();
  await clOpen(clState.selectedId);
}

async function clDelete() {
  if (!confirm('Delete this clone? Everything it learned about the owner goes with it.')) return;
  const res = await fetchJSON(`/api/clones/${clState.selectedId}`, { method: 'DELETE' });
  if (res && res.error) return showSettingsToast(res.error, true);
  clState.selectedId = null;
  clState.detail = null;
  await clFetchList();
  clRenderEmptyDetail();
}

async function clNewDraft() {
  const el = document.getElementById('clInbound');
  const inbound = el ? el.value.trim() : '';
  if (!inbound) return showSettingsToast('Paste a customer message first', true);
  const channel = (document.getElementById('clChannel') || {}).value || 'email';
  if (clState.busy) return;
  clState.busy = true;
  showSettingsToast('Drafting…');
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/drafts`, { method: 'POST', body: { inbound, channel } });
  clState.busy = false;
  if (res && res.error) return showSettingsToast(res.error, true);
  await clFetchDrafts();
  clRenderDetail();
}

async function clReview(draftId, verdict) {
  const box = document.getElementById(`clDraftText-${draftId}`);
  const finalText = box ? box.value : '';
  const body = { verdict };
  if (verdict === 'edited') {
    if (!finalText.trim()) return showSettingsToast('Edit the text first, then save it', true);
    body.finalText = finalText;
  }
  const res = await fetchJSON(`/api/clones/${clState.selectedId}/drafts/${draftId}/review`, { method: 'POST', body });
  if (res && res.error) return showSettingsToast(res.error, true);
  await clFetchDrafts();
  clRenderDetail();
  showSettingsToast(verdict === 'edited' ? 'Saved — your edit is what it learns from' : 'Recorded');
}
