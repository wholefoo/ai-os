const API = '';
let ws = null;

// --- State ---
const state = {
  health: {},
  agents: [],
  skills: [],
  workflows: [],
  activity: [],
  inbox: [],
  timeline: [],
  fleetStatus: {},
  radarReport: null,
  proposals: [],
  vaultStats: null,
  costSummary: null,
};

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupWebSocket();
  setupModal();
  setupChat();
  setupInboxFilters();
  loadDashboard();
  // Seed demo inbox items and fleet status
  seedInbox();
  seedFleetStatus();
  seedTimeline();
  setupRadar();
});

// --- Navigation ---
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      switchView(view);
    });
  });
}

function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-view="${view}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.getElementById('pageTitle').textContent = capitalize(view);

  const loaders = {
    dashboard: loadDashboard,
    agents: loadAgents,
    skills: loadSkills,
    workflows: loadWorkflows,
    mission: loadMission,
    inbox: loadInbox,
    timeline: loadTimeline,
    schedules: loadSchedules,
    radar: loadRadar,
    vault: loadVault,
    costs: loadCosts,
    pipelines: loadPipelines,
    identity: loadIdentity,
    verify: loadVerification,
    contexts: loadContexts,
    browser: loadBrowser,
    grok: loadGrok,
    knowledge: loadKnowledge,
    design: loadDesignSystem,
    media: loadMedia,
    routines: loadRoutines,
    products: loadProducts,
    leads: loadLeads,
    marketing: loadMarketing,
    'golden-loop': loadGoldenLoop,
    'vibe-design': loadVibeDesign,
    '3d-studio': load3DStudio,
    predictions: loadPredictions,
    batch: loadBatch,
    hermes: loadHermes,
    youtube: loadYouTube,
    hq: loadHQ,
    'seo-agency': loadSeoAgency,
    licensing: loadLicensing,
    tenants: loadTenants,
    training: loadTraining,
    plugins: loadPlugins,
    reports: loadReports,
    meetings: loadMeetings,
    monitoring: loadMonitoring,
    'avatar-chat': loadAvatarChat,
    platform: loadPlatform,
    settings: loadSettings,
    automations: loadAutomations,
    social: loadSocial,
    artifacts: loadArtifacts,
    logs: loadLogs,
  };
  if (loaders[view]) loaders[view]();
}

// --- WebSocket with auto-reconnect & backoff ---
let wsReconnectAttempts = 0;
const WS_MAX_BACKOFF = 30000; // 30s max

function setupWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.event === 'server_shutdown') {
      showReconnectBanner('Server restarting...');
      return;
    }
    handleWsMessage(msg);
  };

  ws.onclose = () => {
    document.querySelector('.status-dot').classList.remove('online');
    wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, wsReconnectAttempts), WS_MAX_BACKOFF);
    showReconnectBanner(`Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${wsReconnectAttempts})`);
    setTimeout(setupWebSocket, delay);
  };

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    document.querySelector('.status-dot').classList.add('online');
    hideReconnectBanner();
  };

  ws.onerror = () => { /* onclose will fire */ };
}

function showReconnectBanner(text) {
  let banner = document.getElementById('wsReconnectBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'wsReconnectBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f59e0b;color:#000;text-align:center;padding:8px;font-size:13px;font-weight:600;transition:transform 0.3s;';
    document.body.prepend(banner);
  }
  banner.textContent = text;
  banner.style.transform = 'translateY(0)';
}

function hideReconnectBanner() {
  const banner = document.getElementById('wsReconnectBanner');
  if (banner) {
    banner.style.transform = 'translateY(-100%)';
    setTimeout(() => banner.remove(), 400);
  }
}

function handleWsMessage(msg) {
  switch (msg.event) {
    case 'connected':
      state.health = msg.data.health;
      updateStats();
      break;
    case 'activity':
      state.activity.unshift(msg.data);
      addTimelineEvent('skill', msg.data.message, msg.data.timestamp);
      renderActivityFeed();
      break;
    case 'workflow_update':
      updateWorkflow(msg.data);
      // Also refresh skills view execution progress
      if (document.getElementById('view-skills').classList.contains('active')) {
        renderSkillsExecutions();
      }
      break;
    case 'skill_progress':
      // Update in-progress skill execution display
      if (document.getElementById('view-skills').classList.contains('active')) {
        const wf = state.workflows.find(w => w.id === msg.data.id);
        if (wf) {
          wf.progress = msg.data.progress;
          renderSkillsExecutions();
        }
      }
      break;
    case 'fleet_update':
      if (state.fleetStatus[msg.data.agent] !== undefined) {
        state.fleetStatus[msg.data.agent] = msg.data.status;
        renderFleetGrid();
      }
      break;
    case 'schedule_update':
      if (document.getElementById('view-schedules').classList.contains('active')) {
        loadSchedules();
      }
      break;
    case 'cost_update':
      if (document.getElementById('view-costs').classList.contains('active')) {
        loadCosts();
      }
      break;
    case 'pipeline_update':
      if (document.getElementById('view-pipelines').classList.contains('active')) {
        loadPipelineRuns();
      }
      break;
    case 'notification':
      addTimelineEvent('notification', msg.data.title, msg.data.timestamp, msg.data.message);
      break;
    case 'automation_update':
      if (document.getElementById('view-automations').classList.contains('active')) {
        loadAutomations();
      }
      break;
    case 'verification_update':
      if (document.getElementById('view-verify').classList.contains('active')) {
        loadVerification();
      }
      addTimelineEvent('verification', `Verification ${msg.data.status}: ${msg.data.skillName}${msg.data.verdict ? ' (' + msg.data.verdict + ')' : ''}`, msg.data.completedAt || msg.data.startedAt);
      break;
    case 'grok_stream_start':
      if (document.getElementById('view-grok').classList.contains('active')) {
        const output = document.getElementById('grokStreamOutput');
        if (output) {
          output.classList.add('streaming');
          output.innerHTML = `<span class="grok-stream-cursor"></span>`;
        }
      }
      state.fleetStatus['grok-realtime'] = 'running';
      renderFleetGrid();
      break;
    case 'grok_stream_chunk':
      if (document.getElementById('view-grok').classList.contains('active')) {
        const streamOut = document.getElementById('grokStreamOutput');
        if (streamOut) {
          streamOut.innerHTML = escapeHtml(msg.data.partial) + `<span class="grok-stream-cursor"></span>`;
          streamOut.scrollTop = streamOut.scrollHeight;
        }
      }
      break;
    case 'grok_stream_end':
      if (document.getElementById('view-grok').classList.contains('active')) {
        renderGrokStreamResult(msg.data);
        loadGrokHistory();
        loadGrokStats();
      }
      state.fleetStatus['grok-realtime'] = 'idle';
      renderFleetGrid();
      addTimelineEvent('grok', `Grok query completed: ${msg.data.type} (${Math.round(msg.data.confidence * 100)}% confidence)`, msg.data.completedAt);
      break;
    case 'context_switch':
      if (document.getElementById('view-contexts').classList.contains('active')) {
        loadContexts();
      }
      addTimelineEvent('context', `Context switched to: ${msg.data.project}`, msg.data.timestamp);
      break;
    case 'browser_update':
      if (document.getElementById('view-browser').classList.contains('active')) {
        loadBrowser();
      }
      addTimelineEvent('browser', `Browser task ${msg.data.status}: ${msg.data.taskType} — ${msg.data.url}`, msg.data.timestamp);
      break;
    case 'social_update':
      if (document.getElementById('view-social').classList.contains('active')) {
        loadSocial();
      }
      break;
    case 'knowledge_update':
      if (document.getElementById('view-knowledge').classList.contains('active')) {
        loadKnowledge();
      }
      break;
    case 'design_update':
      if (document.getElementById('view-design').classList.contains('active')) {
        loadDesignSystem();
      }
      break;
    case 'media_update':
      if (document.getElementById('view-media').classList.contains('active')) {
        loadMedia();
      }
      break;
    case 'routine_update':
      if (document.getElementById('view-routines').classList.contains('active')) {
        loadRoutines();
      }
      break;
    case 'product_update':
      if (document.getElementById('view-products').classList.contains('active')) {
        loadProducts();
      }
      break;
    case 'lead_update':
      if (document.getElementById('view-leads').classList.contains('active')) {
        loadLeads();
      }
      break;
    case 'marketing_update':
      if (document.getElementById('view-marketing').classList.contains('active')) {
        loadMarketing();
      }
      break;
    case 'golden_loop_update':
      if (document.getElementById('view-golden-loop').classList.contains('active')) {
        loadGoldenLoop();
      }
      break;
    case 'vibe_design_update':
      if (document.getElementById('view-vibe-design').classList.contains('active')) {
        loadVibeDesign();
      }
      break;
    case '3d_update':
      if (document.getElementById('view-3d-studio').classList.contains('active')) {
        load3DStudio();
      }
      break;
    case 'batch_update':
      if (document.getElementById('view-batch').classList.contains('active')) {
        loadBatch();
      }
      break;
    case 'proposal_update':
      const pIdx = state.proposals.findIndex(p => p.id === msg.data.id);
      if (pIdx >= 0) state.proposals[pIdx] = msg.data;
      if (document.getElementById('view-radar').classList.contains('active')) {
        renderProposals();
        renderRadarStats();
      }
      updateRadarBadge();
      break;
  }
}

// --- Dashboard ---
async function loadDashboard() {
  const [health, skills, activity] = await Promise.all([
    fetchJSON('/api/health'),
    fetchJSON('/api/skills'),
    fetchJSON('/api/activity?limit=20'),
  ]);

  state.health = health;
  state.skills = skills;
  state.activity = activity;

  updateStats();
  renderQuickActions();
  renderActivityFeed();
  renderFleetGrid();
  renderContextHealth();
  renderTeamGrid();
}

function updateStats() {
  const h = state.health;
  document.getElementById('statAgents').textContent = h.agents || 0;
  document.getElementById('statSkills').textContent = h.skills || 0;
  document.getElementById('statWorkflows').textContent = state.workflows.length;
  document.getElementById('statMission').textContent = h.missionActive ? 'Active' : 'None';

  if (h.uptime) {
    const mins = Math.floor(h.uptime / 60);
    const hrs = Math.floor(mins / 60);
    document.getElementById('uptime').textContent = `Uptime: ${hrs}h ${mins % 60}m`;
  }

  // Update inbox badge
  const pending = state.inbox.filter(i => i.status === 'pending').length;
  const badge = document.getElementById('inboxBadge');
  if (pending > 0) {
    badge.textContent = pending;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

function renderQuickActions() {
  const container = document.getElementById('quickActions');
  const actions = state.skills.map(s => ({
    name: s.meta?.name || s.filename.replace('.md', ''),
    icon: getSkillIcon(s.meta?.category),
    filename: s.filename,
    category: s.meta?.category || 'general',
    time: s.meta?.estimated_time || '~10min',
    paramCount: (s.parameters || []).length,
  }));

  container.innerHTML = actions.map(a => `
    <button class="action-btn" onclick="executeSkill('${a.filename}')" title="${a.time} · ${a.paramCount} params">
      <span class="action-icon">${a.icon}</span>
      <span>${capitalize(a.name.replace(/-/g, ' '))}</span>
    </button>
  `).join('') || '<div class="empty-state">No skills configured</div>';
}

function renderActivityFeed() {
  const container = document.getElementById('activityFeed');
  container.innerHTML = state.activity.slice(0, 15).map(a => `
    <div class="activity-item">
      <span class="activity-dot ${a.type}"></span>
      <div>
        <div class="activity-text">${escapeHtml(a.message)}</div>
        <div class="activity-time">${timeAgo(a.timestamp)}</div>
      </div>
    </div>
  `).join('') || '<div class="empty-state">No activity yet</div>';
}

async function renderTeamGrid() {
  const team = await fetchJSON('/api/team');
  const container = document.getElementById('teamGrid');
  if (!team.exists || !team.team?.roles) {
    container.innerHTML = '<div class="empty-state">No team configured</div>';
    return;
  }
  container.innerHTML = team.team.roles.map(r => `
    <div class="team-card">
      <div class="team-card-header">
        <span class="team-card-name">${r.name}</span>
        <span class="team-card-model">${r.model}</span>
      </div>
      <div class="team-card-desc">${escapeHtml(r.description)}</div>
    </div>
  `).join('');
}

// --- Agent Fleet Status ---
function seedFleetStatus() {
  state.fleetStatus = {
    orchestrator: 'idle', researcher: 'idle', architect: 'idle',
    coder: 'idle', reviewer: 'idle', qa: 'idle',
    writer: 'idle', 'data-wrangler': 'idle', factory: 'idle', safety: 'idle',
    scout: 'idle', 'research-architect': 'idle', synthesis: 'idle',
    'report-compiler': 'idle', 'security-auditor': 'idle', 'deepseek-worker': 'idle',
    automator: 'idle', 'social-intel': 'idle', 'browser-agent': 'idle', 'grok-realtime': 'idle',
    'knowledge-graph': 'idle', 'design-system': 'idle', 'media-producer': 'idle', 'routine-runner': 'idle',
    'product-factory': 'idle', 'lead-gen': 'idle', 'marketing-hub': 'idle', 'golden-loop': 'idle',
    'vibe-designer': 'idle', 'blender-3d': 'idle', 'predictor': 'idle', 'batch-runner': 'idle',
  };
}

function renderFleetGrid() {
  const container = document.getElementById('fleetGrid');
  if (!container) return;
  container.innerHTML = Object.entries(state.fleetStatus).map(([name, status]) => `
    <div class="fleet-agent">
      <span class="fleet-dot ${status}"></span>
      <span>${name}</span>
    </div>
  `).join('');
}

// --- Context Health ---
function renderContextHealth() {
  const container = document.getElementById('contextHealth');
  if (!container) return;

  const tokenUsed = 24800;
  const tokenMax = 200000;
  const tokenPct = Math.round((tokenUsed / tokenMax) * 100);
  const toolOverhead = 16800;
  const mcpPct = Math.round((toolOverhead / tokenMax) * 100);
  const artifactCount = 3;
  const staleCount = 0;

  container.innerHTML = `
    <div class="health-metric">
      <div class="health-metric-header">
        <span class="health-metric-label">Context Window</span>
        <span class="health-metric-value">${(tokenUsed/1000).toFixed(1)}K / ${(tokenMax/1000).toFixed(0)}K tokens</span>
      </div>
      <div class="health-bar">
        <div class="health-bar-fill ${tokenPct < 60 ? 'good' : tokenPct < 85 ? 'warn' : 'critical'}" style="width: ${tokenPct}%"></div>
      </div>
    </div>
    <div class="health-metric">
      <div class="health-metric-header">
        <span class="health-metric-label">Tool Overhead</span>
        <span class="health-metric-value">${(toolOverhead/1000).toFixed(1)}K tokens (${mcpPct}%)</span>
      </div>
      <div class="health-bar">
        <div class="health-bar-fill ${mcpPct < 10 ? 'good' : mcpPct < 20 ? 'warn' : 'critical'}" style="width: ${mcpPct}%"></div>
      </div>
    </div>
    <div class="health-metric">
      <div class="health-metric-header">
        <span class="health-metric-label">Artifacts</span>
        <span class="health-metric-value">${artifactCount} active, ${staleCount} stale</span>
      </div>
      <div class="health-bar">
        <div class="health-bar-fill good" style="width: 100%"></div>
      </div>
    </div>
    <div class="health-note">
      Context is healthy. No compaction needed. MCP tool descriptions within budget.
    </div>
  `;
}

// --- Human-in-the-Loop Inbox ---
function seedInbox() {
  state.inbox = [
    {
      id: 'gate-1',
      title: 'Deploy research-brief output to production docs',
      agent: 'orchestrator',
      gate: 'blocking',
      status: 'pending',
      context: 'The research brief for "AI OS Market Landscape" is ready to be published to the shared documentation repository. This is an irreversible external action.',
      timestamp: new Date(Date.now() - 300000).toISOString(),
    },
    {
      id: 'gate-2',
      title: 'Send enriched leads CSV via email',
      agent: 'data-wrangler',
      gate: 'blocking',
      status: 'pending',
      context: 'Lead enrichment completed for 47 contacts. The data-wrangler wants to email the CSV to the sales team distribution list. This sends data externally.',
      timestamp: new Date(Date.now() - 600000).toISOString(),
    },
    {
      id: 'gate-3',
      title: 'Reviewer flagged potential license issue in coder output',
      agent: 'reviewer',
      gate: 'advisory',
      status: 'pending',
      context: 'The reviewer found a code snippet that may be derived from an AGPL-licensed library. Recommendation: verify licensing compatibility before merging.',
      timestamp: new Date(Date.now() - 900000).toISOString(),
    },
  ];
  updateStats();
}

function setupInboxFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadInbox(btn.dataset.filter);
    });
  });
}

function loadInbox(filter = 'all') {
  const container = document.getElementById('inboxList');
  let items = state.inbox;
  if (filter !== 'all') items = items.filter(i => i.gate === filter);

  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No pending approvals. All clear.</div>';
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="inbox-item ${item.gate}">
      <div class="inbox-item-header">
        <span class="inbox-item-title">${escapeHtml(item.title)}</span>
        <span class="inbox-item-gate ${item.gate}">${item.gate}</span>
      </div>
      <div class="inbox-item-body">${escapeHtml(item.context)}</div>
      <div class="inbox-item-meta">
        <span>Agent: <strong>${item.agent}</strong></span>
        <span>${timeAgo(item.timestamp)}</span>
        <span>Status: ${item.status}</span>
      </div>
      ${item.status === 'pending' ? `
        <div class="inbox-actions">
          <button class="btn btn-sm btn-success" onclick="resolveInbox('${item.id}', 'approved')">Approve</button>
          <button class="btn btn-sm btn-secondary" onclick="resolveInbox('${item.id}', 'rejected')">Reject</button>
        </div>
      ` : `<div style="font-size:12px;color:var(--text-muted);">Resolved: ${item.status}</div>`}
    </div>
  `).join('');
}

function resolveInbox(id, verdict) {
  const item = state.inbox.find(i => i.id === id);
  if (item) {
    item.status = verdict;
    addTimelineEvent('approval', `${verdict === 'approved' ? 'Approved' : 'Rejected'}: ${item.title}`);
    state.activity.unshift({
      id: Date.now().toString(),
      type: verdict === 'approved' ? 'mission' : 'plan',
      message: `Gate ${verdict}: ${item.title}`,
      timestamp: new Date().toISOString(),
    });
    renderActivityFeed();
    // Update fleet status to show agent proceeding
    if (verdict === 'approved' && state.fleetStatus[item.agent] !== undefined) {
      state.fleetStatus[item.agent] = 'running';
      renderFleetGrid();
      setTimeout(() => {
        state.fleetStatus[item.agent] = 'idle';
        renderFleetGrid();
      }, 4000);
    }
  }
  updateStats();
  loadInbox(document.querySelector('.filter-btn.active')?.dataset?.filter || 'all');
}

// --- Timeline ---
function seedTimeline() {
  state.timeline = [
    { type: 'system', title: 'AI OS initialized', detail: '10 agents, 6 skills, mission active', timestamp: new Date(Date.now() - 1800000).toISOString() },
    { type: 'skill', title: 'Research Brief executed', detail: 'Topic: AI OS Market Landscape', timestamp: new Date(Date.now() - 1200000).toISOString() },
    { type: 'agent', title: 'Researcher assigned', detail: 'Gathering sources from web search', timestamp: new Date(Date.now() - 1100000).toISOString() },
    { type: 'agent', title: 'Writer compiled report', detail: 'Output: brief-ai-os-market.md', timestamp: new Date(Date.now() - 800000).toISOString() },
    { type: 'approval', title: 'Reviewer approved output', detail: 'All claims cited, no issues found', timestamp: new Date(Date.now() - 600000).toISOString() },
    { type: 'skill', title: 'Content Creation queued', detail: 'Blog post on dashboard accessibility', timestamp: new Date(Date.now() - 300000).toISOString() },
  ];
}

function addTimelineEvent(type, title, timestamp, detail = '') {
  state.timeline.unshift({
    type, title, detail,
    timestamp: timestamp || new Date().toISOString(),
  });
  if (document.getElementById('view-timeline').classList.contains('active')) {
    loadTimeline();
  }
}

function loadTimeline() {
  const container = document.getElementById('timelineContainer');
  if (!state.timeline.length) {
    container.innerHTML = '<div class="empty-state">No events yet.</div>';
    return;
  }
  container.innerHTML = state.timeline.map(ev => `
    <div class="timeline-event">
      <span class="timeline-dot ${ev.type}"></span>
      <div class="timeline-event-card">
        <div class="timeline-event-header">
          <span class="timeline-event-title">${escapeHtml(ev.title)}</span>
          <span class="timeline-event-time">${timeAgo(ev.timestamp)}</span>
        </div>
        ${ev.detail ? `<div class="timeline-event-detail">${escapeHtml(ev.detail)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// --- Command Chat ---
function setupChat() {
  const panel = document.getElementById('chatPanel');
  const header = document.getElementById('chatPanel').querySelector('.chat-header');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');

  header.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  sendBtn.addEventListener('click', () => sendChatMessage());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  appendChatMsg('user', text);
  input.value = '';

  // Simulate orchestrator response
  setTimeout(() => {
    const response = processCommand(text);
    appendChatMsg('orchestrator', response);
  }, 600);
}

function appendChatMsg(role, text) {
  const container = document.getElementById('chatMessages');
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = `<span class="chat-msg-text">${escapeHtml(text)}</span>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function processCommand(text) {
  const lower = text.toLowerCase();

  if (lower.includes('status') || lower.includes('health')) {
    return `System healthy. ${state.health.agents} agents idle, ${state.health.skills} skills available. ${state.inbox.filter(i=>i.status==='pending').length} items awaiting approval. Context at 12% capacity.`;
  }
  if (lower.includes('run ') || lower.includes('execute ') || lower.includes('launch ')) {
    const skillMatch = state.skills.find(s => lower.includes(s.meta?.name?.toLowerCase() || ''));
    if (skillMatch) {
      return `Queuing "${skillMatch.meta.name}" for execution. Check the Workflows view for progress. Shall I configure any parameters first?`;
    }
    return `I couldn't match a skill to that. Available skills: ${state.skills.map(s => s.meta?.name).join(', ')}. Which would you like to run?`;
  }
  if (lower.includes('team') || lower.includes('agents')) {
    const running = Object.entries(state.fleetStatus).filter(([,s]) => s === 'running').map(([n]) => n);
    return running.length
      ? `${running.length} agent(s) currently active: ${running.join(', ')}. All others idle and ready.`
      : `All agents are idle and ready for tasking. The team has ${Object.keys(state.fleetStatus).length} members.`;
  }
  if (lower.includes('inbox') || lower.includes('approval') || lower.includes('pending')) {
    const pending = state.inbox.filter(i => i.status === 'pending');
    return pending.length
      ? `${pending.length} items need your attention: ${pending.map(i => `"${i.title}" (${i.gate})`).join('; ')}.`
      : `No pending approvals. All gates are clear.`;
  }
  if (lower.includes('radar') || lower.includes('sweep') || lower.includes('intelligence') || lower.includes('updates')) {
    const pending = state.proposals.filter(p => p.status === 'pending');
    if (pending.length > 0) {
      return `Tech Radar has ${pending.length} pending update proposal(s): ${pending.map(p => `"${p.title}" (${p.impact})`).join('; ')}. Switch to the Tech Radar view to review and approve.`;
    }
    return `Tech Radar is current — no pending proposals. I can run a fresh sweep if you'd like. Just say "run sweep" or click the button in the Tech Radar view.`;
  }
  if (lower.includes('cost') || lower.includes('spend') || lower.includes('budget') || lower.includes('token')) {
    if (state.costSummary) {
      const d = state.costSummary.daily;
      const pct = Math.round((d.cost / d.budget) * 100);
      return `Today's spend: $${d.cost.toFixed(2)} of $${d.budget} budget (${pct}%). ${d.count} API calls using ${(d.tokens/1000).toFixed(0)}K tokens. Switch to Cost Tracker for full breakdown.`;
    }
    return `Cost tracking is active. Switch to the Cost Tracker view for detailed spend analysis.`;
  }
  if (lower.includes('vault') || lower.includes('memory') || lower.includes('knowledge')) {
    return `Memory Vault is online with 3 folders: raw (intake), wiki (synthesized knowledge), outputs (deliverables). Session context hooks auto-load the most relevant files at session start. Switch to Memory Vault to explore.`;
  }
  if (lower.includes('pipeline') || lower.includes('chain') || lower.includes('workflow')) {
    return `3 pipelines available: research-to-report (5 stages), content-pipeline (4 stages), security-sweep (4 stages). Switch to the Pipelines view to launch one, or say "run research pipeline".`;
  }
  if (lower.includes('identity') || lower.includes('soul') || lower.includes('personality') || lower.includes('persona')) {
    return `Identity layer active with 3 files: soul.md (immutable guardrails), user.md (your preferences), personality.md (agent personas). Switch to the Identity view to review.`;
  }
  if (lower.includes('notification') || lower.includes('alert') || lower.includes('telegram') || lower.includes('slack')) {
    return `Notification system active. Dashboard notifications are always on. Telegram and Slack webhooks can be configured via the API. Escalation timeout: 1 hour before auto-safe-park.`;
  }
  if (lower.includes('verify') || lower.includes('verification') || lower.includes('rubric') || lower.includes('quality')) {
    return `Verification Protocols active with rubrics for 6 categories: default, research, marketing, security, sales, and design. Each output is scored against weighted criteria (0-100). PASS >= 80, REVIEW 60-79, FAIL < 60. Switch to the Verification view to run checks or review results.`;
  }
  if (lower.includes('context') || lower.includes('project') && (lower.includes('switch') || lower.includes('active'))) {
    return `Project Context system active. Contexts define per-project rules, tone, audience, and domain terms that override global identity. Switch to the Contexts view to manage projects or preview resolved context.`;
  }
  if (lower.includes('grok') || lower.includes('real-time') || lower.includes('realtime') || lower.includes('xai') || lower.includes('live search')) {
    return `Grok Real-Time Intelligence is active. Use it for live web search, trending topics on X, fact-checking, and real-time monitoring. Rate limit: 30 queries/hour. Switch to the Grok Live view or ask me to "grok [your question]" to query directly.`;
  }
  if (lower.includes('browser') || lower.includes('playwright') || lower.includes('screenshot') || lower.includes('scrape')) {
    return `Browser Agent (Playwright) is available for web tasks: navigate, extract, screenshot, form-fill, and verify. Switch to the Browser view to launch a task or review history.`;
  }
  if (lower.includes('knowledge') || lower.includes('graph') || lower.includes('notebooklm') || lower.includes('categorize')) {
    return `Knowledge Graph is active. Auto-organizes sources (docs, links, PDFs, videos) into intelligent categories with cross-references. Switch to the Knowledge Graph view to explore connections or auto-categorize new sources.`;
  }
  if (lower.includes('design system') || lower.includes('design.md') || lower.includes('tokens') || lower.includes('linter') || lower.includes('wcag')) {
    return `Design System Protocol active. DESIGN.md defines universal tokens (colors, typography, spacing) with a built-in linter for WCAG accessibility audits. Switch to the Design System view to inspect tokens or run the linter.`;
  }
  if (lower.includes('media') || lower.includes('remotion') || lower.includes('video') || lower.includes('blender') || lower.includes('3d')) {
    return `Media Production Pipeline active. Supports Remotion (programmable video), Google Vids (prompt-to-production), and Blender MCP (text-to-3D). Switch to the Media Pipeline view to start a new production.`;
  }
  if (lower.includes('routine') || lower.includes('loop') || lower.includes('cron') || lower.includes('continuous') || lower.includes('schedule')) {
    return `Continuous Loop Workflows active. CRON-scheduled routines run autonomously — ad variations, analytics digests, PR summaries. Switch to the Routines view to manage or create new automated loops.`;
  }
  if (lower.includes('product') || lower.includes('etsy') || lower.includes('gumroad') || lower.includes('spreadsheet') || lower.includes('template')) {
    return `Product Factory active. AI-generates high-ticket digital products (spreadsheets, Notion templates, toolkits) for Etsy and Gumroad. Switch to the Products view to generate or manage products.`;
  }
  if (lower.includes('lead') || lower.includes('outreach') || lower.includes('prospect') || lower.includes('scrape')) {
    return `Lead Generation Pipeline active. Scrapes business leads, enriches with achievements, and auto-generates personalized LinkedIn/email outreach. Switch to the Lead Gen view to manage campaigns.`;
  }
  if (lower.includes('marketing') || lower.includes('content') || lower.includes('social media') || lower.includes('newsletter') || lower.includes('distribution')) {
    return `Marketing Hub active. End-to-end content pipelines — transforms source content (YouTube, blog, podcast) into multi-platform distribution (LinkedIn, X, email, threads). Switch to the Marketing view.`;
  }
  if (lower.includes('golden') || lower.includes('gem') || lower.includes('notebooklm') || lower.includes('sync')) {
    return `Golden Loop active. Connects Gemini Gems (custom AI personas) to NotebookLM notebooks for real-time data sync. The AI expert always has access to your latest research and docs.`;
  }
  if (lower.includes('vibe') || lower.includes('stitch') || lower.includes('ui generation') || lower.includes('wireframe') || lower.includes('prototype')) {
    return `Vibe Design Studio active. Generates functional UI from prompts, voice, sketches, or reference URLs. Includes predictive heat maps and granular style controls (density, hue, roundness, spacing).`;
  }
  if (lower.includes('3d') || lower.includes('blender') || lower.includes('scene') || lower.includes('render')) {
    return `3D Production Studio active. Text-to-3D via Blender MCP — generates environments, product renders, abstract visualizations. Supports multiple lighting presets and resolutions up to 4K.`;
  }
  if (lower.includes('predict') || lower.includes('forecast') || lower.includes('analytics') || lower.includes('churn')) {
    return `Predictive Analytics active. AI-estimated forecasts for revenue, engagement, costs, and churn. Multiple trained models with confidence scores and contributing factor analysis.`;
  }
  if (lower.includes('batch') || lower.includes('mass') || lower.includes('bulk') || lower.includes('generation queue')) {
    return `Batch Generation Queue active. Mass-produce content (images, text, variations) using economy-tier agents. Rate-limit tripping to build massive A/B testing libraries.`;
  }
  if (lower.includes('help') || lower.includes('what can')) {
    return `I can help you with: check system status, run skills by name, review pending approvals, check team status, check tech radar updates, run an intelligence sweep, check cost/budget, search the memory vault, launch pipelines, review identity layer, or ask any question about the system.`;
  }

  // Default: acknowledge as a goal
  return `Understood. I'll break down "${text}" into tasks and assemble the right team. Shall I start with a research phase, or do you have specific requirements to provide first?`;
}

// --- Agents ---
async function loadAgents() {
  state.agents = await fetchJSON('/api/agents');
  const container = document.getElementById('agentsGrid');
  container.innerHTML = state.agents.map(a => {
    const tools = a.meta?.tools || [];
    const model = a.meta?.model || 'sonnet';
    const status = state.fleetStatus[a.meta?.name] || 'idle';
    return `
      <div class="agent-card">
        <div class="agent-card-header">
          <span class="agent-name">
            <span class="fleet-dot ${status}" style="display:inline-block;width:8px;height:8px;margin-right:6px;vertical-align:middle;"></span>
            ${a.meta?.name || a.filename.replace('.md', '')}
          </span>
          <span class="agent-model ${model}">${model}</span>
        </div>
        <div class="agent-desc">${escapeHtml(a.meta?.description || '')}</div>
        <div class="agent-tools">
          ${tools.map(t => `<span class="agent-tool-tag">${t}</span>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// --- Skills — One-Click Launchpad ---
async function loadSkills() {
  state.skills = await fetchJSON('/api/skills');
  const filter = document.getElementById('skillCategoryFilter')?.value || 'all';
  const search = document.getElementById('skillSearch')?.value?.toLowerCase() || '';

  let filtered = state.skills;
  if (filter !== 'all') filtered = filtered.filter(s => (s.meta?.category || 'general') === filter);
  if (search) filtered = filtered.filter(s => {
    const name = (s.meta?.name || s.filename).toLowerCase();
    const desc = (s.meta?.description || '').toLowerCase();
    return name.includes(search) || desc.includes(search);
  });

  renderSkillsStats(state.skills);
  renderSkillsGrid(filtered);
  renderSkillsExecutions();

  // Setup filter/search handlers
  const filterSelect = document.getElementById('skillCategoryFilter');
  if (filterSelect && !filterSelect._bound) {
    filterSelect._bound = true;
    filterSelect.addEventListener('change', () => loadSkills());
  }
  const searchInput = document.getElementById('skillSearch');
  if (searchInput && !searchInput._bound) {
    searchInput._bound = true;
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadSkills(), 200);
    });
  }
}

function renderSkillsStats(skills) {
  const container = document.getElementById('skillsStats');
  if (!container) return;

  const categories = {};
  skills.forEach(s => {
    const cat = s.meta?.category || 'general';
    categories[cat] = (categories[cat] || 0) + 1;
  });

  const totalParams = skills.reduce((sum, s) => sum + (s.parameters?.length || 0), 0);
  const recentRuns = state.workflows.filter(w => w.status === 'running' || w.status === 'queued').length;

  container.innerHTML = `
    <div class="skills-stat">
      <div class="skills-stat-value">${skills.length}</div>
      <div class="skills-stat-label">Total Skills</div>
    </div>
    <div class="skills-stat">
      <div class="skills-stat-value">${Object.keys(categories).length}</div>
      <div class="skills-stat-label">Categories</div>
    </div>
    <div class="skills-stat">
      <div class="skills-stat-value">${totalParams}</div>
      <div class="skills-stat-label">Configurable Params</div>
    </div>
    <div class="skills-stat">
      <div class="skills-stat-value" style="color: ${recentRuns > 0 ? 'var(--accent)' : 'var(--text-primary)'}">${recentRuns}</div>
      <div class="skills-stat-label">Running Now</div>
    </div>
  `;
}

function renderSkillsGrid(skills) {
  const container = document.getElementById('skillsGrid');
  if (!container) return;

  if (!skills.length) {
    container.innerHTML = '<div class="empty-state">No skills match your filter.</div>';
    return;
  }

  container.innerHTML = skills.map(s => {
    const name = s.meta?.name || s.filename.replace('.md', '');
    const category = s.meta?.category || 'general';
    const time = s.meta?.estimated_time || '~10min';
    const params = s.parameters || [];
    const steps = s.steps || [];
    const agents = s.agents || [];
    const icon = getSkillIcon(category);
    const paramCount = params.length;

    const stepsPreview = steps.length > 0 ? `
      <div class="skill-steps-preview">
        ${steps.slice(0, 5).map((st, i) => {
          const arrow = i < Math.min(steps.length, 5) - 1 ? '<span class="skill-step-arrow">&#8594;</span>' : '';
          return `<span class="skill-step-chip">${escapeHtml(st.name)}</span>${arrow}`;
        }).join('')}
        ${steps.length > 5 ? `<span class="skill-step-chip">+${steps.length - 5} more</span>` : ''}
      </div>
    ` : '';

    const agentsPreview = agents.length > 0 ? `
      <div class="skill-card-agents">
        ${agents.map(a => `<span class="skill-agent-chip">${escapeHtml(a.name)}</span>`).join('')}
      </div>
    ` : '';

    return `
      <div class="skill-card" onclick="executeSkill('${s.filename}')">
        <div class="skill-card-icon">${icon}</div>
        <div class="skill-card-header">
          <span class="skill-name">${capitalize(name.replace(/-/g, ' '))}</span>
          <span class="skill-category ${category}">${category}</span>
        </div>
        <div class="skill-desc">${escapeHtml(s.meta?.description || '')}</div>
        ${stepsPreview}
        ${agentsPreview}
        <div class="skill-meta">
          <span class="skill-time">${time}${paramCount > 0 ? `<span class="skill-param-count">${paramCount} params</span>` : ''}</span>
          <button class="skill-run-btn large" onclick="event.stopPropagation(); executeSkill('${s.filename}')">
            <span class="run-icon">&#9654;</span> Launch
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderSkillsExecutions() {
  const container = document.getElementById('skillsExecutions');
  if (!container) return;

  const recent = state.workflows.slice(0, 10);
  const badge = document.getElementById('skillsExecBadge');
  const running = state.workflows.filter(w => w.status === 'running' || w.status === 'queued').length;
  if (badge) {
    badge.textContent = running > 0 ? running : '';
    badge.style.display = running > 0 ? 'inline-block' : 'none';
  }

  if (!recent.length) {
    container.innerHTML = '<div class="empty-state">No skills executed yet. Click a skill above to launch.</div>';
    return;
  }

  container.innerHTML = recent.map(exec => {
    const steps = exec.steps || [];
    const progress = exec.progress || (exec.status === 'completed' ? 100 : 0);
    const params = exec.params || {};
    const paramEntries = Object.entries(params).filter(([,v]) => v);

    const stepDots = steps.length > 0 ? `
      <div class="skill-exec-steps">
        ${steps.map((s, i) => {
          const connector = i < steps.length - 1
            ? `<div class="skill-exec-step-line ${s.status === 'completed' ? 'done' : ''}"></div>`
            : '';
          return `
            <div class="skill-exec-step-dot ${s.status}" title="${escapeHtml(s.name)}">
              ${s.status === 'completed' ? '&#10003;' : s.status === 'running' ? '&#8634;' : (i + 1)}
            </div>
            ${connector}
          `;
        }).join('')}
      </div>
    ` : '';

    return `
      <div class="skill-exec-progress">
        <div class="skill-exec-header">
          <span class="skill-exec-name">${capitalize((exec.skillName || exec.skill).replace('.md', '').replace(/-/g, ' '))}</span>
          <span class="skill-exec-status ${exec.status}">${exec.status}</span>
        </div>
        <div class="skill-exec-bar-wrap">
          <div class="skill-exec-bar ${progress >= 100 ? 'complete' : ''}" style="width: ${progress}%"></div>
        </div>
        ${stepDots}
        <div class="skill-exec-meta">
          <span>Started: ${timeAgo(exec.startedAt)}</span>
          ${exec.completedAt ? `<span>Completed: ${timeAgo(exec.completedAt)}</span>` : `<span>Progress: ${progress}%</span>`}
          <span>ID: ${exec.id.slice(0, 8)}</span>
        </div>
        ${paramEntries.length > 0 ? `
          <div class="skill-exec-params">
            ${paramEntries.map(([k, v]) => `<span class="skill-exec-param-tag">${k}: ${escapeHtml(String(v))}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function executeSkill(filename) {
  // Fetch skill details with parameters
  const skill = state.skills.find(s => s.filename === filename) || await fetchJSON(`/api/skills/${filename}`);
  const name = skill.meta?.name || filename.replace('.md', '');
  const params = skill.parameters || [];
  const steps = skill.steps || [];
  const agents = skill.agents || [];

  // Build parameter form HTML
  let formHtml = '';
  if (params.length > 0) {
    formHtml = `<div class="skill-exec-form">
      ${params.map(p => {
        if (p.inputType === 'select' && p.options.length > 0) {
          const opts = p.options.map(o => `<option value="${o}" ${o === p.default ? 'selected' : ''}>${o}</option>`).join('');
          return `
            <div class="form-group">
              <label>${p.name}${p.required ? '<span class="required-star">*</span>' : ''}</label>
              <select id="param-${p.name}">${opts}</select>
              ${p.description ? `<span class="form-hint">${escapeHtml(p.description)}</span>` : ''}
            </div>
          `;
        } else if (p.inputType === 'number') {
          return `
            <div class="form-group">
              <label>${p.name}${p.required ? '<span class="required-star">*</span>' : ''}</label>
              <input type="number" id="param-${p.name}" value="${p.default || ''}" placeholder="${p.description || ''}" />
              ${p.description ? `<span class="form-hint">${escapeHtml(p.description)}</span>` : ''}
            </div>
          `;
        } else if (p.inputType === 'toggle') {
          return `
            <div class="form-group">
              <label>${p.name}</label>
              <div class="toggle-group">
                <div class="toggle-switch ${p.default === 'true' ? 'active' : ''}" id="param-${p.name}" onclick="this.classList.toggle('active')"></div>
                <span style="font-size:12px;color:var(--text-secondary);">${escapeHtml(p.description || '')}</span>
              </div>
            </div>
          `;
        } else {
          return `
            <div class="form-group">
              <label>${p.name}${p.required ? '<span class="required-star">*</span>' : ''}</label>
              <input type="text" id="param-${p.name}" value="${p.default || ''}" placeholder="${p.description || `Enter ${p.name}...`}" />
              ${p.description ? `<span class="form-hint">${escapeHtml(p.description)}</span>` : ''}
            </div>
          `;
        }
      }).join('')}
    </div>`;
  } else {
    formHtml = `<p style="color: var(--text-secondary); font-size: 13px;">This skill has no configurable parameters — it runs with defaults.</p>`;
  }

  // Build steps preview
  const stepsHtml = steps.length > 0 ? `
    <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border);">
      <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px;">Execution Steps</div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        ${steps.map((s, i) => {
          const arrow = i < steps.length - 1 ? '<span style="color: var(--text-muted); font-size: 10px; align-self: center;">&#8594;</span>' : '';
          return `<span class="skill-step-chip">${i + 1}. ${escapeHtml(s.name)}</span>${arrow}`;
        }).join('')}
      </div>
    </div>
  ` : '';

  // Build agents preview
  const agentsHtml = agents.length > 0 ? `
    <div style="margin-top: 12px;">
      <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px;">Agents Involved</div>
      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        ${agents.map(a => `<span class="skill-agent-chip">${escapeHtml(a.name)}${a.model ? ` (${a.model})` : ''}</span>`).join('')}
      </div>
    </div>
  ` : '';

  const bodyHtml = `
    <div style="margin-bottom: 12px;">
      <p style="color: var(--text-secondary); font-size: 13px;">${escapeHtml(skill.meta?.description || '')}</p>
      <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--text-muted);">
        <span>Est. time: ${skill.meta?.estimated_time || '~10min'}</span>
        <span>Category: ${skill.meta?.category || 'general'}</span>
      </div>
    </div>
    ${formHtml}
    ${stepsHtml}
    ${agentsHtml}
  `;

  showModal(`Launch: ${capitalize(name.replace(/-/g, ' '))}`, bodyHtml, [
    { label: 'Cancel', class: 'btn-secondary', action: closeModal },
    { label: 'Launch Now', class: 'btn-success', action: async () => {
      // Collect parameter values
      const paramValues = {};
      params.forEach(p => {
        const el = document.getElementById(`param-${p.name}`);
        if (!el) return;
        if (p.inputType === 'toggle') {
          paramValues[p.name] = el.classList.contains('active');
        } else {
          const val = el.value.trim();
          if (val) paramValues[p.name] = val;
        }
      });

      // Validate required params
      const missing = params.filter(p => p.required && !paramValues[p.name]);
      if (missing.length > 0) {
        missing.forEach(p => {
          const el = document.getElementById(`param-${p.name}`);
          if (el) el.style.borderColor = 'var(--error)';
        });
        return;
      }

      closeModal();

      // Execute the skill
      const result = await fetchJSON(`/api/skills/${filename}/execute`, { method: 'POST', body: { params: paramValues } });
      state.workflows.unshift(result);

      // Animate fleet — use agents from the skill if available
      const agentNames = (result.agents || ['orchestrator', 'researcher']).map(n => n.toLowerCase().replace(/\s+/g, '-'));
      state.fleetStatus.orchestrator = 'running';
      renderFleetGrid();

      agentNames.forEach((agent, i) => {
        if (state.fleetStatus[agent] !== undefined && agent !== 'orchestrator') {
          setTimeout(() => {
            state.fleetStatus.orchestrator = i === 0 ? 'idle' : state.fleetStatus.orchestrator;
            state.fleetStatus[agent] = 'running';
            renderFleetGrid();
          }, 1200 * (i + 1));
          setTimeout(() => {
            state.fleetStatus[agent] = 'idle';
            renderFleetGrid();
          }, 1200 * (i + 1) + 2000);
        }
      });

      setTimeout(() => {
        state.fleetStatus.orchestrator = 'idle';
        renderFleetGrid();
      }, 1200 * (agentNames.length + 1));

      addTimelineEvent('skill', `Skill launched: ${name}`, undefined,
        `Params: ${Object.entries(paramValues).map(([k,v]) => `${k}=${v}`).join(', ') || 'defaults'}`);
      updateStats();

      // Stay on skills view to show execution progress
      if (document.getElementById('view-skills').classList.contains('active')) {
        renderSkillsExecutions();
      }
    }},
  ]);
}

// --- Workflows ---
async function loadWorkflows() {
  state.workflows = await fetchJSON('/api/workflows');
  const container = document.getElementById('workflowsList');
  if (!state.workflows.length) {
    container.innerHTML = '<div class="empty-state">No workflows executed yet. Use Skills to launch one.</div>';
    return;
  }
  container.innerHTML = state.workflows.map(w => `
    <div class="workflow-item">
      <div class="workflow-info">
        <span class="workflow-status ${w.status}"></span>
        <div>
          <div class="workflow-name">${capitalize(w.skill.replace('.md', '').replace(/-/g, ' '))}</div>
          <div class="workflow-time">${new Date(w.startedAt).toLocaleString()}</div>
        </div>
      </div>
      <span class="btn btn-sm btn-secondary">${w.status}</span>
    </div>
  `).join('');
  updateStats();
}

function updateWorkflow(data) {
  const idx = state.workflows.findIndex(w => w.id === data.id);
  if (idx >= 0) state.workflows[idx] = data;
  else state.workflows.unshift(data);
  if (document.getElementById('view-workflows').classList.contains('active')) {
    loadWorkflows();
  }
  updateStats();
}

// --- Mission ---
async function loadMission() {
  const mission = await fetchJSON('/api/mission');
  const container = document.getElementById('missionContent');
  if (!mission.exists) {
    container.innerHTML = '<div class="empty-state">No mission defined yet.</div>';
    return;
  }
  container.innerHTML = renderMarkdown(mission.body);
}

// --- Artifacts ---
async function loadArtifacts() {
  const artifacts = await fetchJSON('/api/artifacts');
  const container = document.getElementById('artifactsList');
  if (!artifacts.length) {
    container.innerHTML = '<div class="empty-state">No artifacts generated yet.</div>';
    return;
  }
  container.innerHTML = artifacts.map(a => `
    <div class="artifact-item">
      <div>
        <div class="artifact-name">${a.filename}</div>
        <div class="artifact-category">${a.category}</div>
      </div>
      <span class="workflow-time">${new Date(a.modified).toLocaleDateString()}</span>
    </div>
  `).join('');
}

// --- Logs ---
async function loadLogs() {
  const logs = await fetchJSON('/api/decisions');
  const container = document.getElementById('logsContainer');
  if (!logs.length) {
    container.innerHTML = '<div class="empty-state">No log entries.</div>';
    return;
  }
  container.innerHTML = logs.map(l => `<div class="log-entry">${escapeHtml(l)}</div>`).join('');
}

// --- Modal ---
function setupModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('newWorkflowBtn').addEventListener('click', () => {
    switchView('skills');
  });
}

function showModal(title, bodyHtml, buttons = []) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = buttons.map((b, i) =>
    `<button class="btn ${b.class}" id="modalBtn${i}">${b.label}</button>`
  ).join('');
  buttons.forEach((b, i) => {
    document.getElementById(`modalBtn${i}`).addEventListener('click', b.action);
  });
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

// --- Utilities ---
async function fetchJSON(url, opts = {}) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    // Include Bearer token from localStorage as fallback for cookie auth
    const token = localStorage.getItem('ai-os-token');
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { credentials: 'same-origin', headers, ...opts };
    if (opts.body) options.body = JSON.stringify(opts.body);
    // Preserve our headers if opts also has headers
    if (opts.headers) options.headers = { ...headers, ...opts.headers };

    const res = await fetch(`${API}${url}`, options);
    if (!res.ok && res.status === 401) {
      console.warn('Unauthorized — session may have expired');
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: text || `HTTP ${res.status}` }; }
  } catch (e) {
    console.error('Fetch error:', e);
    return opts.method ? { error: e.message } : [];
  }
}

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getSkillIcon(category) {
  const icons = {
    marketing: '&#9998;',
    research: '&#128269;',
    sales: '&#128176;',
    design: '&#127912;',
    intelligence: '&#128225;',
    security: '&#128274;',
    general: '&#9889;',
  };
  return icons[category] || icons.general;
}

// --- Schedules ---
async function loadSchedules() {
  const [scheds, history] = await Promise.all([
    fetchJSON('/api/schedules'),
    fetchJSON('/api/schedules/history'),
  ]);

  renderScheduleCards(scheds);
  renderScheduleHistory(history);
}

function renderScheduleCards(scheds) {
  const container = document.getElementById('schedulesGrid');
  if (!container) return;

  if (!scheds.length) {
    container.innerHTML = '<div class="empty-state">No schedules configured.</div>';
    return;
  }

  container.innerHTML = scheds.map(s => {
    const isRunning = s.status === 'running';
    const cronHuman = parseCronHuman(s.cron);
    return `
      <div class="schedule-card ${isRunning ? 'running' : ''} ${!s.enabled ? 'disabled' : ''}">
        <div class="schedule-card-header">
          <span class="schedule-agent-name">
            <span class="schedule-status-dot ${s.enabled ? (isRunning ? 'running' : 'idle') : 'disabled'}"></span>
            ${s.agent}
          </span>
          <div class="schedule-toggle ${s.enabled ? 'active' : ''}" onclick="toggleSchedule('${s.id}')" title="${s.enabled ? 'Click to pause' : 'Click to enable'}"></div>
        </div>
        <div class="schedule-desc">${escapeHtml(s.description)}</div>
        <div class="schedule-details">
          <div class="schedule-detail">
            <span class="schedule-detail-label">Skill</span>
            <span class="schedule-detail-value">${s.skill}</span>
          </div>
          <div class="schedule-detail">
            <span class="schedule-detail-label">Schedule</span>
            <span class="schedule-detail-value cron">${cronHuman}</span>
          </div>
          <div class="schedule-detail">
            <span class="schedule-detail-label">Last Run</span>
            <span class="schedule-detail-value">${s.lastRun ? timeAgo(s.lastRun) : 'Never'}</span>
          </div>
          <div class="schedule-detail">
            <span class="schedule-detail-label">Next Run</span>
            <span class="schedule-detail-value">${s.nextRun ? formatNextRun(s.nextRun) : 'Paused'}</span>
          </div>
          <div class="schedule-detail">
            <span class="schedule-detail-label">Total Runs</span>
            <span class="schedule-detail-value">${s.runCount}</span>
          </div>
          <div class="schedule-detail">
            <span class="schedule-detail-label">Status</span>
            <span class="schedule-detail-value">${isRunning ? '⟳ Running...' : s.enabled ? '● Active' : '○ Paused'}</span>
          </div>
        </div>
        <div class="schedule-actions">
          <button class="btn btn-sm btn-primary" onclick="runScheduleNow('${s.id}')" ${isRunning ? 'disabled' : ''}>
            ${isRunning ? '⟳ Running...' : '▶ Run Now'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderScheduleHistory(history) {
  const container = document.getElementById('scheduleHistory');
  if (!container) return;

  if (!history.length) {
    container.innerHTML = '<div class="empty-state">No runs yet. Schedules will execute at their configured times.</div>';
    return;
  }

  container.innerHTML = history.map(h => `
    <div class="history-item">
      <div class="history-item-left">
        <span class="fleet-dot ${h.status === 'running' ? 'running' : 'idle'}"></span>
        <span class="history-agent">${h.agent}</span>
        <span class="history-skill">→ ${h.skill}</span>
      </div>
      <span class="history-status ${h.status}">${h.status}</span>
      <span class="history-time">${timeAgo(h.startedAt)}</span>
    </div>
  `).join('');
}

async function toggleSchedule(id) {
  await fetchJSON(`/api/schedules/${id}/toggle`, { method: 'PUT' });
  loadSchedules();
}

async function runScheduleNow(id) {
  await fetchJSON(`/api/schedules/${id}/run`, { method: 'POST' });
  loadSchedules();
  addTimelineEvent('schedule', `Manual run triggered for scheduled agent`);
}

function parseCronHuman(cronExpr) {
  const parts = cronExpr.split(' ');
  if (parts.length < 5) return cronExpr;
  const min = parts[0];
  const hour = parts[1];
  const dayMonth = parts[2];
  const month = parts[3];
  const dayWeek = parts[4];

  let time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

  if (dayMonth === '*' && month === '*' && dayWeek === '*') return `Daily at ${time}`;
  if (dayMonth === '*' && month === '*' && dayWeek !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[dayWeek] || dayWeek} at ${time}`;
  }
  return `${cronExpr} (${time})`;
}

function formatNextRun(isoDate) {
  const next = new Date(isoDate);
  const now = new Date();
  const diffMs = next - now;
  if (diffMs < 0) return 'Imminent';
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffMins = Math.floor((diffMs % 3600000) / 60000);
  if (diffHrs > 0) return `In ${diffHrs}h ${diffMins}m`;
  return `In ${diffMins}m`;
}

// --- Tech Radar ---
function setupRadar() {
  const sweepBtn = document.getElementById('triggerSweepBtn');
  if (sweepBtn) {
    sweepBtn.addEventListener('click', triggerSweep);
  }
  const filterSelect = document.getElementById('radarCategoryFilter');
  if (filterSelect) {
    filterSelect.addEventListener('change', () => {
      renderFindings(filterSelect.value);
    });
  }
}

async function loadRadar() {
  const [latestRes, proposalsRes] = await Promise.all([
    fetchJSON('/api/tech-radar/latest'),
    fetchJSON('/api/tech-radar/proposals'),
  ]);

  if (latestRes.exists) {
    state.radarReport = latestRes.report;
  }
  state.proposals = proposalsRes;

  renderRadarStats();
  renderFindings('all');
  renderProposals();
  updateRadarBadge();

  const lastSweep = document.getElementById('radarLastSweep');
  if (lastSweep && state.radarReport) {
    lastSweep.textContent = `Last sweep: ${timeAgo(state.radarReport.date)}`;
  }
}

function renderRadarStats() {
  const container = document.getElementById('radarStats');
  if (!container) return;

  const findings = state.radarReport?.findings || [];
  const critical = findings.filter(f => f.impact === 'critical').length;
  const high = findings.filter(f => f.impact === 'high').length;
  const medium = findings.filter(f => f.impact === 'medium').length;
  const pending = state.proposals.filter(p => p.status === 'pending').length;

  container.innerHTML = `
    <div class="radar-stat">
      <div class="radar-stat-value critical">${critical}</div>
      <div class="radar-stat-label">Critical</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value high">${high}</div>
      <div class="radar-stat-label">High Impact</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value medium">${medium}</div>
      <div class="radar-stat-label">Medium</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value total">${pending}</div>
      <div class="radar-stat-label">Pending Proposals</div>
    </div>
  `;
}

function renderFindings(category = 'all') {
  const container = document.getElementById('radarFindings');
  if (!container) return;

  let findings = state.radarReport?.findings || [];
  if (category !== 'all') {
    findings = findings.filter(f => f.category === category);
  }

  if (!findings.length) {
    container.innerHTML = '<div class="empty-state">No findings for this category.</div>';
    return;
  }

  // Sort: critical first, then high, then by relevance
  const impactOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (impactOrder[a.impact] ?? 4) - (impactOrder[b.impact] ?? 4) || b.relevance - a.relevance);

  container.innerHTML = findings.map(f => `
    <div class="radar-finding">
      <div class="radar-finding-header">
        <span class="radar-finding-title">${escapeHtml(f.title)}</span>
        <span class="radar-impact-tag ${f.impact}">${f.impact}</span>
      </div>
      <div class="radar-finding-summary">${escapeHtml(f.summary)}</div>
      <div class="radar-finding-meta">
        <span class="radar-category-tag">${f.category}</span>
        <span class="radar-relevance">
          Relevance:
          <span class="radar-relevance-bar">
            <span class="radar-relevance-fill" style="width: ${f.relevance * 10}%"></span>
          </span>
          ${f.relevance}/10
        </span>
        <span>${timeAgo(f.date)}</span>
      </div>
    </div>
  `).join('');
}

function renderProposals() {
  const container = document.getElementById('radarProposals');
  if (!container) return;

  if (!state.proposals.length) {
    container.innerHTML = '<div class="empty-state">No update proposals.</div>';
    return;
  }

  // Sort: pending first, then by impact
  const statusOrder = { pending: 0, approved: 1, rejected: 2 };
  const impactOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...state.proposals].sort((a, b) =>
    (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3) ||
    (impactOrder[a.impact] ?? 4) - (impactOrder[b.impact] ?? 4)
  );

  container.innerHTML = sorted.map(p => `
    <div class="radar-proposal ${p.status}">
      <div class="radar-proposal-header">
        <span class="radar-proposal-title">${escapeHtml(p.title)}</span>
        <span class="radar-impact-tag ${p.impact}">${p.impact}</span>
      </div>
      <div class="radar-proposal-body">${escapeHtml(p.action.description)}</div>
      <div class="radar-proposal-details">
        <div class="radar-detail-item">
          <span class="radar-detail-label">Type:</span>
          <span class="radar-detail-value">${p.action.type.replace(/_/g, ' ')}</span>
        </div>
        <div class="radar-detail-item">
          <span class="radar-detail-label">Effort:</span>
          <span class="radar-detail-value">${p.action.effort}</span>
        </div>
        <div class="radar-detail-item">
          <span class="radar-detail-label">Target:</span>
          <span class="radar-detail-value">${escapeHtml(p.action.target)}</span>
        </div>
        <div class="radar-detail-item">
          <span class="radar-detail-label">Risk:</span>
          <span class="radar-detail-value">${escapeHtml(p.action.risk)}</span>
        </div>
      </div>
      ${p.status === 'pending' ? `
        <div class="radar-proposal-actions">
          <button class="btn btn-sm btn-success" onclick="resolveProposal('${p.id}', 'approved')">Approve</button>
          <button class="btn btn-sm btn-secondary" onclick="resolveProposal('${p.id}', 'rejected')">Reject</button>
        </div>
      ` : `
        <div class="radar-proposal-status">${p.status === 'approved' ? '&#10003; Approved' : '&#10007; Rejected'} ${p.resolvedAt ? timeAgo(p.resolvedAt) : ''}</div>
      `}
    </div>
  `).join('');

  // Update badge
  const badge = document.getElementById('proposalsBadge');
  const pendingCount = state.proposals.filter(p => p.status === 'pending').length;
  if (badge) {
    badge.textContent = pendingCount > 0 ? pendingCount : '';
    badge.style.display = pendingCount > 0 ? 'inline' : 'none';
  }
}

async function resolveProposal(id, verdict) {
  const result = await fetchJSON(`/api/tech-radar/proposals/${id}`, {
    method: 'PUT',
    body: { verdict },
  });

  if (result.id) {
    const idx = state.proposals.findIndex(p => p.id === id);
    if (idx >= 0) state.proposals[idx] = result;

    addTimelineEvent('radar', `Update proposal ${verdict}: ${result.title}`);
    state.activity.unshift({
      id: Date.now().toString(),
      type: 'radar',
      message: `${verdict === 'approved' ? 'Approved' : 'Rejected'} update: ${result.title}`,
      timestamp: new Date().toISOString(),
    });
    renderActivityFeed();
    renderProposals();
    renderRadarStats();
    updateRadarBadge();

    // Animate fleet if approved
    if (verdict === 'approved') {
      state.fleetStatus.orchestrator = 'running';
      renderFleetGrid();
      setTimeout(() => {
        state.fleetStatus.orchestrator = 'idle';
        state.fleetStatus.coder = 'running';
        renderFleetGrid();
      }, 1500);
      setTimeout(() => {
        state.fleetStatus.coder = 'idle';
        renderFleetGrid();
      }, 4000);
    }
  }
}

async function triggerSweep() {
  const btn = document.getElementById('triggerSweepBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Scanning...';

  state.fleetStatus.scout = 'running';
  renderFleetGrid();

  addTimelineEvent('radar', 'Tech Radar sweep initiated', undefined, 'Scout agent dispatched for daily intelligence sweep');

  await fetchJSON('/api/tech-radar/sweep', { method: 'POST', body: { sweep_type: 'daily' } });

  setTimeout(() => {
    state.fleetStatus.scout = 'idle';
    renderFleetGrid();
    btn.disabled = false;
    btn.innerHTML = '&#128225; Run Sweep';
    addTimelineEvent('radar', 'Sweep completed — findings delivered to orchestrator');
  }, 5000);
}

function updateRadarBadge() {
  const badge = document.getElementById('radarBadge');
  if (!badge) return;
  const pending = state.proposals.filter(p => p.status === 'pending').length;
  if (pending > 0) {
    badge.textContent = pending;
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

// --- Memory Vault ---
async function loadVault() {
  const [stats, context] = await Promise.all([
    fetchJSON('/api/vault'),
    fetchJSON('/api/vault/context'),
  ]);

  state.vaultStats = stats;
  renderVaultStats(stats);
  renderVaultFolder('vaultRaw', stats.raw);
  renderVaultFolder('vaultWiki', stats.wiki);
  renderVaultFolder('vaultOutputs', stats.outputs);
  renderVaultContext(context);

  // Setup search
  const searchInput = document.getElementById('vaultSearch');
  if (searchInput && !searchInput._bound) {
    searchInput._bound = true;
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => searchVault(searchInput.value), 300);
    });
  }
}

function renderVaultStats(stats) {
  const container = document.getElementById('vaultStats');
  if (!container) return;
  container.innerHTML = `
    <div class="vault-stat">
      <div class="vault-stat-value">${stats.totalFiles}</div>
      <div class="vault-stat-label">Total Files</div>
    </div>
    <div class="vault-stat">
      <div class="vault-stat-value">${stats.raw.length}</div>
      <div class="vault-stat-label">Raw Intake</div>
    </div>
    <div class="vault-stat">
      <div class="vault-stat-value">${stats.wiki.length}</div>
      <div class="vault-stat-label">Wiki Entries</div>
    </div>
    <div class="vault-stat">
      <div class="vault-stat-value">${formatFileSize(stats.totalSize)}</div>
      <div class="vault-stat-label">Total Size</div>
    </div>
  `;
}

function renderVaultFolder(containerId, files) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!files.length) {
    container.innerHTML = '<div class="empty-state" style="padding:16px;">No files yet.</div>';
    return;
  }
  container.innerHTML = files.map(f => `
    <div class="vault-file" onclick="viewVaultFile('${f.folder}', '${f.name}')">
      <div>
        <div class="vault-file-name">${escapeHtml(f.name)}</div>
        <div class="vault-file-meta">${formatFileSize(f.size)} · ${timeAgo(f.modified)}</div>
      </div>
    </div>
  `).join('');
}

async function viewVaultFile(folder, file) {
  const data = await fetchJSON(`/api/vault/${folder}/${encodeURIComponent(file)}`);
  if (!data.content) return;
  const tags = data.meta?.tags || [];
  const tagHtml = tags.map(t => `<span class="vault-tag">${t}</span>`).join('');
  showModal(`vault/${folder}/${file}`, `
    <div style="margin-bottom:8px;">${tagHtml}</div>
    <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;max-height:400px;overflow:auto;background:var(--bg-tertiary);padding:12px;border-radius:var(--radius);line-height:1.6;">${escapeHtml(data.body || data.content)}</pre>
  `, [
    { label: 'Close', class: 'btn-secondary', action: closeModal },
  ]);
}

async function searchVault(query) {
  const container = document.getElementById('vaultSearchResults');
  if (!container) return;
  if (!query || query.length < 2) {
    container.innerHTML = '<div class="empty-state">Type a query above to search across all vault files.</div>';
    return;
  }
  const results = await fetchJSON(`/api/vault/search?q=${encodeURIComponent(query)}`);
  if (!results.length) {
    container.innerHTML = `<div class="empty-state">No results for "${escapeHtml(query)}"</div>`;
    return;
  }
  container.innerHTML = results.map(r => `
    <div class="vault-result" onclick="viewVaultFile('${r.folder}', '${r.file}')">
      <div class="vault-result-header">
        <span class="vault-result-file">${escapeHtml(r.file)}</span>
        <span class="vault-result-folder">${r.folder}</span>
      </div>
      ${r.snippet ? `<div class="vault-result-snippet">...${escapeHtml(r.snippet)}...</div>` : ''}
    </div>
  `).join('');
}

function renderVaultContext(context) {
  const container = document.getElementById('vaultContext');
  if (!container) return;

  const decisionHtml = context.decisions.length
    ? context.decisions.map(d => `<div class="vault-context-item">${escapeHtml(d)}</div>`).join('')
    : '<div class="vault-context-item" style="color:var(--text-muted);">No decisions recorded yet.</div>';

  const wikiHtml = context.recentWiki.length
    ? context.recentWiki.map(w => `
      <div class="vault-context-item">
        <strong>${escapeHtml(w.name)}</strong>
        ${w.tags.map(t => `<span class="vault-tag" style="margin-left:6px;">${t}</span>`).join('')}
        <span style="float:right;color:var(--text-muted);font-size:10px;">${timeAgo(w.updated)}</span>
      </div>
    `).join('')
    : '<div class="vault-context-item" style="color:var(--text-muted);">No wiki entries yet.</div>';

  container.innerHTML = `
    <div class="vault-context-section">
      <div class="vault-context-title">Recent Decisions (auto-loaded at session start)</div>
      <div class="vault-context-items">${decisionHtml}</div>
    </div>
    <div class="vault-context-section">
      <div class="vault-context-title">Recent Wiki (auto-loaded by relevance)</div>
      <div class="vault-context-items">${wikiHtml}</div>
    </div>
  `;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// --- Cost Tracker ---
async function loadCosts() {
  const summary = await fetchJSON('/api/costs');
  state.costSummary = summary;
  renderCostBudgetBar(summary);
  renderCostStats(summary);
  renderCostTierBreakdown(summary);
  renderCostAgentBreakdown(summary);
  renderCostLedger(summary.entries);
}

function renderCostBudgetBar(summary) {
  const container = document.getElementById('costsBudgetBar');
  if (!container) return;

  const periods = [
    { label: 'Daily', data: summary.daily },
    { label: 'Weekly', data: summary.weekly },
    { label: 'Monthly', data: summary.monthly },
  ];

  container.innerHTML = periods.map(p => {
    const pct = Math.min(100, Math.round((p.data.cost / p.data.budget) * 100));
    const status = pct < 50 ? 'under' : pct < 75 ? 'warn' : 'over';
    return `
      <div class="budget-card">
        <div class="budget-card-header">
          <span class="budget-card-label">${p.label} Spend</span>
          <span class="budget-card-amount">${p.data.count} calls · ${formatTokenCount(p.data.tokens)}</span>
        </div>
        <div class="budget-card-value ${status}">$${p.data.cost.toFixed(2)}</div>
        <div class="budget-bar">
          <div class="budget-bar-fill ${status}" style="width: ${pct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;color:var(--text-muted);">
          <span>${pct}% of $${p.data.budget} budget</span>
          <span>$${(p.data.budget - p.data.cost).toFixed(2)} remaining</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderCostStats(summary) {
  const container = document.getElementById('costsStats');
  if (!container) return;

  const tiers = [
    { key: 'strategic', label: 'Strategic (Opus xhigh)', cls: 'opus' },
    { key: 'professional', label: 'Professional (Opus high)', cls: 'sonnet' },
    { key: 'scout', label: 'Scout (Opus low)', cls: 'haiku' },
    { key: 'economy', label: 'Economy (DeepSeek)', cls: 'deepseek' },
    { key: 'realtime', label: 'Realtime (Grok)', cls: 'grok' },
  ];

  container.innerHTML = tiers.map(t => {
    const data = summary.byTier[t.key] || { cost: 0, tokens: 0, count: 0 };
    return `
      <div class="cost-stat">
        <div class="cost-stat-value ${t.cls}">$${data.cost.toFixed(2)}</div>
        <div class="cost-stat-label">${t.label}</div>
        <div class="cost-stat-sub">${formatTokenCount(data.tokens)} · ${data.count} calls</div>
      </div>
    `;
  }).join('');
}

function renderCostTierBreakdown(summary) {
  const container = document.getElementById('costsTierBreakdown');
  if (!container) return;

  const totalCost = summary.monthly.cost || 1;
  const tiers = [
    { key: 'strategic', label: 'Strategic (xhigh)', cls: 'strategic' },
    { key: 'professional', label: 'Professional (high)', cls: 'professional' },
    { key: 'scout', label: 'Scout (low)', cls: 'scout' },
    { key: 'economy', label: 'Economy', cls: 'economy' },
    { key: 'realtime', label: 'Realtime', cls: 'realtime' },
  ];

  container.innerHTML = tiers.map(t => {
    const data = summary.byTier[t.key] || { cost: 0, tokens: 0 };
    const pct = Math.round((data.cost / totalCost) * 100);
    return `
      <div class="cost-breakdown-row">
        <span class="cost-breakdown-label">${t.label}</span>
        <div class="cost-breakdown-bar-wrap">
          <div class="cost-breakdown-bar ${t.cls}" style="width: ${pct}%"></div>
        </div>
        <span class="cost-breakdown-value">$${data.cost.toFixed(2)}</span>
        <span class="cost-breakdown-tokens">${formatTokenCount(data.tokens)}</span>
      </div>
    `;
  }).join('');
}

function renderCostAgentBreakdown(summary) {
  const container = document.getElementById('costsAgentBreakdown');
  if (!container) return;

  const totalCost = summary.monthly.cost || 1;
  const agents = Object.entries(summary.byAgent)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8);

  container.innerHTML = agents.map(([name, data]) => {
    const pct = Math.round((data.cost / totalCost) * 100);
    return `
      <div class="cost-breakdown-row">
        <span class="cost-breakdown-label">${name}</span>
        <div class="cost-breakdown-bar-wrap">
          <div class="cost-breakdown-bar agent" style="width: ${pct}%"></div>
        </div>
        <span class="cost-breakdown-value">$${data.cost.toFixed(2)}</span>
        <span class="cost-breakdown-tokens">${formatTokenCount(data.tokens)}</span>
      </div>
    `;
  }).join('');
}

function renderCostLedger(entries) {
  const container = document.getElementById('costsLedger');
  if (!container) return;

  if (!entries || !entries.length) {
    container.innerHTML = '<div class="empty-state">No cost entries recorded.</div>';
    return;
  }

  const modelClass = (m) => {
    if (m.includes('xhigh') || m.includes('opus')) return 'opus';
    if (m.includes('4.8-high') || m.includes('sonnet')) return 'sonnet';
    if (m.includes('4.8-low') || m.includes('haiku')) return 'haiku';
    if (m.includes('grok')) return 'grok';
    if (m.includes('deepseek')) return 'deepseek';
    return '';
  };

  container.innerHTML = `
    <table class="ledger-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Engine</th>
          <th>Skill</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cost</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(e => `
          <tr>
            <td class="ledger-agent">${escapeHtml(e.agent)}</td>
            <td><span class="ledger-model ${modelClass(e.model)}">${e.model.replace('opus-4.8-', 'Opus 4.8 ').replace('claude-4.7-', '')}</span></td>
            <td>${escapeHtml(e.skill)}</td>
            <td class="ledger-tokens">${formatTokenCount(e.inputTokens)}</td>
            <td class="ledger-tokens">${formatTokenCount(e.outputTokens)}</td>
            <td class="ledger-cost">$${e.cost.toFixed(4)}</td>
            <td>${timeAgo(e.timestamp)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// --- Automations ---
async function loadAutomations() {
  const [actions, history] = await Promise.all([
    fetchJSON('/api/automations/actions'),
    fetchJSON('/api/automations/history'),
  ]);
  renderAutomationRegistry(actions);
  renderAutomationHistory(history);
}

function renderAutomationRegistry(actions) {
  const container = document.getElementById('automationsRegistry');
  if (!container) return;
  if (!actions.length) {
    container.innerHTML = '<div class="empty-state">No actions in registry.</div>';
    return;
  }
  container.innerHTML = actions.map(a => {
    const params = (a.params || []).filter(p => p.required);
    return `
      <div class="automation-action-card">
        <div class="automation-action-header">
          <span class="automation-action-name">${escapeHtml(a.name)}</span>
          <span class="automation-platform-tag ${a.platform}">${a.platform}</span>
        </div>
        <div class="automation-action-desc">${escapeHtml(a.description || '')}</div>
        <div class="automation-action-footer">
          <div class="automation-params-list">
            ${params.map(p => `<span class="automation-param">${p.name}</span>`).join('')}
          </div>
          <span class="automation-gate-tag ${a.gate}">${a.gate}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderAutomationHistory(history) {
  const container = document.getElementById('automationsHistory');
  if (!container) return;
  if (!history.length) {
    container.innerHTML = '<div class="empty-state">No automation history yet.</div>';
    return;
  }
  container.innerHTML = history.map(h => {
    const approveBtn = h.status === 'pending_approval'
      ? `<div class="automation-history-actions">
          <button class="btn btn-sm btn-success" onclick="approveAutomation('${h.id}')">Approve</button>
          <button class="btn btn-sm btn-secondary" onclick="rejectAutomation('${h.id}')">Reject</button>
        </div>`
      : '';
    return `
      <div class="automation-history-item">
        <div class="automation-history-left">
          <span class="fleet-dot ${h.status === 'completed' ? 'idle' : h.status === 'pending_approval' ? 'waiting' : 'running'}"></span>
          <div>
            <div class="automation-history-action">${escapeHtml(h.action)}</div>
            <div class="automation-history-agent">${h.platform} · triggered by ${h.triggeredBy}</div>
          </div>
        </div>
        <span class="automation-history-status ${h.status}">${h.status.replace(/_/g, ' ')}</span>
        <span style="font-size:11px;color:var(--text-muted);">${timeAgo(h.timestamp)}</span>
        ${approveBtn}
      </div>
    `;
  }).join('');
}

async function approveAutomation(id) {
  await fetchJSON(`/api/automations/${id}/approve`, { method: 'PUT' });
  loadAutomations();
  addTimelineEvent('automation', 'Automation approved and executing');
}

async function rejectAutomation(id) {
  await fetchJSON(`/api/automations/${id}/reject`, { method: 'PUT' });
  loadAutomations();
  addTimelineEvent('automation', 'Automation rejected');
}

// --- Social Intelligence ---
async function loadSocial() {
  const filter = document.getElementById('socialCategoryFilter')?.value || 'all';
  const data = await fetchJSON(`/api/social-intel?category=${filter}`);
  renderSocialStats(data.stats);
  renderSocialFindings(data.findings);

  // Setup filter
  const filterSelect = document.getElementById('socialCategoryFilter');
  if (filterSelect && !filterSelect._bound) {
    filterSelect._bound = true;
    filterSelect.addEventListener('change', () => loadSocial());
  }

  // Setup sweep button
  const sweepBtn = document.getElementById('triggerSocialSweepBtn');
  if (sweepBtn && !sweepBtn._bound) {
    sweepBtn._bound = true;
    sweepBtn.addEventListener('click', triggerSocialSweep);
  }
}

function renderSocialStats(stats) {
  const container = document.getElementById('socialStats');
  if (!container) return;
  container.innerHTML = `
    <div class="radar-stat">
      <div class="radar-stat-value total">${stats.total}</div>
      <div class="radar-stat-label">Findings</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value" style="color:var(--success);">${stats.positive}</div>
      <div class="radar-stat-label">Positive</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value" style="color:var(--warning);">${stats.mixed}</div>
      <div class="radar-stat-label">Mixed</div>
    </div>
    <div class="radar-stat">
      <div class="radar-stat-value" style="color:var(--accent);">${formatEngagement(stats.totalEngagement)}</div>
      <div class="radar-stat-label">Total Engagement</div>
    </div>
  `;
}

function renderSocialFindings(findings) {
  const container = document.getElementById('socialFindings');
  if (!container) return;
  if (!findings.length) {
    container.innerHTML = '<div class="empty-state">No social findings for this category.</div>';
    return;
  }

  findings.sort((a, b) => b.relevance - a.relevance);

  container.innerHTML = findings.map(f => `
    <div class="social-finding">
      <div class="social-finding-header">
        <span class="social-finding-title">${escapeHtml(f.title)}</span>
        <span class="social-source-tag" data-source="${f.source}">${f.source}</span>
      </div>
      <div class="social-finding-author">${escapeHtml(f.author)}</div>
      <div class="social-finding-summary">${escapeHtml(f.summary)}</div>
      <div class="social-finding-footer">
        <div class="social-engagement">
          <span>&#10084; ${formatEngagement(f.engagement.likes)}</span>
          <span>&#8634; ${formatEngagement(f.engagement.reposts)}</span>
          <span>&#128172; ${formatEngagement(f.engagement.replies)}</span>
        </div>
        <span class="social-sentiment ${f.sentiment}">${f.sentiment}</span>
        <span class="radar-relevance">
          <span class="radar-relevance-bar">
            <span class="radar-relevance-fill" style="width: ${f.relevance * 10}%"></span>
          </span>
          ${f.relevance}/10
        </span>
      </div>
    </div>
  `).join('');
}

function formatEngagement(num) {
  if (!num) return '0';
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  return (num / 1000000).toFixed(1) + 'M';
}

async function triggerSocialSweep() {
  const btn = document.getElementById('triggerSocialSweepBtn');
  btn.disabled = true;
  btn.textContent = '↻ Scanning...';

  state.fleetStatus['social-intel'] = 'running';
  renderFleetGrid();

  addTimelineEvent('social', 'Social intelligence sweep initiated');

  await fetchJSON('/api/social-intel/sweep', { method: 'POST', body: {} });

  setTimeout(() => {
    state.fleetStatus['social-intel'] = 'idle';
    renderFleetGrid();
    btn.disabled = false;
    btn.innerHTML = '&#128172; Run Sweep';
    addTimelineEvent('social', 'Social sweep completed');
    loadSocial();
  }, 4000);
}

// --- Pipelines ---
async function loadPipelines() {
  const [pipelines, runs] = await Promise.all([
    fetchJSON('/api/pipelines'),
    fetchJSON('/api/pipelines/runs'),
  ]);
  renderPipelineCards(pipelines);
  renderPipelineRuns(runs);
}

async function loadPipelineRuns() {
  const runs = await fetchJSON('/api/pipelines/runs');
  renderPipelineRuns(runs);
}

function renderPipelineCards(pipelines) {
  const container = document.getElementById('pipelinesAvailable');
  if (!container) return;
  if (!pipelines.length) {
    container.innerHTML = '<div class="empty-state">No pipelines defined. Add YAML files to .claude/pipelines/</div>';
    return;
  }
  container.innerHTML = pipelines.map(p => {
    const stages = p.stages || [];
    const params = p.parameters ? Object.keys(p.parameters) : [];
    const stagePreview = stages.map((s, i) => {
      const arrow = i < stages.length - 1 ? '<span class="pipeline-stage-arrow">→</span>' : '';
      return `<span class="pipeline-stage-chip">${s.agent}</span>${arrow}`;
    }).join('');

    return `
      <div class="pipeline-card">
        <div class="pipeline-card-header">
          <span class="pipeline-card-name">${escapeHtml(p.name.replace(/-/g, ' '))}</span>
          <span class="pipeline-card-time">${p.estimated_time || '~15min'}</span>
        </div>
        <div class="pipeline-card-desc">${escapeHtml(p.description || '')}</div>
        <div class="pipeline-stages-preview">${stagePreview}</div>
        <div class="pipeline-card-footer">
          <div class="pipeline-params">
            ${params.map(k => `<span class="pipeline-param-tag">${k}</span>`).join('')}
          </div>
          <button class="btn btn-sm btn-primary" onclick="launchPipeline('${p.name}')">Run Pipeline</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderPipelineRuns(runs) {
  const container = document.getElementById('pipelineRuns');
  if (!container) return;
  if (!runs.length) {
    container.innerHTML = '<div class="empty-state">No pipeline runs yet. Select a pipeline above to execute.</div>';
    return;
  }
  container.innerHTML = runs.map(run => {
    const stages = run.stages || [];
    const stageFlow = stages.map((s, i) => {
      const statusIcon = s.status === 'completed' ? '✓' : s.status === 'running' ? '⟳' : s.status === 'awaiting_approval' ? '!' : (i + 1);
      const connector = i < stages.length - 1
        ? `<div class="pipeline-stage-connector ${s.status === 'completed' ? 'done' : ''}"></div>`
        : '';
      return `
        <div class="pipeline-stage-node">
          <div class="pipeline-stage-dot ${s.status}">${statusIcon}</div>
          <div class="pipeline-stage-info">
            <div class="pipeline-stage-name">${s.id}</div>
            <div class="pipeline-stage-agent">${s.agent}</div>
          </div>
        </div>
        ${connector}
      `;
    }).join('');

    const approveBtn = run.status === 'awaiting_approval'
      ? `<div class="pipeline-run-actions">
          <button class="btn btn-sm btn-success" onclick="approvePipelineGate('${run.id}')">Approve Gate</button>
        </div>`
      : '';

    return `
      <div class="pipeline-run">
        <div class="pipeline-run-header">
          <span class="pipeline-run-name">${escapeHtml(run.pipeline.replace(/-/g, ' '))}</span>
          <span class="pipeline-run-status ${run.status}">${run.status.replace(/_/g, ' ')}</span>
        </div>
        <div class="pipeline-stages-flow">${stageFlow}</div>
        <div class="pipeline-run-meta">
          <span>Started: ${timeAgo(run.startedAt)}</span>
          ${run.completedAt ? `<span>Completed: ${timeAgo(run.completedAt)}</span>` : ''}
          <span>Stages: ${stages.filter(s => s.status === 'completed').length}/${stages.length}</span>
        </div>
        ${approveBtn}
      </div>
    `;
  }).join('');
}

async function launchPipeline(name) {
  showModal('Launch Pipeline', `
    <p>Execute <strong>${capitalize(name.replace(/-/g, ' '))}</strong>?</p>
    <p style="color: var(--text-secondary); font-size: 13px; margin-top: 8px;">
      This will chain multiple skills and agents together in sequence. You'll see real-time progress in the pipeline view.
    </p>
  `, [
    { label: 'Cancel', class: 'btn-secondary', action: closeModal },
    { label: 'Execute', class: 'btn-success', action: async () => {
      closeModal();
      await fetchJSON(`/api/pipelines/${name}/execute`, { method: 'POST', body: { params: {} } });
      addTimelineEvent('pipeline', `Pipeline launched: ${name}`);
      loadPipelineRuns();
    }},
  ]);
}

async function approvePipelineGate(runId) {
  await fetchJSON(`/api/pipelines/runs/${runId}/approve`, { method: 'POST' });
  loadPipelineRuns();
  addTimelineEvent('approval', 'Pipeline gate approved');
}

// --- Identity ---
async function loadIdentity() {
  const identityFiles = await fetchJSON('/api/identity');
  renderIdentityCards(identityFiles);
}

function renderIdentityCards(files) {
  const container = document.getElementById('identityCards');
  if (!container) return;
  if (!files.length) {
    container.innerHTML = '<div class="empty-state">No identity files found. Add soul.md, user.md, and personality.md to .claude/identity/</div>';
    return;
  }

  const layerDescriptions = {
    soul: 'Non-negotiable guardrails and core values — immutable foundation',
    user: 'Operator preferences, communication style, workflow patterns',
    personality: 'Agent persona definitions and naming conventions',
  };

  container.innerHTML = files.map(f => {
    const layer = f.layer || 'unknown';
    const desc = layerDescriptions[layer] || '';
    const bodyHtml = renderMarkdown(f.body || '');

    return `
      <div class="identity-card">
        <div class="identity-card-header">
          <span class="identity-card-title">${escapeHtml(f.name)}</span>
          <span class="identity-layer-badge ${layer}">${layer}</span>
        </div>
        <div class="identity-card-subtitle">${desc}</div>
        <div class="identity-card-body">${bodyHtml}</div>
        <div class="identity-card-footer">
          <span>Last modified: ${f.meta?.created || 'unknown'}</span>
          ${f.immutable ? '<span class="identity-immutable">IMMUTABLE</span>' : `<button class="btn btn-sm btn-secondary" onclick="viewIdentityFile('${f.name}')">View Full</button>`}
        </div>
      </div>
    `;
  }).join('');
}

async function viewIdentityFile(name) {
  const data = await fetchJSON(`/api/identity/${name}`);
  if (!data.content) return;
  showModal(`Identity: ${name}`, `
    <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;max-height:500px;overflow:auto;background:var(--bg-tertiary);padding:16px;border-radius:var(--radius);line-height:1.6;">${escapeHtml(data.body || data.content)}</pre>
  `, [
    { label: 'Close', class: 'btn-secondary', action: closeModal },
  ]);
}

// --- Verification Protocols ---
async function loadVerification() {
  const [stats, rubrics, history] = await Promise.all([
    fetchJSON('/api/verify/stats'),
    fetchJSON('/api/verify/rubrics'),
    fetchJSON('/api/verify/history'),
  ]);

  renderVerifyStats(stats);
  renderVerifyRubrics(rubrics);
  renderVerifyCategoryRates(stats);
  renderVerifyHistory(history);

  // Setup manual verify button
  const btn = document.getElementById('runManualVerifyBtn');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', showManualVerifyModal);
  }
}

function renderVerifyStats(stats) {
  const container = document.getElementById('verifyStats');
  if (!container) return;

  container.innerHTML = `
    <div class="verify-stat">
      <div class="verify-stat-value">${stats.total}</div>
      <div class="verify-stat-label">Total Checks</div>
    </div>
    <div class="verify-stat">
      <div class="verify-stat-value pass">${stats.passed}</div>
      <div class="verify-stat-label">Passed</div>
    </div>
    <div class="verify-stat">
      <div class="verify-stat-value review">${stats.review}</div>
      <div class="verify-stat-label">Needs Review</div>
    </div>
    <div class="verify-stat">
      <div class="verify-stat-value fail">${stats.failed}</div>
      <div class="verify-stat-label">Failed</div>
    </div>
    <div class="verify-stat">
      <div class="verify-stat-value" style="color: ${stats.passRate >= 80 ? 'var(--success)' : stats.passRate >= 60 ? 'var(--warning)' : 'var(--error)'}">${stats.passRate}%</div>
      <div class="verify-stat-label">Pass Rate</div>
    </div>
  `;
}

function renderVerifyRubrics(rubrics) {
  const container = document.getElementById('verifyRubrics');
  if (!container) return;

  if (!rubrics.length) {
    container.innerHTML = '<div class="empty-state">No rubrics defined.</div>';
    return;
  }

  const categoryIcons = {
    default: '&#9733;', research: '&#128269;', marketing: '&#9998;',
    security: '&#128274;', sales: '&#128176;', design: '&#127912;',
  };

  container.innerHTML = rubrics.map(r => `
    <div class="verify-rubric-card" onclick="viewRubricDetail('${r.id}')">
      <div class="verify-rubric-header">
        <span class="verify-rubric-name">${categoryIcons[r.id] || '&#9989;'} ${escapeHtml(r.name)}</span>
        <span class="verify-rubric-count">${r.checkCount + (r.inherits ? ' + inherited' : '')} checks</span>
      </div>
      <div class="verify-rubric-desc">${escapeHtml(r.description || '')}</div>
    </div>
  `).join('');
}

function renderVerifyCategoryRates(stats) {
  const container = document.getElementById('verifyCategoryRates');
  if (!container) return;

  const categories = Object.entries(stats.byCategory || {});
  if (!categories.length) {
    container.innerHTML = '<div class="empty-state">Run verifications to see category pass rates.</div>';
    return;
  }

  container.innerHTML = categories.map(([cat, data]) => {
    const barClass = data.passRate >= 80 ? 'high' : data.passRate >= 60 ? 'medium' : 'low';
    return `
      <div class="verify-rate-row">
        <span class="verify-rate-label">${cat}</span>
        <div class="verify-rate-bar-wrap">
          <div class="verify-rate-bar ${barClass}" style="width: ${data.passRate}%"></div>
        </div>
        <span class="verify-rate-value" style="color: ${data.passRate >= 80 ? 'var(--success)' : data.passRate >= 60 ? 'var(--warning)' : 'var(--error)'}">${data.passRate}%</span>
        <span class="verify-rate-count">${data.passed}/${data.total}</span>
      </div>
    `;
  }).join('');
}

function renderVerifyHistory(history) {
  const container = document.getElementById('verifyHistory');
  if (!container) return;

  const reviewCount = history.filter(v => v.verdict === 'review' || v.status === 'running').length;
  const badge = document.getElementById('verifyHistoryBadge');
  if (badge) {
    badge.textContent = reviewCount > 0 ? reviewCount : '';
    badge.style.display = reviewCount > 0 ? 'inline-block' : 'none';
  }

  // Update nav badge
  const navBadge = document.getElementById('verifyBadge');
  if (navBadge) {
    if (reviewCount > 0) {
      navBadge.textContent = reviewCount;
      navBadge.classList.add('visible');
    } else {
      navBadge.classList.remove('visible');
    }
  }

  if (!history.length) {
    container.innerHTML = '<div class="empty-state">No verifications run yet. Execute a skill or click "Run Verification" to start.</div>';
    return;
  }

  container.innerHTML = history.map(v => {
    const verdictClass = v.verdict || v.status;
    const checkIcons = {
      pass: '&#10003;',
      partial: '&#9888;',
      fail: '&#10007;',
    };

    const checksHtml = v.results && v.results.length > 0 ? `
      <div class="verify-checks-grid">
        ${v.results.map(r => `
          <div class="verify-check-item">
            <span class="verify-check-icon ${r.status}">${checkIcons[r.status] || '?'}</span>
            <span class="verify-check-name">${escapeHtml(r.name)}</span>
            <span class="verify-check-score">${r.score}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const overrideTag = v.overriddenAt
      ? `<span class="verify-override-tag">Overridden: ${v.overrideReason || 'Human override'}</span>`
      : '';

    const actionBtns = v.status === 'completed' && v.verdict === 'review' && !v.overriddenAt
      ? `<div class="verify-report-actions">
          <button class="btn btn-sm btn-success" onclick="overrideVerification('${v.id}', 'pass')">Approve</button>
          <button class="btn btn-sm btn-secondary" onclick="overrideVerification('${v.id}', 'fail')">Reject</button>
        </div>`
      : '';

    return `
      <div class="verify-report">
        <div class="verify-report-header">
          <span class="verify-report-name">${capitalize(escapeHtml(v.skillName).replace(/-/g, ' '))}${overrideTag}</span>
          <span class="verify-verdict-tag ${verdictClass}">${v.status === 'running' ? 'Running...' : v.verdict}</span>
        </div>
        <div class="verify-score-gauge">
          <div class="verify-score-ring ${verdictClass}">${v.score}</div>
          <div>
            <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(v.rubricName || v.category)}</div>
            <div class="verify-score-breakdown">
              <span class="verify-score-item"><span class="verify-score-dot pass"></span> ${v.checksPassed} passed</span>
              <span class="verify-score-item"><span class="verify-score-dot partial"></span> ${v.checksPartial} partial</span>
              <span class="verify-score-item"><span class="verify-score-dot fail"></span> ${v.checksFailed} failed</span>
            </div>
          </div>
        </div>
        ${checksHtml}
        <div class="verify-report-meta">
          <span>Category: ${v.category}</span>
          <span>Strictness: ${v.strictness}</span>
          <span>${v.checksTotal} checks total</span>
          <span>${timeAgo(v.startedAt)}</span>
        </div>
        ${actionBtns}
      </div>
    `;
  }).join('');
}

async function viewRubricDetail(category) {
  const rubric = await fetchJSON(`/api/verify/rubrics/${category}`);
  if (!rubric.checks) return;

  const categoryWeights = {};
  rubric.checks.forEach(c => {
    if (!categoryWeights[c.category]) categoryWeights[c.category] = [];
    categoryWeights[c.category].push(c);
  });

  const checksHtml = Object.entries(categoryWeights).map(([cat, checks]) => `
    <div style="margin-bottom: 12px;">
      <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; letter-spacing: 0.5px;">${cat}</div>
      ${checks.map(c => `
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border);">
          <span style="font-size: 12px; font-weight: 600; color: var(--accent); width: 20px;">w${c.weight}</span>
          <div style="flex:1;">
            <div style="font-size: 13px; color: var(--text-primary);">${escapeHtml(c.name)}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(c.description)}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');

  showModal(`Rubric: ${rubric.name || category}`, `
    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 16px;">${escapeHtml(rubric.description || '')}</p>
    <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">${rubric.checks.length} checks total · Category: ${rubric.category}</div>
    ${checksHtml}
  `, [
    { label: 'Close', class: 'btn-secondary', action: closeModal },
  ]);
}

function showManualVerifyModal() {
  const strictness = document.getElementById('verifyStrictnessFilter')?.value || 'standard';
  const recentExecs = state.workflows.filter(w => w.status === 'completed').slice(0, 5);

  const execOptions = recentExecs.length > 0
    ? recentExecs.map(w => `<option value="${w.id}">${capitalize((w.skillName || w.skill).replace('.md', '').replace(/-/g, ' '))} (${timeAgo(w.startedAt)})</option>`).join('')
    : '<option value="">No recent executions</option>';

  showModal('Run Verification', `
    <div class="skill-exec-form">
      <div class="form-group">
        <label>Execution to Verify</label>
        <select id="verify-exec">${execOptions}<option value="manual">Manual (no execution)</option></select>
      </div>
      <div class="form-group">
        <label>Rubric Category</label>
        <select id="verify-rubric">
          <option value="auto">Auto-detect</option>
          <option value="default">General Quality</option>
          <option value="research">Research</option>
          <option value="marketing">Marketing/Content</option>
          <option value="security">Security</option>
          <option value="sales">Sales</option>
          <option value="design">Design</option>
        </select>
      </div>
      <div class="form-group">
        <label>Strictness</label>
        <select id="verify-strictness">
          <option value="lenient">Lenient (60% threshold)</option>
          <option value="standard" selected>Standard (75% threshold)</option>
          <option value="strict">Strict (90% threshold)</option>
        </select>
      </div>
    </div>
  `, [
    { label: 'Cancel', class: 'btn-secondary', action: closeModal },
    { label: 'Run Verification', class: 'btn-success', action: async () => {
      const execId = document.getElementById('verify-exec').value;
      const rubric = document.getElementById('verify-rubric').value;
      const strict = document.getElementById('verify-strictness').value;
      closeModal();

      await fetchJSON('/api/verify/run', {
        method: 'POST',
        body: {
          executionId: execId !== 'manual' ? execId : null,
          rubricCategory: rubric,
          strictness: strict,
          skillName: execId === 'manual' ? 'manual-verification' : undefined,
        },
      });

      addTimelineEvent('verification', 'Verification protocol initiated');

      // Animate fleet
      state.fleetStatus.reviewer = 'running';
      renderFleetGrid();
      setTimeout(() => {
        state.fleetStatus.reviewer = 'idle';
        renderFleetGrid();
        loadVerification();
      }, 6000);
    }},
  ]);
}

async function overrideVerification(id, verdict) {
  await fetchJSON(`/api/verify/${id}/override`, {
    method: 'PUT',
    body: { verdict, reason: verdict === 'pass' ? 'Manually approved by operator' : 'Manually rejected by operator' },
  });
  addTimelineEvent('verification', `Verification ${verdict === 'pass' ? 'approved' : 'rejected'} by operator`);
  loadVerification();
}

// --- Context Inheritance ---
async function loadContexts() {
  const data = await fetchJSON('/api/contexts');
  const projects = data.projects || [];
  const activeSlug = data.activeProject;

  // Mark the active project
  projects.forEach(p => { p.active = (p.slug === activeSlug); });

  renderContextActiveBar(projects, activeSlug);
  renderContextProjects(projects);

  // Load resolved context for active project
  if (activeSlug) {
    const resolved = await fetchJSON(`/api/contexts/resolve/${activeSlug}`);
    renderContextResolved(resolved);
  } else {
    renderContextResolved(null);
  }

  // Setup new context button
  const btn = document.getElementById('newContextBtn');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', showNewContextModal);
  }
}

function renderContextActiveBar(projects, activeSlug) {
  const container = document.getElementById('contextActiveBar');
  if (!container) return;

  const active = projects.find(c => c.active);
  if (!active) {
    container.innerHTML = `
      <div class="context-active-indicator">
        <span class="context-active-dot inactive"></span>
        <span class="context-active-label">No active project context — using global defaults</span>
      </div>
    `;
    return;
  }

  const overrideCount = (active.agentOverrides || []).length;
  const featureFlags = [active.hasIdentity && 'identity', active.hasRules && 'rules', active.hasStrategy && 'strategy'].filter(Boolean);

  container.innerHTML = `
    <div class="context-active-indicator">
      <span class="context-active-dot active"></span>
      <span class="context-active-label">Active: <strong>${escapeHtml(active.name)}</strong></span>
      <span class="context-active-overrides">${featureFlags.length} layers · ${overrideCount} agent override${overrideCount !== 1 ? 's' : ''}</span>
      <button class="btn btn-sm btn-secondary" onclick="switchContext(null)" style="margin-left: auto;">Clear Context</button>
    </div>
    ${active.description ? `<div class="context-active-desc">${escapeHtml(active.description)}</div>` : ''}
  `;
}

function renderContextProjects(contexts) {
  const container = document.getElementById('contextProjects');
  if (!container) return;

  if (!contexts.length) {
    container.innerHTML = '<div class="empty-state">No project contexts defined. Click "+ New Project" to create one.</div>';
    return;
  }

  container.innerHTML = contexts.map(ctx => {
    const features = [ctx.hasIdentity && 'identity', ctx.hasRules && 'rules', ctx.hasStrategy && 'strategy'].filter(Boolean);
    const agentOverrides = ctx.agentOverrides || [];

    return `
      <div class="context-project-card ${ctx.active ? 'active' : ''}" onclick="viewProjectDetail('${ctx.slug}')">
        <div class="context-project-header">
          <span class="context-project-name">${escapeHtml(ctx.name)}</span>
          ${ctx.active ? '<span class="context-project-active-badge">ACTIVE</span>' : ''}
        </div>
        <div class="context-project-desc">${escapeHtml(ctx.description || '')}</div>
        <div class="context-project-overrides">
          ${features.map(f => `<span class="context-override-tag">${f}</span>`).join('')}
          ${ctx.stakeholderCount > 0 ? `<span class="context-override-tag">${ctx.stakeholderCount} stakeholder${ctx.stakeholderCount > 1 ? 's' : ''}</span>` : ''}
        </div>
        ${agentOverrides.length > 0 ? `
          <div class="context-project-terms">
            ${agentOverrides.map(a => `<span class="context-term-chip">${escapeHtml(a)}</span>`).join('')}
          </div>
        ` : ''}
        <div class="context-project-footer">
          <span class="context-project-slug">${ctx.slug}</span>
          ${!ctx.active ? `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); switchContext('${ctx.slug}')">Activate</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderContextResolved(data) {
  const container = document.getElementById('contextResolved');
  if (!container) return;

  if (!data || data.level === 'global' && !data.project) {
    container.innerHTML = '<div class="empty-state">Select a project above to preview resolved context.</div>';
    return;
  }

  const r = data.resolved || {};
  const project = data.project || {};
  const domainTerms = r.domain_terms || [];
  const prohibitedTerms = r.prohibited_terms || [];
  const rules = r.rules || {};
  const rulesEntries = Object.entries(rules);
  const strategy = r.strategy || {};
  const stakeholders = r.stakeholders || [];
  const agentOverrides = r.agent_overrides || {};

  container.innerHTML = `
    <div class="context-resolved-grid">
      <div class="context-resolved-section">
        <div class="context-resolved-title">Project</div>
        <div class="context-resolved-items">
          ${project.name ? `<div class="context-resolved-item"><span class="context-resolved-key">Name</span><span class="context-resolved-val">${escapeHtml(project.name)}</span></div>` : ''}
          ${project.slug ? `<div class="context-resolved-item"><span class="context-resolved-key">Slug</span><span class="context-resolved-val">${escapeHtml(project.slug)}</span></div>` : ''}
          ${project.status ? `<div class="context-resolved-item"><span class="context-resolved-key">Status</span><span class="context-resolved-val">${escapeHtml(project.status)}</span></div>` : ''}
        </div>
      </div>
      <div class="context-resolved-section">
        <div class="context-resolved-title">Tone &amp; Voice</div>
        <div class="context-resolved-items">
          ${r.tone ? `<div class="context-resolved-item"><span class="context-resolved-key">Tone</span><span class="context-resolved-val">${escapeHtml(r.tone)}</span></div>` : ''}
          ${r.voice ? `<div class="context-resolved-item"><span class="context-resolved-key">Voice</span><span class="context-resolved-val">${escapeHtml(r.voice)}</span></div>` : ''}
          ${r.audience ? `<div class="context-resolved-item"><span class="context-resolved-key">Audience</span><span class="context-resolved-val">${escapeHtml(r.audience)}</span></div>` : ''}
        </div>
      </div>
      <div class="context-resolved-section">
        <div class="context-resolved-title">Domain Terms (${domainTerms.length})</div>
        <div class="context-term-list">
          ${domainTerms.map(t => `<span class="context-term-chip">${escapeHtml(typeof t === 'string' ? t : t.term || String(t))}</span>`).join('') || '<span class="context-resolved-val" style="color:var(--text-muted);">None</span>'}
        </div>
        ${prohibitedTerms.length > 0 ? `
          <div style="margin-top:8px;">
            <div style="font-size:10px;color:var(--error);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Prohibited</div>
            ${prohibitedTerms.map(t => `<span class="context-term-chip" style="background:rgba(239,68,68,0.15);color:var(--error);">${escapeHtml(t)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
      <div class="context-resolved-section">
        <div class="context-resolved-title">Strategy</div>
        <div class="context-resolved-items">
          ${strategy.icp ? `<div class="context-resolved-item"><span class="context-resolved-key">ICP</span><span class="context-resolved-val">${escapeHtml(strategy.icp)}</span></div>` : ''}
          ${strategy.current_phase ? `<div class="context-resolved-item"><span class="context-resolved-key">Phase</span><span class="context-resolved-val">${escapeHtml(strategy.current_phase)}</span></div>` : ''}
          ${(strategy.competitors || []).length > 0 ? `<div class="context-resolved-item"><span class="context-resolved-key">Competitors</span><span class="context-resolved-val">${strategy.competitors.map(c => escapeHtml(c)).join(', ')}</span></div>` : ''}
        </div>
      </div>
      ${rulesEntries.length > 0 ? `
        <div class="context-resolved-section" style="grid-column: 1 / -1;">
          <div class="context-resolved-title">Active Rules (${rulesEntries.length})</div>
          <div class="context-resolved-items">
            ${rulesEntries.map(([k, v]) => `<div class="context-resolved-item"><span class="context-resolved-key">${escapeHtml(k)}</span><span class="context-resolved-val">${escapeHtml(String(v))}</span></div>`).join('')}
          </div>
        </div>
      ` : ''}
      ${Object.keys(agentOverrides).length > 0 ? `
        <div class="context-resolved-section" style="grid-column: 1 / -1;">
          <div class="context-resolved-title">Agent Overrides</div>
          <div class="context-resolved-items">
            ${Object.entries(agentOverrides).map(([agent, cfg]) => `
              <div class="context-resolved-item">
                <span class="context-resolved-key">${escapeHtml(agent)}</span>
                <span class="context-resolved-val">${escapeHtml(typeof cfg === 'object' ? JSON.stringify(cfg) : String(cfg))}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

async function switchContext(slug) {
  await fetchJSON('/api/contexts/active', { method: 'PUT', body: { slug } });
  addTimelineEvent('context', slug ? `Context switched to: ${slug}` : 'Context cleared — using global defaults');

  // Animate fleet
  state.fleetStatus.orchestrator = 'running';
  renderFleetGrid();
  setTimeout(() => {
    state.fleetStatus.orchestrator = 'idle';
    renderFleetGrid();
  }, 1500);

  loadContexts();
}

async function viewProjectDetail(slug) {
  const resolved = await fetchJSON(`/api/contexts/resolve/${slug}`);
  renderContextResolved(resolved);

  // Scroll to resolved section
  const section = document.getElementById('contextResolved');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showNewContextModal() {
  showModal('New Project Context', `
    <div class="skill-exec-form">
      <div class="form-group">
        <label>Project Name<span class="required-star">*</span></label>
        <input type="text" id="ctx-name" placeholder="e.g. Client Acme Campaign" />
      </div>
      <div class="form-group">
        <label>Slug<span class="required-star">*</span></label>
        <input type="text" id="ctx-slug" placeholder="e.g. client-acme" />
        <span class="form-hint">Lowercase, hyphens only. Used as the config filename.</span>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="ctx-desc" placeholder="Brief project description" />
      </div>
      <div class="form-group">
        <label>Tone / Voice Override</label>
        <select id="ctx-tone">
          <option value="">Use global default</option>
          <option value="professional">Professional</option>
          <option value="conversational">Conversational</option>
          <option value="technical">Technical</option>
          <option value="creative">Creative</option>
          <option value="formal">Formal</option>
        </select>
      </div>
      <div class="form-group">
        <label>Audience</label>
        <input type="text" id="ctx-audience" placeholder="e.g. enterprise CTOs, indie authors" />
      </div>
      <div class="form-group">
        <label>Domain Terms (comma-separated)</label>
        <input type="text" id="ctx-terms" placeholder="e.g. ARR, churn rate, NPS" />
      </div>
    </div>
  `, [
    { label: 'Cancel', class: 'btn-secondary', action: closeModal },
    { label: 'Create Project', class: 'btn-success', action: async () => {
      const name = document.getElementById('ctx-name').value.trim();
      const slug = document.getElementById('ctx-slug').value.trim();
      if (!name || !slug) {
        ['ctx-name', 'ctx-slug'].forEach(id => {
          const el = document.getElementById(id);
          if (!el.value.trim()) el.style.borderColor = 'var(--error)';
        });
        return;
      }

      const desc = document.getElementById('ctx-desc').value.trim();
      const tone = document.getElementById('ctx-tone').value;
      const audience = document.getElementById('ctx-audience').value.trim();
      const terms = document.getElementById('ctx-terms').value.trim();

      closeModal();

      await fetchJSON('/api/contexts', {
        method: 'POST',
        body: {
          name, slug, description: desc,
          overrides: {
            tone: tone ? { voice: tone } : undefined,
            audience: audience ? { primary: audience } : undefined,
            domain_terms: terms ? terms.split(',').map(t => t.trim()).filter(Boolean) : undefined,
          },
        },
      });

      addTimelineEvent('context', `Project context created: ${name}`);
      loadContexts();
    }},
  ]);
}

// --- Grok Real-Time Intelligence ---
async function loadGrok() {
  await Promise.all([loadGrokStats(), loadGrokHistory()]);

  // Setup query console
  const sendBtn = document.getElementById('grokSendBtn');
  if (sendBtn && !sendBtn._bound) {
    sendBtn._bound = true;
    sendBtn.addEventListener('click', sendGrokQuery);
  }
  const input = document.getElementById('grokQueryInput');
  if (input && !input._bound) {
    input._bound = true;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendGrokQuery();
    });
  }
  const clearCacheBtn = document.getElementById('grokClearCacheBtn');
  if (clearCacheBtn && !clearCacheBtn._bound) {
    clearCacheBtn._bound = true;
    clearCacheBtn.addEventListener('click', async () => {
      await fetchJSON('/api/grok/cache/clear', { method: 'POST' });
      loadGrokStats();
    });
  }
}

async function loadGrokStats() {
  const stats = await fetchJSON('/api/grok/stats');
  renderGrokStats(stats);
}

async function loadGrokHistory() {
  const queries = await fetchJSON('/api/grok/queries');
  renderGrokHistory(queries);
}

function renderGrokStats(stats) {
  const container = document.getElementById('grokStats');
  if (!container) return;

  // Update rate limit display
  const rateEl = document.getElementById('grokRateLimit');
  if (rateEl) {
    rateEl.textContent = `${stats.rateLimitRemaining}/${stats.rateLimit} queries/hr`;
    rateEl.style.color = stats.rateLimitRemaining < 5 ? 'var(--error)' : 'var(--text-muted)';
  }

  const typeIcons = { search: '&#128269;', trending: '&#128200;', 'fact-check': '&#9989;', monitor: '&#128225;' };

  container.innerHTML = `
    <div class="grok-stat">
      <div class="grok-stat-value">${stats.total}</div>
      <div class="grok-stat-label">Total Queries</div>
    </div>
    <div class="grok-stat">
      <div class="grok-stat-value" style="color: var(--success);">${stats.completed}</div>
      <div class="grok-stat-label">Completed</div>
    </div>
    <div class="grok-stat">
      <div class="grok-stat-value" style="color: var(--accent);">${stats.streaming}</div>
      <div class="grok-stat-label">Streaming</div>
    </div>
    <div class="grok-stat">
      <div class="grok-stat-value">${stats.avgConfidence ? Math.round(stats.avgConfidence * 100) + '%' : '—'}</div>
      <div class="grok-stat-label">Avg Confidence</div>
    </div>
    <div class="grok-stat">
      <div class="grok-stat-value">${formatTokenCount(stats.totalTokens)}</div>
      <div class="grok-stat-label">Tokens Used</div>
    </div>
    <div class="grok-stat">
      <div class="grok-stat-value">$${(stats.totalCost || 0).toFixed(3)}</div>
      <div class="grok-stat-label">Total Cost</div>
    </div>
    ${stats.byType && Object.keys(stats.byType).length > 0 ? `
      <div class="grok-stat-types">
        ${Object.entries(stats.byType).map(([type, count]) => `
          <span class="grok-type-chip ${type}">${typeIcons[type] || '&#9889;'} ${type}: ${count}</span>
        `).join('')}
        <span class="grok-type-chip" style="background:rgba(156,163,175,0.1);color:var(--text-muted);">Cache: ${stats.cacheSize || 0} entries</span>
      </div>
    ` : ''}
  `;
}

function renderGrokHistory(queries) {
  const container = document.getElementById('grokHistory');
  if (!container) return;

  if (!queries.length) {
    container.innerHTML = '<div class="empty-state">No queries yet. Try the console above.</div>';
    return;
  }

  container.innerHTML = queries.map(q => {
    const confClass = q.confidence >= 0.85 ? 'high' : q.confidence >= 0.7 ? 'medium' : 'low';
    const duration = q.completedAt && q.startedAt
      ? `${((new Date(q.completedAt) - new Date(q.startedAt)) / 1000).toFixed(1)}s`
      : q.status === 'streaming' ? 'Streaming...' : '—';

    return `
      <div class="grok-history-card" onclick="expandGrokQuery('${q.id}')">
        <div class="grok-history-header">
          <span class="grok-history-query">${escapeHtml(q.query)}</span>
          <span class="grok-query-type-tag ${q.type}">${q.type}</span>
        </div>
        <div class="grok-history-response">${escapeHtml(q.response || 'Streaming...')}</div>
        ${q.sources && q.sources.length > 0 ? `
          <div class="grok-history-sources">
            ${q.sources.map(s => `<span class="grok-history-source-chip" title="${escapeHtml(s.url)}">${escapeHtml(s.title)}</span>`).join('')}
          </div>
        ` : ''}
        <div class="grok-history-meta">
          <span><span class="grok-confidence ${confClass}">${Math.round(q.confidence * 100)}% conf</span></span>
          <span>Tokens: ${formatTokenCount((q.tokens?.input || 0) + (q.tokens?.output || 0))}</span>
          <span>Cost: $${(q.cost || 0).toFixed(4)}</span>
          <span>Duration: ${duration}</span>
          <span>${timeAgo(q.startedAt)}</span>
          ${q.cached ? '<span style="color:var(--warning);">&#9889; Cached</span>' : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderGrokStreamResult(data) {
  const output = document.getElementById('grokStreamOutput');
  if (!output) return;

  output.classList.remove('streaming');

  const confClass = data.confidence >= 0.85 ? 'high' : data.confidence >= 0.7 ? 'medium' : 'low';

  let html = `<div>${escapeHtml(data.response)}</div>`;

  if (data.sources && data.sources.length > 0) {
    html += `<div class="grok-stream-sources">
      ${data.sources.map(s => `
        <div class="grok-source-item">
          <span class="grok-source-relevance">${Math.round(s.relevance * 100)}%</span>
          <span>${escapeHtml(s.title)}</span>
        </div>
      `).join('')}
    </div>`;
  }

  html += `<div class="grok-stream-meta">
    <span class="grok-confidence ${confClass}">${Math.round(data.confidence * 100)}% confidence</span>
    <span>Tokens: ${formatTokenCount((data.tokens?.input || 0) + (data.tokens?.output || 0))}</span>
    <span>Cost: $${(data.cost || 0).toFixed(4)}</span>
    <span>Type: ${data.type}</span>
    <span>Scope: ${data.scope}</span>
  </div>`;

  output.innerHTML = html;
}

async function sendGrokQuery() {
  const input = document.getElementById('grokQueryInput');
  const query = input.value.trim();
  if (!query) {
    input.style.borderColor = 'var(--error)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }

  const type = document.getElementById('grokQueryType').value;
  const scope = document.getElementById('grokQueryScope').value;

  input.value = '';

  // Show streaming state
  const output = document.getElementById('grokStreamOutput');
  if (output) {
    output.classList.add('streaming');
    output.innerHTML = `<span style="color:var(--text-muted);">Querying Grok (${type})...</span><span class="grok-stream-cursor"></span>`;
  }

  // Animate fleet
  state.fleetStatus['grok-realtime'] = 'running';
  renderFleetGrid();

  await fetchJSON('/api/grok/query', {
    method: 'POST',
    body: { query, type, scope, include_sources: true },
  });

  addTimelineEvent('grok', `Grok query sent: ${type} — "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);
}

function expandGrokQuery(id) {
  // Find query in history
  fetchJSON('/api/grok/queries').then(queries => {
    const q = queries.find(x => x.id === id);
    if (!q) return;

    const confClass = q.confidence >= 0.85 ? 'high' : q.confidence >= 0.7 ? 'medium' : 'low';

    const sourcesHtml = q.sources.length > 0 ? `
      <div style="margin-top:12px;">
        <div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px;letter-spacing:0.5px;">Sources</div>
        ${q.sources.map(s => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
            <span class="grok-source-relevance">${Math.round(s.relevance * 100)}%</span>
            <span style="font-size:12px;color:var(--text-secondary);">${escapeHtml(s.title)}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    showModal(`Grok Query: ${q.type}`, `
      <div style="margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">${escapeHtml(q.query)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <span class="grok-query-type-tag ${q.type}">${q.type}</span>
          <span class="grok-confidence ${confClass}">${Math.round(q.confidence * 100)}% confidence</span>
          <span style="font-size:11px;color:var(--text-muted);">Scope: ${q.scope}</span>
        </div>
      </div>
      <div style="background:var(--bg-tertiary);padding:14px;border-radius:var(--radius);font-size:13px;line-height:1.7;color:var(--text-secondary);">
        ${escapeHtml(q.response)}
      </div>
      ${sourcesHtml}
      <div style="margin-top:12px;display:flex;gap:16px;font-size:11px;color:var(--text-muted);">
        <span>Tokens: ${formatTokenCount((q.tokens?.input||0)+(q.tokens?.output||0))}</span>
        <span>Cost: $${(q.cost||0).toFixed(4)}</span>
        <span>${timeAgo(q.startedAt)}</span>
      </div>
    `, [
      { label: 'Close', class: 'btn-secondary', action: closeModal },
    ]);
  });
}

// --- Browser Agent ---
async function loadBrowser() {
  const [stats, tasks] = await Promise.all([
    fetchJSON('/api/browser/stats'),
    fetchJSON('/api/browser/tasks'),
  ]);

  renderBrowserStats(stats);
  renderBrowserTasks(tasks);

  // Setup new task button
  const btn = document.getElementById('newBrowserTaskBtn');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', showNewBrowserTaskModal);
  }
}

function renderBrowserStats(stats) {
  const container = document.getElementById('browserStats');
  if (!container) return;

  const typeIcons = {
    navigate: '&#128640;',
    extract: '&#128203;',
    screenshot: '&#128247;',
    'form-fill': '&#9997;',
    verify: '&#9989;',
  };

  container.innerHTML = `
    <div class="browser-stat">
      <div class="browser-stat-value">${stats.total || 0}</div>
      <div class="browser-stat-label">Total Tasks</div>
    </div>
    <div class="browser-stat">
      <div class="browser-stat-value" style="color: var(--success);">${stats.completed || 0}</div>
      <div class="browser-stat-label">Completed</div>
    </div>
    <div class="browser-stat">
      <div class="browser-stat-value" style="color: var(--accent);">${stats.running || 0}</div>
      <div class="browser-stat-label">Running</div>
    </div>
    <div class="browser-stat">
      <div class="browser-stat-value" style="color: var(--error);">${stats.failed || 0}</div>
      <div class="browser-stat-label">Failed</div>
    </div>
    ${stats.byType ? `
      <div class="browser-stat-types">
        ${Object.entries(stats.byType).map(([type, count]) => `
          <span class="browser-type-chip ${type}">${typeIcons[type] || '&#127760;'} ${type}: ${count}</span>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderBrowserTasks(tasks) {
  const container = document.getElementById('browserTasks');
  if (!container) return;

  if (!tasks.length) {
    container.innerHTML = '<div class="empty-state">No browser tasks yet. Click "+ New Task" to start.</div>';
    return;
  }

  const typeIcons = {
    navigate: '&#128640;',
    extract: '&#128203;',
    screenshot: '&#128247;',
    'form-fill': '&#9997;',
    verify: '&#9989;',
  };

  container.innerHTML = tasks.map(task => {
    const icon = typeIcons[task.taskType] || '&#127760;';
    const duration = task.completedAt && task.startedAt
      ? `${((new Date(task.completedAt) - new Date(task.startedAt)) / 1000).toFixed(1)}s`
      : task.status === 'running' ? 'In progress...' : '—';

    const resultHtml = task.result ? `
      <div class="browser-task-result">
        ${task.result.screenshot ? `<div class="browser-result-item"><span class="browser-result-label">Screenshot:</span> ${escapeHtml(task.result.screenshot)}</div>` : ''}
        ${task.result.title ? `<div class="browser-result-item"><span class="browser-result-label">Title:</span> ${escapeHtml(task.result.title)}</div>` : ''}
        ${task.result.elementsFound ? `<div class="browser-result-item"><span class="browser-result-label">Elements:</span> ${task.result.elementsFound} found</div>` : ''}
        ${task.result.dataExtracted ? `<div class="browser-result-item"><span class="browser-result-label">Data:</span> ${escapeHtml(task.result.dataExtracted)}</div>` : ''}
        ${task.result.error ? `<div class="browser-result-item error"><span class="browser-result-label">Error:</span> ${escapeHtml(task.result.error)}</div>` : ''}
      </div>
    ` : '';

    return `
      <div class="browser-task-card">
        <div class="browser-task-header">
          <span class="browser-task-type ${task.taskType}">${icon} ${task.taskType}</span>
          <span class="browser-task-status ${task.status}">${task.status}</span>
        </div>
        <div class="browser-task-url">${escapeHtml(task.url || '—')}</div>
        ${task.selector ? `<div class="browser-task-selector">Selector: <code>${escapeHtml(task.selector)}</code></div>` : ''}
        ${resultHtml}
        <div class="browser-task-meta">
          <span>Viewport: ${task.viewport || 'desktop'}</span>
          <span>Duration: ${duration}</span>
          <span>${timeAgo(task.startedAt)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function showNewBrowserTaskModal() {
  showModal('New Browser Task', `
    <div class="skill-exec-form">
      <div class="form-group">
        <label>URL<span class="required-star">*</span></label>
        <input type="text" id="browser-url" placeholder="https://example.com" />
      </div>
      <div class="form-group">
        <label>Task Type</label>
        <select id="browser-type">
          <option value="navigate">Navigate — Load page</option>
          <option value="extract">Extract — Pull data</option>
          <option value="screenshot">Screenshot — Capture page</option>
          <option value="form-fill">Form Fill — Interact with forms</option>
          <option value="verify">Verify — Check layout/content</option>
        </select>
      </div>
      <div class="form-group">
        <label>CSS Selector (optional)</label>
        <input type="text" id="browser-selector" placeholder="e.g. .pricing-table, #main-content" />
        <span class="form-hint">Target specific elements for extraction or interaction.</span>
      </div>
      <div class="form-group">
        <label>Viewport</label>
        <select id="browser-viewport">
          <option value="desktop">Desktop (1920×1080)</option>
          <option value="tablet">Tablet (768×1024)</option>
          <option value="mobile">Mobile (375×812)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Wait For</label>
        <select id="browser-wait">
          <option value="networkidle">Network Idle (recommended)</option>
          <option value="load">Page Load</option>
          <option value="selector">Selector Visible</option>
        </select>
      </div>
    </div>
  `, [
    { label: 'Cancel', class: 'btn-secondary', action: closeModal },
    { label: 'Execute Task', class: 'btn-success', action: async () => {
      const url = document.getElementById('browser-url').value.trim();
      if (!url) {
        document.getElementById('browser-url').style.borderColor = 'var(--error)';
        return;
      }

      const taskType = document.getElementById('browser-type').value;
      const selector = document.getElementById('browser-selector').value.trim();
      const viewport = document.getElementById('browser-viewport').value;
      const waitFor = document.getElementById('browser-wait').value;

      closeModal();

      await executeBrowserTask({ url, taskType, selector, viewport, waitFor });
    }},
  ]);
}

async function executeBrowserTask(params) {
  const result = await fetchJSON('/api/browser/execute', {
    method: 'POST',
    body: params,
  });

  addTimelineEvent('browser', `Browser task launched: ${params.taskType} — ${params.url}`);

  // Animate fleet
  state.fleetStatus['browser-agent'] = 'running';
  renderFleetGrid();

  setTimeout(() => {
    state.fleetStatus['browser-agent'] = 'idle';
    renderFleetGrid();
    // Refresh if still on browser view
    if (document.getElementById('view-browser').classList.contains('active')) {
      loadBrowser();
    }
  }, 5000);
}

// =============================
// KNOWLEDGE GRAPH
// =============================
async function loadKnowledge() {
  const [graph, stats] = await Promise.all([
    fetchJSON('/api/knowledge-graph'),
    fetchJSON('/api/knowledge-graph/stats'),
  ]);
  const nodes = graph.nodes || [];
  renderKnowledgeStats(stats);
  renderKnowledgeSources(nodes);
  renderKnowledgeGraph(nodes);
}

function renderKnowledgeStats(stats) {
  const container = document.getElementById('knowledgeStats');
  if (!container) return;
  const categoryCount = stats.categories ? Object.keys(stats.categories).length : (stats.byType ? Object.keys(stats.byType).length : 0);
  container.innerHTML = `
    <div class="knowledge-stat">
      <div class="knowledge-stat-value">${stats.totalNodes || 0}</div>
      <div class="knowledge-stat-label">Total Sources</div>
    </div>
    <div class="knowledge-stat">
      <div class="knowledge-stat-value">${categoryCount}</div>
      <div class="knowledge-stat-label">Categories</div>
    </div>
    <div class="knowledge-stat">
      <div class="knowledge-stat-value">${stats.totalConnections || 0}</div>
      <div class="knowledge-stat-label">Connections</div>
    </div>
    <div class="knowledge-stat">
      <div class="knowledge-stat-value">${stats.totalTags || 0}</div>
      <div class="knowledge-stat-label">Total Tags</div>
    </div>
    <div class="knowledge-stat">
      <div class="knowledge-stat-value">${stats.avgConnections || 0}</div>
      <div class="knowledge-stat-label">Avg Links</div>
    </div>
  `;
}

function renderKnowledgeSources(sources) {
  const container = document.getElementById('knowledgeSources');
  if (!container) return;
  const badge = document.getElementById('knowledgeSourcesBadge');
  if (badge) badge.textContent = sources.length;

  if (!sources.length) {
    container.innerHTML = '<div class="empty-state">No sources yet. Add documents, links, or notes to build the graph.</div>';
    return;
  }

  const typeIcons = { wiki: '&#128196;', docs: '&#128213;', research: '&#128270;', outputs: '&#128230;', raw: '&#128221;', document: '&#128196;', link: '&#128279;', pdf: '&#128213;', video: '&#127916;', note: '&#128221;' };

  container.innerHTML = sources.map(s => `
    <div class="knowledge-source-card">
      <div class="knowledge-source-icon ${s.type}">${typeIcons[s.type] || '&#128196;'}</div>
      <div class="knowledge-source-info">
        <div class="knowledge-source-title">${escapeHtml(s.label || s.title || s.id)}</div>
        <div class="knowledge-source-meta">${s.type} &middot; ${s.connections ? s.connections.length + ' links' : '0 links'}</div>
        ${s.tags && s.tags.length > 0 ? `
          <div class="knowledge-source-tags">
            ${s.tags.map(t => `<span class="knowledge-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function renderKnowledgeGraph(sources) {
  const container = document.getElementById('knowledgeGraphViz');
  if (!container || !sources.length) return;

  // Simple radial layout visualization
  const cx = 150, cy = 150, radius = 110;
  const nodes = sources.slice(0, 12);
  const typeColors = { wiki: '#3b82f6', docs: '#8b5cf6', research: '#10b981', outputs: '#f59e0b', raw: '#6b7280', document: '#6366f1', link: '#3b82f6', pdf: '#ef4444', video: '#f59e0b', note: '#10b981' };
  const typeIcons = { wiki: '&#128196;', docs: '&#128213;', research: '&#128270;', outputs: '&#128230;', raw: '&#128221;' };

  container.innerHTML = nodes.map((s, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const x = cx + radius * Math.cos(angle) - 24;
    const y = cy + radius * Math.sin(angle) - 24;
    const color = typeColors[s.type] || '#6366f1';
    return `<div class="knowledge-node" style="left:${x}px;top:${y}px;border-color:${color};" title="${escapeHtml(s.label || s.id)}">
      ${typeIcons[s.type] || '&#128196;'}
    </div>`;
  }).join('') + `<div class="knowledge-node" style="left:${cx-24}px;top:${cy-24}px;border-color:var(--accent);background:var(--accent-dim);font-size:14px;">&#129504;</div>`;
}

async function knowledgeAutoCategorize() {
  const result = await fetchJSON('/api/knowledge-graph/auto-categorize', { method: 'POST', body: {} });
  if (result) {
    addTimelineEvent('knowledge', `Auto-categorized ${result.processed || 0} sources`);
    loadKnowledge();
  }
}

// Setup knowledge event listeners
document.addEventListener('DOMContentLoaded', () => {
  const autoBtn = document.getElementById('knowledgeAutoBtn');
  if (autoBtn) autoBtn.addEventListener('click', knowledgeAutoCategorize);
});

// =============================
// DESIGN SYSTEM PROTOCOL
// =============================
async function loadDesignSystem() {
  const [system, tokens] = await Promise.all([
    fetchJSON('/api/design-system'),
    fetchJSON('/api/design-system/tokens'),
  ]);
  renderDesignStats(system, tokens);
  renderDesignReasoning(system);
  renderDesignTokens(tokens);
  renderDesignPalette(tokens);
  renderDesignComponents(system.components || []);
  // Show linter results if available from system
  if (system.linterResults) {
    renderDesignLinterResults({ issues: system.linterResults.map(r => ({ severity: r.status === 'warning' ? 'warning' : r.status === 'pass' ? 'pass' : 'error', message: r.message, rule: r.rule })) });
  }
}

function renderDesignStats(system, tokens) {
  const container = document.getElementById('designStats');
  if (!container) return;
  const meta = system.meta || {};
  const colorCount = tokens && tokens.colors ? Object.keys(tokens.colors).length : 0;
  const spacingCount = tokens && tokens.spacing ? Object.keys(tokens.spacing).length : 0;
  const radiusCount = tokens && tokens.radius ? Object.keys(tokens.radius).length : 0;
  const totalTokens = colorCount + spacingCount + radiusCount + (tokens && tokens.typography && tokens.typography.scale ? tokens.typography.scale.length : 0);
  const wcagPass = meta.linterPassed !== false;
  container.innerHTML = `
    <div class="design-stat">
      <div class="design-stat-value">${totalTokens}</div>
      <div class="design-stat-label">Total Tokens</div>
    </div>
    <div class="design-stat">
      <div class="design-stat-value">${colorCount}</div>
      <div class="design-stat-label">Color Roles</div>
    </div>
    <div class="design-stat">
      <div class="design-stat-value">${system.skills ? system.skills.length : 0}</div>
      <div class="design-stat-label">Skills</div>
    </div>
    <div class="design-stat">
      <div class="design-stat-value" style="color:${wcagPass ? 'var(--success)' : 'var(--warning)'};">${meta.wcagLevel || 'AA'}</div>
      <div class="design-stat-label">WCAG Level</div>
    </div>
  `;
}

function renderDesignTokens(tokens) {
  const container = document.getElementById('designTokens');
  if (!container) return;

  if (!tokens) {
    container.innerHTML = '<div class="empty-state">No tokens defined. Create a DESIGN.md to start.</div>';
    return;
  }

  let html = '';

  // Colors group
  if (tokens.colors) {
    html += `<div class="design-token-group"><div class="design-token-group-title">Colors</div>`;
    html += Object.entries(tokens.colors).map(([name, c]) => `
      <div class="design-token-row">
        <div class="design-token-swatch" style="background:${c.hex};"></div>
        <span class="design-token-name">--color-${name}</span>
        <span class="design-token-value">${c.hex}</span>
      </div>
    `).join('');
    html += `</div>`;
  }

  // Spacing group
  if (tokens.spacing) {
    html += `<div class="design-token-group"><div class="design-token-group-title">Spacing</div>`;
    html += Object.entries(tokens.spacing).map(([name, val]) => `
      <div class="design-token-row">
        <span class="design-token-name">--space-${name}</span>
        <span class="design-token-value">${val}</span>
      </div>
    `).join('');
    html += `</div>`;
  }

  // Radius group
  if (tokens.radius) {
    html += `<div class="design-token-group"><div class="design-token-group-title">Border Radius</div>`;
    html += Object.entries(tokens.radius).map(([name, val]) => `
      <div class="design-token-row">
        <span class="design-token-name">--radius-${name}</span>
        <span class="design-token-value">${val}</span>
      </div>
    `).join('');
    html += `</div>`;
  }

  // Typography
  if (tokens.typography && tokens.typography.scale) {
    html += `<div class="design-token-group"><div class="design-token-group-title">Typography</div>`;
    html += tokens.typography.scale.map(t => `
      <div class="design-token-row">
        <span class="design-token-name">--text-${t.name}</span>
        <span class="design-token-value">${t.size} / ${t.lineHeight}</span>
      </div>
    `).join('');
    html += `</div>`;
  }

  container.innerHTML = html || '<div class="empty-state">No tokens defined.</div>';
}

function renderDesignPalette(tokens) {
  const container = document.getElementById('designPalette');
  if (!container) return;

  if (!tokens || !tokens.colors) {
    container.innerHTML = '<div class="empty-state">No color palette defined yet.</div>';
    return;
  }

  // Group by hierarchy
  const hierarchyOrder = ['neutral', 'primary-ink', 'secondary', 'tertiary', 'semantic'];
  const grouped = {};
  Object.entries(tokens.colors).forEach(([name, c]) => {
    const h = c.hierarchy || 'other';
    if (!grouped[h]) grouped[h] = [];
    grouped[h].push({ name, ...c });
  });

  let html = '<div class="design-hierarchy-grid">';
  hierarchyOrder.forEach(h => {
    if (!grouped[h]) return;
    const hierarchyLabel = h === 'primary-ink' ? 'Primary (Ink)' : h.charAt(0).toUpperCase() + h.slice(1);
    html += `<div class="design-hierarchy-group">
      <div class="design-hierarchy-label">${hierarchyLabel}</div>
      ${grouped[h].map(c => `
        <div class="design-color-card">
          <div class="design-color-preview" style="background:${c.hex};"></div>
          <div class="design-color-info">
            <div class="design-color-role">${escapeHtml(c.name)}</div>
            <div class="design-color-hex">${c.hex} ${c.wcag && !c.wcag.passes ? '<span style="color:var(--warning);">&#9888;</span>' : '<span style="color:var(--success);">&#9989;</span>'}</div>
            <div class="design-color-usage" title="${escapeHtml(c.usage || '')}">${escapeHtml(c.role || '')}</div>
            ${c.screenPct ? `<div class="design-color-pct">${escapeHtml(c.screenPct)} of screen</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

async function runDesignLinter() {
  const container = document.getElementById('designLinter');
  if (container) container.innerHTML = '<div class="empty-state">Running linter...</div>';

  const result = await fetchJSON('/api/design-system/lint', { method: 'POST', body: {} });
  if (!result) return;

  const issues = (result.results || []).map(r => ({
    severity: r.status === 'warning' ? 'warning' : r.status === 'pass' ? 'pass' : 'error',
    message: r.message,
    rule: r.rule,
  }));

  renderDesignLinterResults({ issues });

  const warnings = issues.filter(i => i.severity === 'warning').length;
  const passed = issues.filter(i => i.severity === 'pass').length;
  addTimelineEvent('design', `Linter run: ${passed} passed, ${warnings} warnings`);
}

function renderDesignLinterResults(result) {
  const container = document.getElementById('designLinter');
  if (!container) return;

  if (!result.issues || !result.issues.length) {
    container.innerHTML = '<div class="empty-state" style="color:var(--success);">&#9989; All checks passed! No issues found.</div>';
    return;
  }

  container.innerHTML = result.issues.map(issue => {
    const iconClass = issue.severity === 'error' ? 'fail' : issue.severity === 'warning' ? 'warn' : 'pass';
    const icon = issue.severity === 'error' ? '&#10060;' : issue.severity === 'warning' ? '&#9888;' : '&#9989;';
    return `
      <div class="design-lint-item">
        <span class="design-lint-icon ${iconClass}">${icon}</span>
        <div>
          <div class="design-lint-text">${escapeHtml(issue.message)}</div>
          <div class="design-lint-rule">${escapeHtml(issue.rule || '')}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderDesignReasoning(system) {
  const container = document.getElementById('designReasoning');
  if (!container || !system.reasoning) return;

  container.innerHTML = Object.entries(system.reasoning).map(([key, value]) => `
    <div class="design-reasoning-card">
      <div class="design-reasoning-label">${escapeHtml(key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()))}</div>
      <div class="design-reasoning-value">${escapeHtml(value)}</div>
    </div>
  `).join('');
}

function renderDesignComponents(components) {
  const container = document.getElementById('designComponents');
  if (!container) return;

  if (!components.length) {
    container.innerHTML = '<div class="empty-state">No component references defined yet.</div>';
    return;
  }

  container.innerHTML = `
    <div class="design-components-grid">
      ${components.map(c => `
        <div class="design-component-card">
          <div class="design-component-name">${escapeHtml(c.name)}</div>
          <div class="design-component-props">
            <span class="design-component-prop" title="Background role"><span class="prop-label">bg</span> ${escapeHtml(c.background)}</span>
            <span class="design-component-prop" title="Text role"><span class="prop-label">text</span> ${escapeHtml(c.text)}</span>
            <span class="design-component-prop" title="Border radius"><span class="prop-label">radius</span> ${escapeHtml(c.radius)}</span>
            ${c.border ? `<span class="design-component-prop" title="Border role"><span class="prop-label">border</span> ${escapeHtml(c.border)}</span>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function cloneBrandFromUrl() {
  const url = document.getElementById('brandCloneUrl').value.trim();
  if (!url) return;
  const statusEl = document.getElementById('brandCloneStatus');
  statusEl.innerHTML = '<div class="empty-state" style="color:var(--primary);">&#9881; Extracting brand identity...</div>';

  const result = await fetchJSON('/api/design-system/clone-url', { method: 'POST', body: { url } });
  if (result && result.ok) {
    statusEl.innerHTML = `<div class="empty-state" style="color:var(--success);">&#9989; Scanning: ${escapeHtml(result.extracting.join(', '))}. ${escapeHtml(result.estimated)}</div>`;
    setTimeout(() => {
      statusEl.innerHTML = '<div class="empty-state" style="color:var(--success);">&#9989; Brand extracted! Refresh Design System to see updated tokens.</div>';
    }, 4500);
  } else {
    statusEl.innerHTML = '<div class="empty-state" style="color:var(--error);">&#10060; Failed to initiate brand clone.</div>';
  }
}

async function exportDesignSystem() {
  const target = document.getElementById('exportTargetSelect').value;
  const previewEl = document.getElementById('exportPreview');
  previewEl.innerHTML = '<div class="empty-state" style="color:var(--primary);">Generating...</div>';

  const result = await fetchJSON(`/api/design-system/export?target=${target}`);
  if (result && result.ok) {
    previewEl.innerHTML = `
      <div class="design-export-preview">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span class="badge badge-success">${escapeHtml(result.filename)}</span>
          <span style="color:var(--text-muted);font-size:11px;">Compatible: ${result.compatibleWith.join(', ')}</span>
        </div>
        <pre class="design-export-code">${escapeHtml(result.content.substring(0, 600))}${result.content.length > 600 ? '\n...' : ''}</pre>
      </div>
    `;
  }
}

// Setup design system event listeners
document.addEventListener('DOMContentLoaded', () => {
  const lintBtn = document.getElementById('designLintBtn');
  if (lintBtn) lintBtn.addEventListener('click', runDesignLinter);

  // Brand Clone modal
  const cloneBtn = document.getElementById('designCloneBtn');
  const cloneModal = document.getElementById('brandCloneModal');
  const cloneClose = document.getElementById('brandCloneClose');
  const cloneCancel = document.getElementById('brandCloneCancelBtn');
  const cloneSubmit = document.getElementById('brandCloneSubmitBtn');
  if (cloneBtn) cloneBtn.addEventListener('click', () => { cloneModal.style.display = 'flex'; });
  if (cloneClose) cloneClose.addEventListener('click', () => { cloneModal.style.display = 'none'; });
  if (cloneCancel) cloneCancel.addEventListener('click', () => { cloneModal.style.display = 'none'; });
  if (cloneSubmit) cloneSubmit.addEventListener('click', cloneBrandFromUrl);

  // Export modal
  const exportBtn = document.getElementById('designExportBtn');
  const exportModal = document.getElementById('designExportModal');
  const exportClose = document.getElementById('designExportClose');
  const exportCancel = document.getElementById('designExportCancelBtn');
  const exportSubmit = document.getElementById('designExportSubmitBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => { exportModal.style.display = 'flex'; });
  if (exportClose) exportClose.addEventListener('click', () => { exportModal.style.display = 'none'; });
  if (exportCancel) exportCancel.addEventListener('click', () => { exportModal.style.display = 'none'; });
  if (exportSubmit) exportSubmit.addEventListener('click', exportDesignSystem);
});

// =============================
// MEDIA PRODUCTION PIPELINE
// =============================
async function loadMedia() {
  const [prodData, templData, stats] = await Promise.all([
    fetchJSON('/api/media/productions'),
    fetchJSON('/api/media/templates'),
    fetchJSON('/api/media/stats'),
  ]);
  const productions = prodData.value || prodData || [];
  const templates = templData.value || templData || [];
  renderMediaStats(stats);
  renderMediaProductions(productions);
  renderMediaTemplates(templates);
}

function renderMediaStats(stats) {
  const container = document.getElementById('mediaStats');
  if (!container) return;
  container.innerHTML = `
    <div class="media-stat">
      <div class="media-stat-value">${stats.total || 0}</div>
      <div class="media-stat-label">Productions</div>
    </div>
    <div class="media-stat">
      <div class="media-stat-value" style="color:var(--success);">${stats.completed || 0}</div>
      <div class="media-stat-label">Completed</div>
    </div>
    <div class="media-stat">
      <div class="media-stat-value" style="color:var(--accent);">${stats.rendering || 0}</div>
      <div class="media-stat-label">Rendering</div>
    </div>
    <div class="media-stat">
      <div class="media-stat-value">${stats.queued || 0}</div>
      <div class="media-stat-label">Queued</div>
    </div>
    <div class="media-stat">
      <div class="media-stat-value">$${(stats.totalCost || 0).toFixed(2)}</div>
      <div class="media-stat-label">Total Cost</div>
    </div>
  `;
}

function renderMediaProductions(productions) {
  const container = document.getElementById('mediaProductions');
  if (!container) return;

  if (!productions || !productions.length) {
    container.innerHTML = '<div class="empty-state">No active productions. Click "New Production" to start.</div>';
    return;
  }

  container.innerHTML = productions.map(p => `
    <div class="media-production-card">
      <div class="media-production-header">
        <span class="media-production-title">${escapeHtml(p.title)}</span>
        <span class="media-production-type ${p.type}">${p.type}</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(p.description || '')}</div>
      ${p.progress !== undefined ? `
        <div class="media-production-progress">
          <div class="media-production-progress-fill" style="width:${p.progress}%;"></div>
        </div>
      ` : ''}
      <div class="media-production-meta">
        <span>Engine: ${p.engine || 'remotion'}</span>
        <span>Status: ${p.status}</span>
        ${p.duration ? `<span>Duration: ${p.duration}</span>` : ''}
        <span>${timeAgo(p.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

function renderMediaTemplates(templates) {
  const container = document.getElementById('mediaTemplates');
  if (!container) return;

  if (!templates || !templates.length) {
    container.innerHTML = '<div class="empty-state">No templates available.</div>';
    return;
  }

  container.innerHTML = templates.map(t => `
    <div class="media-template-card" onclick="useMediaTemplate('${t.id}')">
      <div class="media-template-name">${escapeHtml(t.name)}</div>
      <div class="media-template-desc">${escapeHtml(t.engine || '')} &middot; ${escapeHtml(t.duration || '')}</div>
      ${t.params ? `
        <div class="media-template-tags">
          ${t.params.split(' ').map(p => `<span class="media-template-tag">${escapeHtml(p)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
}

async function showNewMediaModal() {
  showModal('New Media Production', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Title</label>
        <input type="text" id="mediaTitle" class="grok-input" placeholder="Weekly PR summary video..." style="width:100%;" />
      </div>
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Type</label>
        <select id="mediaType" class="grok-type-select" style="width:100%;">
          <option value="video">Video (Remotion)</option>
          <option value="image">Image</option>
          <option value="audio">Audio</option>
          <option value="three-d">3D (Blender)</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Prompt / Description</label>
        <textarea id="mediaPrompt" class="grok-input" placeholder="Describe what to produce..." style="width:100%;min-height:80px;resize:vertical;"></textarea>
      </div>
      <button class="btn btn-primary" onclick="submitNewMedia()">&#127916; Start Production</button>
    </div>
  `);
}

async function submitNewMedia() {
  const title = document.getElementById('mediaTitle').value.trim();
  const type = document.getElementById('mediaType').value;
  const prompt = document.getElementById('mediaPrompt').value.trim();
  if (!title || !prompt) return;

  await fetchJSON('/api/media/produce', { method: 'POST', body: { title, type, prompt } });
  closeModal();
  loadMedia();
  addTimelineEvent('media', `New ${type} production started: ${title}`);
}

function useMediaTemplate(templateId) {
  // Pre-fill from template
  showNewMediaModal();
}

// Setup media event listeners
document.addEventListener('DOMContentLoaded', () => {
  const produceBtn = document.getElementById('mediaProduceBtn');
  if (produceBtn) produceBtn.addEventListener('click', showNewMediaModal);
});

// =============================
// CONTINUOUS LOOP WORKFLOWS (ROUTINES)
// =============================
async function loadRoutines() {
  const [routinesData, stats] = await Promise.all([
    fetchJSON('/api/routines'),
    fetchJSON('/api/routines/stats'),
  ]);
  const routines = routinesData.value || routinesData || [];
  renderRoutinesStats(stats);
  renderRoutinesList(routines);
}

function renderRoutinesStats(stats) {
  const container = document.getElementById('routinesStats');
  if (!container) return;
  container.innerHTML = `
    <div class="routine-stat">
      <div class="routine-stat-value">${stats.total || 0}</div>
      <div class="routine-stat-label">Total Routines</div>
    </div>
    <div class="routine-stat">
      <div class="routine-stat-value" style="color:var(--success);">${stats.active || 0}</div>
      <div class="routine-stat-label">Active</div>
    </div>
    <div class="routine-stat">
      <div class="routine-stat-value" style="color:var(--warning);">${stats.paused || 0}</div>
      <div class="routine-stat-label">Paused</div>
    </div>
    <div class="routine-stat">
      <div class="routine-stat-value">${stats.totalRuns || 0}</div>
      <div class="routine-stat-label">Total Runs</div>
    </div>
    <div class="routine-stat">
      <div class="routine-stat-value">${stats.totalOutputs || 0}</div>
      <div class="routine-stat-label">Outputs</div>
    </div>
  `;
}

function renderRoutinesList(routines) {
  const container = document.getElementById('routinesList');
  if (!container) return;

  if (!routines || !routines.length) {
    container.innerHTML = '<div class="empty-state">No routines configured. Click "New Routine" to create one.</div>';
    return;
  }

  container.innerHTML = routines.map(r => {
    const statusClass = r.enabled ? 'active' : 'paused';
    const rStats = r.stats || {};
    return `
      <div class="routine-card">
        <div class="routine-header">
          <span class="routine-title">${escapeHtml(r.name)}</span>
          <div class="routine-toggle ${r.enabled ? 'active' : ''}" onclick="toggleRoutine('${r.id}', ${!r.enabled})"></div>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(r.description || '')}</div>
        <div class="routine-schedule">&#128339; ${escapeHtml(r.intervalHuman || r.interval || r.cron || 'Manual')}</div>
        <div class="routine-meta">
          <span class="routine-status-badge ${statusClass}">${r.enabled ? 'Active' : 'Paused'}</span>
          <span>Runs: ${rStats.totalRuns || 0}</span>
          <span>Outputs: ${rStats.totalOutputs || 0}</span>
          ${rStats.lastRun ? `<span>Last: ${timeAgo(rStats.lastRun)}</span>` : ''}
          ${rStats.nextRun ? `<span>Next: ${new Date(rStats.nextRun).toLocaleTimeString()}</span>` : ''}
          ${r.agent ? `<span>Agent: ${r.agent}</span>` : ''}
        </div>
        <div class="routine-actions">
          <button class="btn btn-secondary btn-sm" onclick="runRoutineNow('${r.id}')">&#9654; Run Now</button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleRoutine(id, enabled) {
  await fetchJSON(`/api/routines/${id}/toggle`, { method: 'PUT', body: { enabled } });
  loadRoutines();
  addTimelineEvent('routine', `Routine ${enabled ? 'enabled' : 'paused'}: ${id}`);
}

async function runRoutineNow(id) {
  await fetchJSON(`/api/routines/${id}/run`, { method: 'POST', body: {} });
  loadRoutines();
  addTimelineEvent('routine', `Routine manually triggered: ${id}`);
}

async function showNewRoutineModal() {
  showModal('New Routine', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Name</label>
        <input type="text" id="routineName" class="grok-input" placeholder="Weekly PR video digest..." style="width:100%;" />
      </div>
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">CRON Schedule</label>
        <input type="text" id="routineCron" class="grok-input" placeholder="0 9 * * 1 (every Monday 9am)" style="width:100%;" />
      </div>
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Agent</label>
        <select id="routineAgent" class="grok-type-select" style="width:100%;">
          <option value="orchestrator">Orchestrator</option>
          <option value="researcher">Researcher</option>
          <option value="scout">Scout</option>
          <option value="media-producer">Media Producer</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Task Description</label>
        <textarea id="routineTask" class="grok-input" placeholder="What should this routine do each run..." style="width:100%;min-height:80px;resize:vertical;"></textarea>
      </div>
      <button class="btn btn-primary" onclick="submitNewRoutine()">&#128260; Create Routine</button>
    </div>
  `);
}

async function submitNewRoutine() {
  const name = document.getElementById('routineName').value.trim();
  const cron = document.getElementById('routineCron').value.trim();
  const agent = document.getElementById('routineAgent').value;
  const task = document.getElementById('routineTask').value.trim();
  if (!name || !cron) return;

  await fetchJSON('/api/routines', { method: 'POST', body: { name, cron, agent, description: task } });
  closeModal();
  loadRoutines();
  addTimelineEvent('routine', `New routine created: ${name}`);
}

// Setup routine event listeners
document.addEventListener('DOMContentLoaded', () => {
  const routineBtn = document.getElementById('routineNewBtn');
  if (routineBtn) routineBtn.addEventListener('click', showNewRoutineModal);
});

// =============================
// PRODUCT FACTORY
// =============================
async function loadProducts() {
  const [products, stats] = await Promise.all([
    fetchJSON('/api/products'),
    fetchJSON('/api/products/stats'),
  ]);
  renderProductsStats(stats);
  renderProductsList(products);
}

function renderProductsStats(stats) {
  const container = document.getElementById('productsStats');
  if (!container) return;
  container.innerHTML = `
    <div class="product-stat"><div class="product-stat-value">${stats.total || 0}</div><div class="product-stat-label">Products</div></div>
    <div class="product-stat"><div class="product-stat-value" style="color:var(--success);">${stats.published || 0}</div><div class="product-stat-label">Published</div></div>
    <div class="product-stat"><div class="product-stat-value">$${(stats.totalRevenue || 0).toFixed(0)}</div><div class="product-stat-label">Revenue</div></div>
    <div class="product-stat"><div class="product-stat-value">${stats.totalSales || 0}</div><div class="product-stat-label">Total Sales</div></div>
    <div class="product-stat"><div class="product-stat-value">${stats.avgRating || '—'}</div><div class="product-stat-label">Avg Rating</div></div>
  `;
}

function renderProductsList(products) {
  const container = document.getElementById('productsList');
  if (!container) return;
  if (!products || !products.length) {
    container.innerHTML = '<div class="empty-state">No products yet.</div>';
    return;
  }
  container.innerHTML = products.map(p => `
    <div class="product-card">
      <div class="product-header">
        <span class="product-name">${escapeHtml(p.name)}</span>
        <span class="product-price">$${p.price}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="product-platform ${p.platform}">${p.platform}</span>
        <span class="product-status ${p.status}">${p.status}</span>
      </div>
      <div class="product-meta">
        <span>Sales: ${p.sales}</span>
        <span>Revenue: $${p.revenue.toFixed(2)}</span>
        ${p.rating ? `<span>Rating: ${p.rating}&#9733;</span>` : ''}
        <span>${timeAgo(p.createdAt)}</span>
      </div>
      ${p.features && p.features.length ? `
        <div class="product-features">
          ${p.features.map(f => `<span class="product-feature-tag">${escapeHtml(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
}

async function showNewProductModal() {
  showModal('New Product', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Name</label>
        <input type="text" id="productName" class="grok-input" placeholder="Ultimate Habit Tracker..." style="width:100%;" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Platform</label>
          <select id="productPlatform" class="grok-type-select" style="width:100%;"><option value="etsy">Etsy</option><option value="gumroad">Gumroad</option></select></div>
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Price ($)</label>
          <input type="number" id="productPrice" class="grok-input" value="14.99" style="width:100%;" /></div>
      </div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Type</label>
        <select id="productType" class="grok-type-select" style="width:100%;"><option value="spreadsheet">Spreadsheet (Excel/Sheets)</option><option value="notion-template">Notion Template</option><option value="toolkit">Toolkit Bundle</option></select></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Features (comma-separated)</label>
        <input type="text" id="productFeatures" class="grok-input" placeholder="Feature 1, Feature 2, Feature 3..." style="width:100%;" /></div>
      <button class="btn btn-primary" onclick="submitNewProduct()">&#128230; Generate Product</button>
    </div>
  `);
}

async function submitNewProduct() {
  const name = document.getElementById('productName').value.trim();
  const platform = document.getElementById('productPlatform').value;
  const price = parseFloat(document.getElementById('productPrice').value) || 9.99;
  const type = document.getElementById('productType').value;
  const features = document.getElementById('productFeatures').value.split(',').map(f => f.trim()).filter(Boolean);
  if (!name) return;
  await fetchJSON('/api/products', { method: 'POST', body: { name, platform, price, type, features } });
  closeModal();
  loadProducts();
  addTimelineEvent('product', `New product generating: ${name}`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('productNewBtn');
  if (btn) btn.addEventListener('click', showNewProductModal);
});

// =============================
// LEAD GENERATION PIPELINE
// =============================
async function loadLeads() {
  const [leads, stats, campaigns] = await Promise.all([
    fetchJSON('/api/leads'),
    fetchJSON('/api/leads/stats'),
    fetchJSON('/api/leads/campaigns'),
  ]);
  renderLeadsStats(stats);
  renderLeadsList(leads);
  renderLeadsCampaigns(campaigns);
}

function renderLeadsStats(stats) {
  const container = document.getElementById('leadsStats');
  if (!container) return;
  container.innerHTML = `
    <div class="lead-stat"><div class="lead-stat-value">${stats.total || 0}</div><div class="lead-stat-label">Total Leads</div></div>
    <div class="lead-stat"><div class="lead-stat-value" style="color:var(--info);">${stats.enriched || 0}</div><div class="lead-stat-label">Enriched</div></div>
    <div class="lead-stat"><div class="lead-stat-value" style="color:var(--success);">${stats.replied || 0}</div><div class="lead-stat-label">Replied</div></div>
    <div class="lead-stat"><div class="lead-stat-value">${stats.openRate || 0}%</div><div class="lead-stat-label">Open Rate</div></div>
    <div class="lead-stat"><div class="lead-stat-value">${stats.replyRate || 0}%</div><div class="lead-stat-label">Reply Rate</div></div>
  `;
}

function renderLeadsList(leads) {
  const container = document.getElementById('leadsList');
  if (!container) return;
  if (!leads || !leads.length) {
    container.innerHTML = '<div class="empty-state">No leads yet.</div>';
    return;
  }
  container.innerHTML = leads.map(l => {
    const scoreClass = l.score >= 85 ? 'high' : l.score >= 70 ? 'medium' : 'low';
    return `
      <div class="lead-card">
        <div class="lead-header">
          <span class="lead-contact">${escapeHtml(l.contact)}</span>
          <span class="lead-score ${scoreClass}">${l.score}</span>
        </div>
        <div class="lead-company">${escapeHtml(l.company)} &middot; ${escapeHtml(l.role)}</div>
        ${l.achievement ? `<div class="lead-achievement">${escapeHtml(l.achievement)}</div>` : ''}
        <div class="lead-meta">
          <span class="lead-status ${l.status}">${l.status}</span>
          <span>${l.platform}</span>
          ${l.sentAt ? `<span>Sent ${timeAgo(l.sentAt)}</span>` : ''}
          ${l.repliedAt ? `<span style="color:var(--success);">Replied ${timeAgo(l.repliedAt)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderLeadsCampaigns(campaigns) {
  const container = document.getElementById('leadsCampaigns');
  if (!container) return;
  if (!campaigns || !campaigns.length) {
    container.innerHTML = '<div class="empty-state">No campaigns.</div>';
    return;
  }
  container.innerHTML = campaigns.map(c => `
    <div class="campaign-card">
      <div class="campaign-name">${escapeHtml(c.name)}</div>
      <div class="campaign-target">${escapeHtml(c.target)}</div>
      <div class="campaign-funnel">
        <span class="campaign-funnel-step">&#127919; ${c.leads} leads</span>
        <span class="campaign-funnel-step">&#9993; ${c.sent} sent</span>
        <span class="campaign-funnel-step">&#128065; ${c.opened} opened</span>
        <span class="campaign-funnel-step" style="color:var(--success);">&#128172; ${c.replied} replied</span>
      </div>
    </div>
  `).join('');
}

async function showScrapeLeadsModal() {
  showModal('Scrape New Leads', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Company / Industry</label>
        <input type="text" id="scrapeCompany" class="grok-input" placeholder="AI startups, SaaS companies..." style="width:100%;" /></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Target Role</label>
        <input type="text" id="scrapeRole" class="grok-input" placeholder="CTO, VP Engineering, Head of Growth..." style="width:100%;" /></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Platform</label>
        <select id="scrapePlatform" class="grok-type-select" style="width:100%;"><option value="linkedin">LinkedIn</option><option value="email">Email</option></select></div>
      <button class="btn btn-primary" onclick="submitScrapeLeads()">&#127919; Scrape & Enrich</button>
    </div>
  `);
}

async function submitScrapeLeads() {
  const company = document.getElementById('scrapeCompany').value.trim();
  const role = document.getElementById('scrapeRole').value.trim();
  const platform = document.getElementById('scrapePlatform').value;
  if (!company) return;
  await fetchJSON('/api/leads/scrape', { method: 'POST', body: { company, role, platform } });
  closeModal();
  loadLeads();
  addTimelineEvent('leads', `Scraping leads: ${company} (${role})`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('leadScrapeBtn');
  if (btn) btn.addEventListener('click', showScrapeLeadsModal);
});

// =============================
// MARKETING HUB
// =============================
async function loadMarketing() {
  const [pipelines, channels, queue, stats] = await Promise.all([
    fetchJSON('/api/marketing/pipelines'),
    fetchJSON('/api/marketing/channels'),
    fetchJSON('/api/marketing/queue'),
    fetchJSON('/api/marketing/stats'),
  ]);
  renderMarketingStats(stats);
  renderMarketingPipelines(pipelines);
  renderMarketingChannels(channels);
  renderMarketingQueue(queue);
}

function renderMarketingStats(stats) {
  const container = document.getElementById('marketingStats');
  if (!container) return;
  container.innerHTML = `
    <div class="mkt-stat"><div class="mkt-stat-value">${(stats.totalFollowers || 0).toLocaleString()}</div><div class="mkt-stat-label">Followers</div></div>
    <div class="mkt-stat"><div class="mkt-stat-value">${stats.totalPosts30d || 0}</div><div class="mkt-stat-label">Posts (30d)</div></div>
    <div class="mkt-stat"><div class="mkt-stat-value">${stats.avgEngagement || 0}%</div><div class="mkt-stat-label">Avg Engagement</div></div>
    <div class="mkt-stat"><div class="mkt-stat-value">${stats.activePipelines || 0}</div><div class="mkt-stat-label">Active Pipelines</div></div>
    <div class="mkt-stat"><div class="mkt-stat-value">${stats.queuedContent || 0}</div><div class="mkt-stat-label">Queued</div></div>
  `;
}

function renderMarketingPipelines(pipelines) {
  const container = document.getElementById('marketingPipelines');
  if (!container) return;
  if (!pipelines || !pipelines.length) {
    container.innerHTML = '<div class="empty-state">No pipelines.</div>';
    return;
  }
  container.innerHTML = pipelines.map(p => `
    <div class="mkt-pipeline-card">
      <div class="mkt-pipeline-header">
        <span class="mkt-pipeline-name">${escapeHtml(p.name)}</span>
        <span class="routine-status-badge ${p.status === 'active' ? 'active' : 'paused'}">${p.status}</span>
      </div>
      <div class="mkt-pipeline-outputs">
        ${p.outputs.map(o => `<span class="mkt-output-tag">${escapeHtml(o)}</span>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Runs: ${p.totalRuns} &middot; Last: ${timeAgo(p.lastRun)}</div>
    </div>
  `).join('');
}

function renderMarketingChannels(channels) {
  const container = document.getElementById('marketingChannels');
  if (!container) return;
  container.innerHTML = channels.map(c => `
    <div class="mkt-channel-card">
      <div>
        <div class="mkt-channel-name">${escapeHtml(c.name)}</div>
        <div class="mkt-channel-meta">
          ${c.followers ? `<span>${c.followers.toLocaleString()} followers</span>` : ''}
          <span>${c.posts30d} posts/30d</span>
          ${c.engagement ? `<span>${c.engagement}% eng.</span>` : ''}
        </div>
      </div>
      <span class="mkt-channel-growth">${c.growth}</span>
    </div>
  `).join('');
}

function renderMarketingQueue(queue) {
  const container = document.getElementById('marketingQueue');
  if (!container) return;
  if (!queue || !queue.length) {
    container.innerHTML = '<div class="empty-state">No content queued.</div>';
    return;
  }
  container.innerHTML = queue.map(q => `
    <div class="mkt-queue-item">
      <div>
        <div class="mkt-queue-title">${escapeHtml(q.title)}</div>
        <div class="mkt-queue-meta">
          <span>${q.channel}</span>
          <span>${q.type}</span>
          ${q.scheduledFor ? `<span>${new Date(q.scheduledFor).toLocaleString()}</span>` : ''}
        </div>
      </div>
      <span class="mkt-queue-status ${q.status}">${q.status}</span>
    </div>
  `).join('');
}

async function showQueueContentModal() {
  showModal('Queue Content', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Title</label>
        <input type="text" id="queueTitle" class="grok-input" placeholder="Content title..." style="width:100%;" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Channel</label>
          <select id="queueChannel" class="grok-type-select" style="width:100%;"><option value="linkedin">LinkedIn</option><option value="x-twitter">X / Twitter</option><option value="email">Email</option><option value="blog">Blog</option></select></div>
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Type</label>
          <select id="queueType" class="grok-type-select" style="width:100%;"><option value="post">Post</option><option value="thread">Thread</option><option value="carousel">Carousel</option><option value="newsletter">Newsletter</option><option value="video">Video</option></select></div>
      </div>
      <button class="btn btn-primary" onclick="submitQueueContent()">&#128227; Queue Content</button>
    </div>
  `);
}

async function submitQueueContent() {
  const title = document.getElementById('queueTitle').value.trim();
  const channel = document.getElementById('queueChannel').value;
  const type = document.getElementById('queueType').value;
  if (!title) return;
  await fetchJSON('/api/marketing/queue', { method: 'POST', body: { title, channel, type } });
  closeModal();
  loadMarketing();
  addTimelineEvent('marketing', `Content queued: ${title} → ${channel}`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('marketingQueueBtn');
  if (btn) btn.addEventListener('click', showQueueContentModal);
});

// =============================
// GOLDEN LOOP
// =============================
async function loadGoldenLoop() {
  const [loops, stats] = await Promise.all([
    fetchJSON('/api/golden-loop'),
    fetchJSON('/api/golden-loop/stats'),
  ]);
  renderGoldenStats(stats);
  renderGoldenLoops(loops);
}

function renderGoldenStats(stats) {
  const container = document.getElementById('goldenStats');
  if (!container) return;
  container.innerHTML = `
    <div class="golden-stat"><div class="golden-stat-value">${stats.total || 0}</div><div class="golden-stat-label">Loops</div></div>
    <div class="golden-stat"><div class="golden-stat-value" style="color:var(--success);">${stats.synced || 0}</div><div class="golden-stat-label">Synced</div></div>
    <div class="golden-stat"><div class="golden-stat-value" style="color:var(--danger);">${stats.errors || 0}</div><div class="golden-stat-label">Errors</div></div>
    <div class="golden-stat"><div class="golden-stat-value">${stats.totalOutputs || 0}</div><div class="golden-stat-label">Outputs</div></div>
    <div class="golden-stat"><div class="golden-stat-value">${stats.avgAccuracy || 0}%</div><div class="golden-stat-label">Accuracy</div></div>
  `;
}

function renderGoldenLoops(loops) {
  const container = document.getElementById('goldenLoops');
  if (!container) return;
  if (!loops || !loops.length) {
    container.innerHTML = '<div class="empty-state">No Golden Loops configured.</div>';
    return;
  }
  container.innerHTML = loops.map(l => `
    <div class="golden-loop-card">
      <div class="golden-loop-header">
        <div class="golden-loop-title">
          <span class="golden-loop-gem">${escapeHtml(l.gem)}</span>
          <span class="golden-loop-arrow">&#8596;</span>
          <span class="golden-loop-notebook">${escapeHtml(l.notebook)}</span>
        </div>
        <span class="golden-loop-status ${l.status}">${l.status}</span>
      </div>
      <div class="golden-loop-meta">
        <span>Sync: ${l.syncInterval}</span>
        <span>Outputs: ${l.outputs}</span>
        <span>Accuracy: ${l.accuracy}%</span>
        <span>Last: ${timeAgo(l.lastSync)}</span>
      </div>
      ${l.dataSources && l.dataSources.length ? `
        <div class="golden-loop-sources">
          ${l.dataSources.map(s => `<span class="golden-loop-source-tag">${escapeHtml(s)}</span>`).join('')}
        </div>
      ` : ''}
      ${l.error ? `<div class="golden-loop-error">&#9888; ${escapeHtml(l.error)}</div>` : ''}
      <div class="golden-loop-actions">
        <button class="btn btn-secondary btn-sm" onclick="syncGoldenLoop('${l.id}')">&#128260; Sync Now</button>
      </div>
    </div>
  `).join('');
}

async function syncGoldenLoop(id) {
  await fetchJSON(`/api/golden-loop/${id}/sync`, { method: 'POST', body: {} });
  loadGoldenLoop();
  addTimelineEvent('golden-loop', `Golden Loop sync triggered: ${id}`);
}

async function showNewGoldenLoopModal() {
  showModal('New Golden Loop', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Gem Name (AI Persona)</label>
        <input type="text" id="glGem" class="grok-input" placeholder="Brand Strategist, Technical Writer..." style="width:100%;" /></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">NotebookLM Notebook</label>
        <input type="text" id="glNotebook" class="grok-input" placeholder="Brand Guidelines, Product Docs..." style="width:100%;" /></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Sync Interval</label>
        <select id="glInterval" class="grok-type-select" style="width:100%;"><option value="15min">Every 15 min</option><option value="30min">Every 30 min</option><option value="1hr" selected>Every hour</option><option value="2hr">Every 2 hours</option></select></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Data Sources (comma-separated paths)</label>
        <input type="text" id="glSources" class="grok-input" placeholder="docs/brand.md, research/, pricing.md" style="width:100%;" /></div>
      <button class="btn btn-primary" onclick="submitNewGoldenLoop()">&#128311; Create Loop</button>
    </div>
  `);
}

async function submitNewGoldenLoop() {
  const gem = document.getElementById('glGem').value.trim();
  const notebook = document.getElementById('glNotebook').value.trim();
  const syncInterval = document.getElementById('glInterval').value;
  const dataSources = document.getElementById('glSources').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!gem || !notebook) return;
  await fetchJSON('/api/golden-loop', { method: 'POST', body: { gem, notebook, syncInterval, dataSources } });
  closeModal();
  loadGoldenLoop();
  addTimelineEvent('golden-loop', `New Golden Loop: ${gem} ↔ ${notebook}`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('goldenLoopNewBtn');
  if (btn) btn.addEventListener('click', showNewGoldenLoopModal);
});

// =============================
// VIBE DESIGN STUDIO
// =============================
async function loadVibeDesign() {
  const [projects, stats, controls] = await Promise.all([
    fetchJSON('/api/vibe-design/projects'),
    fetchJSON('/api/vibe-design/stats'),
    fetchJSON('/api/vibe-design/controls'),
  ]);
  renderVibeStats(stats);
  renderVibeProjects(projects);
  renderVibeControls(controls);
}

function renderVibeStats(stats) {
  const container = document.getElementById('vibeStats');
  if (!container) return;
  container.innerHTML = `
    <div class="vibe-stat"><div class="vibe-stat-value">${stats.totalProjects || 0}</div><div class="vibe-stat-label">Projects</div></div>
    <div class="vibe-stat"><div class="vibe-stat-value" style="color:var(--success);">${stats.completed || 0}</div><div class="vibe-stat-label">Completed</div></div>
    <div class="vibe-stat"><div class="vibe-stat-value" style="color:var(--accent);">${stats.iterating || 0}</div><div class="vibe-stat-label">Iterating</div></div>
    <div class="vibe-stat"><div class="vibe-stat-value">${stats.totalScreens || 0}</div><div class="vibe-stat-label">Screens</div></div>
    <div class="vibe-stat"><div class="vibe-stat-value">${stats.heatmapsGenerated || 0}</div><div class="vibe-stat-label">Heat Maps</div></div>
  `;
}

function renderVibeProjects(projects) {
  const container = document.getElementById('vibeProjects');
  if (!container) return;
  if (!projects || !projects.length) {
    container.innerHTML = '<div class="empty-state">No designs yet.</div>';
    return;
  }
  container.innerHTML = projects.map(p => `
    <div class="vibe-project-card">
      <div class="vibe-project-header">
        <span class="vibe-project-name">${escapeHtml(p.name)}</span>
        <span class="vibe-method-tag ${p.method}">${p.method}</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);">Style: ${p.style} &middot; ${p.screens} screens</div>
      <div class="vibe-project-meta">
        <span class="routine-status-badge ${p.status === 'completed' ? 'active' : p.status === 'generating' ? '' : 'paused'}">${p.status}</span>
        ${p.heatmap ? '<span style="color:var(--warning);">&#128293; Heat map</span>' : ''}
        <span>${p.interactions} iterations</span>
        <span>${timeAgo(p.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

function renderVibeControls(controls) {
  const container = document.getElementById('vibeControls');
  if (!container) return;
  if (!controls) return;
  container.innerHTML = Object.entries(controls).map(([name, ctrl]) => `
    <div class="vibe-control-row">
      <div class="vibe-control-label"><span>${name.charAt(0).toUpperCase() + name.slice(1)}</span><span id="vibeVal_${name}">${ctrl.default}</span></div>
      <input type="range" class="vibe-control-slider" min="${ctrl.min}" max="${ctrl.max}" value="${ctrl.default}" oninput="document.getElementById('vibeVal_${name}').textContent=this.value" />
    </div>
  `).join('');
}

async function showNewVibeModal() {
  showModal('New Vibe Design', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Project Name</label>
        <input type="text" id="vibeName" class="grok-input" placeholder="Landing page, Dashboard..." style="width:100%;" /></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Input Method</label>
        <select id="vibeMethod" class="grok-type-select" style="width:100%;"><option value="prompt">Natural Language Prompt</option><option value="voice">Voice Description</option><option value="sketch">Upload Sketch</option><option value="url">Reference URL</option></select></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Style</label>
        <select id="vibeStyle" class="grok-type-select" style="width:100%;"><option value="minimal-tech">Minimal Tech</option><option value="playful">Playful</option><option value="luxe">Luxe / Premium</option><option value="data-dense">Data Dense</option><option value="editorial">Editorial</option></select></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Prompt / Description</label>
        <textarea id="vibePrompt" class="grok-input" placeholder="Describe the UI you want..." style="width:100%;min-height:80px;resize:vertical;"></textarea></div>
      <button class="btn btn-primary" onclick="submitVibeDesign()">&#127912; Generate Design</button>
    </div>
  `);
}

async function submitVibeDesign() {
  const name = document.getElementById('vibeName').value.trim();
  const method = document.getElementById('vibeMethod').value;
  const style = document.getElementById('vibeStyle').value;
  const prompt = document.getElementById('vibePrompt').value.trim();
  if (!name) return;
  await fetchJSON('/api/vibe-design/projects', { method: 'POST', body: { name, method, style, prompt } });
  closeModal();
  loadVibeDesign();
  addTimelineEvent('vibe-design', `New design: ${name} (${method})`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('vibeNewBtn');
  if (btn) btn.addEventListener('click', showNewVibeModal);
});

// =============================
// 3D PRODUCTION STUDIO
// =============================
async function load3DStudio() {
  const [scenes, stats] = await Promise.all([
    fetchJSON('/api/3d/scenes'),
    fetchJSON('/api/3d/stats'),
  ]);
  render3DStats(stats);
  render3DScenes(scenes);
}

function render3DStats(stats) {
  const container = document.getElementById('studio3dStats');
  if (!container) return;
  container.innerHTML = `
    <div class="studio3d-stat"><div class="studio3d-stat-value">${stats.total || 0}</div><div class="studio3d-stat-label">Scenes</div></div>
    <div class="studio3d-stat"><div class="studio3d-stat-value" style="color:var(--success);">${stats.rendered || 0}</div><div class="studio3d-stat-label">Rendered</div></div>
    <div class="studio3d-stat"><div class="studio3d-stat-value" style="color:var(--accent);">${stats.rendering || 0}</div><div class="studio3d-stat-label">Rendering</div></div>
    <div class="studio3d-stat"><div class="studio3d-stat-value">${stats.queued || 0}</div><div class="studio3d-stat-label">Queued</div></div>
    <div class="studio3d-stat"><div class="studio3d-stat-value">${stats.totalObjects || 0}</div><div class="studio3d-stat-label">Objects</div></div>
  `;
}

function render3DScenes(scenes) {
  const container = document.getElementById('studio3dScenes');
  if (!container) return;
  if (!scenes || !scenes.length) {
    container.innerHTML = '<div class="empty-state">No 3D scenes yet.</div>';
    return;
  }
  container.innerHTML = scenes.map(s => `
    <div class="scene3d-card">
      <div class="scene3d-header">
        <span class="scene3d-name">${escapeHtml(s.name)}</span>
        <span class="scene3d-status ${s.status}">${s.status}</span>
      </div>
      <div class="scene3d-prompt">${escapeHtml(s.prompt)}</div>
      <div class="scene3d-tags">
        <span class="scene3d-tag">${s.style}</span>
        <span class="scene3d-tag">${s.lighting}</span>
        <span class="scene3d-tag">${s.resolution}</span>
      </div>
      <div class="scene3d-meta">
        <span>Objects: ${s.objects}</span>
        ${s.renderTime ? `<span>Render: ${s.renderTime}</span>` : ''}
        ${s.fileSize ? `<span>Size: ${s.fileSize}</span>` : ''}
        <span>${timeAgo(s.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

async function showNew3DModal() {
  showModal('New 3D Scene', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Scene Name</label>
        <input type="text" id="scene3dName" class="grok-input" placeholder="Product render, Environment..." style="width:100%;" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Style</label>
          <select id="scene3dStyle" class="grok-type-select" style="width:100%;"><option value="photorealistic">Photorealistic</option><option value="abstract">Abstract</option><option value="studio">Studio</option><option value="cinematic">Cinematic</option></select></div>
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Lighting</label>
          <select id="scene3dLighting" class="grok-type-select" style="width:100%;"><option value="dramatic">Dramatic</option><option value="three-point">Three-Point</option><option value="neon">Neon Glow</option><option value="hdri">Natural (HDRI)</option><option value="ambient">Ambient</option></select></div>
      </div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Resolution</label>
        <select id="scene3dRes" class="grok-type-select" style="width:100%;"><option value="1920x1080">1080p (1920x1080)</option><option value="2048x2048">2K Square</option><option value="3840x2160">4K UHD</option><option value="4096x4096">4K Square</option></select></div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Prompt</label>
        <textarea id="scene3dPrompt" class="grok-input" placeholder="Describe the 3D scene..." style="width:100%;min-height:80px;resize:vertical;"></textarea></div>
      <button class="btn btn-primary" onclick="submit3DScene()">&#127922; Generate Scene</button>
    </div>
  `);
}

async function submit3DScene() {
  const name = document.getElementById('scene3dName').value.trim();
  const style = document.getElementById('scene3dStyle').value;
  const lighting = document.getElementById('scene3dLighting').value;
  const resolution = document.getElementById('scene3dRes').value;
  const prompt = document.getElementById('scene3dPrompt').value.trim();
  if (!name || !prompt) return;
  await fetchJSON('/api/3d/scenes', { method: 'POST', body: { name, style, lighting, resolution, prompt } });
  closeModal();
  load3DStudio();
  addTimelineEvent('3d', `New 3D scene: ${name}`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('3dNewBtn');
  if (btn) btn.addEventListener('click', showNew3DModal);
});

// =============================
// PREDICTIVE ANALYTICS
// =============================
async function loadPredictions() {
  const [predictions, stats, models] = await Promise.all([
    fetchJSON('/api/predictions'),
    fetchJSON('/api/predictions/stats'),
    fetchJSON('/api/predictions/models'),
  ]);
  renderPredictStats(stats);
  renderPredictList(predictions);
  renderPredictModels(models);
}

function renderPredictStats(stats) {
  const container = document.getElementById('predictStats');
  if (!container) return;
  container.innerHTML = `
    <div class="predict-stat"><div class="predict-stat-value">${stats.totalPredictions || 0}</div><div class="predict-stat-label">Predictions</div></div>
    <div class="predict-stat"><div class="predict-stat-value">${stats.avgConfidence || 0}%</div><div class="predict-stat-label">Avg Confidence</div></div>
    <div class="predict-stat"><div class="predict-stat-value" style="color:var(--success);">${stats.trendsUp || 0}</div><div class="predict-stat-label">Trends Up</div></div>
    <div class="predict-stat"><div class="predict-stat-value" style="color:var(--danger);">${stats.trendsDown || 0}</div><div class="predict-stat-label">Trends Down</div></div>
    <div class="predict-stat"><div class="predict-stat-value">${stats.avgModelAccuracy || 0}%</div><div class="predict-stat-label">Model Accuracy</div></div>
  `;
}

function renderPredictList(predictions) {
  const container = document.getElementById('predictList');
  if (!container) return;
  if (!predictions || !predictions.length) {
    container.innerHTML = '<div class="empty-state">No predictions yet.</div>';
    return;
  }
  container.innerHTML = predictions.map(p => `
    <div class="predict-card">
      <div class="predict-header">
        <span class="predict-metric">${escapeHtml(p.metric)}</span>
        <span class="predict-trend ${p.trend}">&#${p.trend === 'up' ? '9650' : '9660'}; ${p.trend}</span>
      </div>
      <div class="predict-values">
        <span class="predict-current">Current: ${typeof p.current === 'number' && p.current > 100 ? '$' + p.current.toLocaleString() : p.current + (p.metric.includes('Rate') || p.metric.includes('Engagement') || p.metric.includes('Risk') ? '%' : '')}</span>
        <span class="predict-predicted">Predicted: ${typeof p.predicted === 'number' && p.predicted > 100 ? '$' + p.predicted.toLocaleString() : p.predicted + (p.metric.includes('Rate') || p.metric.includes('Engagement') || p.metric.includes('Risk') ? '%' : '')}</span>
      </div>
      <div class="predict-confidence">${Math.round(p.confidence * 100)}% confidence &middot; ${p.period}</div>
      <div class="predict-factors">
        ${p.factors.map(f => `<span class="predict-factor">${escapeHtml(f)}</span>`).join('')}
      </div>
    </div>
  `).join('');
}

function renderPredictModels(models) {
  const container = document.getElementById('predictModels');
  if (!container) return;
  if (!models || !models.length) {
    container.innerHTML = '<div class="empty-state">No models trained.</div>';
    return;
  }
  container.innerHTML = models.map(m => `
    <div class="predict-model-card">
      <div class="predict-model-name">${escapeHtml(m.name)}</div>
      <div class="predict-model-meta">
        <span>Accuracy: ${m.accuracy}%</span>
        <span>Data points: ${m.dataPoints}</span>
        <span>Trained: ${timeAgo(m.lastTrained)}</span>
      </div>
    </div>
  `).join('');
}

// =============================
// BATCH GENERATION QUEUE
// =============================
async function loadBatch() {
  const [batches, stats] = await Promise.all([
    fetchJSON('/api/batch'),
    fetchJSON('/api/batch/stats'),
  ]);
  renderBatchStats(stats);
  renderBatchList(batches);
}

function renderBatchStats(stats) {
  const container = document.getElementById('batchStats');
  if (!container) return;
  container.innerHTML = `
    <div class="batch-stat"><div class="batch-stat-value">${stats.total || 0}</div><div class="batch-stat-label">Batches</div></div>
    <div class="batch-stat"><div class="batch-stat-value" style="color:var(--accent);">${stats.running || 0}</div><div class="batch-stat-label">Running</div></div>
    <div class="batch-stat"><div class="batch-stat-value" style="color:var(--success);">${stats.done || 0}</div><div class="batch-stat-label">Done</div></div>
    <div class="batch-stat"><div class="batch-stat-value">${stats.completedItems || 0}/${stats.totalItems || 0}</div><div class="batch-stat-label">Items</div></div>
    <div class="batch-stat"><div class="batch-stat-value">$${(stats.totalCost || 0).toFixed(2)}</div><div class="batch-stat-label">Total Cost</div></div>
  `;
}

function renderBatchList(batches) {
  const container = document.getElementById('batchList');
  if (!container) return;
  if (!batches || !batches.length) {
    container.innerHTML = '<div class="empty-state">No batches yet.</div>';
    return;
  }
  container.innerHTML = batches.map(b => {
    const pct = b.count > 0 ? Math.round(b.completed / b.count * 100) : 0;
    return `
      <div class="batch-card">
        <div class="batch-header">
          <span class="batch-name">${escapeHtml(b.name)}</span>
          <span class="batch-status ${b.status}">${b.status}</span>
        </div>
        <div class="batch-progress">
          <div class="batch-progress-fill" style="width:${pct}%;"></div>
        </div>
        <div class="batch-meta">
          <span>${b.completed}/${b.count} items (${pct}%)</span>
          <span>Type: ${b.type}</span>
          <span>Agent: ${b.agent}</span>
          <span>Cost: $${b.cost.toFixed(3)}</span>
          ${b.startedAt ? `<span>${timeAgo(b.startedAt)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function showNewBatchModal() {
  showModal('New Batch Generation', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Batch Name</label>
        <input type="text" id="batchName" class="grok-input" placeholder="Ad variants, blog posts..." style="width:100%;" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Type</label>
          <select id="batchType" class="grok-type-select" style="width:100%;"><option value="text">Text</option><option value="image">Image</option></select></div>
        <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Count</label>
          <input type="number" id="batchCount" class="grok-input" value="20" min="1" max="500" style="width:100%;" /></div>
      </div>
      <div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Agent</label>
        <select id="batchAgent" class="grok-type-select" style="width:100%;"><option value="deepseek-worker">DeepSeek (Economy)</option><option value="writer">Writer (Sonnet)</option><option value="media-producer">Media Producer</option></select></div>
      <button class="btn btn-primary" onclick="submitNewBatch()">&#9968; Start Batch</button>
    </div>
  `);
}

async function submitNewBatch() {
  const name = document.getElementById('batchName').value.trim();
  const type = document.getElementById('batchType').value;
  const count = parseInt(document.getElementById('batchCount').value) || 10;
  const agent = document.getElementById('batchAgent').value;
  if (!name) return;
  await fetchJSON('/api/batch', { method: 'POST', body: { name, type, count, agent } });
  closeModal();
  loadBatch();
  addTimelineEvent('batch', `New batch: ${name} (${count} ${type} items)`);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('batchNewBtn');
  if (btn) btn.addEventListener('click', showNewBatchModal);
});

function formatTokenCount(tokens) {
  if (!tokens) return '0';
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return (tokens / 1000).toFixed(1) + 'K';
  return (tokens / 1000000).toFixed(2) + 'M';
}

// --- Hermes Agent ---

async function loadHermes() {
  const [status, tasks, approvals, cron] = await Promise.all([
    fetchJSON('/api/hermes/status'),
    fetchJSON('/api/hermes/tasks'),
    fetchJSON('/api/hermes/approvals'),
    fetchJSON('/api/hermes/cron'),
  ]);
  renderHermesStatus(status);
  renderHermesApprovals(approvals);
  renderHermesTasks(tasks);
  renderHermesCron(cron);
}

function renderHermesStatus(status) {
  const badge = document.getElementById('hermesStatusBadge');
  if (badge) {
    badge.textContent = status.connected ? 'Connected' : 'Disconnected';
    badge.className = 'hermes-status-badge ' + (status.connected ? 'online' : 'offline');
  }
  const el = document.getElementById('hermesStats');
  if (!el) return;
  el.innerHTML = `
    <div class="hermes-stat-grid">
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.connected ? 'Online' : 'Offline'}</div>
        <div class="hermes-stat-label">MCP Status</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.endpoint}</div>
        <div class="hermes-stat-label">Endpoint</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.stats.tasksCompleted}</div>
        <div class="hermes-stat-label">Tasks Completed</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.stats.cronExecutions}</div>
        <div class="hermes-stat-label">Cron Executions</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.stats.approvalsPending}</div>
        <div class="hermes-stat-label">Approvals Pending</div>
      </div>
      <div class="hermes-stat">
        <div class="hermes-stat-value">${status.skills.length}</div>
        <div class="hermes-stat-label">Skills Loaded</div>
      </div>
    </div>
  `;
}

function renderHermesApprovals(approvals) {
  const countEl = document.getElementById('hermesApprovalCount');
  if (countEl) countEl.textContent = approvals.length;
  const el = document.getElementById('hermesApprovals');
  if (!el) return;
  if (!approvals.length) { el.innerHTML = '<div class="empty-state">No pending approvals</div>'; return; }
  el.innerHTML = approvals.map(a => `
    <div class="hermes-approval-card risk-${a.risk}">
      <div class="hermes-approval-header">
        <span class="hermes-risk-badge ${a.risk}">${a.risk.toUpperCase()}</span>
        <span class="hermes-approval-time">${timeAgo(a.requestedAt)}</span>
      </div>
      <div class="hermes-approval-action">${a.action}</div>
      <div class="hermes-approval-context">${a.context}</div>
      <div class="hermes-approval-buttons">
        <button class="btn btn-success btn-sm" onclick="respondApproval('${a.id}', 'approve')">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="respondApproval('${a.id}', 'reject')">Reject</button>
      </div>
    </div>
  `).join('');
}

async function respondApproval(id, decision) {
  await fetchJSON(`/api/hermes/approvals/${id}`, { method: 'POST', body: { decision } });
  loadHermes();
}

function renderHermesTasks(tasks) {
  const el = document.getElementById('hermesTasks');
  if (!el) return;
  if (!tasks.length) { el.innerHTML = '<div class="empty-state">No active tasks</div>'; return; }
  el.innerHTML = tasks.map(t => `
    <div class="hermes-task-card">
      <div class="hermes-task-header">
        <span class="hermes-task-name">${t.task}</span>
        <span class="badge ${t.status === 'complete' ? 'badge-success' : t.status === 'running' ? 'badge-info' : ''}">${t.status}</span>
      </div>
      <div class="hermes-task-meta">
        <span class="hermes-mode-badge">${t.mode}</span>
        <span>via ${t.notifyVia || 'websocket'}</span>
        <span>${timeAgo(t.delegatedAt)}</span>
      </div>
      ${t.progress !== undefined ? `<div class="hermes-progress"><div class="hermes-progress-bar" style="width:${t.progress}%"></div></div>` : ''}
      <div class="hermes-task-log">${(t.log || []).map(l => `<div class="hermes-log-line">${l}</div>`).join('')}</div>
      ${t.mode === 'walkaway' && t.status === 'running' ? `
        <div class="hermes-walkaway-reply">
          <input type="text" class="form-input" id="reply-${t.id}" placeholder="Send a mobile reply...">
          <button class="btn btn-sm btn-primary" onclick="sendWalkawayReply('${t.id}')">Send</button>
        </div>` : ''}
    </div>
  `).join('');
}

async function sendWalkawayReply(taskId) {
  const input = document.getElementById(`reply-${taskId}`);
  if (!input || !input.value.trim()) return;
  await fetchJSON(`/api/hermes/walkaway/${taskId}/reply`, { method: 'POST', body: { message: input.value.trim() } });
  input.value = '';
  loadHermes();
}

function renderHermesCron(jobs) {
  const el = document.getElementById('hermesCronJobs');
  if (!el) return;
  if (!jobs.length) { el.innerHTML = '<div class="empty-state">No cron jobs configured</div>'; return; }
  el.innerHTML = `<table class="table"><thead><tr><th>Task</th><th>Schedule</th><th>Last Run</th><th>Next Run</th><th>Runs</th><th>Notify</th><th></th></tr></thead><tbody>
    ${jobs.map(j => `<tr>
      <td><strong>${j.task}</strong></td>
      <td><code>${j.schedule}</code></td>
      <td>${j.lastRun ? timeAgo(j.lastRun) : '—'}</td>
      <td>${j.nextRun ? new Date(j.nextRun).toLocaleTimeString() : '—'}</td>
      <td>${j.runs || 0}</td>
      <td>${j.notifyVia || 'ws'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteHermesCron('${j.id}')">&#10005;</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function deleteHermesCron(id) {
  await fetchJSON(`/api/hermes/cron/${id}`, { method: 'DELETE' });
  loadHermes();
}

function showDelegateModal() {
  showModal('Delegate to Hermes', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label class="form-label">Task Description</label>
        <textarea id="hermesTask" class="form-input" rows="3" placeholder="Describe the task to delegate to Hermes..."></textarea></div>
      <div><label class="form-label">Mode</label>
        <select id="hermesMode" class="grok-type-select" style="width:100%;">
          <option value="background">Background — fire and forget</option>
          <option value="walkaway">Walkaway — progress pings to mobile</option>
          <option value="cron">Cron — scheduled recurring task</option>
        </select></div>
      <div id="hermesCronScheduleWrap" style="display:none;">
        <label class="form-label">Cron Schedule</label>
        <input type="text" id="hermesCronSchedule" class="form-input" placeholder="0 8 * * * (daily at 8am)">
      </div>
      <div><label class="form-label">Notify Via</label>
        <select id="hermesNotify" class="grok-type-select" style="width:100%;">
          <option value="websocket">Dashboard (WebSocket)</option>
          <option value="telegram">Telegram</option>
          <option value="slack">Slack</option>
        </select></div>
      <button class="btn btn-primary" onclick="submitHermesDelegate()">&#9889; Delegate</button>
    </div>
  `);
  document.getElementById('hermesMode').addEventListener('change', (e) => {
    document.getElementById('hermesCronScheduleWrap').style.display = e.target.value === 'cron' ? 'block' : 'none';
  });
}

async function submitHermesDelegate() {
  const task = document.getElementById('hermesTask').value.trim();
  const mode = document.getElementById('hermesMode').value;
  const notifyVia = document.getElementById('hermesNotify').value;
  if (!task) return;

  const body = { task, mode, notifyVia };
  if (mode === 'cron') {
    body.schedule = document.getElementById('hermesCronSchedule').value.trim() || '0 8 * * *';
  }
  await fetchJSON('/api/hermes/delegate', { method: 'POST', body });
  closeModal();
  loadHermes();
}

function showAddCronModal() {
  showModal('New Cron Job', `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div><label class="form-label">Task Description</label>
        <input type="text" id="cronTask" class="form-input" placeholder="Daily inbox summary..."></div>
      <div><label class="form-label">Cron Schedule</label>
        <input type="text" id="cronSchedule" class="form-input" placeholder="0 8 * * * (daily at 8am)"></div>
      <div><label class="form-label">Notify Via</label>
        <select id="cronNotify" class="grok-type-select" style="width:100%;">
          <option value="websocket">Dashboard</option>
          <option value="telegram">Telegram</option>
          <option value="slack">Slack</option>
        </select></div>
      <button class="btn btn-primary" onclick="submitHermesCron()">+ Create Job</button>
    </div>
  `);
}

async function submitHermesCron() {
  const task = document.getElementById('cronTask').value.trim();
  const schedule = document.getElementById('cronSchedule').value.trim();
  const notifyVia = document.getElementById('cronNotify').value;
  if (!task || !schedule) return;
  await fetchJSON('/api/hermes/cron', { method: 'POST', body: { task, schedule, notifyVia } });
  closeModal();
  loadHermes();
}

document.addEventListener('DOMContentLoaded', () => {
  const delegateBtn = document.getElementById('hermesDelegateBtn');
  if (delegateBtn) delegateBtn.addEventListener('click', showDelegateModal);
  const cronAddBtn = document.getElementById('hermesCronAddBtn');
  if (cronAddBtn) cronAddBtn.addEventListener('click', showAddCronModal);
});

// --- Settings ---

// Map of section → field → input ID
const settingsFieldMap = {
  ai: ['anthropic_api_key', 'openai_api_key', 'deepseek_api_key', 'xai_api_key', 'gemini_api_key', 'perplexity_api_key', 'firecrawl_api_key', 'tavily_api_key', 'apify_api_token', 'manus_api_key', 'heygen_api_key', 'did_api_key', 'livekit_api_key', 'livekit_api_secret', 'livekit_url', 'deepgram_api_key', 'cartesia_api_key'],
  mcp: ['hermes_url', 'hermes_enabled'],
  notifications: ['telegram_bot_token', 'telegram_chat_id', 'slack_webhook_url'],
  automation: ['n8n_webhook_base', 'n8n_api_key', 'team_webhook_url'],
  stripe: ['secret_key', 'webhook_secret', 'business_price_id', 'enterprise_price_id', 'enterprise_renewal_price_id'],
  seo: ['dataforseo_login', 'dataforseo_password', 'default_location', 'default_language'],
  general: ['demo_mode', 'cors_origin', 'api_token'],
};

async function loadSettings() {
  const data = await fetchJSON('/api/settings');
  if (!data || data.error) return;

  // Populate fields from server response
  for (const [section, fields] of Object.entries(settingsFieldMap)) {
    const sectionData = data[section];
    if (!sectionData) continue;

    for (const field of fields) {
      const el = document.getElementById(`set-${field}`);
      if (!el) continue;
      const val = sectionData[field];

      if (el.type === 'checkbox') {
        el.checked = typeof val === 'object' ? val.configured : !!val;
      } else if (typeof val === 'object' && val !== null) {
        // Masked key object { value, configured }
        el.value = val.value || '';
        el.placeholder = val.configured ? 'Configured (enter new value to change)' : el.placeholder;
        const statusEl = document.getElementById(`status-${field}`);
        if (statusEl) {
          statusEl.textContent = val.configured ? 'Active' : 'Not set';
          statusEl.className = `settings-status ${val.configured ? 'active' : 'inactive'}`;
        }
      } else {
        el.value = val || '';
      }
    }
  }
}

async function saveSettings(section) {
  const fields = settingsFieldMap[section];
  if (!fields) return;

  const body = {};
  let hasNewValue = false;
  for (const field of fields) {
    const el = document.getElementById(`set-${field}`);
    if (!el) { console.warn(`[Settings] Missing element: set-${field}`); continue; }
    if (el.type === 'checkbox') {
      body[field] = el.checked;
    } else {
      body[field] = el.value;
      // Track if user entered a non-empty, non-masked value
      if (el.value && !el.value.includes('****')) hasNewValue = true;
    }
  }

  // Show debug info on page
  const debugEl = document.getElementById(`settings-${section}-debug`);
  const debugLines = fields.map(f => {
    const v = body[f];
    if (typeof v === 'boolean') return `${f}=${v}`;
    if (!v) return `${f}=EMPTY`;
    if (v.includes('****')) return `${f}=MASKED`;
    return `${f}=${v.substring(0, 6)}...(${v.length})`;
  });
  if (debugEl) debugEl.textContent = debugLines.join(' | ');

  if (!hasNewValue) {
    showSettingsToast('No new values entered — type a key then click Save', true);
    if (debugEl) debugEl.textContent += ' → BLOCKED: all empty or masked';
    return;
  }

  // Direct fetch with explicit auth
  try {
    const token = localStorage.getItem('ai-os-token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    if (debugEl) debugEl.textContent += ` | token:${token ? 'YES' : 'NONE'}`;
    console.log('[Settings] PUT', section, body);

    const res = await fetch(`/api/settings/${section}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { error: text }; }
    console.log(`[Settings] HTTP ${res.status}:`, result);
    if (debugEl) debugEl.textContent += ` → ${res.status}: ${JSON.stringify(result).substring(0, 120)}`;

    if (res.status === 401) {
      showSettingsToast('Session expired — log out and log back in', true);
      return;
    }
    if (res.status === 403) {
      showSettingsToast('Admin access required', true);
      return;
    }

    if (result.ok) {
      const saved = result.updated && result.updated.length > 0;
      showSettingsToast(saved ? `Saved: ${result.updated.join(', ')}` : 'No changes detected', !saved);
      setTimeout(() => loadSettings(), 500);
    } else {
      showSettingsToast(result.error || `Save failed (HTTP ${res.status})`, true);
    }
  } catch (e) {
    console.error('[Settings] Save error:', e);
    if (debugEl) debugEl.textContent += ` → ERROR: ${e.message}`;
    showSettingsToast(`Network error: ${e.message}`, true);
  }
}

async function testConnection(service) {
  const result = await fetchJSON(`/api/settings/test/${service}`, { method: 'POST', body: {} });
  const msg = result.message || (result.ok ? 'Connected' : 'Failed');
  showSettingsToast(`${service}: ${msg}`, !result.ok);
}

async function changePassword() {
  const current = document.getElementById('set-current-password').value;
  const newPw = document.getElementById('set-new-password').value;
  const confirm = document.getElementById('set-confirm-password').value;
  const msgEl = document.getElementById('settingsPasswordMsg');

  if (!current || !newPw) {
    msgEl.textContent = 'Both fields are required';
    msgEl.className = 'settings-msg error';
    return;
  }
  if (newPw !== confirm) {
    msgEl.textContent = 'New passwords do not match';
    msgEl.className = 'settings-msg error';
    return;
  }
  if (newPw.length < 10) {
    msgEl.textContent = 'Password must be at least 10 characters';
    msgEl.className = 'settings-msg error';
    return;
  }

  const result = await fetchJSON('/api/settings/change-password', {
    method: 'POST',
    body: { currentPassword: current, newPassword: newPw },
  });

  if (result.ok) {
    msgEl.textContent = 'Password changed successfully';
    msgEl.className = 'settings-msg success';
    document.getElementById('set-current-password').value = '';
    document.getElementById('set-new-password').value = '';
    document.getElementById('set-confirm-password').value = '';
  } else {
    msgEl.textContent = result.error || 'Failed to change password';
    msgEl.className = 'settings-msg error';
  }
}

function toggleKeyVisibility(btn) {
  const input = btn.parentElement.querySelector('.settings-input');
  if (!input) return;
  if (input.classList.contains('visible')) {
    input.classList.remove('visible');
    btn.textContent = '👁';
    btn.title = 'Show';
  } else {
    input.classList.add('visible');
    btn.textContent = '🙈';
    btn.title = 'Hide';
  }
}

function showSettingsToast(message, isError = false) {
  // Remove existing toast if any
  const existing = document.querySelector('.settings-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `settings-toast ${isError ? 'error' : 'success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '<p>')
    .replace(/(<p>)+/g, '<p>')
    .replace(/<p><\/p>/g, '');
}

// --- White-Label Licensing ---
async function loadLicensing() {
  const [stats, participants, info] = await Promise.all([
    fetchJSON('/api/license/stats'),
    fetchJSON('/api/license/participants'),
    fetchJSON('/api/license/info'),
  ]);
  renderLicenseStats(stats);
  renderLicenseList(Array.isArray(participants) ? participants : []);
  renderLicenseInfo(info);
}

function renderLicenseStats(stats) {
  const container = document.getElementById('licenseStats');
  if (!container || !stats) return;
  const fillColor = stats.fillRate > 75 ? 'var(--error)' : stats.fillRate > 50 ? 'var(--warning)' : 'var(--success)';
  container.innerHTML = `
    <div class="hq-stat"><div class="hq-stat-value">${stats.active || 0}</div><div class="hq-stat-label">Active Licenses</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${stats.byStatus?.pending || 0}</div><div class="hq-stat-label">Pending</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:${fillColor};">${stats.remaining}</div><div class="hq-stat-label">Lifetime Remaining</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--success);">$${(stats.totalRevenue || 0).toLocaleString()}</div><div class="hq-stat-label">Revenue</div></div>
    <div class="hq-stat"><div class="hq-stat-value">$${((stats.projectedRevenue || 0) / 1000000).toFixed(1)}M</div><div class="hq-stat-label">Projected (Full)</div></div>
    <div class="hq-stat">
      <div class="hq-stat-value">${stats.fillRate || 0}%</div>
      <div class="hq-stat-label">Fill Rate</div>
      <div class="franchise-fill-bar"><div class="franchise-fill" style="width:${stats.fillRate || 0}%; background:${fillColor};"></div></div>
    </div>
  `;
}

function renderLicenseList(participants) {
  const container = document.getElementById('licenseList');
  if (!container) return;

  if (!participants.length) {
    container.innerHTML = '<div class="empty-state">No license applications yet.</div>';
    return;
  }

  container.innerHTML = participants.slice().reverse().map(p => {
    const statusColors = { pending: '#f59e0b', approved: '#3b82f6', payment: '#8b5cf6', active: '#10b981', suspended: '#ef4444', rejected: '#6b7280' };
    return `
      <div class="franchise-card" onclick="viewLicenseParticipant('${p.id}')">
        <div class="franchise-card-status" style="background:${statusColors[p.status] || '#6b7280'};">${p.status}</div>
        <div class="franchise-card-info">
          <div class="franchise-card-name">${escapeHtml(p.name)}</div>
          <div class="franchise-card-meta">${escapeHtml(p.email)}${p.company ? ` · ${escapeHtml(p.company)}` : ''}${p.industry ? ` · ${escapeHtml(p.industry)}` : ''}</div>
        </div>
        <div class="franchise-card-date">${new Date(p.appliedAt).toLocaleDateString()}</div>
      </div>
    `;
  }).join('');
}

function renderLicenseInfo(info) {
  const container = document.getElementById('licenseInfo');
  if (!container || !info) return;
  const tiers = info.tiers || {};
  const tierRows = Object.entries(tiers).map(([key, t]) =>
    `<div class="franchise-tier-row">
      <span class="franchise-tier-name">${t.name}</span>
      <span class="franchise-tier-price">${t.price === 0 ? 'Free' : `$${t.price.toLocaleString()}`}${t.interval === 'one-time' ? ' one-time' : t.interval === 'year' ? '/yr' : ''}</span>
    </div>`
  ).join('');
  container.innerHTML = `
    <div class="franchise-info-header">
      <div class="franchise-price">Open-Core Licensing</div>
      <div class="franchise-price-label">Self-Hosted Deployment</div>
    </div>
    <div class="franchise-tiers" style="margin:12px 0;">${tierRows}</div>
    <div class="franchise-availability open">
      Community edition free &amp; open-source. Business &amp; Enterprise licenses available.
    </div>
    <h4 style="margin:16px 0 8px; font-size:13px;">What's Included:</h4>
    <ul class="franchise-includes">
      ${(info.includes || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}
    </ul>
  `;
}

async function viewLicenseParticipant(id) {
  const p = await fetchJSON(`/api/license/participant/${id}`);
  if (!p || p.error) return;

  const modal = document.getElementById('licenseModal');
  const detail = document.getElementById('licenseDetail');
  const statusColors = { pending: '#f59e0b', approved: '#3b82f6', payment: '#8b5cf6', active: '#10b981', suspended: '#ef4444', rejected: '#6b7280' };
  const nextActions = {
    pending: [{ label: 'Approve', status: 'approved', cls: 'btn-primary' }, { label: 'Reject', status: 'rejected', cls: 'btn-danger' }],
    approved: [{ label: 'Send Payment Link', status: 'payment', cls: 'btn-primary' }, { label: 'Reject', status: 'rejected', cls: 'btn-danger' }],
    payment: [{ label: 'Mark Active', status: 'active', cls: 'btn-primary' }],
    active: [{ label: 'Suspend', status: 'suspended', cls: 'btn-danger' }],
    suspended: [{ label: 'Reactivate', status: 'active', cls: 'btn-primary' }],
    rejected: [{ label: 'Reconsider', status: 'pending', cls: '' }],
  };
  const actions = (nextActions[p.status] || []).map(a =>
    `<button class="btn btn-sm ${a.cls}" onclick="updateLicense('${p.id}','${a.status}')">${a.label}</button>`
  ).join(' ');

  detail.innerHTML = `
    <div class="hq-modal-header">
      <button class="btn btn-sm" onclick="document.getElementById('licenseModal').style.display='none';">&times; Close</button>
    </div>
    <div class="franchise-detail-header">
      <h3>${escapeHtml(p.name)}</h3>
      <span class="franchise-status-badge" style="background:${statusColors[p.status]};">${p.status}</span>
    </div>
    <div class="hq-profile-details" style="margin-top:16px;">
      <div class="hq-detail-row"><span class="hq-detail-key">Email</span><span class="hq-detail-val">${escapeHtml(p.email)}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Company</span><span class="hq-detail-val">${escapeHtml(p.company || 'N/A')}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Industry</span><span class="hq-detail-val">${escapeHtml(p.industry || 'N/A')}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Website</span><span class="hq-detail-val">${p.website ? escapeHtml(p.website) : 'N/A'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Applied</span><span class="hq-detail-val">${new Date(p.appliedAt).toLocaleString()}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Payment ID</span><span class="hq-detail-val">${p.paymentId || 'N/A'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Instance URL</span><span class="hq-detail-val">${p.instanceUrl || 'Not deployed'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Territory</span><span class="hq-detail-val">${p.territory || 'Unassigned'}</span></div>
    </div>
    ${p.message ? `<div class="hq-profile-desc" style="margin-top:12px;"><strong>Message:</strong> ${escapeHtml(p.message)}</div>` : ''}
    <div style="margin-top:16px;">
      <h4 style="margin-bottom:8px; font-size:13px;">Admin Notes</h4>
      <textarea id="licenseNotes" class="settings-input" rows="3" style="width:100%; font-size:13px;">${escapeHtml(p.notes || '')}</textarea>
      <button class="btn btn-sm" style="margin-top:6px;" onclick="saveLicenseNotes('${p.id}')">Save Notes</button>
    </div>
    <div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
      ${actions}
    </div>
    <div id="licenseActionResult" style="margin-top:10px;"></div>
  `;
  modal.style.display = 'flex';
}

async function updateLicense(id, newStatus) {
  const result = await fetchJSON(`/api/license/participant/${id}`, { method: 'PUT', body: { status: newStatus } });
  const el = document.getElementById('licenseActionResult');
  if (result.ok) {
    el.innerHTML = `<div class="hq-dispatch-success">Status updated to: ${newStatus}</div>`;
    setTimeout(() => { document.getElementById('licenseModal').style.display = 'none'; loadLicensing(); }, 1000);
  } else {
    el.innerHTML = `<div class="hq-dispatch-error">${result.error || 'Update failed'}</div>`;
  }
}

async function saveLicenseNotes(id) {
  const notes = document.getElementById('licenseNotes').value;
  const result = await fetchJSON(`/api/license/participant/${id}`, { method: 'PUT', body: { notes } });
  if (result.ok) showSettingsToast('Notes saved');
}

// --- Platform Self-Improvement ---
async function loadPlatform() {
  const [proposals, stats] = await Promise.all([
    fetchJSON('/api/platform/proposals'),
    fetchJSON('/api/platform/stats'),
  ]);
  const list = Array.isArray(proposals) ? proposals : [];
  renderPlatformStats(stats);
  renderPlatformPending(list.filter(p => p.status === 'pending'));
  renderPlatformHistory(list.filter(p => p.status !== 'pending'));
}

function renderPlatformStats(stats) {
  const container = document.getElementById('platformStats');
  if (!container || !stats) return;
  container.innerHTML = `
    <div class="hq-stat"><div class="hq-stat-value">${stats.total || 0}</div><div class="hq-stat-label">Total Proposals</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--warning);">${stats.byStatus?.pending || 0}</div><div class="hq-stat-label">Pending</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--success);">${(stats.byStatus?.approved || 0) + (stats.byStatus?.applied || 0)}</div><div class="hq-stat-label">Approved</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--error);">${stats.byStatus?.rejected || 0}</div><div class="hq-stat-label">Rejected</div></div>
  `;
}

function renderPlatformPending(proposals) {
  const container = document.getElementById('platformPending');
  if (!container) return;
  if (!proposals.length) { container.innerHTML = '<div class="empty-state">No pending proposals. The platform is up to date.</div>'; return; }

  container.innerHTML = proposals.map(p => {
    const riskClass = p.risk === 'high' ? 'critical' : p.risk === 'medium' ? 'warning' : 'info';
    return `
      <div class="platform-proposal">
        <div class="platform-proposal-icon">${p.icon}</div>
        <div class="platform-proposal-content">
          <div class="platform-proposal-title">${escapeHtml(p.title)}</div>
          <div class="platform-proposal-meta">
            <span class="seo-finding-severity seo-finding-${riskClass}" style="display:inline-block;">${p.risk} risk</span>
            <span>${p.typeLabel}</span>
            <span>${new Date(p.createdAt).toLocaleString()}</span>
            ${p.autoApply ? '<span style="color:var(--primary);">Auto-apply on approve</span>' : ''}
          </div>
          ${p.description ? `<div class="platform-proposal-desc">${escapeHtml(p.description)}</div>` : ''}
          ${p.diff ? `<pre class="platform-diff">${escapeHtml(p.diff.substring(0, 300))}${p.diff.length > 300 ? '...' : ''}</pre>` : ''}
        </div>
        <div class="platform-proposal-actions">
          <button class="btn btn-sm btn-primary" onclick="respondProposal('${p.id}','approved')">Approve</button>
          <button class="btn btn-sm btn-danger" onclick="respondProposal('${p.id}','rejected')">Reject</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderPlatformHistory(proposals) {
  const container = document.getElementById('platformHistory');
  if (!container) return;
  if (!proposals.length) { container.innerHTML = '<div class="empty-state">No history yet.</div>'; return; }

  container.innerHTML = proposals.slice().reverse().slice(0, 20).map(p => {
    const statusIcon = p.status === 'applied' ? '&#9989;' : p.status === 'approved' ? '&#128993;' : '&#10060;';
    const via = p.respondedVia ? ` via ${p.respondedVia}` : '';
    const applyBtn = p.status === 'approved' ? `<button class="btn btn-sm btn-primary" onclick="manualApplyProposal('${p.id}')">Apply Now</button>` : '';
    const appliedInfo = p.applyResult ? `<span class="platform-history-steps" title="${(p.applyResult.steps || []).map(s => s.action).join(' → ')}">${p.applyResult.steps?.length || 0} steps</span>` : '';
    return `
      <div class="platform-history-item">
        <span>${statusIcon} ${p.icon}</span>
        <span class="platform-history-title">${escapeHtml(p.title)}</span>
        <span class="platform-history-status">${p.status}${via}</span>
        ${appliedInfo}
        ${applyBtn}
        <span class="platform-history-date">${p.respondedAt ? new Date(p.respondedAt).toLocaleDateString() : ''}</span>
      </div>
    `;
  }).join('');
}

async function manualApplyProposal(id) {
  const result = await fetchJSON(`/api/platform/proposals/${id}/apply`, { method: 'POST', body: {} });
  if (result.ok) {
    const steps = (result.applyResult?.steps || []).map(s => s.action).join(' → ');
    showSettingsToast(`Applied: ${result.proposal.title} (${steps})`);
    loadPlatform();
  } else {
    showSettingsToast(result.error || 'Apply failed', true);
  }
}

async function respondProposal(id, status) {
  const result = await fetchJSON(`/api/platform/proposals/${id}`, { method: 'PUT', body: { status } });
  if (result.ok) {
    showSettingsToast(`Proposal ${status}: ${result.proposal.title}`);
    loadPlatform();
  }
}

function showCreateProposal() {
  const modal = document.getElementById('platformModal');
  const content = document.getElementById('platformModalContent');
  const typeOptions = [
    ['dependency-update', '📦 Dependency Update'],
    ['model-upgrade', '🧠 Model Upgrade'],
    ['cost-optimization', '💰 Cost Optimization'],
    ['new-skill', '✨ New Skill'],
    ['bug-fix', '🔧 Bug Fix'],
    ['security-patch', '🛡️ Security Patch'],
    ['content-refresh', '📄 Content Refresh'],
    ['config-change', '⚙️ Config Change'],
    ['feature-proposal', '🚀 Feature Proposal'],
  ].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

  content.innerHTML = `
    <div class="hq-modal-header"><button class="btn btn-sm" onclick="document.getElementById('platformModal').style.display='none';">&times; Close</button></div>
    <h3 style="margin-bottom:16px;">Create Proposal</h3>
    <div class="settings-fields">
      <div class="settings-field"><label class="settings-label">Type</label><select class="settings-input" id="propType">${typeOptions}</select></div>
      <div class="settings-field"><label class="settings-label">Title *</label><input type="text" class="settings-input" id="propTitle" placeholder="What should change?"></div>
      <div class="settings-field"><label class="settings-label">Description</label><textarea class="settings-input" id="propDesc" rows="3" placeholder="Why and how..."></textarea></div>
      <div class="settings-field"><label class="settings-label">Diff / Code Change (optional)</label><textarea class="settings-input" id="propDiff" rows="3" placeholder="+ added line&#10;- removed line" style="font-family:var(--font-mono);font-size:12px;"></textarea></div>
      <div class="settings-field"><label class="settings-toggle"><input type="checkbox" id="propAutoApply"><span class="settings-toggle-slider"></span><span class="settings-toggle-label">Auto-apply on approval</span></label></div>
    </div>
    <div id="propResult" style="margin-top:10px;"></div>
    <button class="btn btn-primary" style="margin-top:12px;" onclick="submitProposal()">Submit Proposal</button>
  `;
  modal.style.display = 'flex';
}

async function submitProposal() {
  const type = document.getElementById('propType').value;
  const title = document.getElementById('propTitle').value.trim();
  const description = document.getElementById('propDesc').value.trim();
  const diff = document.getElementById('propDiff').value.trim();
  const autoApply = document.getElementById('propAutoApply').checked;
  const el = document.getElementById('propResult');

  if (!title) { el.innerHTML = '<div class="hq-dispatch-error">Title required</div>'; return; }

  const result = await fetchJSON('/api/platform/propose', { method: 'POST', body: { type, title, description, diff: diff || null, autoApply } });
  if (result.ok) {
    el.innerHTML = '<div class="hq-dispatch-success">Proposal submitted — check Telegram/Slack for approval request</div>';
    setTimeout(() => { document.getElementById('platformModal').style.display = 'none'; loadPlatform(); }, 1500);
  } else {
    el.innerHTML = `<div class="hq-dispatch-error">${result.error || 'Failed'}</div>`;
  }
}

// --- HQ Avatar Animations ---
// Listen for agent execution events and animate the corresponding employee
function setupHQAnimations() {
  if (!ws) return;
  const origOnMessage = ws.onmessage;
  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.event === 'hq_task_dispatched') {
        // Set employee to busy with typing animation
        const empEl = document.querySelector(`.hq-employee[onclick*="'${data.data.employee}'"]`);
        if (empEl) {
          empEl.dataset.status = 'busy';
        }
      }

      if (data.event === 'hq_task_complete' || data.event === 'agent_complete') {
        // Return to active after task completes
        const agentName = data.data.employee || data.data.agent;
        const empEl = document.querySelector(`.hq-employee[onclick*="'${agentName}'"]`);
        if (empEl) {
          empEl.dataset.status = 'active';
        }
      }
    } catch {}
  });
}

// Ambient animation — randomly pulse a few employees to show "life"
function startAmbientHQLife() {
  setInterval(() => {
    const employees = document.querySelectorAll('.hq-employee[data-status="active"]');
    if (employees.length < 3) return;
    // Pick 1-2 random active employees and briefly make them "busy"
    const count = Math.random() > 0.6 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const emp = employees[Math.floor(Math.random() * employees.length)];
      if (emp.dataset.status === 'active') {
        emp.dataset.status = 'busy';
        setTimeout(() => { emp.dataset.status = 'active'; }, 3000 + Math.random() * 5000);
      }
    }
  }, 8000);
}

// Initialize when HQ view loads
const _origLoadHQ = loadHQ;
loadHQ = async function() {
  await _origLoadHQ();
  setupHQAnimations();
  startAmbientHQLife();
};

// --- Monitoring & Analytics ---
async function loadMonitoring() {
  const [analytics, monitoring, onboarding] = await Promise.all([
    fetchJSON('/api/tenants/analytics'),
    fetchJSON('/api/tenants/monitoring'),
    fetchJSON('/api/onboarding/status'),
  ]);
  renderOnboarding(onboarding);
  renderMonitoringStats(analytics, monitoring);
  renderByModel(analytics?.byModel || []);
  renderByAgent(analytics?.byAgent || []);
  renderTenantHealth(monitoring?.tenants || []);
}

function renderOnboarding(data) {
  const container = document.getElementById('onboardingWizard');
  if (!container || !data || data.allDone) { if (container) container.style.display = 'none'; return; }

  container.style.display = 'block';
  container.innerHTML = `
    <section class="panel" style="margin-bottom:16px; border-left:3px solid var(--primary);">
      <h3 class="panel-title" style="display:flex;justify-content:space-between;">
        <span>&#128640; Setup Wizard — ${data.percentage}% Complete</span>
        <span style="font-size:13px;color:var(--text-muted);">${data.completed}/${data.total} steps</span>
      </h3>
      <div style="height:6px;background:var(--bg-primary);border-radius:3px;margin:12px 0;overflow:hidden;">
        <div style="height:100%;width:${data.percentage}%;background:linear-gradient(90deg,var(--primary),#10b981);border-radius:3px;transition:width 0.5s;"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${data.steps.map(s => `
          <div style="display:flex;gap:8px;align-items:center;padding:8px 12px;background:var(--bg-primary);border-radius:var(--radius);font-size:13px;">
            <span style="font-size:16px;">${s.done ? '&#9989;' : '&#11036;'}</span>
            <span style="color:${s.done ? 'var(--text-muted)' : 'var(--text-primary)'};${s.done ? 'text-decoration:line-through;' : ''}">${s.label}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderMonitoringStats(analytics, monitoring) {
  const container = document.getElementById('monitoringStats');
  if (!container) return;
  const a = analytics || {};
  const m = monitoring?.summary || {};
  container.innerHTML = `
    <div class="hq-stat"><div class="hq-stat-value">${m.activeTenants || 0}</div><div class="hq-stat-label">Active Tenants</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${m.totalUsers || 0}</div><div class="hq-stat-label">Total Users</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${m.totalAudits || 0}</div><div class="hq-stat-label">SEO Audits</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${a.leads?.total || 0}</div><div class="hq-stat-label">Free Audit Leads</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--success);">$${(a.cost?.daily || 0).toFixed(2)}</div><div class="hq-stat-label">Cost Today</div></div>
    <div class="hq-stat"><div class="hq-stat-value">$${(a.cost?.weekly || 0).toFixed(2)}</div><div class="hq-stat-label">Cost This Week</div></div>
    <div class="hq-stat"><div class="hq-stat-value">$${(a.cost?.monthly || 0).toFixed(2)}</div><div class="hq-stat-label">Cost This Month</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${a.totalApiCalls || 0}</div><div class="hq-stat-label">API Calls</div></div>
  `;
}

function renderByModel(models) {
  const container = document.getElementById('monitoringByModel');
  if (!container) return;
  if (!models.length) { container.innerHTML = '<div class="empty-state">No API calls recorded yet.</div>'; return; }
  container.innerHTML = models.map(m => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span style="font-weight:600;">${m.model}</span>
      <span style="color:var(--text-muted);">${m.calls} calls</span>
      <span style="color:var(--success);font-weight:700;">$${m.cost.toFixed(2)}</span>
    </div>
  `).join('');
}

function renderByAgent(agents) {
  const container = document.getElementById('monitoringByAgent');
  if (!container) return;
  if (!agents.length) { container.innerHTML = '<div class="empty-state">No agent activity yet.</div>'; return; }
  container.innerHTML = agents.slice(0, 10).map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span style="font-weight:600;">${a.agent}</span>
      <span style="color:var(--text-muted);">${a.calls} calls</span>
      <span style="color:var(--success);font-weight:700;">$${a.cost.toFixed(2)}</span>
    </div>
  `).join('');
}

function renderTenantHealth(tenants) {
  const container = document.getElementById('monitoringTenants');
  if (!container) return;
  if (!tenants.length) { container.innerHTML = '<div class="empty-state">No tenants.</div>'; return; }
  container.innerHTML = tenants.map(t => {
    const healthColor = t.health === 'ready' ? 'var(--success)' : 'var(--warning)';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${healthColor};flex-shrink:0;"></span>
        <span style="font-weight:600;min-width:120px;">${escapeHtml(t.name)}</span>
        <span style="color:var(--text-muted);">${t.subdomain || t.domain || 'no domain'}</span>
        <span style="color:var(--text-muted);">${t.users} users</span>
        <span style="color:var(--text-muted);">${t.audits} audits</span>
        <span style="color:var(--text-muted);">Keys: ${t.apiKeys}</span>
        <span style="margin-left:auto;font-size:11px;font-weight:600;text-transform:uppercase;color:${healthColor};">${t.health}</span>
      </div>
    `;
  }).join('');
}

// --- Tenant Management ---
async function loadTenants() {
  const [tenants, templates] = await Promise.all([
    fetchJSON('/api/tenants'),
    fetchJSON('/api/templates'),
  ]);
  renderTenantStats(Array.isArray(tenants) ? tenants : []);
  renderTenantList(Array.isArray(tenants) ? tenants : []);
  window._templates = Array.isArray(templates) ? templates : [];
}

function renderTenantStats(tenants) {
  const container = document.getElementById('tenantStats');
  if (!container) return;
  const active = tenants.filter(t => t.status === 'active').length;
  const deactivated = tenants.filter(t => t.status === 'deactivated').length;
  container.innerHTML = `
    <div class="hq-stat"><div class="hq-stat-value">${tenants.length}</div><div class="hq-stat-label">Total Tenants</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--success);">${active}</div><div class="hq-stat-label">Active</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--text-muted);">${deactivated}</div><div class="hq-stat-label">Deactivated</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${tenants.filter(t => t.industry).length}</div><div class="hq-stat-label">With Template</div></div>
  `;
}

function renderTenantList(tenants) {
  const container = document.getElementById('tenantList');
  if (!container) return;
  if (!tenants.length) { container.innerHTML = '<div class="empty-state">No tenants yet. Provision one from a franchise application.</div>'; return; }

  container.innerHTML = tenants.map(t => {
    const statusColor = t.status === 'active' ? 'var(--success)' : t.status === 'deactivated' ? 'var(--error)' : 'var(--text-muted)';
    return `
      <div class="franchise-card" onclick="viewTenant('${t.id}')">
        <div class="franchise-card-status" style="background:${statusColor};">${t.status}</div>
        <div class="franchise-card-info">
          <div class="franchise-card-name">${escapeHtml(t.name)} ${t.id === 'master' ? '<span style="color:var(--primary);font-size:11px;">(MASTER)</span>' : ''}</div>
          <div class="franchise-card-meta">
            ${t.subdomain ? `${escapeHtml(t.subdomain)}.aiosorchestrationlab.com` : t.domain || 'No domain'}
            ${t.industry ? ` &middot; ${escapeHtml(t.industry)}` : ''}
            &middot; ${escapeHtml(t.ownerId)}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:12px;height:12px;border-radius:50%;background:${t.branding?.primaryColor || '#3b82f6'};"></div>
          <span style="font-size:11px;color:var(--text-muted);">${new Date(t.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function viewTenant(id) {
  const [tenant, stats] = await Promise.all([
    fetchJSON(`/api/tenants/${id}`),
    fetchJSON(`/api/tenants/${id}/stats`),
  ]);
  if (!tenant || tenant.error) return;

  const modal = document.getElementById('tenantModal');
  const content = document.getElementById('tenantModalContent');

  content.innerHTML = `
    <div class="hq-modal-header"><button class="btn btn-sm" onclick="document.getElementById('tenantModal').style.display='none';">&times; Close</button></div>
    <div class="franchise-detail-header">
      <h3>${escapeHtml(tenant.name)}</h3>
      <span class="franchise-status-badge" style="background:${tenant.status === 'active' ? 'var(--success)' : 'var(--error)'};">${tenant.status}</span>
    </div>
    <div class="hq-profile-details" style="margin-top:16px;">
      <div class="hq-detail-row"><span class="hq-detail-key">Tenant ID</span><span class="hq-detail-val"><code>${tenant.id}</code></span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Owner</span><span class="hq-detail-val">${escapeHtml(tenant.ownerId)}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Subdomain</span><span class="hq-detail-val">${tenant.subdomain || 'None'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Domain</span><span class="hq-detail-val">${tenant.domain || 'None'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Industry</span><span class="hq-detail-val">${tenant.industry || 'General'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Template</span><span class="hq-detail-val">${tenant.template || 'None'}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Users</span><span class="hq-detail-val">${stats?.users || 0}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">API Keys Set</span><span class="hq-detail-val">${stats?.apiKeysConfigured || 0} / 7</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">SEO Audits</span><span class="hq-detail-val">${stats?.seoAudits || 0}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Created</span><span class="hq-detail-val">${new Date(tenant.createdAt).toLocaleString()}</span></div>
    </div>
    <h4 style="margin:16px 0 8px; font-size:13px;">Branding</h4>
    <div class="hq-profile-details">
      <div class="hq-detail-row"><span class="hq-detail-key">Company Name</span><span class="hq-detail-val">${escapeHtml(tenant.branding?.companyName || '')}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Tagline</span><span class="hq-detail-val">${escapeHtml(tenant.branding?.tagline || '')}</span></div>
      <div class="hq-detail-row">
        <span class="hq-detail-key">Colors</span>
        <span class="hq-detail-val" style="display:flex;gap:8px;align-items:center;">
          <span style="width:20px;height:20px;border-radius:4px;background:${tenant.branding?.primaryColor};display:inline-block;"></span> ${tenant.branding?.primaryColor}
          <span style="width:20px;height:20px;border-radius:4px;background:${tenant.branding?.accentColor};display:inline-block;margin-left:8px;"></span> ${tenant.branding?.accentColor}
        </span>
      </div>
    </div>
    ${tenant.id !== 'master' ? `
    <div style="margin-top:16px; display:flex; gap:8px;">
      <button class="btn btn-sm btn-danger" onclick="deactivateTenant('${tenant.id}')">Deactivate</button>
    </div>` : ''}
    <div id="tenantActionResult" style="margin-top:10px;"></div>
  `;
  modal.style.display = 'flex';
}

function showProvisionTenantModal() {
  const modal = document.getElementById('tenantModal');
  const content = document.getElementById('tenantModalContent');
  const templateOptions = (window._templates || []).map(t =>
    `<option value="${t.id}">${escapeHtml(t.name)}</option>`
  ).join('');

  content.innerHTML = `
    <div class="hq-modal-header"><button class="btn btn-sm" onclick="document.getElementById('tenantModal').style.display='none';">&times; Close</button></div>
    <h3 style="margin-bottom:16px;">Provision New Tenant</h3>
    <div class="settings-fields">
      <div class="settings-field"><label class="settings-label">Company Name *</label><input type="text" class="settings-input" id="newTenantName" placeholder="Acme Corp"></div>
      <div class="settings-field"><label class="settings-label">Owner Email *</label><input type="email" class="settings-input" id="newTenantEmail" placeholder="owner@company.com"></div>
      <div class="settings-field"><label class="settings-label">Subdomain</label><input type="text" class="settings-input" id="newTenantSubdomain" placeholder="acme" style="font-family:var(--font-mono);"><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">.aiosorchestrationlab.com</div></div>
      <div class="settings-field"><label class="settings-label">Industry Template</label><select class="settings-input" id="newTenantTemplate"><option value="">None (General)</option>${templateOptions}</select></div>
      <div class="settings-field"><label class="settings-label">Primary Color</label><input type="color" id="newTenantColor" value="#3b82f6" style="width:60px;height:36px;border:none;cursor:pointer;"></div>
      <div class="settings-field"><label class="settings-label">Franchise ID (optional)</label><input type="text" class="settings-input" id="newTenantFranchise" placeholder="From franchise application"></div>
    </div>
    <div id="provisionResult" style="margin-top:10px;"></div>
    <button class="btn btn-primary" style="margin-top:12px;" onclick="provisionTenant()">Provision Tenant</button>
  `;
  modal.style.display = 'flex';
}

async function provisionTenant() {
  const name = document.getElementById('newTenantName').value.trim();
  const ownerEmail = document.getElementById('newTenantEmail').value.trim();
  const subdomain = document.getElementById('newTenantSubdomain').value.trim();
  const template = document.getElementById('newTenantTemplate').value;
  const primaryColor = document.getElementById('newTenantColor').value;
  const franchiseId = document.getElementById('newTenantFranchise').value.trim();
  const resultEl = document.getElementById('provisionResult');

  if (!name || !ownerEmail) { resultEl.innerHTML = '<div class="hq-dispatch-error">Name and email required</div>'; return; }

  const result = await fetchJSON('/api/tenants', { method: 'POST', body: {
    name, ownerEmail, subdomain: subdomain || null, template: template || null,
    franchiseId: franchiseId || null, branding: { primaryColor },
  }});

  if (result.ok) {
    resultEl.innerHTML = `<div class="hq-dispatch-success">Tenant provisioned: ${escapeHtml(result.tenant.name)} (ID: ${result.tenant.id})</div>`;
    setTimeout(() => { document.getElementById('tenantModal').style.display = 'none'; loadTenants(); }, 1500);
  } else {
    resultEl.innerHTML = `<div class="hq-dispatch-error">${result.error || 'Provisioning failed'}</div>`;
  }
}

async function deactivateTenant(id) {
  const result = await fetchJSON(`/api/tenants/${id}`, { method: 'DELETE' });
  const el = document.getElementById('tenantActionResult');
  if (result.ok) {
    el.innerHTML = '<div class="hq-dispatch-success">Tenant deactivated</div>';
    setTimeout(() => { document.getElementById('tenantModal').style.display = 'none'; loadTenants(); }, 1000);
  } else {
    el.innerHTML = `<div class="hq-dispatch-error">${result.error || 'Failed'}</div>`;
  }
}

// --- AI Training Center ---
let trainingConfig = null;

async function loadTraining() {
  try {
    const data = await fetchJSON('/api/training');
    if (data.ok === false && data.error?.includes('Requires')) {
      document.getElementById('view-training').innerHTML = `
        <div class="empty-state" style="padding:60px 20px; text-align:center;">
          <div style="font-size:48px; margin-bottom:16px;">&#128274;</div>
          <h3>AI Training requires Business plan or higher</h3>
          <p style="color:var(--text-muted); margin-top:8px;">Custom instructions, knowledge base, and custom agents are available with Business ($1,997 one-time) and Enterprise ($4,997 one-time) licenses.</p>
          <a href="/#pricing" class="btn btn-primary" style="margin-top:16px;">Upgrade Plan</a>
        </div>`;
      return;
    }
    trainingConfig = data;
    renderTrainingInstructions();
    renderTrainingKB();
    renderTrainingAgents();
  } catch (e) {
    console.error('[TRAINING] Load failed:', e);
  }
}

function renderTrainingInstructions() {
  if (!trainingConfig) return;
  const ins = trainingConfig.instructions || {};
  document.getElementById('trainingGlobal').value = ins.global || '';
  document.getElementById('trainingBrandVoice').value = ins.brandVoice || '';
  document.getElementById('trainingIndustry').value = ins.industry || '';
  renderTrainingRules(ins.rules || []);
}

function renderTrainingRules(rules) {
  const container = document.getElementById('trainingRulesList');
  if (!rules.length) {
    container.innerHTML = '<div class="text-muted" style="font-size:13px;">No rules defined yet.</div>';
    return;
  }
  container.innerHTML = rules.map((r, i) => `
    <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border);">
      <span style="flex:1; font-size:13px;">${i + 1}. ${escapeHtml(r)}</span>
      <button class="btn btn-sm btn-ghost" onclick="removeTrainingRule(${i})" title="Remove">&#10005;</button>
    </div>
  `).join('');
}

function addTrainingRule() {
  const input = document.getElementById('trainingNewRule');
  const rule = input.value.trim();
  if (!rule) return;
  if (!trainingConfig.instructions.rules) trainingConfig.instructions.rules = [];
  trainingConfig.instructions.rules.push(rule);
  renderTrainingRules(trainingConfig.instructions.rules);
  input.value = '';
}

function removeTrainingRule(idx) {
  trainingConfig.instructions.rules.splice(idx, 1);
  renderTrainingRules(trainingConfig.instructions.rules);
}

async function saveTrainingInstructions() {
  const instructions = {
    global: document.getElementById('trainingGlobal').value,
    brandVoice: document.getElementById('trainingBrandVoice').value,
    industry: document.getElementById('trainingIndustry').value,
    rules: trainingConfig?.instructions?.rules || [],
  };
  const result = await fetchJSON('/api/training/instructions', {
    method: 'PUT',
    body: instructions,
  });
  if (result.ok !== false) {
    showSettingsToast('Custom instructions saved');
    trainingConfig.instructions = result.instructions || instructions;
  } else {
    showSettingsToast(result.error || 'Failed to save', true);
  }
}

// --- Knowledge Base UI ---

function renderTrainingKB() {
  const docs = trainingConfig?.knowledgeBase || [];
  document.getElementById('trainingKBCount').textContent = `${docs.length} document${docs.length !== 1 ? 's' : ''}`;

  if (!docs.length) {
    document.getElementById('trainingKBList').innerHTML = '<div class="empty-state">No knowledge documents yet. Add your first one above.</div>';
    return;
  }

  document.getElementById('trainingKBList').innerHTML = docs.map(doc => `
    <div class="panel" style="padding:16px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>${escapeHtml(doc.title)}</strong>
          <span class="badge" style="margin-left:8px; font-size:11px;">${escapeHtml(doc.category)}</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-sm" onclick="editKnowledgeDoc('${doc.id}')">Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="deleteKnowledgeDoc('${doc.id}')">Delete</button>
        </div>
      </div>
      <p style="font-size:13px; color:var(--text-muted); margin-top:8px; white-space:pre-wrap; max-height:80px; overflow:hidden;">${escapeHtml(doc.content.substring(0, 300))}${doc.content.length > 300 ? '...' : ''}</p>
    </div>
  `).join('');
}

function showAddKnowledgeModal() {
  const modal = document.getElementById('trainingModal');
  document.getElementById('trainingModalContent').innerHTML = `
    <h3>Add Knowledge Document</h3>
    <div class="settings-field"><label>Title</label><input type="text" id="kbTitle" placeholder="e.g., Product FAQ, Sales Playbook"></div>
    <div class="settings-field"><label>Category</label><input type="text" id="kbCategory" value="general" placeholder="e.g., product, sales, support"></div>
    <div class="settings-field"><label>Content</label><textarea id="kbContent" rows="10" placeholder="Paste your document content here. Markdown supported."></textarea></div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn btn-primary" onclick="submitKnowledgeDoc()">Add Document</button>
      <button class="btn btn-ghost" onclick="document.getElementById('trainingModal').style.display='none'">Cancel</button>
    </div>
  `;
  modal.style.display = 'flex';
}

async function submitKnowledgeDoc(editId) {
  const title = document.getElementById('kbTitle').value.trim();
  const content = document.getElementById('kbContent').value.trim();
  const category = document.getElementById('kbCategory').value.trim() || 'general';

  if (!title || !content) return showSettingsToast('Title and content required', true);

  const url = editId ? `/api/training/knowledge/${editId}` : '/api/training/knowledge';
  const method = editId ? 'PUT' : 'POST';

  const result = await fetchJSON(url, { method, body: { title, content, category } });
  if (result.ok !== false) {
    document.getElementById('trainingModal').style.display = 'none';
    showSettingsToast(editId ? 'Document updated' : 'Document added');
    await loadTraining();
  } else {
    showSettingsToast(result.error || 'Failed', true);
  }
}

function editKnowledgeDoc(id) {
  const doc = trainingConfig.knowledgeBase.find(d => d.id === id);
  if (!doc) return;
  showAddKnowledgeModal();
  document.getElementById('kbTitle').value = doc.title;
  document.getElementById('kbCategory').value = doc.category;
  document.getElementById('kbContent').value = doc.content;
  // Replace submit to update
  document.querySelector('#trainingModalContent .btn-primary').setAttribute('onclick', `submitKnowledgeDoc('${id}')`);
  document.querySelector('#trainingModalContent h3').textContent = 'Edit Knowledge Document';
}

async function deleteKnowledgeDoc(id) {
  if (!confirm('Delete this knowledge document?')) return;
  const result = await fetchJSON(`/api/training/knowledge/${id}`, { method: 'DELETE' });
  if (result.ok !== false) {
    showSettingsToast('Document deleted');
    await loadTraining();
  }
}

// --- Custom Agent Personas UI ---

function renderTrainingAgents() {
  const agents = trainingConfig?.customAgents || [];
  document.getElementById('trainingAgentCount').textContent = `${agents.length} custom agent${agents.length !== 1 ? 's' : ''}`;

  if (!agents.length) {
    document.getElementById('trainingAgentList').innerHTML = '<div class="empty-state">No custom agents yet. Create your first one above.</div>';
    return;
  }

  const tierColors = { strategic: '#ef4444', professional: '#3b82f6', scout: '#10b981', creative: '#ec4899', economy: '#f59e0b', realtime: '#8b5cf6' };

  document.getElementById('trainingAgentList').innerHTML = agents.map(agent => `
    <div class="panel" style="padding:16px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="font-size:24px;">${agent.avatar || '&#129302;'}</span>
          <div>
            <strong>${escapeHtml(agent.displayName)}</strong> — <span class="text-muted">${escapeHtml(agent.title)}</span>
            <div style="margin-top:4px;">
              <span class="badge" style="background:${tierColors[agent.modelTier] || '#666'}; color:#fff; font-size:11px;">${agent.modelTier}</span>
              <span class="badge" style="font-size:11px; margin-left:4px;">${escapeHtml(agent.department)}</span>
            </div>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-sm" onclick="testCustomAgent('${agent.id}')">Test</button>
          <button class="btn btn-sm" onclick="editCustomAgent('${agent.id}')">Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="deleteCustomAgent('${agent.id}')">Delete</button>
        </div>
      </div>
      <p style="font-size:13px; color:var(--text-muted); margin-top:8px; white-space:pre-wrap; max-height:60px; overflow:hidden;">${escapeHtml(agent.prompt.substring(0, 200))}${agent.prompt.length > 200 ? '...' : ''}</p>
    </div>
  `).join('');
}

function showAddAgentModal() {
  const modal = document.getElementById('trainingModal');
  document.getElementById('trainingModalContent').innerHTML = `
    <h3>Create Custom Agent</h3>
    <div class="settings-field"><label>Agent Name</label><input type="text" id="caName" placeholder="e.g., Sales Closer, Onboarding Guide"></div>
    <div class="settings-field"><label>Title / Role</label><input type="text" id="caTitle" placeholder="e.g., Senior Sales Agent"></div>
    <div class="settings-field"><label>Department</label><input type="text" id="caDept" value="Custom" placeholder="e.g., Sales, Support, Ops"></div>
    <div class="settings-field">
      <label>Model Tier</label>
      <select id="caTier">
        <option value="professional">Professional (Opus 4.8 high) — balanced</option>
        <option value="strategic">Strategic (Opus 4.8 xhigh) — deep reasoning</option>
        <option value="scout">Scout (Opus 4.8 low) — fast, lightweight</option>
        <option value="creative">Creative (Gemini Omni) — multimodal</option>
        <option value="economy">Economy (DeepSeek) — bulk processing</option>
        <option value="realtime">Realtime (Grok-3) — live web search</option>
      </select>
    </div>
    <div class="settings-field"><label>Avatar Emoji</label><input type="text" id="caAvatar" placeholder="e.g., &#129302; or &#128187;" maxlength="4"></div>
    <div class="settings-field"><label>System Prompt</label><textarea id="caPrompt" rows="8" placeholder="You are a specialized agent for... Define the agent's expertise, behavior, constraints, and output format."></textarea></div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn btn-primary" onclick="submitCustomAgent()">Create Agent</button>
      <button class="btn btn-ghost" onclick="document.getElementById('trainingModal').style.display='none'">Cancel</button>
    </div>
  `;
  modal.style.display = 'flex';
}

async function submitCustomAgent(editId) {
  const name = document.getElementById('caName').value.trim();
  const title = document.getElementById('caTitle').value.trim();
  const department = document.getElementById('caDept').value.trim();
  const modelTier = document.getElementById('caTier').value;
  const avatar = document.getElementById('caAvatar').value.trim();
  const prompt = document.getElementById('caPrompt').value.trim();

  if (!name || !prompt) return showSettingsToast('Name and prompt required', true);

  const url = editId ? `/api/training/agents/${editId}` : '/api/training/agents';
  const method = editId ? 'PUT' : 'POST';

  const result = await fetchJSON(url, { method, body: { name, title, department, modelTier, avatar, prompt, displayName: name } });
  if (result.ok !== false) {
    document.getElementById('trainingModal').style.display = 'none';
    showSettingsToast(editId ? 'Agent updated' : 'Agent created');
    await loadTraining();
  } else {
    showSettingsToast(result.error || 'Failed', true);
  }
}

function editCustomAgent(id) {
  const agent = trainingConfig.customAgents.find(a => a.id === id);
  if (!agent) return;
  showAddAgentModal();
  document.getElementById('caName').value = agent.displayName;
  document.getElementById('caTitle').value = agent.title;
  document.getElementById('caDept').value = agent.department;
  document.getElementById('caTier').value = agent.modelTier;
  document.getElementById('caAvatar').value = agent.avatar || '';
  document.getElementById('caPrompt').value = agent.prompt;
  document.querySelector('#trainingModalContent .btn-primary').setAttribute('onclick', `submitCustomAgent('${id}')`);
  document.querySelector('#trainingModalContent h3').textContent = 'Edit Custom Agent';
}

async function deleteCustomAgent(id) {
  if (!confirm('Delete this custom agent?')) return;
  const result = await fetchJSON(`/api/training/agents/${id}`, { method: 'DELETE' });
  if (result.ok !== false) {
    showSettingsToast('Agent deleted');
    await loadTraining();
  }
}

async function testCustomAgent(id) {
  const task = prompt('Enter a test task for this agent:');
  if (!task) return;

  showSettingsToast('Running test...');
  const result = await fetchJSON(`/api/training/agents/${id}/test`, { method: 'POST', body: { task } });
  if (result.ok !== false) {
    const modal = document.getElementById('trainingModal');
    document.getElementById('trainingModalContent').innerHTML = `
      <h3>Agent Test Result</h3>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Model: ${result.model} | In: ${result.inputTokens} | Out: ${result.outputTokens}</div>
      <div style="background:var(--bg-primary); border:1px solid var(--border); border-radius:8px; padding:16px; white-space:pre-wrap; font-size:14px; max-height:400px; overflow-y:auto;">${escapeHtml(result.response)}</div>
      <button class="btn btn-ghost" style="margin-top:16px;" onclick="document.getElementById('trainingModal').style.display='none'">Close</button>
    `;
    modal.style.display = 'flex';
  } else {
    showSettingsToast(result.error || 'Test failed', true);
  }
}

// ========================================================================
//  PLUGINS & EXTENSIONS
// ========================================================================

let pluginsData = { plugins: [], limit: 0, plan: 'free' };

async function loadPlugins() {
  try {
    const result = await fetchJSON('/api/plugins');
    pluginsData = result;
    renderPlugins();
  } catch (e) {
    document.getElementById('pluginList').innerHTML = '<div class="empty-state">Plugins require Pro plan or higher. <a href="/#pricing">Upgrade</a></div>';
  }
}

function renderPlugins() {
  const container = document.getElementById('pluginList');
  const { plugins, limit, plan } = pluginsData;

  document.getElementById('pluginCount').textContent = plugins.length;
  document.getElementById('pluginActiveCount').textContent = plugins.filter(p => p.enabled).length;
  document.getElementById('pluginLimitDisplay').textContent = limit;
  document.getElementById('pluginTypeCount').textContent = new Set(plugins.map(p => p.type)).size;
  document.getElementById('pluginPlanBadge').textContent = plan.charAt(0).toUpperCase() + plan.slice(1);

  if (plugins.length === 0) {
    container.innerHTML = '<div class="empty-state">No plugins installed. Click "+ New Plugin" to extend your agents with custom tools.</div>';
    return;
  }

  const typeIcons = { webhook: '🔗', 'api-tool': '⚙️', 'data-source': '📊', formatter: '📝', validator: '✅' };

  container.innerHTML = plugins.map(p => `
    <div class="panel" style="margin-bottom:12px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">${typeIcons[p.type] || '🧩'}</span>
          <strong>${escapeHtml(p.name)}</strong>
          <span class="badge" style="font-size:11px;">${p.type}</span>
          ${p.enabled ? '<span style="color:var(--success);font-size:12px;">● Active</span>' : '<span style="color:var(--text-muted);font-size:12px;">○ Disabled</span>'}
        </div>
        <div class="text-muted" style="margin-top:4px;font-size:13px;">${escapeHtml(p.description || '')}</div>
        ${p.agentBindings?.length ? `<div style="margin-top:4px;font-size:12px;color:var(--primary);">Bound to: ${p.agentBindings.join(', ')}</div>` : ''}
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-sm" onclick="testPlugin('${p.id}')" title="Test">&#9654;</button>
        <button class="btn btn-sm" onclick="togglePlugin('${p.id}', ${!p.enabled})" title="${p.enabled ? 'Disable' : 'Enable'}">${p.enabled ? '⏸' : '▶'}</button>
        <button class="btn btn-sm" onclick="editPlugin('${p.id}')" title="Edit">&#9998;</button>
        <button class="btn btn-sm" onclick="deletePlugin('${p.id}')" title="Delete" style="color:#ef4444;">&#128465;</button>
      </div>
    </div>
  `).join('');
}

function showAddPluginModal(editId) {
  const plugin = editId ? pluginsData.plugins.find(p => p.id === editId) : null;
  const modal = document.getElementById('pluginModal');
  document.getElementById('pluginModalContent').innerHTML = `
    <h3>${plugin ? 'Edit Plugin' : 'New Plugin'}</h3>
    <div class="settings-field"><label>Name</label><input type="text" id="pluginName" value="${plugin ? escapeHtml(plugin.name) : ''}" placeholder="e.g., Slack Notifier, CRM Lookup" maxlength="60"></div>
    <div class="settings-field"><label>Type</label>
      <select id="pluginType">
        <option value="webhook" ${plugin?.type === 'webhook' ? 'selected' : ''}>Webhook — POST to an external URL on events</option>
        <option value="api-tool" ${plugin?.type === 'api-tool' ? 'selected' : ''}>API Tool — Call an external API as an agent tool</option>
        <option value="data-source" ${plugin?.type === 'data-source' ? 'selected' : ''}>Data Source — Inject external data into agent context</option>
        <option value="formatter" ${plugin?.type === 'formatter' ? 'selected' : ''}>Formatter — Transform agent output before delivery</option>
        <option value="validator" ${plugin?.type === 'validator' ? 'selected' : ''}>Validator — Validate agent output against rules</option>
      </select>
    </div>
    <div class="settings-field"><label>Description</label><textarea id="pluginDesc" rows="2" maxlength="500" placeholder="What does this plugin do?">${plugin ? escapeHtml(plugin.description) : ''}</textarea></div>
    <div class="settings-field"><label>URL / Endpoint</label><input type="text" id="pluginUrl" value="${plugin?.config?.url || plugin?.config?.endpoint || ''}" placeholder="https://hooks.slack.com/..."></div>
    <div class="settings-field"><label>Agent Bindings (comma-separated agent names, leave blank for all)</label><input type="text" id="pluginBindings" value="${(plugin?.agentBindings || []).join(', ')}" placeholder="e.g., orchestrator, coder, writer"></div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn btn-primary" onclick="submitPlugin('${editId || ''}')">${plugin ? 'Save' : 'Create'}</button>
      <button class="btn" onclick="document.getElementById('pluginModal').style.display='none'">Cancel</button>
    </div>
  `;
  modal.style.display = 'flex';
}

async function submitPlugin(editId) {
  const name = document.getElementById('pluginName').value.trim();
  const type = document.getElementById('pluginType').value;
  const description = document.getElementById('pluginDesc').value.trim();
  const url = document.getElementById('pluginUrl').value.trim();
  const bindings = document.getElementById('pluginBindings').value.split(',').map(s => s.trim()).filter(Boolean);

  if (!name) return showSettingsToast('Name is required', true);

  const config = {};
  if (type === 'webhook') config.url = url;
  else if (type === 'api-tool') config.endpoint = url;
  else if (url) config.url = url;

  const body = { name, type, description, config, agentBindings: bindings };
  const endpoint = editId ? `/api/plugins/${editId}` : '/api/plugins';
  const method = editId ? 'PUT' : 'POST';

  const result = await fetchJSON(endpoint, { method, body });
  if (result.ok) {
    document.getElementById('pluginModal').style.display = 'none';
    showSettingsToast(editId ? 'Plugin updated' : 'Plugin created');
    loadPlugins();
  } else {
    showSettingsToast(result.error || 'Failed', true);
  }
}

function editPlugin(id) { showAddPluginModal(id); }

async function deletePlugin(id) {
  if (!confirm('Delete this plugin?')) return;
  const result = await fetchJSON(`/api/plugins/${id}`, { method: 'DELETE' });
  if (result.ok) { showSettingsToast('Plugin deleted'); loadPlugins(); }
}

async function togglePlugin(id, enabled) {
  await fetchJSON(`/api/plugins/${id}`, { method: 'PUT', body: { enabled } });
  loadPlugins();
}

async function testPlugin(id) {
  showSettingsToast('Testing plugin...');
  const result = await fetchJSON(`/api/plugins/${id}/test`, { method: 'POST' });
  if (result.ok) {
    showSettingsToast(`Plugin test passed (status: ${result.status || 'OK'})`);
  } else {
    showSettingsToast(`Plugin test failed: ${result.error || 'Unknown error'}`, true);
  }
}

// ========================================================================
//  ADVANCED REPORTING
// ========================================================================

let reportsData = { templates: [], schedules: [], history: [], limit: 0, plan: 'free' };

async function loadReports() {
  try {
    const result = await fetchJSON('/api/reports');
    reportsData = result;
    renderReportTemplates();
    renderReportSchedules();
    renderReportHistory();
    document.getElementById('reportPlanBadge').textContent = reportsData.plan.charAt(0).toUpperCase() + reportsData.plan.slice(1);
  } catch (e) {
    document.getElementById('reportTemplates').innerHTML = '<div class="empty-state">Reports require Pro plan or higher. <a href="/#pricing">View Plans</a></div>';
  }
}

function renderReportTemplates() {
  const container = document.getElementById('reportTemplates');
  const categoryIcons = { SEO: '🔎', Operations: '⚙️', Admin: '🏛️', Marketing: '📣', Finance: '💰', Security: '🛡️', Executive: '👔', Custom: '🧩' };

  container.innerHTML = reportsData.templates.map(t => `
    <div class="panel" style="padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:start;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:20px;">${categoryIcons[t.category] || '📄'}</span>
            <strong>${escapeHtml(t.name)}</strong>
            <span class="badge" style="font-size:11px;">${t.category}</span>
          </div>
          <div class="text-muted" style="margin-top:4px;font-size:13px;">${escapeHtml(t.description)}</div>
          <div style="margin-top:6px;font-size:12px;">Formats: ${t.formats.map(f => f.toUpperCase()).join(', ')}</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-primary" onclick="generateReport('${t.id}', 'pdf')">PDF</button>
          ${t.formats.includes('csv') ? `<button class="btn btn-sm" onclick="generateReport('${t.id}', 'csv')">CSV</button>` : ''}
          <button class="btn btn-sm" onclick="showScheduleReportModal('${t.id}')" title="Schedule">&#128339;</button>
        </div>
      </div>
    </div>
  `).join('');
}

function renderReportSchedules() {
  const container = document.getElementById('reportSchedules');
  const { schedules } = reportsData;
  if (!schedules?.length) {
    container.innerHTML = '<div class="empty-state">No scheduled reports. Click the clock icon on a template to set up recurring delivery.</div>';
    return;
  }
  container.innerHTML = schedules.map(s => `
    <div class="panel" style="padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong>${escapeHtml(s.templateId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</strong>
        <span class="text-muted" style="margin-left:8px;">${s.frequency} &middot; ${s.format.toUpperCase()}</span>
        ${s.email ? `<span class="text-muted" style="margin-left:8px;">&#8594; ${escapeHtml(s.email)}</span>` : ''}
        <span style="margin-left:8px;">${s.enabled ? '<span style="color:var(--success);">● Active</span>' : '<span style="color:var(--text-muted);">○ Paused</span>'}</span>
      </div>
      <button class="btn btn-sm" onclick="deleteReportSchedule('${s.id}')" style="color:#ef4444;">&#128465;</button>
    </div>
  `).join('');
}

function renderReportHistory() {
  const container = document.getElementById('reportHistory');
  const { history } = reportsData;
  if (!history?.length) {
    container.innerHTML = '<div class="empty-state">No reports generated yet. Click "PDF" or "CSV" on a template above.</div>';
    return;
  }
  container.innerHTML = [...history].reverse().slice(0, 20).map(h => `
    <div class="panel" style="padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong>${escapeHtml(h.title)}</strong>
        <span class="text-muted" style="margin-left:8px;">${h.format?.toUpperCase() || 'PDF'} &middot; ${new Date(h.generatedAt).toLocaleDateString()}</span>
      </div>
      <div style="display:flex; gap:6px;">
        ${h.filePath || h.data ? `<button class="btn btn-sm btn-primary" onclick="downloadReport('${h.id}')">Download</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function generateReport(templateId, format) {
  showSettingsToast('Generating report...');
  const result = await fetchJSON('/api/reports/generate', {
    method: 'POST',
    body: { templateId, format, dateRange: { start: new Date(Date.now() - 30 * 86400000).toISOString(), end: new Date().toISOString() } },
  });
  if (result.ok) {
    showSettingsToast(`Report generated: ${result.report.title}`);
    if (format === 'csv' || format === 'json') {
      window.open(`/api/reports/download/${result.report.id}`, '_blank');
    } else if (result.data) {
      showReportPreview(result.data);
    }
    loadReports();
  } else {
    showSettingsToast(result.error || 'Report generation failed', true);
  }
}

function showReportPreview(data) {
  const modal = document.getElementById('reportModal');
  let html = `<h3>${escapeHtml(data.title)}</h3><p class="text-muted">Generated: ${new Date(data.generatedAt).toLocaleString()}</p>`;
  for (const section of data.sections || []) {
    html += `<h4 style="margin-top:16px;">${escapeHtml(section.name)}</h4>`;
    if (Array.isArray(section.data)) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>' +
        Object.keys(section.data[0] || {}).map(k => `<th style="padding:6px 10px;border:1px solid var(--border);background:var(--bg-secondary);">${k}</th>`).join('') +
        '</tr></thead><tbody>' +
        section.data.map(row => '<tr>' + Object.values(row).map(v => `<td style="padding:6px 10px;border:1px solid var(--border);">${v}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>';
    } else {
      html += '<div style="background:var(--bg-secondary);padding:12px;border-radius:8px;font-size:13px;">';
      Object.entries(section.data).forEach(([k, v]) => { html += `<div><strong>${k}:</strong> ${v}</div>`; });
      html += '</div>';
    }
  }
  html += '<div style="margin-top:16px;"><button class="btn" onclick="document.getElementById(\'reportModal\').style.display=\'none\'">Close</button></div>';
  document.getElementById('reportModalContent').innerHTML = html;
  modal.style.display = 'flex';
}

function showScheduleReportModal(templateId) {
  const modal = document.getElementById('reportModal');
  document.getElementById('reportModalContent').innerHTML = `
    <h3>Schedule Report</h3>
    <div class="settings-field"><label>Report</label><input type="text" value="${templateId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}" disabled></div>
    <div class="settings-field"><label>Frequency</label>
      <select id="schedFrequency">
        <option value="daily">Daily</option>
        <option value="weekly" selected>Weekly</option>
        <option value="biweekly">Biweekly</option>
        <option value="monthly">Monthly</option>
      </select>
    </div>
    <div class="settings-field"><label>Format</label>
      <select id="schedFormat">
        <option value="pdf">PDF</option>
        <option value="csv">CSV</option>
      </select>
    </div>
    <div class="settings-field"><label>Email (optional)</label><input type="email" id="schedEmail" placeholder="reports@yourcompany.com"></div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn btn-primary" onclick="submitReportSchedule('${templateId}')">Schedule</button>
      <button class="btn" onclick="document.getElementById('reportModal').style.display='none'">Cancel</button>
    </div>
  `;
  modal.style.display = 'flex';
}

async function submitReportSchedule(templateId) {
  const result = await fetchJSON('/api/reports/schedule', {
    method: 'POST',
    body: {
      templateId,
      frequency: document.getElementById('schedFrequency').value,
      format: document.getElementById('schedFormat').value,
      email: document.getElementById('schedEmail').value,
    },
  });
  if (result.ok) {
    document.getElementById('reportModal').style.display = 'none';
    showSettingsToast('Report scheduled');
    loadReports();
  } else {
    showSettingsToast(result.error || 'Failed to schedule', true);
  }
}

async function deleteReportSchedule(id) {
  if (!confirm('Remove this scheduled report?')) return;
  await fetchJSON(`/api/reports/schedule/${id}`, { method: 'DELETE' });
  showSettingsToast('Schedule removed');
  loadReports();
}

async function downloadReport(reportId) {
  window.open(`/api/reports/download/${reportId}`, '_blank');
}

// ========================================================================
//  VIDEO AVATAR MEETINGS
// ========================================================================

let activeMeeting = null;
let meetingTTSEnabled = true;

async function loadMeetings() {
  // Check capabilities and populate participant picker
  try {
    const caps = await fetchJSON('/api/meetings/capabilities');
    if (!caps.videoEnabled) {
      document.getElementById('meetingLobby').innerHTML += '<div class="empty-state" style="margin-top:12px;color:var(--warning);">Video meetings require a Gemini API key. Add it in Settings.</div>';
    }
  } catch {}

  // Build participant picker from org chart
  try {
    const org = await fetchJSON('/api/hq/org');
    const picker = document.getElementById('meetingParticipantPicker');
    if (picker && org.departments) {
      const allEmployees = org.departments.flatMap(d => d.employees);
      picker.innerHTML = allEmployees.map(e => `
        <label style="display:flex; align-items:center; gap:4px; padding:4px 10px; border:1px solid var(--border); border-radius:8px; cursor:pointer; font-size:13px; transition:all 0.2s;">
          <input type="checkbox" class="meeting-participant-cb" value="${e.name}" style="margin:0;">
          <span>${e.avatar} ${e.name}</span>
        </label>
      `).join('');
    }
  } catch {}
}

async function startMeeting() {
  const checkboxes = document.querySelectorAll('.meeting-participant-cb:checked');
  const participants = Array.from(checkboxes).map(cb => cb.value);
  if (participants.length === 0) return showSettingsToast('Select at least one participant', true);
  if (participants.length > 5) return showSettingsToast('Maximum 5 participants', true);

  const topic = document.getElementById('meetingTopic').value.trim() || 'General Discussion';
  const mode = document.getElementById('meetingMode').value;

  showSettingsToast('Starting meeting...');
  const result = await fetchJSON('/api/meetings/create', {
    method: 'POST',
    body: { participants, topic, mode },
  });

  if (result.ok) {
    activeMeeting = result.meeting;
    document.getElementById('meetingLobby').style.display = 'none';
    document.getElementById('meetingRoom').style.display = 'block';
    document.getElementById('meetingRoomTitle').textContent = topic;
    document.getElementById('meetingRoomParticipants').textContent =
      activeMeeting.participants.map(p => `${p.avatar} ${p.name}`).join('  ');

    // Render avatar row
    const avatarRow = document.getElementById('meetingAvatarRow');
    avatarRow.innerHTML = activeMeeting.participants.map(p => `
      <div style="text-align:center; padding:12px;">
        <div style="width:64px;height:64px;border-radius:50%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 6px;border:2px solid var(--border);">
          ${typeof renderAvatar === 'function' && AVATAR_MAP?.[p.name.toLowerCase()] ? renderAvatar(p.name, 'md') : p.avatar}
        </div>
        <div style="font-size:13px;font-weight:600;">${p.name}</div>
        <div style="font-size:11px;color:var(--text-muted);">${p.title}</div>
      </div>
    `).join('');

    document.getElementById('meetingMessages').innerHTML = '';
    addMeetingSystemMessage(`Meeting started: "${topic}" with ${participants.join(', ')}`);
    document.getElementById('meetingInput').focus();
  } else {
    showSettingsToast(result.error || 'Failed to start meeting', true);
  }
}

function addMeetingSystemMessage(text) {
  const container = document.getElementById('meetingMessages');
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;color:var(--text-muted);font-size:12px;padding:8px;font-style:italic;';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addMeetingMessage(speaker, title, avatar, content, isUser) {
  const container = document.getElementById('meetingMessages');
  const div = document.createElement('div');
  div.style.cssText = `display:flex;gap:10px;padding:10px 0;${isUser ? 'flex-direction:row-reverse;' : ''}`;
  div.innerHTML = `
    <div style="width:36px;height:36px;border-radius:50%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
      ${isUser ? '👤' : (typeof renderAvatar === 'function' && AVATAR_MAP?.[speaker?.toLowerCase()] ? renderAvatar(speaker, 'sm') : (avatar || '🤖'))}
    </div>
    <div style="max-width:70%;${isUser ? 'text-align:right;' : ''}">
      <div style="font-size:12px;font-weight:600;margin-bottom:2px;">${isUser ? 'You' : `${escapeHtml(speaker)} — ${escapeHtml(title)}`}</div>
      <div style="padding:10px 14px;border-radius:12px;background:${isUser ? 'var(--primary)' : 'var(--bg-secondary)'};color:${isUser ? '#fff' : 'var(--text-primary)'};font-size:14px;line-height:1.5;">
        ${escapeHtml(content)}
      </div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendMeetingMessage() {
  if (!activeMeeting) return;
  const input = document.getElementById('meetingInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  addMeetingMessage('You', '', '', text, true);

  // Show typing indicators
  activeMeeting.participants.forEach(p => {
    addMeetingSystemMessage(`${p.name} is thinking...`);
  });

  const result = await fetchJSON(`/api/meetings/${activeMeeting.id}/message`, {
    method: 'POST',
    body: { text },
  });

  // Remove typing indicators
  const msgs = document.getElementById('meetingMessages');
  msgs.querySelectorAll('div[style*="font-style:italic"]').forEach(el => {
    if (el.textContent.includes('is thinking...')) el.remove();
  });

  if (result.ok && result.responses) {
    for (const r of result.responses) {
      addMeetingMessage(r.speaker, r.title || '', r.avatar || '', r.content, false);
      if (meetingTTSEnabled && typeof speakText === 'function') {
        // Brief delay between speakers
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
}

function toggleMeetingTTS() {
  meetingTTSEnabled = !meetingTTSEnabled;
  document.getElementById('meetingTTSBtn').textContent = meetingTTSEnabled ? '🔊' : '🔇';
}

async function endMeeting() {
  if (!activeMeeting) return;
  if (!confirm('End this meeting?')) return;

  await fetchJSON(`/api/meetings/${activeMeeting.id}`, { method: 'DELETE' });
  addMeetingSystemMessage('Meeting ended.');
  activeMeeting = null;

  setTimeout(() => {
    document.getElementById('meetingRoom').style.display = 'none';
    document.getElementById('meetingLobby').style.display = 'block';
  }, 1500);
}

// --- YouTube Video Intelligence ---
let ytAnalyses = [];

async function loadYouTube() {
  const data = await fetchJSON('/api/youtube/analyses');
  if (Array.isArray(data)) ytAnalyses = data;
  renderYTList();
}

function renderYTList() {
  const container = document.getElementById('ytAnalysisList');
  if (!container) return;

  if (ytAnalyses.length === 0) {
    container.innerHTML = '<div class="empty-state">No videos analyzed yet. Paste a YouTube URL above to start.</div>';
    return;
  }

  container.innerHTML = ytAnalyses.slice().reverse().map(a => {
    const statusIcon = a.status === 'complete' ? '&#9989;' : a.status === 'processing' ? '&#9203;' : '&#10060;';
    return `
      <div class="yt-card">
        <div class="yt-card-thumb">
          <img src="https://img.youtube.com/vi/${a.videoId}/mqdefault.jpg" alt="thumbnail" loading="lazy">
          <span class="yt-card-duration">${a.duration || '...'}</span>
        </div>
        <div class="yt-card-info">
          <div class="yt-card-title">${statusIcon} ${escapeHtml(a.title || a.videoId)}</div>
          <div class="yt-card-meta">
            <span>${a.type}</span>
            <span>${a.frameCount} frames</span>
            <span>${new Date(a.startedAt).toLocaleDateString()}</span>
            <span class="yt-status-${a.status}">${a.status}</span>
          </div>
        </div>
        <div class="yt-card-actions">
          <button class="btn btn-sm btn-primary" onclick="viewYTAnalysis('${a.id}')" ${a.status !== 'complete' ? 'disabled' : ''}>View</button>
          <button class="btn btn-sm btn-danger" onclick="deleteYTAnalysis('${a.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function startYTAnalysis() {
  const urlInput = document.getElementById('ytUrl');
  const url = urlInput.value.trim();
  if (!url) return;

  const frameInterval = parseInt(document.getElementById('ytFrameInterval').value);
  const analysisType = document.getElementById('ytAnalysisType').value;
  const btn = document.getElementById('ytAnalyzeBtn');
  const progressEl = document.getElementById('ytProgress');

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  progressEl.innerHTML = `
    <div class="omni-progress-bar"><div class="omni-progress-fill yt-progress-fill" id="ytProgressFill" style="width:5%"></div></div>
    <div class="omni-progress-status" id="ytProgressStatus">Initializing video analysis pipeline...</div>
  `;

  const result = await fetchJSON('/api/youtube/analyze', { method: 'POST', body: { url, frameInterval, analysisType } });

  if (!result.ok) {
    progressEl.innerHTML = `<div class="empty-state" style="color:var(--error);">${result.error || 'Analysis failed'}</div>`;
    btn.disabled = false;
    btn.innerHTML = '&#127909; Analyze';
    return;
  }

  const analysisId = result.analysisId;

  // Listen for WebSocket progress
  const origHandler = ws?.onmessage;
  const progressSteps = { fetching_info: 15, extracting_frames: 35, transcribing: 55, analyzing_frames: 75, synthesizing: 90, complete: 100 };

  const handler = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'yt_analysis_progress' && data.data.id === analysisId) {
        const fill = document.getElementById('ytProgressFill');
        const status = document.getElementById('ytProgressStatus');
        if (fill) fill.style.width = `${progressSteps[data.data.status] || 50}%`;
        if (status) status.textContent = data.data.msg;
      }
      if (data.event === 'yt_analysis_complete' && data.data.id === analysisId) {
        progressEl.innerHTML = '';
        btn.disabled = false;
        btn.innerHTML = '&#127909; Analyze';
        urlInput.value = '';
        loadYouTube();
        showSettingsToast('Video analysis complete');
        if (ws) ws.onmessage = origHandler;
      }
    } catch {}
    if (origHandler) origHandler(event);
  };
  if (ws) ws.onmessage = handler;

  setTimeout(() => {
    if (btn.disabled) { btn.disabled = false; btn.innerHTML = '&#127909; Analyze'; if (ws) ws.onmessage = origHandler; loadYouTube(); }
  }, 30000);
}

async function viewYTAnalysis(analysisId) {
  const analysis = await fetchJSON(`/api/youtube/analysis/${analysisId}`);
  if (!analysis || analysis.error) return;

  const detail = document.getElementById('ytAnalysisDetail');
  if (!detail) return;

  const info = analysis.videoInfo || {};
  const summary = analysis.summary || {};
  const transcript = analysis.transcript || {};
  const insights = analysis.insights || [];
  const visuals = analysis.visualAnalysis || [];

  // Visual timeline
  const timeline = visuals.map(v => `
    <div class="yt-timeline-frame">
      <div class="yt-frame-time">${v.timecode}</div>
      <div class="yt-frame-content">
        <div class="yt-frame-scene">${escapeHtml(v.scene)}</div>
        <div class="yt-frame-elements">${v.elements.map(e => `<span class="yt-element-tag">${escapeHtml(e)}</span>`).join('')}</div>
        ${v.onScreenText ? `<div class="yt-frame-ocr"><span class="yt-ocr-label">On-screen:</span> ${escapeHtml(v.onScreenText)}</div>` : ''}
      </div>
    </div>
  `).join('');

  // Transcript segments
  const transcriptHtml = (transcript.segments || []).map(s => `
    <div class="yt-transcript-seg">
      <span class="yt-transcript-time">${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, '0')}</span>
      <span class="yt-transcript-text">${escapeHtml(s.text)}</span>
    </div>
  `).join('');

  // Insights
  const insightsHtml = insights.map(i => {
    const typeIcon = i.type === 'visual' ? '&#128065;' : i.type === 'content' ? '&#128218;' : i.type === 'seo' ? '&#128200;' : '&#128268;';
    return `
      <div class="yt-insight">
        <span class="yt-insight-icon">${typeIcon}</span>
        <div class="yt-insight-text">${escapeHtml(i.insight)}</div>
        <span class="yt-insight-confidence">${Math.round(i.confidence * 100)}%</span>
      </div>
    `;
  }).join('');

  // Key topics
  const topicsHtml = (summary.keyTopics || []).map(t => `<span class="yt-topic-tag">${escapeHtml(t)}</span>`).join('');

  detail.innerHTML = `
    <div class="yt-report">
      <div class="yt-report-header">
        <button class="btn btn-sm" onclick="document.getElementById('ytAnalysisDetail').innerHTML=''; document.getElementById('ytAnalysisDetail').style.display='none';">&larr; Back</button>
        <h3>${escapeHtml(info.title || analysis.videoId)}</h3>
      </div>

      <div class="yt-video-meta">
        <img src="https://img.youtube.com/vi/${analysis.videoId}/mqdefault.jpg" alt="thumb" class="yt-report-thumb">
        <div class="yt-meta-details">
          <div class="yt-meta-row"><strong>Channel:</strong> ${escapeHtml(info.channel || 'Unknown')}</div>
          <div class="yt-meta-row"><strong>Duration:</strong> ${info.duration || 'Unknown'}</div>
          <div class="yt-meta-row"><strong>Views:</strong> ${info.views ? info.views.toLocaleString() : 'N/A'}</div>
          <div class="yt-meta-row"><strong>Likes:</strong> ${info.likes ? info.likes.toLocaleString() : 'N/A'}</div>
          <div class="yt-meta-row"><strong>Frames analyzed:</strong> ${visuals.length}</div>
          <div class="yt-meta-row"><strong>Analysis type:</strong> ${analysis.type}</div>
        </div>
      </div>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">Summary</h3>
        <p class="yt-summary-text">${escapeHtml(summary.overview || '')}</p>
        <div class="yt-summary-meta">
          <div><strong>Content Type:</strong> ${summary.contentType || 'N/A'}</div>
          <div><strong>Level:</strong> ${summary.technicalLevel || 'N/A'}</div>
          <div><strong>Actionability:</strong> ${summary.actionability || 'N/A'}</div>
        </div>
        <div class="yt-topics" style="margin-top:10px;">${topicsHtml}</div>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">&#128065; Visual + Transcript Insights</h3>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">What Claude Vision found that the transcript alone would miss.</p>
        <div class="yt-insights">${insightsHtml}</div>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">&#127910; Visual Frame-by-Frame Timeline</h3>
        <div class="yt-timeline">${timeline}</div>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">&#128196; Transcript</h3>
        <div class="yt-transcript">${transcriptHtml}</div>
      </section>
    </div>
  `;
  detail.style.display = 'block';
}

async function deleteYTAnalysis(id) {
  const result = await fetchJSON(`/api/youtube/analysis/${id}`, { method: 'DELETE' });
  if (result.ok) { loadYouTube(); showSettingsToast('Analysis deleted'); }
}

// --- 3D Avatar Chat + Voice System ---
let avatarState = {
  employee: 'atlas',
  color: '#3b52cc',
  speaking: false,
  listening: false,
  ttsEnabled: true,
  history: [],
  recognition: null,
  animationFrame: null,
  mouthOpenness: 0,
  eyeBlink: 0,
  headRotation: { x: 0, y: 0 },
};

// Avatar name → agent + portrait + voice mapping
// OpenAI voices: alloy (neutral), echo (warm male), fable (British), onyx (deep male), nova (bright female), shimmer (soft female)
// D-ID Microsoft voices: en-US-GuyNeural (male), en-US-JennyNeural (female), en-US-AriaNeural (F), en-US-DavisNeural (M), en-GB-RyanNeural (M-British)
// photo: path to imported headshot image (set via upload or manual placement in assets/avatars/)
const AVATAR_PROFILES = {
  atlas:   { agent: 'orchestrator',    voice: 'onyx',    didVoice: 'en-US-DavisNeural',  fallbackPitch: 0.9,  fallbackRate: 1.0,  gender: 'M', title: 'CEO & Orchestrator',      gradient: 'linear-gradient(135deg, #1e3a5f, #3b52cc)', initials: 'AT', photo: '' },
  nova:    { agent: 'architect',       voice: 'nova',    didVoice: 'en-US-AriaNeural',   fallbackPitch: 1.15, fallbackRate: 1.05, gender: 'F', title: 'CTO & Architect',          gradient: 'linear-gradient(135deg, #0c4a6e, #06b6d4)', initials: 'NV', photo: '' },
  justice: { agent: 'general-counsel', voice: 'fable',   didVoice: 'en-GB-RyanNeural',   fallbackPitch: 0.75, fallbackRate: 0.95, gender: 'M', title: 'General Counsel',          gradient: 'linear-gradient(135deg, #44403c, #78716c)', initials: 'JC', photo: '' },
  muse:    { agent: 'media-producer',  voice: 'shimmer', didVoice: 'en-US-JennyNeural',  fallbackPitch: 1.2,  fallbackRate: 1.1,  gender: 'F', title: 'Creative Director',        gradient: 'linear-gradient(135deg, #9d174d, #ec4899)', initials: 'MS', photo: '' },
  forge:   { agent: 'coder',          voice: 'echo',    didVoice: 'en-US-GuyNeural',    fallbackPitch: 0.85, fallbackRate: 1.0,  gender: 'M', title: 'Engineering Lead',         gradient: 'linear-gradient(135deg, #92400e, #f59e0b)', initials: 'FG', photo: '' },
  echo:    { agent: 'marketing-hub',   voice: 'nova',    didVoice: 'en-US-AriaNeural',   fallbackPitch: 1.1,  fallbackRate: 1.05, gender: 'F', title: 'Marketing Director',       gradient: 'linear-gradient(135deg, #065f46, #10b981)', initials: 'EC', photo: '' },
  hermes:  { agent: 'hermes-delegate', voice: 'alloy',   didVoice: 'en-US-DavisNeural',  fallbackPitch: 1.0,  fallbackRate: 1.15, gender: 'M', title: 'Operations Director',      gradient: 'linear-gradient(135deg, #5b21b6, #a78bfa)', initials: 'HM', photo: '' },
  harbor:  { agent: 'cs-lead',        voice: 'shimmer', didVoice: 'en-US-JennyNeural',  fallbackPitch: 1.05, fallbackRate: 1.0,  gender: 'F', title: 'Support Lead',             gradient: 'linear-gradient(135deg, #78350f, #fbbf24)', initials: 'HB', photo: '' },
  hawkeye: { agent: 'grok-realtime',   voice: 'onyx',    didVoice: 'en-US-GuyNeural',    fallbackPitch: 0.8,  fallbackRate: 0.9,  gender: 'M', title: 'Intelligence Analyst',     gradient: 'linear-gradient(135deg, #7f1d1d, #ef4444)', initials: 'HK', photo: '' },
  ledger:  { agent: 'cost-analyst',    voice: 'fable',   didVoice: 'en-GB-RyanNeural',   fallbackPitch: 0.95, fallbackRate: 0.95, gender: 'M', title: 'Chief Financial Officer',  gradient: 'linear-gradient(135deg, #14532d, #22c55e)', initials: 'LG', photo: '' },
};

const AVATAR_AGENTS = Object.fromEntries(Object.entries(AVATAR_PROFILES).map(([k, v]) => [k, v.agent]));

let livekitRoom = null;
let heygenAvatar = null;
let heygenSessionActive = false;
let didTalkingActive = false;
let avatarPhotos = {}; // employee -> local photo path or D-ID URL

async function loadAvatarChat() {
  initVoiceSystem();

  // Load any saved avatar photos from localStorage
  try {
    const saved = localStorage.getItem('ai-os-avatar-photos');
    if (saved) avatarPhotos = JSON.parse(saved);
  } catch {}

  // Also load photos from any existing files in assets/avatars/
  await detectAvatarPhotos();

  // Check D-ID, HeyGen, LiveKit in priority order
  const [didStatus, heygenStatus, lkStatus] = await Promise.all([
    fetchJSON('/api/did/status'),
    fetchJSON('/api/heygen/status'),
    fetchJSON('/api/livekit/status'),
  ]);

  avatarState.didReady = didStatus.configured;
  avatarState.heygenReady = heygenStatus.configured;
  avatarState.livekitReady = lkStatus.allReady;

  // Show HeyGen button if configured
  if (heygenStatus.configured) {
    document.getElementById('heygenStartBtn').style.display = 'inline-block';
  }

  // Initialize the avatar display (photo or portrait fallback)
  initAvatarDisplay();

  // Welcome message based on capabilities
  const name = avatarState.employee.charAt(0).toUpperCase() + avatarState.employee.slice(1);
  const profile = AVATAR_PROFILES[avatarState.employee];
  const hasPhoto = getAvatarPhoto(avatarState.employee);

  if (didStatus.configured && hasPhoto) {
    addAvatarBotMessage(`Hello! I'm ${name}, ${profile.title}. I have a photorealistic avatar ready. When I respond, you'll see me speak with lip-synced video. Type or click the mic to start.`);
  } else if (didStatus.configured) {
    addAvatarBotMessage(`Hello! I'm ${name}, ${profile.title}. D-ID talking avatars are ready. Upload a headshot photo below to see me come alive with lip-synced speech!`);
  } else if (hasPhoto) {
    addAvatarBotMessage(`Hello! I'm ${name}, ${profile.title}. My photo avatar is active. Add a D-ID API key in Settings to make me talk with lip-synced video!`);
  } else {
    addAvatarBotMessage(`Hello! I'm ${name}, ${profile.title}. Type below to chat. Upload a headshot and add a D-ID key in Settings for interactive talking avatars.`);
  }
}

// Detect avatar photos placed in assets/avatars/ directory
async function detectAvatarPhotos() {
  const employees = Object.keys(AVATAR_PROFILES);
  for (const emp of employees) {
    // Check common image extensions
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const path = `assets/avatars/${emp}.${ext}`;
      try {
        const resp = await fetch(path, { method: 'HEAD' });
        if (resp.ok) {
          avatarPhotos[emp] = path;
          AVATAR_PROFILES[emp].photo = path;
          break;
        }
      } catch {}
    }
  }
}

// Get the avatar photo URL for an employee
function getAvatarPhoto(employee) {
  return avatarPhotos[employee] || AVATAR_PROFILES[employee]?.photo || '';
}

// Initialize the avatar display — photo if available, portrait fallback otherwise
function initAvatarDisplay() {
  const photo = getAvatarPhoto(avatarState.employee);
  const photoLayer = document.getElementById('avatarPhotoLayer');
  const portraitFallback = document.getElementById('avatarPortraitFallback');

  if (photo && photoLayer) {
    document.getElementById('avatarPhotoImg').src = photo;
    photoLayer.style.display = 'flex';
    portraitFallback.style.display = 'none';
    document.getElementById('avatarUploadHint').textContent = 'Photo loaded';
  } else {
    if (photoLayer) photoLayer.style.display = 'none';
    portraitFallback.style.display = 'block';
    initAvatar3D();
  }

  // Update name display
  const profile = AVATAR_PROFILES[avatarState.employee];
  const name = avatarState.employee.charAt(0).toUpperCase() + avatarState.employee.slice(1);
  document.getElementById('avatarName').textContent = `${name} — ${profile.title}`;

  // Start status animation loop
  startAvatarStatusLoop();
}

// Photo speaking animation loop
function startAvatarStatusLoop() {
  if (avatarState._statusInterval) clearInterval(avatarState._statusInterval);
  avatarState._statusInterval = setInterval(() => {
    const ring = document.getElementById('avatarPhotoRing');
    const bars = document.getElementById('avatarPhotoBars');
    if (ring) {
      ring.classList.toggle('speaking', avatarState.speaking);
      ring.classList.toggle('listening', avatarState.listening);
    }
    if (bars) {
      bars.style.opacity = avatarState.speaking ? '1' : '0';
    }
  }, 150);
}

// Handle photo upload from the file input
async function handleAvatarPhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    const dataUrl = e.target.result;
    const employee = avatarState.employee;

    // Store locally
    avatarPhotos[employee] = dataUrl;
    AVATAR_PROFILES[employee].photo = dataUrl;
    localStorage.setItem('ai-os-avatar-photos', JSON.stringify(avatarPhotos));

    // Update display immediately
    initAvatarDisplay();
    showSettingsToast(`Photo uploaded for ${employee.charAt(0).toUpperCase() + employee.slice(1)}`);

    // If D-ID is configured, upload to D-ID for talking avatar
    if (avatarState.didReady) {
      const uploadResult = await fetchJSON('/api/did/upload-photo', {
        method: 'POST',
        body: { imageBase64: dataUrl, employee },
      });
      if (uploadResult.ok) {
        avatarPhotos[employee + '_did'] = uploadResult.url;
        localStorage.setItem('ai-os-avatar-photos', JSON.stringify(avatarPhotos));
        showSettingsToast('Photo also uploaded to D-ID for talking avatar');
      }
    }
  };
  reader.readAsDataURL(file);
}

// --- HeyGen LiveAvatar ---

async function startHeyGenSession() {
  const btn = document.getElementById('heygenStartBtn');
  const stopBtn = document.getElementById('heygenStopBtn');
  btn.textContent = 'Connecting...';
  btn.disabled = true;
  document.getElementById('avatarStatus').textContent = 'Connecting to HeyGen...';

  try {
    // Get session token from server
    const tokenData = await fetchJSON('/api/heygen/token', { method: 'POST', body: {} });
    if (!tokenData.ok) throw new Error(tokenData.error || 'Token request failed');

    // Try multiple SDK export paths
    const SDK = window.StreamingAvatar || window.HeyGenStreaming || window.default;
    if (!SDK) throw new Error('HeyGen SDK not loaded — check browser console for CSP errors');

    // Create avatar instance
    heygenAvatar = new SDK({ token: tokenData.token });

    // Listen for stream ready event
    const videoEl = document.getElementById('avatarVideo');

    heygenAvatar.on('stream_ready', (event) => {
      if (event.detail) {
        videoEl.srcObject = event.detail;
      } else if (event instanceof MediaStream) {
        videoEl.srcObject = event;
      }
      videoEl.style.display = 'block';
      document.getElementById('avatarPortraitFallback').style.display = 'none';
    });

    // Start session with an avatar
    const sessionData = await heygenAvatar.createStartAvatar({
      quality: 'medium',
      avatarName: 'default',
      voice: { voiceId: '' },
      language: 'en',
    });

    // If stream returned directly
    if (sessionData && sessionData.stream) {
      videoEl.srcObject = sessionData.stream;
      videoEl.style.display = 'block';
      document.getElementById('avatarPortraitFallback').style.display = 'none';
    }

    heygenSessionActive = true;
    btn.style.display = 'none';
    stopBtn.style.display = 'inline-block';
    document.getElementById('avatarStatus').textContent = 'Video avatar active — speak or type';

    // Listen for avatar events
    heygenAvatar.on('avatar_start_talking', () => {
      avatarState.speaking = true;
      document.getElementById('avatarStatus').textContent = 'Speaking...';
    });

    heygenAvatar.on('avatar_stop_talking', () => {
      avatarState.speaking = false;
      document.getElementById('avatarStatus').textContent = 'Listening...';
    });

    addAvatarBotMessage(`Video avatar connected! I'm ${AVATAR_PROFILES[avatarState.employee]?.title || 'Atlas'}. Speak naturally or type below.`);

  } catch (e) {
    console.error('[HEYGEN] Session failed:', e);
    btn.textContent = '🎬 Start Video Avatar';
    btn.disabled = false;
    document.getElementById('avatarStatus').textContent = 'Connection failed';
    addAvatarBotMessage(`Video avatar failed to connect: ${e.message}. You can still use text chat below.`);
  }
}

async function stopHeyGenSession() {
  if (heygenAvatar) {
    try { await heygenAvatar.stopAvatar(); } catch {}
    heygenAvatar = null;
  }
  heygenSessionActive = false;

  const videoEl = document.getElementById('avatarVideo');
  videoEl.srcObject = null;
  videoEl.style.display = 'none';
  document.getElementById('avatarPortraitFallback').style.display = 'block';

  document.getElementById('heygenStartBtn').style.display = 'inline-block';
  document.getElementById('heygenStartBtn').textContent = '🎬 Start Video Avatar';
  document.getElementById('heygenStartBtn').disabled = false;
  document.getElementById('heygenStopBtn').style.display = 'none';
  document.getElementById('avatarStatus').textContent = 'Idle';

  addAvatarBotMessage('Video session ended. Click Start to reconnect, or keep using text chat.');
}

// Send text to HeyGen avatar to speak
async function sendToHeyGen(text) {
  if (!heygenAvatar || !heygenSessionActive) return false;
  try {
    await heygenAvatar.speak({ text, taskType: 'talk' });
    return true;
  } catch (e) {
    console.error('[HEYGEN] Speak failed:', e);
    return false;
  }
}

async function connectLiveKit() {
  if (!avatarState.livekitReady || typeof LivekitClient === 'undefined') return false;

  try {
    const tokenData = await fetchJSON('/api/livekit/token', {
      method: 'POST',
      body: { employee: avatarState.employee },
    });

    if (!tokenData.ok) return false;

    const room = new LivekitClient.Room({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
      adaptiveStream: true,
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        // Agent's voice audio — attach to page
        const el = track.attach();
        el.id = 'livekit-agent-audio';
        document.body.appendChild(el);

        // Animate portrait when agent speaks
        avatarState.speaking = true;
        document.getElementById('avatarStatus').textContent = 'Speaking...';
        const mouthInterval = setInterval(() => { avatarState.mouthOpenness = 0.2 + Math.random() * 0.6; }, 80);

        track.on('ended', () => {
          clearInterval(mouthInterval);
          avatarState.mouthOpenness = 0;
          avatarState.speaking = false;
          document.getElementById('avatarStatus').textContent = 'Idle';
        });
      }
    });

    room.on(LivekitClient.RoomEvent.DataReceived, (data, participant) => {
      // Agent can send text data (transcript of what it said)
      try {
        const msg = JSON.parse(new TextDecoder().decode(data));
        if (msg.type === 'transcript' && msg.text) {
          addAvatarBotMessage(msg.text);
        }
      } catch {}
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      avatarState.speaking = false;
      avatarState.listening = false;
      document.getElementById('avatarStatus').textContent = 'Disconnected';
      livekitRoom = null;
    });

    await room.connect(tokenData.url, tokenData.token);
    livekitRoom = room;

    // Enable microphone
    await room.localParticipant.setMicrophoneEnabled(true);
    avatarState.listening = true;
    document.getElementById('avatarStatus').textContent = 'Connected — speak naturally';
    document.getElementById('micIcon').textContent = '🔴';

    logActivity && console.log('[LIVEKIT] Connected to room:', tokenData.roomName);
    return true;
  } catch (e) {
    console.error('[LIVEKIT] Connection failed:', e);
    return false;
  }
}

function disconnectLiveKit() {
  if (livekitRoom) {
    livekitRoom.disconnect();
    livekitRoom = null;
  }
  avatarState.listening = false;
  avatarState.speaking = false;
  document.getElementById('avatarStatus').textContent = 'Idle';
  document.getElementById('micIcon').textContent = '🎤';
  // Remove agent audio element
  const audioEl = document.getElementById('livekit-agent-audio');
  if (audioEl) audioEl.remove();
}

// --- Portrait Avatar System (CSS animated) ---

function initAvatar3D() {
  // Replace the canvas with a portrait container
  const canvas = document.getElementById('avatarCanvas');
  if (!canvas) return;

  // Hide canvas, show portrait
  canvas.style.display = 'none';
  let container = document.getElementById('avatarPortrait');
  if (!container) {
    container = document.createElement('div');
    container.id = 'avatarPortrait';
    container.className = 'portrait-container';
    canvas.parentElement.insertBefore(container, canvas);
  }

  renderPortrait(container);
}

function renderPortrait(container) {
  const profile = AVATAR_PROFILES[avatarState.employee] || AVATAR_PROFILES.atlas;
  const name = avatarState.employee.charAt(0).toUpperCase() + avatarState.employee.slice(1);

  container.innerHTML = `
    <div class="portrait-frame ${avatarState.speaking ? 'speaking' : ''} ${avatarState.listening ? 'listening' : ''}" id="portraitFrame">
      <div class="portrait-glow" style="background:${profile.gradient};"></div>
      <div class="portrait-avatar" style="background:${profile.gradient};">
        <span class="portrait-initials">${profile.initials}</span>
      </div>
      <div class="portrait-ring ${avatarState.speaking ? 'ring-speaking' : avatarState.listening ? 'ring-listening' : 'ring-idle'}"></div>
      <div class="portrait-speaking-indicator" id="portraitSpeakingBars">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
    </div>
    <div class="portrait-status-badge" id="portraitBadge">
      <span class="portrait-status-dot ${avatarState.speaking ? 'dot-speaking' : avatarState.listening ? 'dot-listening' : 'dot-idle'}"></span>
      <span>${avatarState.speaking ? 'Speaking' : avatarState.listening ? 'Listening' : 'Online'}</span>
    </div>
  `;

  // Start animation loop for speaking indicator
  if (avatarState.portraitInterval) clearInterval(avatarState.portraitInterval);
  avatarState.portraitInterval = setInterval(() => {
    const frame = document.getElementById('portraitFrame');
    const badge = document.getElementById('portraitBadge');
    if (!frame) return;

    frame.className = `portrait-frame ${avatarState.speaking ? 'speaking' : ''} ${avatarState.listening ? 'listening' : ''}`;
    const ring = frame.querySelector('.portrait-ring');
    if (ring) ring.className = `portrait-ring ${avatarState.speaking ? 'ring-speaking' : avatarState.listening ? 'ring-listening' : 'ring-idle'}`;

    const bars = frame.querySelector('.portrait-speaking-indicator');
    if (bars) bars.style.opacity = avatarState.speaking ? '1' : '0';

    if (badge) {
      const dot = badge.querySelector('.portrait-status-dot');
      if (dot) dot.className = `portrait-status-dot ${avatarState.speaking ? 'dot-speaking' : avatarState.listening ? 'dot-listening' : 'dot-idle'}`;
      badge.querySelector('span:last-child').textContent = avatarState.speaking ? 'Speaking' : avatarState.listening ? 'Listening' : 'Online';
    }
  }, 200);
}

function updateAvatarColor() {
  const container = document.getElementById('avatarPortrait');
  if (container) renderPortrait(container);
}

// Legacy — kept for compatibility but no longer used
function _buildAvatar3D_legacy(canvas, profile) {
  const w = 400, h = 500;
  canvas.width = w; canvas.height = h;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 100);
  camera.position.set(0, 0.15, 3.2);
  camera.lookAt(0, -0.1, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Lighting — warm key, cool fill, soft ambient
  scene.add(new THREE.AmbientLight(0xfff0e0, 0.55));
  const key = new THREE.DirectionalLight(0xfff5e8, 0.9);
  key.position.set(2, 3, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc0d8ff, 0.3);
  fill.position.set(-2, 1, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.2);
  rim.position.set(0, 2, -3);
  scene.add(rim);

  const skinMat = new THREE.MeshStandardMaterial({ color: profile.skin, roughness: 0.65, metalness: 0.02 });
  const hairMat = new THREE.MeshStandardMaterial({ color: profile.hair, roughness: 0.8, metalness: 0.05 });
  const lipMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(profile.skin).multiplyScalar(0.7), roughness: 0.5 });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf8f8f0, roughness: 0.15 });
  const irisMat = new THREE.MeshStandardMaterial({ color: profile.eyeColor, roughness: 0.2, metalness: 0.1 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.1 });
  const clothMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.7 });

  // Head group (everything moves together)
  const headGroup = new THREE.Group();
  scene.add(headGroup);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.48, 32, 32), skinMat);
  head.scale.set(1, 1.12, 0.92);
  headGroup.add(head);

  // Nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 8), skinMat);
  nose.position.set(0, -0.04, 0.46);
  nose.rotation.x = -0.3;
  headGroup.add(nose);

  // Eyebrows
  const browMat = new THREE.MeshStandardMaterial({ color: profile.hair, roughness: 0.9 });
  const leftBrow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.03), browMat);
  leftBrow.position.set(-0.16, 0.2, 0.42);
  leftBrow.rotation.z = 0.1;
  headGroup.add(leftBrow);
  const rightBrow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.03), browMat);
  rightBrow.position.set(0.16, 0.2, 0.42);
  rightBrow.rotation.z = -0.1;
  headGroup.add(rightBrow);

  // Eyes
  const makeEye = (x) => {
    const group = new THREE.Group();
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), eyeWhiteMat);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12), irisMat);
    iris.position.z = 0.05;
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), pupilMat);
    pupil.position.z = 0.065;
    const highlight = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    highlight.position.set(0.02, 0.02, 0.075);
    group.add(white, iris, pupil, highlight);
    group.position.set(x, 0.08, 0.38);
    return group;
  };
  const leftEye = makeEye(-0.16);
  const rightEye = makeEye(0.16);
  headGroup.add(leftEye, rightEye);

  // Mouth (lips)
  const upperLip = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 8, 16, Math.PI), lipMat);
  upperLip.position.set(0, -0.16, 0.41);
  upperLip.rotation.z = Math.PI;
  headGroup.add(upperLip);
  const lowerLip = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.02, 8, 16, Math.PI), lipMat);
  lowerLip.position.set(0, -0.18, 0.41);
  headGroup.add(lowerLip);
  // Mouth interior (dark)
  const mouthInner = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.01), new THREE.MeshBasicMaterial({ color: 0x1a0a0a, side: THREE.DoubleSide }));
  mouthInner.position.set(0, -0.17, 0.415);
  headGroup.add(mouthInner);

  // Ears
  const earGeo = new THREE.SphereGeometry(0.06, 8, 8);
  const leftEar = new THREE.Mesh(earGeo, skinMat);
  leftEar.position.set(-0.46, 0.02, 0);
  leftEar.scale.set(0.5, 1, 0.7);
  headGroup.add(leftEar);
  const rightEar = new THREE.Mesh(earGeo, skinMat);
  rightEar.position.set(0.46, 0.02, 0);
  rightEar.scale.set(0.5, 1, 0.7);
  headGroup.add(rightEar);

  // Hair
  const hairGroup = new THREE.Group();
  if (profile.hairStyle === 'short' || profile.hairStyle === 'buzz' || profile.hairStyle === 'military') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), hairMat);
    cap.scale.set(1.02, 0.55, 0.95);
    cap.position.y = 0.25;
    hairGroup.add(cap);
  } else if (profile.hairStyle === 'long' || profile.hairStyle === 'bob') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.52, 32, 32), hairMat);
    cap.scale.set(1.05, 0.6, 1);
    cap.position.y = 0.22;
    hairGroup.add(cap);
    // Side hair
    const sideL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, profile.hairStyle === 'long' ? 0.6 : 0.3, 8), hairMat);
    sideL.position.set(-0.4, profile.hairStyle === 'long' ? -0.2 : -0.05, 0);
    hairGroup.add(sideL);
    const sideR = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, profile.hairStyle === 'long' ? 0.6 : 0.3, 8), hairMat);
    sideR.position.set(0.4, profile.hairStyle === 'long' ? -0.2 : -0.05, 0);
    hairGroup.add(sideR);
  } else if (profile.hairStyle === 'sleek') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.51, 32, 32), hairMat);
    cap.scale.set(1.03, 0.5, 0.98);
    cap.position.y = 0.27;
    hairGroup.add(cap);
  } else if (profile.hairStyle === 'curly') {
    for (let i = 0; i < 12; i++) {
      const curl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), hairMat);
      const angle = (i / 12) * Math.PI * 2;
      curl.position.set(Math.cos(angle) * 0.38, 0.25 + Math.sin(i) * 0.05, Math.sin(angle) * 0.35);
      hairGroup.add(curl);
    }
  } else if (profile.hairStyle === 'receding') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.49, 32, 32), hairMat);
    cap.scale.set(1, 0.35, 0.9);
    cap.position.set(0, 0.32, -0.05);
    hairGroup.add(cap);
  } else {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), hairMat);
    cap.scale.set(1.02, 0.5, 0.95);
    cap.position.y = 0.25;
    hairGroup.add(cap);
  }
  headGroup.add(hairGroup);

  // Neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 16), skinMat);
  neck.position.y = -0.6;
  scene.add(neck);

  // Body/shoulders (clothing)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.7, 32), clothMat);
  body.position.y = -1.1;
  scene.add(body);
  // Shoulder curves
  const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), clothMat);
  shoulderL.position.set(-0.4, -0.8, 0);
  scene.add(shoulderL);
  const shoulderR = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), clothMat);
  shoulderR.position.set(0.4, -0.8, 0);
  scene.add(shoulderR);

  // Collar detail
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 8, 16, Math.PI), clothMat);
  collar.position.set(0, -0.72, 0.1);
  collar.rotation.x = 0.3;
  scene.add(collar);

  // Jaw (separate mesh for open/close)
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.3), skinMat);
  jaw.position.set(0, -0.28, 0.05);
  jaw.scale.set(1.6, 0.4, 1.5);
  headGroup.add(jaw);

  // Tongue (visible during open-mouth visemes)
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshStandardMaterial({ color: 0xcc6666, roughness: 0.6 }));
  tongue.position.set(0, -0.2, 0.38);
  tongue.scale.set(1.5, 0.5, 1);
  tongue.visible = false;
  headGroup.add(tongue);

  // Teeth (upper row, visible when mouth opens)
  const teethMat = new THREE.MeshStandardMaterial({ color: 0xf0ece0, roughness: 0.3 });
  const upperTeeth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.015, 0.02), teethMat);
  upperTeeth.position.set(0, -0.155, 0.42);
  upperTeeth.visible = false;
  headGroup.add(upperTeeth);

  // Store references
  avatar3D = { scene, camera, renderer, headGroup, leftEye, rightEye, upperLip, lowerLip, mouthInner, leftBrow, rightBrow, body, jaw, tongue, upperTeeth };

  // --- Viseme system ---
  // Maps viseme IDs to mouth shape parameters: { jawOpen, lipWidth, lipRound, tongueUp }
  const VISEME_SHAPES = {
    sil:  { jawOpen: 0, lipWidth: 0, lipRound: 0, tongueUp: false },     // Silence
    aa:   { jawOpen: 0.8, lipWidth: 0.3, lipRound: 0, tongueUp: false },  // "ah" as in father
    ae:   { jawOpen: 0.6, lipWidth: 0.5, lipRound: 0, tongueUp: false },  // "ae" as in cat
    ah:   { jawOpen: 0.5, lipWidth: 0.2, lipRound: 0, tongueUp: false },  // "uh" as in but
    ao:   { jawOpen: 0.7, lipWidth: 0, lipRound: 0.5, tongueUp: false },  // "aw" as in law
    eh:   { jawOpen: 0.4, lipWidth: 0.4, lipRound: 0, tongueUp: false },  // "e" as in bed
    er:   { jawOpen: 0.3, lipWidth: 0.1, lipRound: 0.3, tongueUp: true }, // "er" as in bird
    ih:   { jawOpen: 0.2, lipWidth: 0.5, lipRound: 0, tongueUp: false },  // "i" as in bit
    iy:   { jawOpen: 0.15, lipWidth: 0.6, lipRound: 0, tongueUp: false }, // "ee" as in see
    ow:   { jawOpen: 0.4, lipWidth: 0, lipRound: 0.8, tongueUp: false },  // "o" as in go
    uw:   { jawOpen: 0.2, lipWidth: 0, lipRound: 0.9, tongueUp: false },  // "oo" as in too
    pp:   { jawOpen: 0, lipWidth: 0, lipRound: 0.1, tongueUp: false },    // p/b/m — lips pressed
    ff:   { jawOpen: 0.1, lipWidth: 0.2, lipRound: 0, tongueUp: false },  // f/v — lower lip tuck
    th:   { jawOpen: 0.15, lipWidth: 0.3, lipRound: 0, tongueUp: true },  // th — tongue tip
    dd:   { jawOpen: 0.2, lipWidth: 0.3, lipRound: 0, tongueUp: true },   // d/t/n — tongue tap
    kk:   { jawOpen: 0.3, lipWidth: 0.2, lipRound: 0, tongueUp: false },  // k/g — back of tongue
    ss:   { jawOpen: 0.1, lipWidth: 0.4, lipRound: 0, tongueUp: false },  // s/z — hiss
    sh:   { jawOpen: 0.15, lipWidth: 0, lipRound: 0.4, tongueUp: false }, // sh/ch/j
    rr:   { jawOpen: 0.2, lipWidth: 0, lipRound: 0.3, tongueUp: true },  // r
  };

  // Current and target viseme (for smooth interpolation)
  let currentViseme = { jawOpen: 0, lipWidth: 0, lipRound: 0, tongueUp: false };
  let targetViseme = { ...currentViseme };
  avatarState._visemeQueue = [];
  avatarState._currentVisemeKey = 'sil';

  // Set target viseme from audio energy or explicit viseme key
  avatarState.setViseme = function(key) {
    const shape = VISEME_SHAPES[key] || VISEME_SHAPES.sil;
    targetViseme = { ...shape };
    avatarState._currentVisemeKey = key;
  };

  // Drive visemes from audio energy level (0-1)
  avatarState.setAudioEnergy = function(energy) {
    if (energy < 0.05) {
      targetViseme = { ...VISEME_SHAPES.sil };
      return;
    }
    // Map energy to a blend of open-mouth visemes
    const vowels = ['ah', 'ae', 'eh', 'ow', 'aa', 'iy'];
    const idx = Math.floor(energy * 10 + Date.now() * 0.003) % vowels.length;
    const shape = VISEME_SHAPES[vowels[idx]];
    targetViseme = {
      jawOpen: shape.jawOpen * energy,
      lipWidth: shape.lipWidth * (0.5 + energy * 0.5),
      lipRound: shape.lipRound * energy,
      tongueUp: false,
    };
  };

  // Animation loop
  function animate() {
    avatarState.animationFrame = requestAnimationFrame(animate);
    const t = Date.now() / 1000;
    const dt = 0.016; // ~60fps

    // Idle head sway (more natural with multiple frequencies)
    headGroup.rotation.y = Math.sin(t * 0.4) * 0.04 + Math.sin(t * 0.17) * 0.02 + avatarState.headRotation.x * 0.008;
    headGroup.rotation.x = Math.sin(t * 0.3) * 0.015 + Math.sin(t * 0.11) * 0.008 + avatarState.headRotation.y * 0.005;
    headGroup.position.y = Math.sin(t * 0.5) * 0.005;

    // Subtle head movement when speaking
    if (avatarState.speaking) {
      headGroup.rotation.y += Math.sin(t * 2.1) * 0.015;
      headGroup.rotation.x += Math.sin(t * 1.7) * 0.008;
      headGroup.rotation.z = Math.sin(t * 1.3) * 0.01;
    } else {
      headGroup.rotation.z *= 0.95;
    }

    // Eye tracking with saccades
    const saccade = Math.floor(t * 0.5) !== Math.floor((t - dt) * 0.5);
    const eyeTargetX = saccade ? (Math.random() - 0.5) * 0.06 : Math.sin(t * 0.2) * 0.02;
    const eyeTargetY = Math.sin(t * 0.15) * 0.01;
    leftEye.rotation.y += (eyeTargetX - leftEye.rotation.y) * 0.1;
    leftEye.rotation.x += (eyeTargetY - leftEye.rotation.x) * 0.1;
    rightEye.rotation.y = leftEye.rotation.y;
    rightEye.rotation.x = leftEye.rotation.x;

    // Natural blink (variable interval 2-5 seconds)
    const blinkPhase = (t * 1.1 + Math.sin(t * 0.37) * 0.5) % 4;
    const blink = blinkPhase > 3.85 && blinkPhase < 3.95;
    const blinkAmount = blink ? 0.05 : 1;
    leftEye.scale.y += (blinkAmount - leftEye.scale.y) * 0.4;
    rightEye.scale.y = leftEye.scale.y;

    // Eyebrow animation
    if (avatarState.speaking) {
      leftBrow.position.y = 0.22 + Math.sin(t * 2.5) * 0.012;
      rightBrow.position.y = 0.22 + Math.sin(t * 2.5 + 0.7) * 0.012;
    } else if (avatarState.listening) {
      leftBrow.position.y = 0.23;
      rightBrow.position.y = 0.23;
    } else {
      leftBrow.position.y += (0.2 - leftBrow.position.y) * 0.05;
      rightBrow.position.y += (0.2 - rightBrow.position.y) * 0.05;
    }

    // --- Viseme-driven mouth animation ---
    const lerpSpeed = 0.18; // Smooth interpolation speed
    currentViseme.jawOpen += (targetViseme.jawOpen - currentViseme.jawOpen) * lerpSpeed;
    currentViseme.lipWidth += (targetViseme.lipWidth - currentViseme.lipWidth) * lerpSpeed;
    currentViseme.lipRound += (targetViseme.lipRound - currentViseme.lipRound) * lerpSpeed;

    const jOpen = currentViseme.jawOpen;
    const lWidth = currentViseme.lipWidth;
    const lRound = currentViseme.lipRound;

    // Jaw — drops down when open
    jaw.position.y = -0.28 - jOpen * 0.04;

    // Lower lip follows jaw
    lowerLip.position.y = -0.18 - jOpen * 0.06;
    lowerLip.scale.x = 1 + lWidth * 0.3 - lRound * 0.2;

    // Upper lip — slight movement, width changes
    upperLip.scale.x = 1 + lWidth * 0.2 - lRound * 0.15;
    upperLip.position.y = -0.16 - jOpen * 0.005;

    // Mouth interior — scales with jaw opening
    mouthInner.scale.y = 1 + jOpen * 10;
    mouthInner.scale.x = 1 + lWidth * 0.3 - lRound * 0.3;
    mouthInner.position.y = -0.17 - jOpen * 0.03;

    // Teeth visible when mouth opens enough
    upperTeeth.visible = jOpen > 0.15;
    upperTeeth.scale.x = 1 + lWidth * 0.2;

    // Tongue visible during certain visemes
    tongue.visible = targetViseme.tongueUp && jOpen > 0.1;
    tongue.position.y = -0.19 - jOpen * 0.02;

    // Lip rounding — push lips forward for "oo"/"oh" shapes
    upperLip.position.z = 0.41 + lRound * 0.02;
    lowerLip.position.z = 0.41 + lRound * 0.02;

    // Also drive the legacy mouthOpenness for photo avatar sync
    avatarState.mouthOpenness = jOpen;

    renderer.render(scene, camera);
  }
  animate();
}

function _updateAvatarColor_legacy() {
  // Legacy Three.js update — no longer used
}

function switchAvatarEmployee() {
  // Disconnect LiveKit if active (need new room for new employee)
  if (livekitRoom) disconnectLiveKit();

  // Stop any playing D-ID video
  const talkingVideo = document.getElementById('avatarTalkingVideo');
  if (talkingVideo) { talkingVideo.pause(); talkingVideo.style.display = 'none'; }

  const select = document.getElementById('avatarSelect');
  const option = select.options[select.selectedIndex];
  avatarState.employee = select.value;
  avatarState.color = option.dataset.color || '#3b82f6';
  avatarState.history = [];
  document.getElementById('avatarMessages').innerHTML = '';

  // Re-initialize avatar display for new employee (photo or portrait)
  initAvatarDisplay();
  addAvatarBotMessage(`Switched to ${option.textContent}. How can I help you?`);
}

// --- Voice System ---
function initVoiceSystem() {
  avatarState.continuousMode = false;
  avatarState.vadStream = null;
  avatarState.vadAnimFrame = null;

  // Check for Speech Recognition support
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    avatarState.recognition = new SpeechRecognition();
    avatarState.recognition.continuous = false;
    avatarState.recognition.interimResults = true;
    avatarState.recognition.lang = 'en-US';

    avatarState.recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map(r => r[0].transcript).join('');
      document.getElementById('avatarInput').value = transcript;
      if (event.results[0].isFinal) {
        avatarState.listening = false;
        document.getElementById('micIcon').textContent = '🎤';
        document.getElementById('avatarStatus').textContent = 'Processing...';
        sendAvatarMessage();
      }
    };

    avatarState.recognition.onend = () => {
      avatarState.listening = false;
      document.getElementById('micIcon').textContent = '🎤';
    };

    avatarState.recognition.onerror = (e) => {
      avatarState.listening = false;
      document.getElementById('micIcon').textContent = '🎤';
      if (e.error !== 'no-speech') console.warn('Speech recognition error:', e.error);
    };
  }
}

async function toggleVoiceInput() {
  // If LiveKit is ready, use real-time voice pipeline
  if (avatarState.livekitReady && typeof LivekitClient !== 'undefined') {
    if (livekitRoom) {
      disconnectLiveKit();
      addAvatarBotMessage('Voice session ended. Click the mic to start again, or type below.');
    } else {
      document.getElementById('avatarStatus').textContent = 'Connecting...';
      document.getElementById('micIcon').textContent = '⏳';
      const connected = await connectLiveKit();
      if (connected) {
        addAvatarBotMessage('Voice pipeline connected! Speak naturally — I can hear you.');
      } else {
        document.getElementById('micIcon').textContent = '🎤';
        document.getElementById('avatarStatus').textContent = 'Idle';
        showSettingsToast('LiveKit connection failed — falling back to browser STT', true);
        // Fall through to browser STT
        startBrowserSTT();
      }
    }
    return;
  }

  // Fallback: browser Speech Recognition
  startBrowserSTT();
}

function startBrowserSTT() {
  if (!avatarState.recognition) {
    showSettingsToast('Speech recognition not supported in this browser', true);
    return;
  }
  if (avatarState.listening) {
    avatarState.recognition.stop();
    avatarState.listening = false;
    document.getElementById('micIcon').textContent = '🎤';
    document.getElementById('avatarStatus').textContent = 'Idle';
  } else {
    avatarState.recognition.start();
    avatarState.listening = true;
    document.getElementById('micIcon').textContent = '🔴';
    document.getElementById('avatarStatus').textContent = 'Listening...';
  }
}

function toggleTTS() {
  avatarState.ttsEnabled = !avatarState.ttsEnabled;
  document.getElementById('speakerIcon').textContent = avatarState.ttsEnabled ? '🔊' : '🔇';
}

// --- Web Audio API for Lip-Sync ---
let audioContext = null;
let audioAnalyser = null;
let audioFreqData = null;
let lipSyncAnimFrame = null;

function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function startLipSyncFromAudio(sourceNode) {
  const ctx = getAudioContext();
  audioAnalyser = ctx.createAnalyser();
  audioAnalyser.fftSize = 256;
  audioAnalyser.smoothingTimeConstant = 0.7;
  audioFreqData = new Uint8Array(audioAnalyser.frequencyBinCount);

  sourceNode.connect(audioAnalyser);
  audioAnalyser.connect(ctx.destination);

  // Drive visemes from frequency data
  function updateLipSync() {
    lipSyncAnimFrame = requestAnimationFrame(updateLipSync);
    audioAnalyser.getByteFrequencyData(audioFreqData);

    // Calculate energy bands
    const bins = audioFreqData.length;
    let lowEnergy = 0, midEnergy = 0, highEnergy = 0, totalEnergy = 0;
    for (let i = 0; i < bins; i++) {
      const v = audioFreqData[i] / 255;
      totalEnergy += v;
      if (i < bins * 0.15) lowEnergy += v;       // 0-1200 Hz (vowels, fundamentals)
      else if (i < bins * 0.4) midEnergy += v;    // 1200-3200 Hz (consonants, formants)
      else highEnergy += v;                        // 3200+ Hz (sibilants, fricatives)
    }
    lowEnergy /= (bins * 0.15);
    midEnergy /= (bins * 0.25);
    highEnergy /= (bins * 0.6);
    totalEnergy /= bins;

    if (avatarState.setAudioEnergy) {
      // Enhanced: use frequency bands to select better viseme shapes
      const energy = Math.min(1, totalEnergy * 3);
      if (energy < 0.03) {
        avatarState.setViseme('sil');
      } else if (highEnergy > midEnergy * 1.5 && highEnergy > 0.15) {
        // Sibilant — "s", "sh", "f" sounds
        avatarState.setViseme(highEnergy > 0.3 ? 'ss' : 'ff');
      } else if (lowEnergy > midEnergy * 1.3 && lowEnergy > 0.2) {
        // Strong low = open vowels
        const vowelIdx = Math.floor(Date.now() * 0.004) % 3;
        avatarState.setViseme(['aa', 'ao', 'ah'][vowelIdx]);
      } else if (midEnergy > 0.15) {
        // Mid-range = consonants or mid vowels
        const midIdx = Math.floor(Date.now() * 0.005) % 4;
        avatarState.setViseme(['eh', 'ih', 'dd', 'kk'][midIdx]);
      } else {
        avatarState.setAudioEnergy(energy);
      }
    }
  }
  updateLipSync();
}

function stopLipSync() {
  if (lipSyncAnimFrame) {
    cancelAnimationFrame(lipSyncAnimFrame);
    lipSyncAnimFrame = null;
  }
  if (avatarState.setViseme) avatarState.setViseme('sil');
  avatarState.mouthOpenness = 0;
  avatarState.speaking = false;
  const statusEl = document.getElementById('avatarStatus');
  if (statusEl) statusEl.textContent = avatarState.continuousMode ? 'Listening...' : 'Idle';
}

async function speakText(text) {
  if (!avatarState.ttsEnabled) return;

  avatarState.speaking = true;
  document.getElementById('avatarStatus').textContent = 'Speaking...';

  // Try OpenAI TTS with Web Audio API lip-sync
  try {
    const token = localStorage.getItem('ai-os-token');
    const profile = AVATAR_PROFILES[avatarState.employee] || {};
    const res = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text: text.substring(0, 2000), voice: profile.voice || 'onyx' }),
    });
    const data = await res.json();

    if (data.ok && data.audioContent) {
      const ctx = getAudioContext();

      // Decode base64 audio into AudioBuffer for AnalyserNode
      const binaryStr = atob(data.audioContent);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);

      // Create buffer source and pipe through analyser for lip-sync
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      startLipSyncFromAudio(source);

      source.onended = () => {
        stopLipSync();
        // In continuous mode, resume listening after speaking
        if (avatarState.continuousMode && avatarState.recognition) {
          setTimeout(() => {
            if (avatarState.continuousMode) startContinuousSTT();
          }, 300);
        }
      };
      source.start(0);
      return;
    }
  } catch (e) {
    console.warn('TTS with lip-sync failed:', e);
  }

  // Fallback to browser Speech Synthesis with lip-sync
  avatarState.speaking = false;
  speakTextBrowserFallback(text);
}

function speakTextBrowserFallback(text) {
  if (!window.speechSynthesis) return;

  const profile = AVATAR_PROFILES[avatarState.employee] || {};
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = profile.fallbackRate || 1.0;
  utterance.pitch = profile.fallbackPitch || 1.0;
  utterance.volume = 0.8;

  const voices = window.speechSynthesis.getVoices();
  // Try to match gender
  const genderFilter = profile.gender === 'F'
    ? v => (v.name.toLowerCase().includes('female') || v.name.includes('Samantha') || v.name.includes('Victoria') || v.name.includes('Karen'))
    : v => (v.name.toLowerCase().includes('male') || v.name.includes('Daniel') || v.name.includes('James') || v.name.includes('David'));
  const preferred = voices.find(v => v.lang.startsWith('en') && genderFilter(v)) ||
                    voices.find(v => v.name.includes('Google') && v.lang.startsWith('en')) ||
                    voices.find(v => v.lang.startsWith('en-US')) || voices[0];
  if (preferred) utterance.voice = preferred;

  avatarState.speaking = true;
  document.getElementById('avatarStatus').textContent = 'Speaking...';

  // Use browser SpeechSynthesis boundary events for lip-sync
  const vowelVisemes = ['aa', 'eh', 'ih', 'ow', 'ae', 'ah'];
  const consonantVisemes = ['dd', 'kk', 'pp', 'ff', 'ss'];
  let wordIdx = 0;
  utterance.onboundary = (e) => {
    if (e.name === 'word') {
      // Cycle through viseme shapes on each word boundary
      wordIdx++;
      const v = wordIdx % 3 === 0 ? consonantVisemes[wordIdx % consonantVisemes.length] : vowelVisemes[wordIdx % vowelVisemes.length];
      if (avatarState.setViseme) avatarState.setViseme(v);
    }
  };

  // Between word boundaries, animate with simple energy
  const mouthInterval = setInterval(() => {
    if (avatarState.setAudioEnergy) {
      avatarState.setAudioEnergy(0.3 + Math.random() * 0.4);
    }
  }, 100);

  utterance.onend = () => {
    clearInterval(mouthInterval);
    stopLipSync();
    // In continuous mode, resume listening
    if (avatarState.continuousMode && avatarState.recognition) {
      setTimeout(() => {
        if (avatarState.continuousMode) startContinuousSTT();
      }, 300);
    }
  };
  utterance.onerror = () => { clearInterval(mouthInterval); stopLipSync(); };

  window.speechSynthesis.speak(utterance);
}

// --- Continuous Voice Chat Mode ---
// Always-on microphone with voice activity detection (VAD)
// Auto-sends on silence, auto-resumes after agent speaks

function toggleContinuousVoice() {
  if (avatarState.continuousMode) {
    stopContinuousVoice();
  } else {
    startContinuousVoice();
  }
}

function startContinuousVoice() {
  avatarState.continuousMode = true;
  const btn = document.getElementById('continuousVoiceBtn');
  if (btn) {
    btn.classList.add('active');
    btn.title = 'Stop continuous voice chat';
  }
  document.getElementById('avatarStatus').textContent = 'Voice chat active';
  document.getElementById('micIcon').textContent = '🟢';

  // Start microphone for VAD
  startVADMicrophone();
  startContinuousSTT();
  showSettingsToast('Continuous voice chat active — speak naturally');
}

function stopContinuousVoice() {
  avatarState.continuousMode = false;
  const btn = document.getElementById('continuousVoiceBtn');
  if (btn) {
    btn.classList.remove('active');
    btn.title = 'Start continuous voice chat';
  }

  // Stop VAD microphone
  if (avatarState.vadStream) {
    avatarState.vadStream.getTracks().forEach(t => t.stop());
    avatarState.vadStream = null;
  }
  if (avatarState.vadAnimFrame) {
    cancelAnimationFrame(avatarState.vadAnimFrame);
    avatarState.vadAnimFrame = null;
  }

  if (avatarState.recognition) {
    try { avatarState.recognition.stop(); } catch {}
  }
  avatarState.listening = false;
  document.getElementById('micIcon').textContent = '🎤';
  document.getElementById('avatarStatus').textContent = 'Idle';
  showSettingsToast('Voice chat ended');
}

async function startVADMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    avatarState.vadStream = stream;
    const ctx = getAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    avatarState.vadSilenceStart = null;
    avatarState.vadSpeechDetected = false;

    // Visual feedback: show input level on the listening indicator
    function vadLoop() {
      avatarState.vadAnimFrame = requestAnimationFrame(vadLoop);
      analyser.getByteFrequencyData(data);
      let energy = 0;
      for (let i = 0; i < data.length; i++) energy += data[i];
      energy /= (data.length * 255);

      // Voice activity threshold
      const threshold = 0.04;
      const statusEl = document.getElementById('avatarStatus');
      if (energy > threshold) {
        avatarState.vadSilenceStart = null;
        if (!avatarState.vadSpeechDetected) {
          avatarState.vadSpeechDetected = true;
        }
        if (statusEl && avatarState.listening && !avatarState.speaking) {
          statusEl.textContent = 'Hearing you...';
        }
      } else if (avatarState.vadSpeechDetected) {
        if (!avatarState.vadSilenceStart) {
          avatarState.vadSilenceStart = Date.now();
        }
        // After 1.5s of silence following speech, trigger send
        if (Date.now() - avatarState.vadSilenceStart > 1500) {
          avatarState.vadSpeechDetected = false;
          avatarState.vadSilenceStart = null;
          // The recognition.onresult with isFinal handles the actual send
        }
      }
    }
    vadLoop();
  } catch (e) {
    console.warn('VAD microphone access denied:', e);
  }
}

function startContinuousSTT() {
  if (!avatarState.recognition || avatarState.speaking) return;
  if (avatarState.listening) return;

  // Re-configure for continuous mode
  avatarState.recognition.continuous = true;
  avatarState.recognition.interimResults = true;

  // Override handlers for continuous mode
  avatarState.recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    const input = document.getElementById('avatarInput');
    if (interimTranscript) {
      input.value = interimTranscript;
      document.getElementById('avatarStatus').textContent = 'Hearing you...';
    }
    if (finalTranscript.trim()) {
      input.value = finalTranscript.trim();
      // Stop listening while processing
      try { avatarState.recognition.stop(); } catch {}
      avatarState.listening = false;
      document.getElementById('avatarStatus').textContent = 'Processing...';
      sendAvatarMessage();
    }
  };

  avatarState.recognition.onend = () => {
    avatarState.listening = false;
    // Auto-restart if in continuous mode and not speaking
    if (avatarState.continuousMode && !avatarState.speaking) {
      setTimeout(() => {
        if (avatarState.continuousMode && !avatarState.speaking) {
          startContinuousSTT();
        }
      }, 200);
    }
  };

  avatarState.recognition.onerror = (e) => {
    avatarState.listening = false;
    if (e.error === 'no-speech' && avatarState.continuousMode) {
      // Silently restart on no-speech in continuous mode
      setTimeout(() => {
        if (avatarState.continuousMode && !avatarState.speaking) startContinuousSTT();
      }, 500);
    } else if (e.error !== 'aborted') {
      console.warn('Continuous STT error:', e.error);
    }
  };

  try {
    avatarState.recognition.start();
    avatarState.listening = true;
    if (!avatarState.speaking) {
      document.getElementById('avatarStatus').textContent = 'Listening...';
    }
  } catch (e) {
    // Already started
  }
}

// --- Avatar Chat Messages ---
function addAvatarBotMessage(text) {
  const container = document.getElementById('avatarMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'avatar-msg avatar-msg-bot';
  div.innerHTML = `<div class="avatar-msg-face">${renderAvatar(avatarState.employee, 'sm')}</div><div class="avatar-msg-text">${escapeHtml(text)}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  speakText(text);
}

function addAvatarUserMessage(text) {
  const container = document.getElementById('avatarMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'avatar-msg avatar-msg-user';
  div.innerHTML = `<div class="avatar-msg-text">${escapeHtml(text)}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendAvatarMessage() {
  const input = document.getElementById('avatarInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  addAvatarUserMessage(text);
  avatarState.history.push({ role: 'user', content: text });
  document.getElementById('avatarStatus').textContent = 'Thinking...';

  try {
    const agentName = AVATAR_AGENTS[avatarState.employee] || 'orchestrator';
    const result = await fetchJSON('/api/agent/execute', {
      method: 'POST',
      body: { agent: agentName, task: text, context: `Conversation history: ${avatarState.history.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n')}` },
    });

    const reply = result.content || result.error || 'I could not process that request.';
    avatarState.history.push({ role: 'assistant', content: reply });

    // Priority: D-ID talking video > HeyGen streaming > OpenAI TTS > browser TTS
    const didTriggered = await triggerDIDTalk(reply);

    if (!didTriggered && heygenSessionActive) {
      sendToHeyGen(reply);
    }

    // addAvatarBotMessage handles text display + TTS fallback
    // If D-ID is handling video, skip TTS to avoid double audio
    if (didTriggered) {
      addAvatarBotMessageNoSpeak(reply);
    } else {
      addAvatarBotMessage(reply);
    }
  } catch (e) {
    addAvatarBotMessage('Sorry, something went wrong. Please try again.');
  }

  document.getElementById('avatarStatus').textContent = 'Idle';
}

// Add bot message without speaking (used when D-ID handles audio)
function addAvatarBotMessageNoSpeak(text) {
  const container = document.getElementById('avatarMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'avatar-msg avatar-msg-bot';
  div.innerHTML = `<div class="avatar-msg-face">${renderAvatar(avatarState.employee, 'sm')}</div><div class="avatar-msg-text">${escapeHtml(text)}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// --- D-ID Interactive Talking Avatar ---

async function triggerDIDTalk(text) {
  if (!avatarState.didReady || !avatarState.ttsEnabled) return false;

  const employee = avatarState.employee;
  const profile = AVATAR_PROFILES[employee];
  const photoUrl = avatarPhotos[employee + '_did'] || ''; // D-ID uploaded photo URL

  // Need either a D-ID photo URL or fall back to stock
  document.getElementById('avatarStatus').textContent = 'Generating video...';
  avatarState.speaking = true;

  try {
    const result = await fetchJSON('/api/did/talk', {
      method: 'POST',
      body: {
        text: text.substring(0, 1500),
        photoUrl: photoUrl,
        voice: profile.didVoice || 'en-US-JennyNeural',
        employee,
      },
    });

    if (!result.ok) {
      console.warn('[D-ID] Talk creation failed:', result.error);
      avatarState.speaking = false;
      return false;
    }

    // Poll for completion
    const videoUrl = await pollDIDTalk(result.talkId);
    if (videoUrl) {
      await playDIDVideo(videoUrl);
      return true;
    }

    avatarState.speaking = false;
    return false;
  } catch (e) {
    console.error('[D-ID] Error:', e);
    avatarState.speaking = false;
    return false;
  }
}

async function pollDIDTalk(talkId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000)); // Poll every 1s

    const status = await fetchJSON(`/api/did/talk/${talkId}`);
    if (!status.ok) continue;

    if (status.status === 'done' && status.resultUrl) {
      return status.resultUrl;
    }

    if (status.status === 'error' || status.status === 'rejected') {
      console.warn('[D-ID] Talk failed:', status);
      return null;
    }

    // Update status display with progress
    document.getElementById('avatarStatus').textContent = `Generating video... ${Math.round((i / maxAttempts) * 100)}%`;
  }

  console.warn('[D-ID] Talk timed out');
  return null;
}

async function playDIDVideo(videoUrl) {
  const videoEl = document.getElementById('avatarTalkingVideo');
  const photoLayer = document.getElementById('avatarPhotoLayer');
  const portraitFallback = document.getElementById('avatarPortraitFallback');

  if (!videoEl) return;

  videoEl.src = videoUrl;
  videoEl.style.display = 'block';
  if (photoLayer) photoLayer.style.display = 'none';
  if (portraitFallback) portraitFallback.style.display = 'none';

  avatarState.speaking = true;
  document.getElementById('avatarStatus').textContent = 'Speaking...';

  return new Promise((resolve) => {
    videoEl.onended = () => {
      avatarState.speaking = false;
      document.getElementById('avatarStatus').textContent = 'Idle';
      videoEl.style.display = 'none';
      // Show photo or portrait again
      initAvatarDisplay();
      resolve();
    };

    videoEl.onerror = () => {
      avatarState.speaking = false;
      videoEl.style.display = 'none';
      initAvatarDisplay();
      resolve();
    };

    videoEl.play().catch(() => {
      videoEl.style.display = 'none';
      initAvatarDisplay();
      resolve();
    });
  });
}

// --- Avatar Identity System ---
const AVATAR_MAP = {
  'atlas': 'avatar-atlas', 'nova': 'avatar-nova', 'justice': 'avatar-justice',
  'muse': 'avatar-muse', 'forge': 'avatar-forge', 'echo': 'avatar-echo',
  'hermes': 'avatar-hermes', 'harbor': 'avatar-harbor', 'matrix': 'avatar-matrix',
  'hawkeye': 'avatar-hawkeye', 'ledger': 'avatar-ledger',
  // Aliases for agent names
  'orchestrator': 'avatar-atlas', 'architect': 'avatar-nova', 'general-counsel': 'avatar-justice',
  'media-producer': 'avatar-muse', 'coder': 'avatar-forge', 'marketing-hub': 'avatar-echo',
  'hermes-delegate': 'avatar-hermes', 'cs-lead': 'avatar-harbor', 'it-director': 'avatar-matrix',
  'grok-realtime': 'avatar-hawkeye', 'cost-analyst': 'avatar-ledger',
};

function renderAvatar(name, size = 'sm') {
  const key = (name || '').toLowerCase();
  const avatarClass = AVATAR_MAP[key] || 'avatar-generic';
  return `<div class="${avatarClass} avatar-${size}"><div class="avatar-face"><div class="eye eye-l"></div><div class="eye eye-r"></div><div class="mouth"></div></div></div>`;
}

// --- Virtual HQ ---
async function loadHQ() {
  const [org, stats] = await Promise.all([
    fetchJSON('/api/hq/org'),
    fetchJSON('/api/hq/stats'),
  ]);
  if (!org || !org.departments) return;

  renderHQStats(stats);
  renderOrgChart(org);

  const countEl = document.getElementById('hqEmployeeCount');
  const deptEl = document.getElementById('hqDeptCount');
  if (countEl) countEl.textContent = stats.totalEmployees || 0;
  if (deptEl) deptEl.textContent = stats.departments || 0;
}

function renderHQStats(stats) {
  const container = document.getElementById('hqStats');
  if (!container) return;
  container.innerHTML = `
    <div class="hq-stat"><div class="hq-stat-value">${stats.totalEmployees}</div><div class="hq-stat-label">Total Employees</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${stats.departments}</div><div class="hq-stat-label">Departments</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--success);">${stats.byStatus?.active || 0}</div><div class="hq-stat-label">Active</div></div>
    <div class="hq-stat"><div class="hq-stat-value" style="color:var(--text-muted);">${stats.byStatus?.idle || 0}</div><div class="hq-stat-label">Idle</div></div>
    <div class="hq-stat"><div class="hq-stat-value">${stats.cSuite}</div><div class="hq-stat-label">C-Suite</div></div>
  `;
}

function renderOrgChart(org) {
  const container = document.getElementById('hqOrgChart');
  if (!container) return;

  container.innerHTML = org.departments.map(dept => {
    const employees = dept.employees.map(emp => {
      const tierClass = emp.tier === 'strategic' ? 'opus' : emp.tier === 'creative' ? 'omni' : emp.tier === 'scout' ? 'haiku' : emp.tier === 'persistent' ? 'hermes' : emp.tier === 'economy' ? 'economy' : emp.tier === 'realtime' ? 'grok' : 'sonnet';
      const statusDot = emp.status === 'active' ? '🟢' : emp.status === 'busy' ? '🟡' : '⚪';
      return `
        <div class="hq-employee" onclick="showEmployee('${emp.id}', this)" data-tier="${tierClass}" data-status="${emp.status}">
          <div class="hq-avatar">
            ${AVATAR_MAP[emp.name.toLowerCase()] ? renderAvatar(emp.name, 'sm') : `<span class="hq-avatar-face">${emp.avatar}</span>`}
            <div class="hq-avatar-typing"><div class="hq-typing-dots"><span></span><span></span><span></span></div></div>
          </div>
          <div class="hq-emp-info">
            <div class="hq-emp-name">${statusDot} ${emp.name}</div>
            <div class="hq-emp-title">${emp.title}</div>
          </div>
          <span class="hq-tier-badge hq-tier-${tierClass}">${emp.tier}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="hq-department" style="--dept-color: ${dept.color};">
        <div class="hq-dept-header">
          <span class="hq-dept-icon">${dept.icon}</span>
          <h3 class="hq-dept-name">${dept.name}</h3>
          <span class="hq-dept-count">${dept.employees.length}</span>
        </div>
        <div class="hq-employees">${employees}</div>
      </div>
    `;
  }).join('');
}

async function showEmployee(empId, el) {
  const data = await fetchJSON(`/api/hq/employee/${empId}`);
  if (!data || data.error) return;

  const modal = document.getElementById('hqEmployeeModal');
  const detail = document.getElementById('hqEmployeeDetail');
  const tierClass = data.tier === 'strategic' ? 'opus' : data.tier === 'creative' ? 'omni' : data.tier === 'scout' ? 'haiku' : data.tier === 'persistent' ? 'hermes' : 'sonnet';
  const routing = data.tier === 'strategic' ? 'Opus 4.8 xhigh' : data.tier === 'creative' ? 'Gemini Omni' : data.tier === 'scout' ? 'Opus 4.8 low' : data.tier === 'persistent' ? 'Hermes MCP' : data.tier === 'economy' ? 'DeepSeek V4' : data.tier === 'realtime' ? 'Grok-3' : 'Opus 4.8 high';

  detail.innerHTML = `
    <div class="hq-modal-header">
      <button class="btn btn-sm" onclick="document.getElementById('hqEmployeeModal').style.display='none';">&times; Close</button>
    </div>
    <div class="hq-profile">
      <div class="hq-profile-avatar">${AVATAR_MAP[(data.name || '').toLowerCase()] ? renderAvatar(data.name, 'lg') : data.avatar}</div>
      <div class="hq-profile-info">
        <h3>${data.name}</h3>
        <div class="hq-profile-title">${data.title}</div>
        <div class="hq-profile-dept">${data.department}</div>
      </div>
      <span class="hq-tier-badge hq-tier-${tierClass}">${data.tier}</span>
    </div>
    <div class="hq-profile-details">
      <div class="hq-detail-row"><span class="hq-detail-key">Agent</span><span class="hq-detail-val"><code>${data.agent}</code></span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Model</span><span class="hq-detail-val">${routing}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Status</span><span class="hq-detail-val hq-status-${data.status}">${data.status}</span></div>
      <div class="hq-detail-row"><span class="hq-detail-key">Reports To</span><span class="hq-detail-val">${data.reportsTo || 'Board'}</span></div>
    </div>
    <div class="hq-profile-desc">${data.desc}</div>
    <div class="hq-dispatch">
      <h4>Dispatch Task</h4>
      <div class="settings-input-row">
        <input type="text" class="settings-input" id="hqTaskInput" placeholder="Describe the task..." spellcheck="false">
        <button class="btn btn-primary" onclick="dispatchHQTask('${data.id}')">Dispatch</button>
      </div>
      <div id="hqDispatchResult" style="margin-top:10px;"></div>
    </div>
  `;
  modal.style.display = 'flex';
}

async function dispatchHQTask(employeeId) {
  const input = document.getElementById('hqTaskInput');
  const task = input.value.trim();
  if (!task) return;

  const resultEl = document.getElementById('hqDispatchResult');
  resultEl.innerHTML = '<div class="empty-state">Dispatching...</div>';

  const result = await fetchJSON(`/api/hq/dispatch/${employeeId}`, { method: 'POST', body: { task } });
  if (result.ok) {
    resultEl.innerHTML = `<div class="hq-dispatch-success">&#9989; Task dispatched to <strong>${result.employee}</strong> (${result.title}) via ${result.model}</div>`;
    input.value = '';
  } else {
    resultEl.innerHTML = `<div class="hq-dispatch-error">${result.error || 'Dispatch failed'}</div>`;
  }
}

// --- Gemini Omni Creative ---
async function startOmniGeneration() {
  const prompt = document.getElementById('omniPrompt').value.trim();
  if (!prompt) return;

  const type = document.querySelector('input[name="omniType"]:checked')?.value || 'video';
  const progressEl = document.getElementById('omniProgress');
  const resultEl = document.getElementById('omniResult');
  const btn = document.getElementById('omniGenerateBtn');

  btn.disabled = true;
  btn.textContent = 'Generating...';
  resultEl.innerHTML = '';
  progressEl.innerHTML = `
    <div class="omni-progress-bar">
      <div class="omni-progress-fill" id="omniProgressFill" style="width:5%"></div>
    </div>
    <div class="omni-progress-status" id="omniProgressStatus">Initializing Gemini Omni...</div>
  `;

  const result = await fetchJSON('/api/omni/generate', { method: 'POST', body: { type, prompt } });

  if (!result.ok) {
    progressEl.innerHTML = '';
    resultEl.innerHTML = `<div class="empty-state" style="color:var(--error);">${result.error || 'Generation failed'}</div>`;
    btn.disabled = false;
    btn.innerHTML = '&#10024; Generate';
    return;
  }

  // Listen for WebSocket progress updates
  const jobId = result.jobId;
  const originalOnMessage = ws?.onmessage;
  const progressHandler = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'omni_job_progress' && data.data.id === jobId) {
        const fill = document.getElementById('omniProgressFill');
        const status = document.getElementById('omniProgressStatus');
        if (fill) fill.style.width = `${data.data.progress}%`;
        if (status) status.textContent = data.data.msg;
      }
      if (data.event === 'omni_job_complete' && data.data.id === jobId) {
        renderOmniResult(data.data.type, data.data.result);
        progressEl.innerHTML = '';
        btn.disabled = false;
        btn.innerHTML = '&#10024; Generate';
      }
    } catch {}
    // Call original handler too
    if (originalOnMessage) originalOnMessage(event);
  };
  if (ws) ws.onmessage = progressHandler;

  // Fallback: stop after 30s
  setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false;
      btn.innerHTML = '&#10024; Generate';
      if (ws) ws.onmessage = originalOnMessage;
      if (!resultEl.innerHTML) resultEl.innerHTML = '<div class="empty-state">Generation timed out — check Activity Log for status.</div>';
    }
  }, 30000);
}

function renderOmniResult(type, result) {
  const el = document.getElementById('omniResult');
  if (!el || !result) return;

  const typeIcons = { video: '&#127909;', image: '&#128444;', audio: '&#127911;', thumbnail: '&#128247;', 'social-clip': '&#128241;' };
  const icon = typeIcons[type] || '&#10024;';

  const details = Object.entries(result)
    .filter(([k]) => !['prompt', 'model', 'watermark', 'generatedAt', 'preview'].includes(k))
    .map(([k, v]) => `<div class="omni-result-detail"><span class="omni-detail-key">${k.replace(/([A-Z])/g, ' $1').trim()}</span><span class="omni-detail-val">${v}</span></div>`)
    .join('');

  el.innerHTML = `
    <div class="omni-result-card">
      <div class="omni-result-header">
        <span class="omni-result-icon">${icon}</span>
        <div>
          <strong>${capitalize(type)} Generated</strong>
          <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(result.prompt.substring(0, 100))}${result.prompt.length > 100 ? '...' : ''}</div>
        </div>
        <span class="omni-result-badge">${result.model}</span>
      </div>
      <div class="omni-result-details">${details}</div>
      <div class="omni-result-preview">${escapeHtml(result.preview)}</div>
      <div class="omni-result-meta">
        <span>&#128274; SynthID watermarked</span>
        <span>${new Date(result.generatedAt).toLocaleString()}</span>
      </div>
    </div>
  `;
}

// --- SEO Agency ---
let seoAudits = [];

async function loadSeoAgency() {
  const data = await fetchJSON('/api/seo/audits');
  if (Array.isArray(data)) seoAudits = data;
  renderSeoAgency();
}

function renderSeoAgency() {
  const container = document.getElementById('seoAuditList');
  if (!container) return;

  if (seoAudits.length === 0) {
    container.innerHTML = '<div class="empty-state">No audits yet. Enter a domain above and click Audit to start.</div>';
    return;
  }

  container.innerHTML = seoAudits.slice().reverse().map(a => {
    const scoreClass = a.compositeScore >= 75 ? 'good' : a.compositeScore >= 50 ? 'warning' : 'critical';
    const statusIcon = a.status === 'complete' ? '&#9989;' : a.status === 'running' ? '&#9203;' : '&#10060;';
    return `
      <div class="seo-audit-card" data-id="${a.id}">
        <div class="seo-audit-header">
          <span class="seo-audit-domain">${statusIcon} ${escapeHtml(a.domain)}</span>
          ${a.compositeScore !== null ? `<span class="seo-score seo-score-${scoreClass}">${a.compositeScore}<small>/100</small></span>` : '<span class="seo-score seo-score-pending">...</span>'}
        </div>
        <div class="seo-audit-meta">
          <span>${new Date(a.startedAt).toLocaleDateString()}</span>
          <span class="seo-audit-status status-${a.status}">${a.status}</span>
        </div>
        <div class="seo-audit-actions">
          <button class="btn btn-sm btn-primary" onclick="viewSeoAudit('${a.id}')" ${a.status !== 'complete' ? 'disabled' : ''}>View Report</button>
          <button class="btn btn-sm" onclick="generateSeoReport('${a.id}')" ${a.status !== 'complete' ? 'disabled' : ''}>Export PDF</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSeoAudit('${a.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function startSeoAudit() {
  const input = document.getElementById('seoAuditDomain');
  const domain = input.value.trim();
  if (!domain) return;

  input.disabled = true;
  document.getElementById('seoAuditBtn').disabled = true;

  const result = await fetchJSON('/api/seo/audit', { method: 'POST', body: { domain } });

  if (result.ok) {
    showSettingsToast(`Audit started: ${result.domain}`);
    input.value = '';
    // Poll for updates
    pollSeoAudit(result.auditId);
  } else {
    showSettingsToast(result.error || 'Failed to start audit', true);
  }

  input.disabled = false;
  document.getElementById('seoAuditBtn').disabled = false;
}

function pollSeoAudit(auditId) {
  const poll = setInterval(async () => {
    const audit = await fetchJSON(`/api/seo/audit/${auditId}`);
    if (audit && audit.status === 'complete') {
      clearInterval(poll);
      loadSeoAgency();
      showSettingsToast(`Audit complete: ${audit.domain} — Score: ${audit.compositeScore}/100`);
    }
  }, 2000);
  // Stop polling after 60 seconds regardless
  setTimeout(() => clearInterval(poll), 60000);
  // Refresh list immediately
  setTimeout(() => loadSeoAgency(), 1000);
}

async function viewSeoAudit(auditId) {
  const audit = await fetchJSON(`/api/seo/audit/${auditId}`);
  if (!audit || audit.error) return;

  const detail = document.getElementById('seoAuditDetail');
  if (!detail) return;

  const agentCards = Object.entries(audit.agents).map(([name, data]) => {
    const scoreClass = data.score >= 75 ? 'good' : data.score >= 50 ? 'warning' : 'critical';
    const findings = (data.findings || []).map(f => {
      const sevClass = f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'warning' : 'info';
      return `<div class="seo-finding seo-finding-${sevClass}">
        <span class="seo-finding-severity">${f.severity.toUpperCase()}</span>
        <div><strong>${escapeHtml(f.issue)}</strong><br><span class="seo-finding-rec">${escapeHtml(f.recommendation)}</span></div>
      </div>`;
    }).join('');
    return `
      <div class="seo-agent-card">
        <div class="seo-agent-header">
          <span class="seo-agent-name">${capitalize(name)} Analysis</span>
          <span class="seo-score seo-score-${scoreClass}">${data.score}<small>/100</small></span>
        </div>
        <div class="seo-findings">${findings}</div>
      </div>
    `;
  }).join('');

  const quickWins = (audit.quickWins || []).map(w =>
    `<tr><td>${w.priority}</td><td>${escapeHtml(w.action)}</td><td>${w.time}</td><td><span class="seo-impact seo-impact-${w.impact}">${w.impact}</span></td></tr>`
  ).join('');

  const actionPlan = (audit.actionPlan || []).map(p =>
    `<div class="seo-phase">
      <div class="seo-phase-header"><span class="seo-phase-name">${p.phase}</span><span class="seo-phase-title">${p.title}</span><span class="seo-phase-priority priority-${p.priority}">${p.priority}</span></div>
      <ul>${p.tasks.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    </div>`
  ).join('');

  const scoreClass = audit.compositeScore >= 75 ? 'good' : audit.compositeScore >= 50 ? 'warning' : 'critical';

  detail.innerHTML = `
    <div class="seo-report">
      <div class="seo-report-header">
        <button class="btn btn-sm" onclick="document.getElementById('seoAuditDetail').innerHTML=''; document.getElementById('seoAuditDetail').style.display='none';">&larr; Back to Audits</button>
        <h3>${escapeHtml(audit.domain)} — Full SEO Audit Report</h3>
        <span class="seo-score seo-score-${scoreClass} seo-score-lg">${audit.compositeScore}<small>/100</small></span>
      </div>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">Executive Summary</h3>
        <p class="seo-executive-summary">${escapeHtml(audit.executiveSummary)}</p>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">Quick Wins</h3>
        <table class="docs-table seo-quickwins-table">
          <thead><tr><th>#</th><th>Action</th><th>Time</th><th>Impact</th></tr></thead>
          <tbody>${quickWins}</tbody>
        </table>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">Agent Analysis (5 Parallel Sub-Agents)</h3>
        <div class="seo-agents-grid">${agentCards}</div>
      </section>

      <section class="panel" style="margin-top:16px;">
        <h3 class="panel-title">Action Plan</h3>
        <div class="seo-action-plan">${actionPlan}</div>
      </section>

      <section class="panel seo-post-actions" style="margin-top:16px;">
        <h3 class="panel-title">Post-Audit Actions</h3>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">Generate deliverables from this audit's findings to accelerate implementation.</p>
        <div class="seo-action-btns">
          <button class="btn btn-primary" onclick="seoGenerateBriefs('${audit.id}')">
            <span class="seo-action-icon">&#128221;</span> Draft Content Briefs
          </button>
          <button class="btn btn-primary" onclick="seoGenerateCalendar('${audit.id}')">
            <span class="seo-action-icon">&#128197;</span> Generate Content Calendar
          </button>
          <button class="btn btn-primary" onclick="seoOptimizeMeta('${audit.id}')">
            <span class="seo-action-icon">&#127991;</span> Optimize Meta Tags
          </button>
          <button class="btn" onclick="generateSeoReport('${audit.id}')">
            <span class="seo-action-icon">&#128196;</span> Export PDF Report
          </button>
        </div>
        <div id="seoPostActionResult" style="margin-top:16px;"></div>
      </section>
    </div>
  `;
  detail.style.display = 'block';
}

async function generateSeoReport(auditId) {
  const result = await fetchJSON(`/api/seo/report/${auditId}`, { method: 'POST', body: {} });
  if (result.ok) {
    showSettingsToast(`Report generated: ${result.filename}`);
  } else {
    showSettingsToast(result.error || 'Report generation failed', true);
  }
}

async function seoGenerateBriefs(auditId) {
  const container = document.getElementById('seoPostActionResult');
  container.innerHTML = '<div class="empty-state">Generating content briefs...</div>';

  const result = await fetchJSON(`/api/seo/briefs/${auditId}`, { method: 'POST', body: {} });
  if (!result.ok) { container.innerHTML = `<div class="empty-state" style="color:var(--error);">${result.error || 'Failed'}</div>`; return; }

  container.innerHTML = `
    <h4 style="margin-bottom:12px;">Content Briefs for ${escapeHtml(result.domain)} (${result.briefs.length} briefs)</h4>
    ${result.briefs.map((b, i) => `
      <div class="seo-brief-card">
        <div class="seo-brief-header">
          <span class="seo-brief-num">${i + 1}</span>
          <div class="seo-brief-info">
            <strong>${escapeHtml(b.title)}</strong>
            <div class="seo-brief-meta">
              <span class="seo-impact seo-impact-${b.priority}">${b.priority}</span>
              <span>${b.wordCount} words</span>
              <span class="seo-intent-badge">${b.intent}</span>
              <span>Target: <code>${escapeHtml(b.targetKeyword)}</code></span>
            </div>
          </div>
        </div>
        <div class="seo-brief-outline">
          <strong>Outline:</strong>
          <ol>${b.outline.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
        </div>
      </div>
    `).join('')}
  `;
}

async function seoGenerateCalendar(auditId) {
  const container = document.getElementById('seoPostActionResult');
  container.innerHTML = '<div class="empty-state">Generating content calendar...</div>';

  const result = await fetchJSON(`/api/seo/calendar/${auditId}`, { method: 'POST', body: {} });
  if (!result.ok) { container.innerHTML = `<div class="empty-state" style="color:var(--error);">${result.error || 'Failed'}</div>`; return; }

  container.innerHTML = `
    <h4 style="margin-bottom:12px;">12-Week Content Calendar for ${escapeHtml(result.domain)}</h4>
    <div class="seo-calendar">
      ${result.weeks.map(w => `
        <div class="seo-calendar-week">
          <div class="seo-calendar-week-label">${escapeHtml(w.week)}</div>
          <div class="seo-calendar-items">
            ${w.items.map(item => `
              <div class="seo-calendar-item seo-cal-${item.type}">
                <span class="seo-cal-type">${item.type}</span>
                <span class="seo-cal-title">${escapeHtml(item.title)}</span>
                <span class="seo-cal-effort">${item.effort}</span>
                <span class="seo-impact seo-impact-${item.priority}">${item.priority}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function seoOptimizeMeta(auditId) {
  const container = document.getElementById('seoPostActionResult');
  container.innerHTML = '<div class="empty-state">Optimizing meta tags...</div>';

  const result = await fetchJSON(`/api/seo/meta/${auditId}`, { method: 'POST', body: {} });
  if (!result.ok) { container.innerHTML = `<div class="empty-state" style="color:var(--error);">${result.error || 'Failed'}</div>`; return; }

  container.innerHTML = `
    <h4 style="margin-bottom:12px;">Optimized Meta Tags for ${escapeHtml(result.domain)} (${result.pages.length} pages)</h4>
    ${result.pages.map(p => `
      <div class="seo-meta-card">
        <div class="seo-meta-page">
          <strong>${escapeHtml(p.page)}</strong>
          <code>${escapeHtml(p.url)}</code>
        </div>
        <div class="seo-meta-comparison">
          <div class="seo-meta-before">
            <span class="seo-meta-label">Current Title</span>
            <div class="seo-meta-value seo-meta-old">${escapeHtml(p.currentTitle)}</div>
          </div>
          <div class="seo-meta-after">
            <span class="seo-meta-label">Optimized Title</span>
            <div class="seo-meta-value seo-meta-new">${escapeHtml(p.optimizedTitle)}</div>
          </div>
        </div>
        <div class="seo-meta-comparison">
          <div class="seo-meta-before">
            <span class="seo-meta-label">Current Description</span>
            <div class="seo-meta-value seo-meta-old">${p.currentDesc ? escapeHtml(p.currentDesc) : '<em>Missing</em>'}</div>
          </div>
          <div class="seo-meta-after">
            <span class="seo-meta-label">Optimized Description</span>
            <div class="seo-meta-value seo-meta-new">${escapeHtml(p.optimizedDesc)}</div>
          </div>
        </div>
        <div class="seo-meta-changes">
          <strong>Changes:</strong> ${p.changes.map(c => `<span class="seo-meta-change">${escapeHtml(c)}</span>`).join('')}
        </div>
      </div>
    `).join('')}
  `;
}

async function deleteSeoAudit(auditId) {
  const result = await fetchJSON(`/api/seo/audit/${auditId}`, { method: 'DELETE' });
  if (result.ok) {
    loadSeoAgency();
    showSettingsToast('Audit deleted');
  }
}
