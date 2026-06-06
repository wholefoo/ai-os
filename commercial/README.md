# Commercial Modules

This directory is the mount point for AI OS commercial modules (Business and Enterprise licenses).

## Community Edition

You're running the **Community edition** — free and open-source with 15 AI agents across 5 departments. No commercial module is required.

## Upgrading to Business or Enterprise

1. Purchase a license at [aiosorchestrationlab.com](https://aiosorchestrationlab.com)
2. You'll receive access to the private `ai-os-commercial` repository and a license key
3. Install the commercial module:

```bash
# Option A: Clone into commercial/modules/
git clone https://github.com/wholefoo/ai-os-commercial.git commercial/modules

# Option B: npm install (if published to private registry)
npm install ai-os-commercial

# Option C: Set a custom path
export AIOS_COMMERCIAL_PATH=/path/to/ai-os-commercial
```

4. Add your license key to `.env`:

```
AIOS_LICENSE_KEY=AIOS-BIZ-XXXXXXXX-XXXXXXXX-XXXX
```

5. Restart the server. You'll see:

```
[COMMERCIAL] Loaded commercial module from: commercial/modules
[LICENSE] Active tier: business
[LICENSE] 51 agents, 10 departments loaded
```

## License Tiers

| Tier | Price | Agents | Departments | Key Features |
|------|-------|--------|-------------|--------------|
| Community | Free | 15 | 5 | Core platform, SEO (1 audit/mo), open-source |
| Business | $1,997 one-time | 51 | 10 | White-label, multi-tenant, Creative Studio, unlimited SEO |
| Enterprise | $4,997 one-time | 51 | 10 | Everything in Business + 1 year priority support, custom agents, SLA |
