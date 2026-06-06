# Commercial Modules

This directory contains the open-core licensing and feature module system. All code ships with the repo — features are unlocked via license key + signing secret.

## Community Edition (default)

Without a license key, you're running the **Community edition** — free with 15 AI agents across 5 departments. All commercial routes return 403 with an upgrade prompt.

## Activating Business or Enterprise

1. Set your signing secret and license key in `.env`:

```bash
AIOS_SIGNING_SECRET=your-private-signing-secret
AIOS_LICENSE_KEY=AIOS-BIZ-XXXXXXXX-XXXXXXXX-XXXX
```

2. Generate a license key (admin only — requires the signing secret):

```bash
# Business license
node -e "process.env.AIOS_SIGNING_SECRET='your-secret'; console.log(require('./commercial/lib/license-validator').generateLicenseKey('BIZ'))"

# Enterprise license
node -e "process.env.AIOS_SIGNING_SECRET='your-secret'; console.log(require('./commercial/lib/license-validator').generateLicenseKey('ENT'))"
```

3. Restart the server. You'll see:

```
[LICENSE] ✓ Valid BUSINESS license (issued 2026-06-06)
[COMMERCIAL] Loaded — BUSINESS license active
[HQ] Org chart loaded: 10 departments, 43 agents (business tier)
```

## How It Works

- `loader.js` — Loads `index.js` and falls back to community defaults if no valid key
- `index.js` — Resolves license key, validates it, exports tier/features/routes
- `lib/license-validator.js` — HMAC-SHA256 key generation and validation (requires `AIOS_SIGNING_SECRET` env var)
- `lib/tier-resolver.js` — Maps tiers to feature flags and limits
- `lib/feature-gate.js` — Express middleware factory for tier-based route gating
- `modules/` — 13 feature modules, each with `registerRoutes(app, ctx)`
- `org-chart/departments.js` — Additional departments and agents for paid tiers
- `enterprise/` — SSO, SLA, and priority support stubs

## License Tiers

| Tier | Price | Agents | Departments | Key Features |
|------|-------|--------|-------------|--------------|
| Community | Free | 15 | 5 | Core platform, SEO (1 audit/mo), open-source |
| Business | $1,997 one-time | 43 | 10 | Multi-tenant, Creative Studio, unlimited SEO, Grok Intel, lead gen |
| Enterprise | $4,997 one-time | 43 | 10 | Everything in Business + SSO, SLA, custom agents, 1yr priority support |

## Security

The signing secret (`AIOS_SIGNING_SECRET`) is the only thing protecting license key generation. Keep it private:

- Never commit it to version control
- Set it only in `.env` (which is gitignored) or your deployment's environment
- Without the secret, the code is fully visible but keys cannot be forged
