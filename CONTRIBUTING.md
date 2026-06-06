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

### Open-Core Structure

```
ai-os/                    ← Public repo (Community edition)
├── server.js             ← Core server with requireCommercial() gates
├── commercial/
│   ├── loader.js         ← Detects commercial module
│   └── README.md         ← Installation docs
├── dashboard/            ← Frontend
└── .github/              ← CI + PR template

ai-os-commercial/         ← Private repo (Business/Enterprise)
├── index.js              ← License validation + module registration
├── lib/                  ← License validator, tier resolver, feature gate
├── modules/              ← 13 feature modules
├── org-chart/            ← Extended departments + agents
└── enterprise/           ← SSO, SLA, priority support
```

### Feature Gating

Routes gated with `requireCommercial('featureFlag')` return 403 in community mode.
The commercial module unlocks them when a valid license key is present.

```javascript
// Community users get a clear upgrade message:
{
  "error": "This feature requires a Business or Enterprise license",
  "feature": "browserAgent",
  "currentTier": "community",
  "upgrade": "https://aiosorchestrationlab.com/#pricing"
}
```

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
