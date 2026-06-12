# AI OS — Hosting Requirements & Provider Guide

## Minimum System Requirements

### Community Edition (Free)
- **CPU**: 1 vCPU
- **RAM**: 2 GB (4 GB recommended)
- **Storage**: 20 GB SSD
- **OS**: Ubuntu 22.04 or 24.04 LTS
- **Network**: Public IPv4, ports 80/443/22
- **Bandwidth**: 1 TB/month minimum

### Business / Enterprise Edition
- **CPU**: 2+ vCPU (4 recommended for heavy media/knowledge-graph use)
- **RAM**: 4 GB minimum (8 GB with n8n + media production)
- **Storage**: 40-80 GB SSD (depends on knowledge graph + media production usage)
- **OS**: Ubuntu 22.04 or 24.04 LTS
- **Network**: Public IPv4, ports 80/443/22
- **Bandwidth**: 2+ TB/month

### With n8n Workflow Automation
Add to the above:
- **RAM**: +1 GB
- **Storage**: +10 GB
- **Port**: 5678 (internal, proxied through Nginx)

## Software Stack
- Node.js 20 LTS
- PM2 process manager
- Nginx reverse proxy
- Let's Encrypt TLS (Certbot)
- UFW firewall
- Fail2ban intrusion prevention
- (Optional) n8n for workflow automation
- (Optional) Docker + Docker Compose

## VPS Provider Comparison

| Provider | Starting Price | CPU | RAM | Storage | Bandwidth | Data Centers | Pros | Cons | Best For |
|----------|---------------|-----|-----|---------|-----------|-------------|------|------|----------|
| Hetzner Cloud | ~$4.50/mo | 2 vCPU | 4 GB | 40 GB SSD | 20 TB | EU, US (Ashburn, Hillsboro) | Incredible price/performance, snapshots included, ARM option even cheaper | Smaller ecosystem, ticket-only support | Cost-conscious, EU businesses |
| DigitalOcean | $6/mo | 1 vCPU | 1 GB | 25 GB SSD | 1 TB | 15 locations globally | Excellent UI/UX, outstanding docs, managed DBs, App Platform | Premium pricing vs Hetzner, noisy-neighbor on basic plans | Developers who value simplicity |
| Linode (Akamai) | $5/mo | 1 core | 1 GB | 25 GB SSD | 1 TB | 11 locations globally | Consistent performance, Akamai CDN, included DDOS protection | UI less polished, fewer managed services | Performance-focused deployments |
| Vultr | $5/mo | 1 vCPU | 1 GB | 25 GB SSD | 1 TB | 32 locations globally | Most data centers of any provider, bare metal, hourly billing | Bandwidth overages expensive, support varies | Global deployments, edge presence |
| Hostinger VPS | $5.99/mo | 1 vCPU | 4 GB | 50 GB SSD | 1 TB | US, EU, Asia, South America | Cheap for specs, KVM, weekly backups included | Limited data centers, no API, less developer-focused | Budget deployments, beginners |
| Contabo | ~$5.50/mo | 4 vCPU | 8 GB | 50 GB SSD | 32 TB | US, EU, Asia, Australia | Unbeatable RAM/dollar ratio | Inconsistent disk I/O, oversold infra, limited support | Lots of RAM cheaply, non-critical workloads |
| AWS Lightsail | $5/mo | 1 vCPU | 1 GB | 40 GB SSD | 2 TB | All AWS regions | Easy upgrade to full AWS, predictable pricing, snapshots | Less raw performance per dollar, ecosystem lock-in | Teams already in AWS |
| Oracle Cloud Free | $0 | 4 OCPU (ARM) | 24 GB | 200 GB | 10 TB | Many OCI regions | Extremely generous free tier, ARM is great for Node.js | Instances reclaimed if idle, confusing UI, ARM compat issues | Development/testing only |

### Provider Details

#### 1. Hetzner Cloud — Best value in Europe

- **Entry**: ~$4.50/mo (CX22: 2 vCPU, 4 GB, 40 GB SSD)
- **Recommended for AI OS**: CX22 at ~$4.50/mo or CX32 at ~$9.50/mo for heavier workloads
- **Pros**: Incredible price/performance ratio. EU data centers are ideal for GDPR compliance. Snapshots are included at no extra cost. ARM-based CAX line is even cheaper and runs Node.js perfectly. 20 TB bandwidth included on all plans.
- **Cons**: US data centers were only recently added (Ashburn and Hillsboro) so latency to US users is higher from EU locations. Smaller ecosystem compared to AWS/DO. Support is ticket-only, no live chat.
- **Best for**: Cost-conscious deployments, EU-based businesses, anyone who wants the most server for the least money.

#### 2. DigitalOcean — Developer-friendly, great docs

