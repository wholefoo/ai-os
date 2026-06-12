# Contributing to AI OS

## Branch Workflow

All changes go through pull requests. Direct pushes to `master` are not allowed.

### Branch Naming

Use prefixed branch names:

| Prefix | Use for | Example |
|--------|---------|---------|
| `feature/` | New features or enhancements | `feature/agent-memory-v2` |
| `fix/` | Bug fixes | `fix/websocket-reconnect` |
| `refactor/` | Code restructuring (no behavior change) | `refactor/extract-seo-module` |
| `docs/` | Documentation or content updates | `docs/api-reference` |
| `infra/` | CI, deployment, config changes | `infra/add-docker-healthcheck` |

### Workflow

```
1. Create branch    →  git checkout -b feature/my-change
2. Make changes     →  commit with clear messages
3. Push branch      →  git push -u origin feature/my-change
4. Open PR          →  gh pr create (fills template automatically)
5. CI runs          →  lint, boot check, security audit
6. Review + merge   →  squash merge into master
7. Deploy           →  SSH to VPS, git pull, pm2 restart
```

### Commit Messages

Write commits that explain **why**, not just what:

```
# Good
Add feature gates to commercial routes so community edition restricts paid features

# Bad
Update server.js
```

For multi-line commits:
```
Short summary (under 72 chars)

Longer explanation of what changed and why. Include context
that would help someone reading this 6 months from now.
```

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Fill out the PR template completely
- Make sure `npm test` passes before requesting review
- Include deployment notes if adding env vars or dependencies

## Architecture Notes

### Open-Core Structure (Single Repo)

The entire platform lives in one private repo. License validation gates commercial features at runtime.

```
ai-os/
├── server.js             ← Core server (~6,900 lines), all data structures & helpers
├── commercial/
│   ├── index.js          ← License validation + module loader
│   ├── loader.js         ← Graceful fallback when no license key
│   ├── lib/              ← license-validator, tier-resolver, feature-gate
│   ├── modules/          ← 12 feature modules (each exports registerRoutes)
│   │   ├── creative-studio/
│   │   ├── advanced-reporting/
│   │   ├── lead-gen/
│   │   ├── hermes-advanced/
│   │   ├── seo-unlimited/
│   │   ├── self-improving/
│   │   ├── video-meetings/
│   │   ├── grok-intel/
│   │   ├── browser-agent/
│   │   ├── youtube-intel/
│   │   ├── design-system/
│   │   └── agent-builder/
│   ├── org-chart/        ← Extended departments + agents
│   └── enterprise/       ← SSO, SLA, priority support (stubs)
├── dashboard/            ← Frontend SPA
├── .github/              ← CI + PR template
└── ecosystem.config.js   ← PM2 deployment config
```

### Commercial Module Pattern

Each module in `commercial/modules/*/index.js` exports:

```javascript
module.exports = {
  name: 'module-name',
  tier: 'business',  // or 'enterprise'
  registerRoutes(app, ctx) {
    // ctx provides ~70 shared globals from server.js
    // (middleware, data structures, helpers, AI callers, etc.)
    if (!ctx.features.featureFlag) return;
    app.get('/api/...', (req, res) => { ... });
  }
};
```

### Feature Gating

The `requireCommercial('featureFlag')` middleware on core routes returns 403 in community mode.
Commercial modules check `ctx.features` internally and skip registration if tier is insufficient.

```javascript
// Community users get a clear upgrade message:
{
  "error": "This feature requires a Business or Enterprise license",
  "feature": "browserAgent",
  "currentTier": "community",
  "upgrade": "https://aiosorchestrationlab.com/#pricing"
}
```

The dashboard also gates UI panels — locked features show a 🔒 icon and an upgrade modal on click.

### Testing Changes

```bash
# Syntax check
node --check server.js

# Full test suite
npm test

# Manual boot test
npm start
# → verify http://localhost:3000/api/health returns status
# → verify http://localhost:3000/api/hq/stats shows correct tier
```
