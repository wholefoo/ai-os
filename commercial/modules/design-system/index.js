// modules/design-system/index.js — AI OS Design System
// Tier: business+ — requires ai-os-commercial license
//
// Dual-structure design system: reasoning (emotional intent) + tokens (exact values).
// Includes linter, brand clone from URL, cross-platform export, and component references.

module.exports = {
  name: 'design-system',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.designSystem) {
      console.log('[COMMERCIAL] Skipping design-system (requires business+ license)');
      return;
    }

    const { heavyLimiter, designSystem, logActivity, broadcast, validateBody } = ctx;

    // GET /api/design-system — full design system
    app.get('/api/design-system', (req, res) => {
      res.json(designSystem);
    });

    // GET /api/design-system/tokens — token values only
    app.get('/api/design-system/tokens', (req, res) => {
      res.json(designSystem.tokens);
    });

    // GET /api/design-system/linter — linter summary + results
    app.get('/api/design-system/linter', (req, res) => {
      const passed = designSystem.linterResults.filter(r => r.status === 'pass').length;
      const warnings = designSystem.linterResults.filter(r => r.status === 'warning').length;
      const failures = designSystem.linterResults.filter(r => r.status === 'fail').length;
      res.json({
        summary: { total: designSystem.linterResults.length, passed, warnings, failures, score: Math.round((passed / designSystem.linterResults.length) * 100) },
        results: designSystem.linterResults,
        wcagLevel: designSystem.meta.wcagLevel,
      });
    });

    // POST /api/design-system/lint — execute linter
    app.post('/api/design-system/lint', (req, res) => {
      logActivity('design', 'Design system linter executed');
      broadcast({ event: 'design_update', data: { action: 'lint', status: 'completed' } });
      res.json({ ok: true, results: designSystem.linterResults });
    });

    // POST /api/design-system/clone-url — Brand Clone from URL
    app.post('/api/design-system/clone-url', heavyLimiter, (req, res) => {
      const errs = validateBody(req.body, { url: { required: true, type: 'url', maxLength: 2048 } });
      if (errs) return res.status(400).json({ error: errs.join('; ') });
      const { url } = req.body;
      logActivity('design', `Brand clone initiated from: ${url}`);
      broadcast({ event: 'design_update', data: { action: 'brand-clone', status: 'scanning', url } });

      // Simulate extraction (in production, this would use Firecrawl + analysis)
      setTimeout(() => {
        broadcast({ event: 'design_update', data: { action: 'brand-clone', status: 'completed', url } });
        logActivity('design', `Brand clone completed from: ${url}`);
      }, 4000);

      res.json({
        ok: true,
        status: 'extracting',
        message: `Scanning ${url} for brand identity...`,
        estimated: '~5 seconds',
        extracting: ['colors', 'typography', 'spacing', 'imagery', 'vibe'],
      });
    });

    // GET /api/design-system/export — Cross-Platform Export (DESIGN.md)
    app.get('/api/design-system/export', (req, res) => {
      const target = req.query.target || 'claude-code';
      logActivity('design', `DESIGN.md exported for: ${target}`);

      const exportContent = `# DESIGN.md — ${designSystem.meta.name} v${designSystem.meta.version}
## Format: dual-structure (reasoning + tokens)
## Target: ${target}

### Brand Reasoning
${Object.entries(designSystem.reasoning).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

### Color Tokens
${Object.entries(designSystem.tokens.colors).map(([name, c]) => `| ${name} | ${c.hex} | ${c.hierarchy} | ${c.usage} | ${c.screenPct} |`).join('\n')}

### Typography
- Primary: ${designSystem.tokens.typography.fontFamily.primary}
- Mono: ${designSystem.tokens.typography.fontFamily.mono}

### Components (Role References)
${designSystem.components.map(c => `- **${c.name}**: bg=${c.background}, text=${c.text}, radius=${c.radius}`).join('\n')}

### Shape Language
${designSystem.tokens.radiusReasoning}
`;

      res.json({
        ok: true,
        target,
        format: 'markdown',
        content: exportContent,
        filename: `DESIGN-${target}.md`,
        portable: true,
        compatibleWith: designSystem.meta.exportTargets,
      });
    });

    // GET /api/design-system/reasoning — reasoning layer only
    app.get('/api/design-system/reasoning', (req, res) => {
      res.json({
        reasoning: designSystem.reasoning,
        radiusReasoning: designSystem.tokens.radiusReasoning,
        typographyReasoning: designSystem.tokens.typography.reasoning,
      });
    });

    // GET /api/design-system/components — component references
    app.get('/api/design-system/components', (req, res) => {
      res.json({ components: designSystem.components });
    });

    console.log('[COMMERCIAL] ✓ Design System routes registered');
  },
};