- **Entry**: $6/mo (1 vCPU, 1 GB, 25 GB SSD)
- **Recommended for AI OS**: $24/mo Regular Droplet (2 vCPU, 4 GB, 80 GB SSD)
- **Pros**: Excellent UI/UX that just works. Outstanding documentation and tutorials. Managed databases, load balancers, and Spaces (S3-compatible) available. App Platform for zero-config deploys. Generous bandwidth on all plans.
- **Cons**: Premium pricing compared to Hetzner (you pay for the polish). CPU on Basic Droplets can suffer from noisy-neighbor effects; upgrade to Premium Droplets for dedicated CPU.
- **Best for**: Developers who value simplicity and documentation. Teams that want managed services alongside their VPS.

#### 3. Linode (Akamai) — Balanced performance and price

- **Entry**: $5/mo (1 core, 1 GB, 25 GB SSD)
- **Recommended for AI OS**: $24/mo (2 cores, 4 GB, 80 GB SSD)
- **Pros**: Consistently good performance across all plans. Good global coverage with 11 data center locations. Akamai CDN integration is a natural fit. Included DDOS protection on all plans.
- **Cons**: UI is functional but less polished than DigitalOcean. Fewer managed services. Akamai acquisition has introduced some billing complexity.
- **Best for**: Performance-focused deployments where consistent CPU and network matter.

#### 4. Vultr — Global reach, hourly billing

- **Entry**: $5/mo (1 vCPU, 1 GB, 25 GB SSD)
- **Recommended for AI OS**: $24/mo (2 vCPU, 4 GB, 80 GB SSD)
- **Pros**: 32 data center locations worldwide, more than any other provider on this list. Bare metal options available for high-performance needs. Hourly billing means you only pay for what you use. High-Frequency Compute plans offer NVMe + 3GHz+ CPUs.
- **Cons**: Bandwidth overages can be expensive. Support quality varies. Fewer managed services than DO.
- **Best for**: Global deployments requiring edge presence, temporary/burst workloads with hourly billing.

#### 5. Hostinger VPS — Budget entry point

- **Entry**: $5.99/mo (1 vCPU, 4 GB, 50 GB SSD)
- **Pros**: Very competitive specs for the price. KVM virtualization (not OpenVZ). Includes weekly backups. Good onboarding for beginners with AI-assisted setup.
- **Cons**: Limited data center options. Not developer-focused (no robust API, limited CLI tools). Support quality is inconsistent. No Terraform/Pulumi provider.
- **Best for**: Budget deployments, solo operators getting started quickly who plan to migrate later.

#### 6. Contabo — Maximum RAM per dollar

- **Entry**: ~$5.50/mo (4 vCPU, 8 GB, 50 GB SSD)
- **Pros**: Unbeatable RAM-to-dollar ratio. The cheapest plan gives you 8 GB RAM, which is more than most providers offer at 3-4x the price. Good for memory-hungry workloads like running AI OS + n8n + knowledge graph processing simultaneously.
- **Cons**: Disk I/O is inconsistent and can be painfully slow. Network throughput is lower than advertised. Infrastructure is oversold. Support is minimal. No API for automation.
- **Best for**: When you need lots of RAM cheaply and can tolerate inconsistent performance. Non-critical or internal-only deployments.

#### 7. AWS Lightsail — AWS ecosystem entry point

- **Entry**: $5/mo (1 vCPU, 1 GB, 40 GB SSD)
- **Recommended for AI OS**: $20/mo (2 vCPU, 4 GB, 80 GB SSD)
- **Pros**: Easy upgrade path to full AWS (RDS, SQS, Lambda, etc.) when you outgrow Lightsail. Predictable monthly pricing unlike regular EC2. Integrated CDN and DNS. Snapshots included. AWS support tiers available.
- **Cons**: Less raw performance per dollar than alternatives. You are locked into the AWS ecosystem. Egress pricing becomes expensive at scale if you move beyond Lightsail.
- **Best for**: Teams already invested in AWS who want a simple starting point with a clear scale-out path.

#### 8. Oracle Cloud Free Tier — Free forever (with caveats)

- **Free**: ARM A1 Flex (4 OCPU, 24 GB RAM, 200 GB block storage) — genuinely free, not a trial
- **Pros**: Extremely generous free tier that has no time limit. ARM Ampere processors run Node.js very well. 24 GB RAM is more than enough for AI OS + n8n + anything else.
- **Cons**: Availability is luck-of-the-draw; free-tier instances are reclaimed if they sit idle for 7 days. The OCI console UI is confusing. ARM architecture causes compatibility issues with some native npm packages (most work fine, but check your dependencies). Not reliable enough for production.
- **Best for**: Development, testing, proof of concept, demos. Do not use for production workloads.

## Quick Recommendation

| Use Case | Recommended Provider | Plan | Monthly Cost |
|----------|---------------------|------|-------------|
| Testing / Development | Oracle Cloud | Free Tier ARM | $0 |
| Community Edition (solo) | Hetzner | CX22 | ~$4.50 |
| Community + n8n | DigitalOcean | Regular 4GB | $24 |
| Business | DigitalOcean | Regular 4GB | $24 |
| Business + heavy media | Hetzner | CX32 | ~$9.50 |
| Enterprise | DigitalOcean | Premium 8GB | $48 |
| Enterprise + n8n + media | Hetzner | CX42 | ~$18 |

