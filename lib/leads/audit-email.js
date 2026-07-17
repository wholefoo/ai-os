// lib/leads/audit-email.js — turn a COMPLETED SEO/AEO audit into a lead-facing email.
//
// The outreach door-opener: run a real audit on a prospect's site (the existing 6-agent
// pipeline), then send them the headline findings as a clean, personal email with a CTA.
// Rendering is DETERMINISTIC — pure templating over the audit record, no LLM call, so every
// send costs zero tokens and the content is predictable enough to trust unreviewed.
// Compliance (unsubscribe link/footer) is appended by lib/email itself, not here.

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const AGENT_LABELS = {
  technical: 'Technical SEO', content: 'Content', keyword: 'Keywords',
  backlink: 'Backlinks', competitor: 'Competitive position', aeo: 'AI-search readiness (AEO)',
  local: 'Local SEO / Google Business Profile',
};

function scoreWord(n) {
  if (n == null) return 'not measured';
  if (n >= 75) return 'strong';
  if (n >= 50) return 'needs work';
  return 'weak';
}

// Pick the 3 lowest-scoring areas — the ones worth an email — plus the AEO angle if weak
// (it's the differentiator nobody else is pitching them on).
function worstAreas(audit, n = 3) {
  return Object.entries(audit.agents || {})
    .filter(([, a]) => a && typeof a.score === 'number')
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, n)
    .map(([key, a]) => ({ key, label: AGENT_LABELS[key] || key, score: a.score }));
}

function validateAuditForEmail(audit) {
  const errs = [];
  if (!audit) return ['audit not found'];
  if (audit.status !== 'complete') errs.push('audit is not complete yet');
  if (audit.compositeScore == null) errs.push('audit has no score');
  return errs;
}

// renderAuditLeadEmail(audit, { toName, businessName, replyPrompt }) -> { subject, text, html }
function renderAuditLeadEmail(audit, { toName = '', businessName = 'our team', replyPrompt = 'Just reply to this email and I\'ll walk you through the fixes — no obligation.' } = {}) {
  const domain = String(audit.domain || 'your website');
  const score = audit.compositeScore;
  const first = String(toName || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first},` : 'Hi,';
  const areas = worstAreas(audit);
  const wins = (audit.quickWins || []).slice(0, 3);
  const aeo = audit.agents?.aeo;

  const subject = `${domain}: your website scored ${score}/100 — here's what we found`;

  // ---- plain text ----
  const textParts = [
    hi,
    '',
    `We ran a full technical, content, and AI-search audit of ${domain}. The overall score came out at ${score}/100${score >= 75 ? ' — a solid foundation with room to pull ahead.' : score >= 50 ? ' — decent bones, but real opportunities are being left on the table.' : ' — there are significant issues costing you visibility and customers right now.'}`,
    '',
    'Where you stand:',
    ...areas.map((a) => `  • ${a.label}: ${a.score}/100 (${scoreWord(a.score)})`),
    ...(aeo && typeof aeo.score === 'number' && aeo.score < 60 ? ['', `Worth flagging: your AI-search readiness is ${aeo.score}/100. When people ask ChatGPT, Perplexity, or Google AI for a business like yours, your site is largely invisible to them today — that's where searches are moving.`] : []),
    ...(wins.length ? ['', 'Three fixes with immediate impact:', ...wins.map((w, i) => `  ${i + 1}. ${w.action} (~${w.time}, ${w.impact} impact)`)] : []),
    '',
    replyPrompt,
    '',
    `— ${businessName}`,
  ];
  const text = textParts.join('\n');

  // ---- html ----
  const scoreColor = score >= 75 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
  const areaRows = areas.map((a) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${esc(a.label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:${a.score >= 75 ? '#16a34a' : a.score >= 50 ? '#d97706' : '#dc2626'};">${a.score}/100</td>
    </tr>`).join('');
  const winRows = wins.map((w, i) => `<li style="margin:0 0 8px;">${esc(w.action)} <span style="color:#888;">(~${esc(w.time)}, ${esc(w.impact)} impact)</span></li>`).join('');
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;max-width:640px;margin:0 auto;padding:8px 4px;">
  <p style="margin:0 0 14px;line-height:1.55;">${esc(hi)}</p>
  <p style="margin:0 0 14px;line-height:1.55;">We ran a full technical, content, and AI-search audit of <b>${esc(domain)}</b>.</p>
  <div style="text-align:center;margin:18px 0;">
    <span style="display:inline-block;font-size:40px;font-weight:800;color:${scoreColor};">${esc(score)}<span style="font-size:18px;color:#888;">/100</span></span>
    <div style="font-size:12px;color:#888;">overall website health</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:0 0 14px;">${areaRows}</table>
  ${aeo && typeof aeo.score === 'number' && aeo.score < 60 ? `<p style="margin:0 0 14px;line-height:1.55;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;"><b>Worth flagging:</b> your AI-search readiness is ${esc(aeo.score)}/100. When people ask ChatGPT, Perplexity, or Google AI for a business like yours, your site is largely invisible to them today &mdash; and that's where searches are moving.</p>` : ''}
  ${wins.length ? `<p style="margin:0 0 6px;font-weight:700;">Three fixes with immediate impact:</p><ol style="margin:0 0 14px;padding-left:20px;line-height:1.5;">${winRows}</ol>` : ''}
  <p style="margin:0 0 14px;line-height:1.55;">${esc(replyPrompt)}</p>
  <p style="margin:0 0 14px;line-height:1.55;">&mdash; ${esc(businessName)}</p>
</div>`;

  return { subject, text, html };
}

module.exports = { renderAuditLeadEmail, validateAuditForEmail, worstAreas, scoreWord };
