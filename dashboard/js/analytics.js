// dashboard/js/analytics.js
// ============================================================
//  Analytics dashboard view (admin-only). Globals from app.js: fetchJSON, escapeHtml, timeAgo.
//  Exposes loadAnalytics() + onAnalyticsEvent(msg). Data comes from /api/analytics/* (nginx-log
//  derived — the AI-crawler layer GA can't see); live rows arrive over SSE as 'web_analytics_bot'.
// ============================================================

const anState = { wired: false, days: 7, feed: [] };

function loadAnalytics() {
  if (!anState.wired) {
    anState.wired = true;
    const range = document.getElementById('anRange');
    if (range) range.addEventListener('change', () => { anState.days = parseInt(range.value, 10) || 7; anFetchAll(); });
    const refresh = document.getElementById('anRefresh');
    if (refresh) refresh.addEventListener('click', anFetchAll);
  }
  anFetchAll();
}

async function anFetchAll() {
  const [summary, crawlers, pages] = await Promise.all([
    fetchJSON(`/api/analytics/summary?days=${anState.days}`),
    fetchJSON(`/api/analytics/ai-crawlers?days=${anState.days}`),
    fetchJSON(`/api/analytics/pages?days=${anState.days}`),
  ]);
  if (summary && summary.ok) anRenderStats(summary);
  if (crawlers && crawlers.ok) {
    anState.feed = crawlers.recent || [];
    anRenderFeed();
    anRenderLeaderboard(crawlers.leaderboard || []);
  }
  if (pages && pages.ok) anRenderHeat(pages.crawlHeat || []);
  if (summary && summary.ok) anRenderRefs(summary.aiReferrers || [], summary.referrers || []);
}

function anRenderStats(s) {
  const el = document.getElementById('anStats');
  if (!el) return;
  const liveFetches = anState.feed.filter((e) => e.purpose === 'live').length;
  el.innerHTML = `
    <div class="an-stat"><div class="an-stat-value">${s.botHits}</div><div class="an-stat-label">AI crawler hits</div></div>
    <div class="an-stat"><div class="an-stat-value">${s.pageviews}</div><div class="an-stat-label">Human pageviews</div></div>
    <div class="an-stat"><div class="an-stat-value">${(s.aiReferrers || []).reduce((a, r) => a + r.count, 0)}</div><div class="an-stat-label">AI-referred visits</div></div>
    <div class="an-stat"><div class="an-stat-value">${liveFetches}</div><div class="an-stat-label">Live AI fetches (recent)</div></div>`;
}

function anRenderFeed() {
  const el = document.getElementById('anFeed');
  if (!el) return;
  if (!anState.feed.length) { el.innerHTML = '<div class="an-empty">No AI crawler activity recorded yet. If the site is behind Cloudflare, also check bot-fight settings aren&rsquo;t blocking the engines you want.</div>'; return; }
  el.innerHTML = anState.feed.slice(0, 50).map((e) => `
    <div class="an-feed-row">
      <strong>${escapeHtml(e.bot || e.engine || '?')}</strong>
      <span class="an-badge ${escapeHtml(e.purpose || '')}">${escapeHtml(e.purpose || '')}</span>
      <span class="an-path" title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</span>
      ${e.status && e.status >= 400 ? `<span class="an-badge" style="color:#f43f5e;border-color:#f43f5e;">${e.status}</span>` : ''}
      <span class="an-time">${timeAgo(e.ts)}</span>
    </div>`).join('');
}

function anRenderLeaderboard(rows) {
  const el = document.getElementById('anLeaderboard');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="an-empty">No AI engine hits in this range.</div>'; return; }
  el.innerHTML = rows.slice(0, 15).map((r) => `
    <div class="an-row">
      <span><strong>${escapeHtml(r.engine)}</strong> <span class="an-badge ${escapeHtml(r.purpose)}">${escapeHtml(r.purpose)}</span> <span style="color:var(--text-secondary,#9aa);font-size:11px;">${escapeHtml(r.bot)}</span></span>
      <span class="an-count">${r.count}</span>
    </div>`).join('');
}

function anRenderHeat(rows) {
  const el = document.getElementById('anHeat');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="an-empty">No AI page fetches in this range.</div>'; return; }
  const max = rows[0].count || 1;
  el.innerHTML = rows.slice(0, 12).map((r) => `
    <div class="an-row">
      <span class="an-path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</span>
      <span style="flex:0 0 90px;display:flex;align-items:center;gap:6px;justify-content:flex-end;">
        <span style="height:6px;border-radius:3px;background:var(--brand,#4f46e5);width:${Math.max(6, Math.round((r.count / max) * 60))}px;"></span>
        <span class="an-count">${r.count}</span>
      </span>
    </div>`).join('');
}

function anRenderRefs(aiRefs, refClasses) {
  const el = document.getElementById('anRefs');
  if (!el) return;
  if (!aiRefs.length) {
    const total = refClasses.reduce((a, r) => a + r.count, 0);
    const totalNote = total > 0 ? ` (of ${Number(total)} classified visits)` : '';
    el.innerHTML = `<div class="an-empty">No answer-engine referrals in this range${escapeHtml(totalNote)}.</div>`;
    return;
  }
  el.innerHTML = aiRefs.map((r) => `
    <div class="an-row"><span><strong>${escapeHtml(r.engine)}</strong></span><span class="an-count">${r.count}</span></div>`).join('');
}

// SSE: prepend live bot hits when the view is open; cheap re-render of feed + top stats only.
function onAnalyticsEvent(msg) {
  const view = document.getElementById('view-analytics');
  if (!view || !view.classList.contains('active')) return;
  if (msg.event === 'web_analytics_bot' && msg.data) {
    anState.feed.unshift(msg.data);
    if (anState.feed.length > 100) anState.feed.length = 100;
    anRenderFeed();
  }
}