**TL;DR**: If you want the best value, go with Hetzner. If you want the smoothest experience, go with DigitalOcean. If you want free, use Oracle Cloud for dev/test only.

## n8n Workflow Automation

### What is n8n?

n8n is an open-source workflow automation tool (like Zapier/Make, but self-hosted). AI OS integrates with n8n for:
- Scheduled agent tasks (cron-based content generation, SEO audits)
- Webhook-triggered workflows (lead capture -> agent processing -> notification)
- Multi-step pipelines (research -> draft -> review -> publish)
- External integrations (500+ nodes: Slack, Gmail, Sheets, CRM, etc.)

### Repository & Documentation

- **GitHub**: https://github.com/n8n-io/n8n
- **Documentation**: https://docs.n8n.io
- **Self-hosting guide**: https://docs.n8n.io/hosting/

### Installation (included in install-vps.sh --with-n8n)

The AI OS VPS setup script handles n8n installation automatically when you pass the `--with-n8n` flag:

```bash
sudo bash deploy/install-vps.sh yourdomain.com --with-n8n
```

This will:
1. Install n8n globally via npm
2. Create a PM2 process for n8n on port 5678
3. Add Nginx reverse proxy at `https://yourdomain.com/n8n/`
4. Configure N8N_WEBHOOK_BASE in your .env

> Also available: `--with-codex` installs the OpenAI Codex CLI configured as the cross-model verification engine (read-only `reviewer` profile + `/crossreview` prompt) for adversarial review panels. Requires `OPENAI_API_KEY` in `.env`. Headless calls must close stdin (`< /dev/null`).

### Manual Installation

If you prefer to set up n8n manually:

```bash
# Install n8n
npm install -g n8n

# Create data directory
sudo mkdir -p /opt/ai-os/.n8n
sudo chown aios:aios /opt/ai-os/.n8n

# Start with PM2
sudo -u aios N8N_PORT=5678 \
  N8N_PROTOCOL=https \
  N8N_HOST=yourdomain.com \
  N8N_PATH=/n8n/ \
  WEBHOOK_URL=https://yourdomain.com/n8n/ \
  N8N_USER_FOLDER=/opt/ai-os/.n8n \
  pm2 start n8n -- start

# Save PM2 process list
sudo -u aios pm2 save
```

### Connecting AI OS to n8n

1. In n8n, create a Webhook node as your workflow trigger
2. Copy the webhook URL (e.g., `https://yourdomain.com/n8n/webhook/abc123`)
3. In your AI OS `.env`, set:
   ```
   N8N_WEBHOOK_BASE=http://localhost:5678
   N8N_API_KEY=your-n8n-api-key-here
   ```
4. AI OS agents can now trigger n8n workflows via the automation bridge

### Example Workflows

**Daily SEO Audit Pipeline:**
```
Schedule Trigger (daily 6am) -> AI OS Webhook (run SEO audit) ->
Wait for results -> Format report -> Send via Gmail -> Post to Slack
```

**Lead Capture Automation:**
```
Webhook (form submission) -> AI OS agent (qualify lead) ->
IF qualified -> Add to CRM + Send follow-up email
ELSE -> Add to nurture list
```

**Content Publishing Pipeline:**
```
Manual Trigger -> AI OS (research topic) -> AI OS (draft article) ->
Google Docs (create draft) -> Slack (request review) ->
Wait for approval -> WordPress (publish)
```

## Domain & DNS Setup

Before running the install script, point your domain to your VPS:

1. Get your VPS IP address from the provider dashboard
2. In your DNS provider, create an A record:
   - **Name**: `@` (or subdomain like `app`)
   - **Type**: A
   - **Value**: Your VPS IP address
   - **TTL**: 300 (5 minutes during setup, increase to 3600 after everything works)
3. (Optional) Add a CNAME for `www`:
   - **Name**: `www`
   - **Type**: CNAME
   - **Value**: `yourdomain.com`
4. Wait for DNS propagation (usually 5-30 minutes)
5. Verify: `dig +short yourdomain.com` should return your VPS IP

## Post-Installation Checklist

- [ ] `.env` file configured with all required API keys
- [ ] Admin password hash generated and set
- [ ] TLS certificate obtained (`sudo certbot --nginx -d yourdomain.com`)
- [ ] PM2 restart with `--update-env` flag
- [ ] Health check: `curl https://yourdomain.com/api/health`
- [ ] Stripe webhook configured (if using paid tiers)
- [ ] Backup strategy in place (provider snapshots or custom)
- [ ] Monitoring alerts set up (UptimeRobot, BetterUptime, etc.)
- [ ] (Optional) n8n configured and first workflow tested
