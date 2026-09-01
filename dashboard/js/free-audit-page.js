// Externalised from an inline <script> block in free-audit.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

// Local copy: free-audit.html does NOT load app.js, so the dashboard's escapeHtml is not in scope
// here. Same implementation deliberately — it escapes quotes as well as angle brackets, because the
// values below land in an href="..." attribute as well as in text.
//
// This page is PUBLIC and unauthenticated, which is why it gets the escaping even though the two
// values are server-constants today: /api/seo/free-audit returns fixed strings for every error path
// it currently has. The moment one of them echoes the submitted URL back — the obvious next edit —
// this becomes reflected XSS on the most-visited page on the site.
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function startFreeAudit() {
      const domain = document.getElementById('faDomain').value.trim();
      const email = document.getElementById('faEmail').value.trim();
      const name = document.getElementById('faName').value.trim();
      const btn = document.getElementById('faSubmit');

      if (!domain) { alert('Please enter a domain'); return; }
      if (!email) { alert('Email is required to use your free monthly audit'); return; }

      btn.disabled = true;
      btn.textContent = 'Starting audit...';

      const res = await fetch('/api/seo/free-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, email, name }),
      });
      const data = await res.json();

      if (!data.ok) {
        btn.disabled = false;
        btn.textContent = 'Run Free SEO Audit';
        if (data.upgradeUrl) {
          document.getElementById('auditResult').innerHTML = `<div class="audit-upgrade"><h3>Monthly Limit Reached</h3><p>${escapeHtml(data.error)}</p><a href="${escapeHtml(data.upgradeUrl)}" class="audit-submit" style="display:inline-block;width:auto;padding:12px 28px;">View Plans</a></div>`;
          document.getElementById('auditResult').style.display = 'block';
        } else {
          alert(data.error);
        }
        return;
      }

      // Track conversion
      if (typeof gtag === 'function') gtag('event', 'free_audit_started', { event_category: 'conversion', event_label: email });

      // Show running state
      document.getElementById('auditForm').style.display = 'none';
      document.getElementById('auditRunning').style.display = 'block';

      // Animate agents
      const agents = ['keyword', 'technical', 'competitor', 'content', 'backlink', 'aeo'];
      agents.forEach((a, i) => {
        setTimeout(() => {
          const el = document.getElementById('fa-' + a);
          if (el) el.classList.add('running');
        }, i * 500);
      });

      // Poll for completion
      const auditId = data.auditId;
      let progress = 10;
      const fill = document.getElementById('faProgressFill');
      const label = document.getElementById('faProgressLabel');

      const pollInterval = setInterval(async () => {
        progress = Math.min(progress + 5, 90);
        fill.style.width = progress + '%';

        try {
          const r = await fetch('/api/seo/free-audit/' + auditId);
          const audit = await r.json();

          // Update agent statuses
          agents.forEach(a => {
            const agentData = audit.agents?.[a];
            const el = document.getElementById('fa-' + a);
            if (el && (agentData?.status === 'complete' || agentData?.score != null)) {
              el.classList.remove('running');
              el.classList.add('complete');
            }
          });

          if (audit.status === 'complete') {
            clearInterval(pollInterval);
            fill.style.width = '100%';
            label.textContent = 'Audit complete!';

            setTimeout(() => {
              document.getElementById('auditRunning').style.display = 'none';
              renderFreeResult(audit);
            }, 800);
          } else {
            const doneCount = agents.filter(a => audit.agents?.[a]?.status === 'complete' || audit.agents?.[a]?.score != null).length;
            label.textContent = `${doneCount}/${agents.length} agents complete...`;
          }
        } catch {}
      }, 2000);

      // Timeout after 90 seconds
      setTimeout(() => { clearInterval(pollInterval); }, 90000);
    }

    function renderFreeResult(audit) {
      const scoreClass = audit.compositeScore >= 75 ? 'score-good' : audit.compositeScore >= 50 ? 'score-warn' : 'score-bad';
      const agents = audit.agents || {};
      // Only dimensions that actually ran get a card. A skipped one (Local SEO in demo mode, or a
      // dimension that does not apply to this site) has no score, and the card below renders
      // `data.score || '?'` in the critical-red class — which reads to a lead as a failing grade for
      // something nobody measured. Filtered on the STATUS rather than on the dimension's name, so a
      // future skipped dimension is handled without anyone remembering this line exists.
      const agentCards = Object.entries(agents).filter(([, data]) => data && data.status === 'complete').map(([name, data]) => {
        const sc = (data.score || 0) >= 75 ? 'score-good' : (data.score || 0) >= 50 ? 'score-warn' : 'score-bad';
        // EVERY value below is LLM output derived from a user-supplied domain — and the audit agents
        // CRAWL that domain, so text from an attacker's own page (title, meta, headings) reaches
        // these findings. `sc` and `scoreClass` are computed literals and are the only safe ones.
        return `<div class="audit-agent-result">
          <div class="audit-agent-result-score ${sc}">${escapeHtml(data.score || '?')}</div>
          <div class="audit-agent-result-name">${escapeHtml(name)}</div>
          ${data.topFinding ? `<div class="audit-finding-peek">${escapeHtml(data.topFinding.severity)}: ${escapeHtml((data.topFinding.issue || '').substring(0, 60))}...</div>` : ''}
        </div>`;
      }).join('');

      // `impact` lands in a CLASS ATTRIBUTE as well as in text, which is why escapeHtml here escapes
      // quotes too — an unescaped quote would break out of class="…" and add arbitrary attributes.
      const wins = (audit.quickWins || []).slice(0, 4).map(w =>
        `<div class="audit-win"><span class="audit-win-num">${escapeHtml(w.priority)}</span><span>${escapeHtml(w.action)}</span><span class="audit-win-impact impact-${escapeHtml(w.impact)}">${escapeHtml(w.impact)}</span></div>`
      ).join('');

      const estimateNotice = audit.estimated ? `
        <div class="audit-estimate-notice">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          <span>This is a preliminary, directional estimate — not a live search-data crawl. Scores may shift once the full audit runs against real ranking data.</span>
        </div>` : '';

      const el = document.getElementById('auditResult');
      el.innerHTML = `
        ${estimateNotice}
        <div class="audit-score">
          <div class="audit-score-num ${scoreClass}">${escapeHtml(audit.compositeScore || 0)}</div>
          <div class="audit-score-label">Composite SEO Score out of 100</div>
        </div>

        <div class="audit-summary">${escapeHtml(audit.executiveSummary || 'Audit complete.')}</div>

        <div class="audit-agents-result">${agentCards}</div>

        ${wins ? `<div class="audit-wins"><h3>Quick Wins</h3>${wins}</div>` : ''}

        <div class="audit-upgrade">
          <h3>Want the Full Report?</h3>
          <p>Upgrade for all findings, content briefs, 12-week action calendar, and optimized meta tags for every page.</p>
          <a href="/#pricing" class="audit-submit" style="display:inline-block;width:auto;padding:12px 28px;">View Plans — Community Edition Free</a>
        </div>

        <div style="text-align:center;margin-top:16px;">
          <a href="/free-audit" style="color:var(--text-muted);font-size:13px;">Run another audit (next month)</a>
        </div>
      `;
      el.style.display = 'block';

      if (typeof gtag === 'function') gtag('event', 'free_audit_complete', { event_category: 'conversion', value: audit.compositeScore });
    }
