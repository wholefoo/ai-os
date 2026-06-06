// enterprise/sso.js — SSO configuration stubs (SAML/OIDC ready)
// Enterprise-only feature: Single Sign-On integration

module.exports = {
  configure: (app, ctx) => {
    if (ctx.activeTier !== 'enterprise') return;

    app.get('/api/sso/config', ctx.requireTier('enterprise'), (req, res) => {
      res.json({
        enabled: false,
        providers: [],
        message: 'SSO is available on the Enterprise plan. Contact support to configure SAML or OIDC.',
      });
    });

    console.log('[ENTERPRISE] SSO endpoints registered');
  },
};
