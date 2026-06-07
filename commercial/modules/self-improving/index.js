// modules/self-improving/index.js — Self-improving platform capabilities
// Tier: enterprise — requires ai-os-commercial license
//
// Self-improvement proposals, auto-apply execution engine, Telegram/Slack
// approval workflows, and automated improvement checks.

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'self-improving',
  tier: 'enterprise',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.selfImproving) {
      console.log('[COMMERCIAL] Skipping self-improving (requires enterprise license)');
      return;
    }

    const { requireAdmin, broadcast, logActivity, uuidv4, saveState,
            pendingApprovals, settings, PROPOSAL_TYPES, BLOCKED_PATHS, SAFE_OPERATIONS,
            applyProposal, sendTelegramApproval, sendTelegramMessage,
            sendSlackApproval, sendSlackMessage,
            BASE, CLAUDE_DIR, OPUS_MODEL } = ctx;

    // POST /api/platform/propose — create a self-improvement proposal
    app.post('/api/platform/propose', requireAdmin, (req, res) => {
      const { type, title, description, diff, autoApply } = req.body;
      if (!type || !title) return res.status(400).json({ error: 'Type and title required' });

      const proposalType = PROPOSAL_TYPES[type] || { icon: '📋', label: type, risk: 'medium' };
      const proposal = {
        id: uuidv4(),
        type,
        typeLabel: proposalType.label,
        icon: proposalType.icon,
        risk: proposalType.risk,
        title,
        description: description || '',
        diff: diff || null,
        autoApply: autoApply || false,
        status: 'pending', // pending → approved → applied | rejected | expired
        createdAt: new Date().toISOString(),
        respondedAt: null,
        appliedAt: null,
        respondedVia: null, // telegram, slack, dashboard
        response: null,
      };

      pendingApprovals.push(proposal);
      saveState('pending_approvals', pendingApprovals);

      // Send to Telegram if configured
      sendTelegramApproval(proposal);
      // Send to Slack if configured
      sendSlackApproval(proposal);

      broadcast({ event: 'platform_proposal', data: proposal });
      logActivity('platform', `Self-improvement proposed: ${title}`, { id: proposal.id, type, risk: proposalType.risk });

      res.json({ ok: true, proposal });
    });

    // GET /api/platform/proposals — list all proposals
    app.get('/api/platform/proposals', requireAdmin, (req, res) => {
      res.json(pendingApprovals);
    });

    // PUT /api/platform/proposals/:id — approve or reject
    app.put('/api/platform/proposals/:id', requireAdmin, async (req, res) => {
      const proposal = pendingApprovals.find(p => p.id === req.params.id);
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

      const { status, response } = req.body;
      if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be approved or rejected' });

      proposal.status = status;
      proposal.respondedAt = new Date().toISOString();
      proposal.respondedVia = 'dashboard';
      proposal.response = response || null;

      if (status === 'approved' && proposal.autoApply) {
        const applyResult = await applyProposal(proposal);
        if (applyResult.success) {
          proposal.status = 'applied';
          proposal.appliedAt = new Date().toISOString();
          proposal.applyResult = applyResult;
          logActivity('platform', `Auto-applied: ${proposal.title}`, { id: proposal.id, steps: applyResult.steps });
          sendTelegramMessage(`✅ Auto-applied: ${proposal.title}\nSteps: ${applyResult.steps.map(s => s.action).join(' → ')}`);
        } else {
          proposal.status = 'approved'; // stays approved but not applied
          proposal.applyResult = applyResult;
          logActivity('platform', `Auto-apply failed: ${proposal.title}`, { id: proposal.id, steps: applyResult.steps });
          sendTelegramMessage(`⚠️ Auto-apply failed: ${proposal.title}\nReason: ${applyResult.steps.map(s => s.reason || s.warning || s.action).join(', ')}`);
        }
      }

      saveState('pending_approvals', pendingApprovals);
      broadcast({ event: 'platform_proposal_responded', data: { id: proposal.id, status: proposal.status } });

      // Notify via Telegram/Slack
      const emoji = status === 'approved' ? '✅' : '❌';
      sendTelegramMessage(`${emoji} Proposal ${status}: ${proposal.title}`);
      sendSlackMessage(`${emoji} Proposal ${status}: ${proposal.title}`);

      res.json({ ok: true, proposal });
    });

    // POST /api/platform/proposals/:id/apply — manually trigger apply on an approved proposal
    app.post('/api/platform/proposals/:id/apply', requireAdmin, async (req, res) => {
      const proposal = pendingApprovals.find(p => p.id === req.params.id);
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      if (proposal.status !== 'approved') return res.status(400).json({ error: `Cannot apply — status is "${proposal.status}", must be "approved"` });

      const applyResult = await applyProposal(proposal);
      if (applyResult.success) {
        proposal.status = 'applied';
        proposal.appliedAt = new Date().toISOString();
        proposal.applyResult = applyResult;
        saveState('pending_approvals', pendingApprovals);
        logActivity('platform', `Manually applied: ${proposal.title}`, { id: proposal.id, steps: applyResult.steps });
        sendTelegramMessage(`✅ Applied: ${proposal.title}`);
        res.json({ ok: true, proposal, applyResult });
      } else {
        proposal.applyResult = applyResult;
        saveState('pending_approvals', pendingApprovals);
        res.json({ ok: false, error: 'Apply failed', applyResult });
      }
    });

    // GET /api/platform/stats — self-improvement stats
    app.get('/api/platform/stats', requireAdmin, (req, res) => {
      const byStatus = {};
      const byType = {};
      pendingApprovals.forEach(p => {
        byStatus[p.status] = (byStatus[p.status] || 0) + 1;
        byType[p.type] = (byType[p.type] || 0) + 1;
      });
      res.json({ total: pendingApprovals.length, byStatus, byType });
    });

    // POST /api/platform/telegram-webhook — receive Telegram bot responses
    app.post('/api/platform/telegram-webhook', async (req, res) => {
      const update = req.body;
      const text = update?.message?.text || '';
      const chatId = String(update?.message?.chat?.id || '');

      // Verify this is from our configured chat
      const configuredChat = String(settings.notifications?.telegram_chat_id || '');
      if (!configuredChat || chatId !== configuredChat) return res.json({ ok: true });

      // Parse /approve or /reject commands
      const approveMatch = text.match(/\/approve\s+(\S+)/i);
      const rejectMatch = text.match(/\/reject\s+(\S+)/i);

      if (approveMatch || rejectMatch) {
        const isApprove = !!approveMatch;
        const shortId = (approveMatch || rejectMatch)[1];
        const proposal = pendingApprovals.find(p => p.id.startsWith(shortId) && p.status === 'pending');

        if (proposal) {
          proposal.status = isApprove ? 'approved' : 'rejected';
          proposal.respondedAt = new Date().toISOString();
          proposal.respondedVia = 'telegram';

          if (isApprove && proposal.autoApply) {
            const applyResult = await applyProposal(proposal);
            if (applyResult.success) {
              proposal.status = 'applied';
              proposal.appliedAt = new Date().toISOString();
              proposal.applyResult = applyResult;
            }
          }

          saveState('pending_approvals', pendingApprovals);
          broadcast({ event: 'platform_proposal_responded', data: { id: proposal.id, status: proposal.status } });
          logActivity('platform', `Proposal ${proposal.status} via Telegram: ${proposal.title}`, { id: proposal.id });

          const emoji = isApprove ? '✅' : '❌';
          sendTelegramMessage(`${emoji} <b>${proposal.title}</b> — ${proposal.status}${proposal.status === 'applied' ? ' and auto-applied' : ''}`);
        } else {
          sendTelegramMessage(`⚠️ No pending proposal found matching: ${shortId}`);
        }
      }

      res.json({ ok: true });
    });

    console.log('[COMMERCIAL] ✓ Self-Improving routes registered');
  },
};
