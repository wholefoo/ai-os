// enterprise/sla-config.js — SLA monitoring configuration
// Enterprise-only: uptime targets, response time commitments, escalation rules

module.exports = {
  defaults: {
    uptimeTarget: 99.9,
    responseTimeSla: {
      critical: '1 hour',
      high: '4 hours',
      medium: '24 hours',
      low: '72 hours',
    },
    escalationChain: ['support-lead', 'it-director', 'cto'],
  },

  configure: (app, ctx) => {
    if (ctx.activeTier !== 'enterprise') return;

    app.get('/api/sla/config', ctx.requireTier('enterprise'), (req, res) => {
      res.json(module.exports.defaults);
    });

    console.log('[ENTERPRISE] SLA config endpoints registered');
  },
};
