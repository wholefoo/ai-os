require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
const DEMO_MODE = process.env.DEMO_MODE !== 'false'; // default true until real APIs wired
const API_TOKEN = process.env.API_TOKEN || null;
const BASE = __dirname;
const MAGENT_DIR = path.join(BASE, '.magent');
const CLAUDE_DIR = path.join(BASE, '.claude');
const STATE_DIR = path.join(MAGENT_DIR, 'state');

// Ensure state directory exists for persistence
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// --- Multi-Tenant System ---
// Each franchise participant gets an isolated tenant with its own state, users, and config.
// The platform owner (you) is tenant 'master'. Franchise tenants are identified by subdomain or tenant header.

const TENANTS_DIR = path.join(MAGENT_DIR, 'tenants');
if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });

const MASTER_TENANT_ID = 'master';

// Tenant registry — loaded from disk, maps tenantId to config
const tenantRegistry = loadState('tenant_registry', {
  [MASTER_TENANT_ID]: {
    id: MASTER_TENANT_ID,
    name: 'AI OS Corp',
    domain: process.env.PRIMARY_DOMAIN || 'aiosorchestrationlab.com',
    subdomain: null,
    ownerId: process.env.ADMIN_EMAIL || 'wholefoo@gmail.com',
    plan: 'enterprise',
    status: 'active',
    branding: {
      companyName: 'AI OS Corp',
      tagline: 'The Agentic Operating System',
      logo: null,
      primaryColor: '#3b82f6',
      accentColor: '#8b5cf6',
    },
    industry: null,
    template: null,
    createdAt: new Date().toISOString(),
    franchiseId: null,
  },
});

// Ensure each tenant has a state directory
function ensureTenantDir(tenantId) {
  const dir = path.join(TENANTS_DIR, tenantId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // Initialize empty state files
    ['users', 'settings', 'seo_audits', 'yt_analyses', 'franchises'].forEach(f => {
      const fp = path.join(dir, `${f}.json`);
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, f === 'users' ? '[]' : '{}');
    });
    console.log(`[TENANT] Created state directory for tenant: ${tenantId}`);
  }
  return dir;
}

// Tenant-scoped state read/write
function saveTenantState(tenantId, key, data) {
  try {
    if (tenantId === MASTER_TENANT_ID) return saveState(key, data);
    const dir = ensureTenantDir(tenantId);
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[TENANT] Failed to save ${key} for tenant ${tenantId}:`, e.message);
  }
}

function loadTenantState(tenantId, key, fallback) {
  if (tenantId === MASTER_TENANT_ID) return loadState(key, fallback);
  const defaults = typeof fallback === 'function' ? fallback() : fallback;
  try {
    const fp = path.join(TENANTS_DIR, tenantId, `${key}.json`);
    if (fs.existsSync(fp)) {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      // Deep-merge defaults
      if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
        for (const [section, vals] of Object.entries(defaults)) {
          if (typeof vals === 'object' && !Array.isArray(vals) && vals !== null) {
            if (!data[section]) data[section] = {};
            for (const [k, v] of Object.entries(vals)) {
              if (!(k in data[section])) data[section][k] = v;
            }
          } else if (!(section in data)) {
            data[section] = vals;
          }
        }
      }
      return data;
    }
  } catch (e) {
    console.error(`[TENANT] Failed to load ${key} for tenant ${tenantId}:`, e.message);
  }
  return defaults;
}

// Resolve tenant from request — checks subdomain, header, or defaults to master
function resolveTenant(req) {
  // 1. Explicit header (for API clients and testing)
  const headerTenant = req.headers['x-tenant-id'];
  if (headerTenant && tenantRegistry[headerTenant]) return tenantRegistry[headerTenant];

  // 2. Subdomain-based (franchise.aiosorchestrationlab.com)
  const host = req.hostname || req.headers.host || '';
  const primaryDomain = tenantRegistry[MASTER_TENANT_ID]?.domain || '';
  if (primaryDomain && host !== primaryDomain && host.endsWith(primaryDomain)) {
    const subdomain = host.replace(`.${primaryDomain}`, '');
    const tenant = Object.values(tenantRegistry).find(t => t.subdomain === subdomain && t.status === 'active');
    if (tenant) return tenant;
  }

  // 3. Custom domain mapping
  const byDomain = Object.values(tenantRegistry).find(t => t.domain === host && t.status === 'active');
  if (byDomain) return byDomain;

  // 4. Default to master
  return tenantRegistry[MASTER_TENANT_ID];
}

// Middleware: attach tenant to every request
app.use((req, res, next) => {
  req.tenant = resolveTenant(req);
  req.tenantId = req.tenant?.id || MASTER_TENANT_ID;
  next();
});

// --- Tenant Management API ---
// Note: routes are registered in registerTenantRoutes() after requireAdmin is defined

function registerTenantRoutes() {

// GET /api/tenants — list all tenants
app.get('/api/tenants', requireAdmin, (req, res) => {
  res.json(Object.values(tenantRegistry));
});

// GET /api/tenants/:id — single tenant detail
app.get('/api/tenants/:id', requireAdmin, (req, res) => {
  const tenant = tenantRegistry[req.params.id];
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json(tenant);
});

// POST /api/tenants — provision a new tenant (from franchise activation)
app.post('/api/tenants', requireAdmin, (req, res) => {
  const { name, subdomain, domain, ownerEmail, plan, industry, template, franchiseId, branding } = req.body;
  if (!name || !ownerEmail) return res.status(400).json({ error: 'Name and owner email required' });

  // Check subdomain uniqueness
  if (subdomain && Object.values(tenantRegistry).find(t => t.subdomain === subdomain)) {
    return res.status(400).json({ error: `Subdomain "${subdomain}" is already taken` });
  }

  const tenantId = uuidv4().substring(0, 12);
  const tenant = {
    id: tenantId,
    name,
    domain: domain || null,
    subdomain: subdomain || null,
    ownerId: ownerEmail,
    plan: plan || 'franchise',
    status: 'active',
    branding: {
      companyName: name,
      tagline: branding?.tagline || 'Powered by AI OS',
      logo: branding?.logo || null,
      primaryColor: branding?.primaryColor || '#3b82f6',
      accentColor: branding?.accentColor || '#8b5cf6',
    },
    industry: industry || null,
    template: template || null,
    createdAt: new Date().toISOString(),
    franchiseId: franchiseId || null,
  };

  // Create tenant directory and seed initial state
  ensureTenantDir(tenantId);

  // Seed tenant admin user
  const tenantUsers = [{
    email: ownerEmail,
    passwordHash: null, // Owner sets password on first login
    plan: 'franchise',
    role: 'admin',
    tenantId,
    createdAt: new Date().toISOString(),
  }];
  saveTenantState(tenantId, 'users', tenantUsers);

  // Seed tenant settings with defaults
  const tenantSettings = {
    ai: { anthropic_api_key: '', openai_api_key: '', deepseek_api_key: '', xai_api_key: '', gemini_api_key: '', perplexity_api_key: '', firecrawl_api_key: '', tavily_api_key: '', apify_api_token: '', manus_api_key: '' },
    mcp: { hermes_url: 'http://127.0.0.1:8420', hermes_enabled: false },
    notifications: { telegram_bot_token: '', telegram_chat_id: '', slack_webhook_url: '' },
    automation: { n8n_webhook_base: '', n8n_api_key: '', team_webhook_url: '' },
    stripe: { secret_key: '', webhook_secret: '', pro_price_id: '', business_price_id: '', enterprise_price_id: '' },
    seo: { dataforseo_login: '', dataforseo_password: '', default_location: 'United States', default_language: 'en' },
    general: { demo_mode: true, cors_origin: '*', api_token: '' },
  };
  saveTenantState(tenantId, 'settings', tenantSettings);

  // Apply industry template if specified
  if (template && INDUSTRY_TEMPLATES[template]) {
    const tmpl = INDUSTRY_TEMPLATES[template];
    tenant.branding.tagline = tmpl.tagline;
    if (tmpl.settings) {
      Object.assign(tenantSettings.general, tmpl.settings);
      saveTenantState(tenantId, 'settings', tenantSettings);
    }
  }

  tenantRegistry[tenantId] = tenant;
  saveState('tenant_registry', tenantRegistry);

  logActivity('tenant', `Tenant provisioned: ${name} (${tenantId})`, { tenantId, ownerEmail, industry, template });
  broadcast({ event: 'tenant_provisioned', data: { id: tenantId, name, subdomain } });

  res.json({ ok: true, tenant });
});

// PUT /api/tenants/:id — update tenant config
app.put('/api/tenants/:id', requireAdmin, (req, res) => {
  const tenant = tenantRegistry[req.params.id];
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { name, subdomain, domain, status, branding, industry } = req.body;
  if (name) tenant.name = name;
  if (subdomain !== undefined) {
    if (subdomain && Object.values(tenantRegistry).find(t => t.id !== tenant.id && t.subdomain === subdomain)) {
      return res.status(400).json({ error: `Subdomain "${subdomain}" is already taken` });
    }
    tenant.subdomain = subdomain;
  }
  if (domain !== undefined) tenant.domain = domain;
  if (status) tenant.status = status;
  if (branding) Object.assign(tenant.branding, branding);
  if (industry) tenant.industry = industry;

  saveState('tenant_registry', tenantRegistry);
  res.json({ ok: true, tenant });
});

// DELETE /api/tenants/:id — deactivate a tenant (soft delete)
app.delete('/api/tenants/:id', requireAdmin, (req, res) => {
  const tenant = tenantRegistry[req.params.id];
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.id === MASTER_TENANT_ID) return res.status(400).json({ error: 'Cannot delete master tenant' });

  tenant.status = 'deactivated';
  saveState('tenant_registry', tenantRegistry);
  logActivity('tenant', `Tenant deactivated: ${tenant.name} (${tenant.id})`, { tenantId: tenant.id });
  res.json({ ok: true });
});

// GET /api/tenants/:id/stats — tenant usage stats
app.get('/api/tenants/:id/stats', requireAdmin, (req, res) => {
  const tenant = tenantRegistry[req.params.id];
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const tenantUsers = loadTenantState(tenant.id, 'users', []);
  const tenantAudits = loadTenantState(tenant.id, 'seo_audits', []);
  const tenantSettings = loadTenantState(tenant.id, 'settings', {});

  const configuredKeys = Object.values(tenantSettings.ai || {}).filter(v => !!v).length;

  res.json({
    tenantId: tenant.id,
    name: tenant.name,
    status: tenant.status,
    users: Array.isArray(tenantUsers) ? tenantUsers.length : 0,
    seoAudits: Array.isArray(tenantAudits) ? tenantAudits.length : 0,
    apiKeysConfigured: configuredKeys,
    createdAt: tenant.createdAt,
  });
});

// GET /api/tenant/branding — current tenant's branding (public, no auth)
app.get('/api/tenant/branding', (req, res) => {
  const tenant = req.tenant || tenantRegistry[MASTER_TENANT_ID];
  res.json({
    tenantId: tenant.id,
    companyName: tenant.branding?.companyName || 'AI OS Corp',
    tagline: tenant.branding?.tagline || 'The Agentic Operating System',
    logo: tenant.branding?.logo || null,
    primaryColor: tenant.branding?.primaryColor || '#3b82f6',
    accentColor: tenant.branding?.accentColor || '#8b5cf6',
    industry: tenant.industry,
  });
});

// --- Industry Templates ---
const INDUSTRY_TEMPLATES = {
  'digital-agency': {
    name: 'Digital Marketing Agency',
    tagline: 'AI-Powered Digital Marketing',
    description: 'Pre-configured for SEO, content marketing, social media management, and client reporting.',
    departments: ['marketing', 'creative', 'seo-agency', 'customer-service'],
    settings: {},
  },
  'law-firm': {
    name: 'Law Firm',
    tagline: 'AI-Powered Legal Operations',
    description: 'Contract review, compliance monitoring, legal research, and client communication.',
    departments: ['legal', 'customer-service', 'product'],
    settings: {},
  },
  'ecommerce': {
    name: 'E-Commerce Business',
    tagline: 'AI-Powered Online Retail',
    description: 'Product listings, inventory management, customer support, and marketing automation.',
    departments: ['marketing', 'creative', 'customer-service', 'product'],
    settings: {},
  },
  'saas': {
    name: 'SaaS Company',
    tagline: 'AI-Powered Software Operations',
    description: 'Engineering, DevOps, customer support, product management, and growth marketing.',
    departments: ['engineering', 'tech-support', 'marketing', 'product'],
    settings: {},
  },
  'real-estate': {
    name: 'Real Estate Agency',
    tagline: 'AI-Powered Property Sales',
    description: 'Lead generation, property listing optimization, client communication, and market analysis.',
    departments: ['marketing', 'customer-service', 'product'],
    settings: {},
  },
  'healthcare': {
    name: 'Healthcare Practice',
    tagline: 'AI-Powered Healthcare Admin',
    description: 'Patient communication, scheduling, compliance, documentation, and billing support.',
    departments: ['customer-service', 'legal', 'operations'],
    settings: {},
  },
  'consulting': {
    name: 'Consulting Firm',
    tagline: 'AI-Powered Consulting',
    description: 'Research, analysis, report generation, client deliverables, and knowledge management.',
    departments: ['product', 'creative', 'marketing'],
    settings: {},
  },
  'trades': {
    name: 'Trades & Home Services',
    tagline: 'AI-Powered Service Business',
    description: 'Local SEO, lead generation, scheduling, customer follow-up, and review management.',
    departments: ['marketing', 'customer-service', 'operations'],
    settings: {},
  },
};

// GET /api/templates — list available industry templates
app.get('/api/templates', (req, res) => {
  res.json(Object.entries(INDUSTRY_TEMPLATES).map(([id, t]) => ({ id, ...t })));
});

} // end registerTenantRoutes

// --- Security & Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com", "https://www.google-analytics.com"],
      scriptSrcAttr: ["'unsafe-inline'"],  // Required for onclick handlers in HTML
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://www.google-analytics.com", "https://analytics.google.com", "https://*.google-analytics.com", "https://*.analytics.google.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://www.google-analytics.com", "https://www.googletagmanager.com"],
    }
  }
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(compression());
app.use(cookieParser());
// Skip JSON parsing for Stripe webhook (needs raw body for signature verification)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// Request logging
if (process.env.NODE_ENV === 'production') {
  const logStream = fs.createWriteStream(path.join(BASE, 'access.log'), { flags: 'a' });
  app.use(morgan('combined', { stream: logStream }));
} else {
  app.use(morgan('dev'));
}

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api/', apiLimiter);

// Stricter rate limit for expensive POST operations
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Rate limit exceeded for this operation.' },
});

// Auth middleware — if API_TOKEN is set, all /api/ routes require it
function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next(); // no token configured = open (dev mode)
  // Allow health check without auth
  if (req.path === '/api/health') return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token === API_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token> header.' });
}
app.use('/api/', authMiddleware);

// --- Stripe Integration ---
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;

const STRIPE_PLANS = {
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRO_PRICE_ID || 'price_pro_placeholder',
    amount: 9900, // $99
  },
  business: {
    name: 'Business',
    priceId: process.env.STRIPE_BUSINESS_PRICE_ID || 'price_business_placeholder',
    amount: 49700, // $497
  },
  enterprise: {
    name: 'Enterprise',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise_placeholder',
    amount: 199700, // $1,997
  },
};

// In-memory user/session store (replace with DB in production)
const users = loadState('users', []);
const sessions = new Map(); // token -> { email, plan, stripeCustomerId, expiresAt }

// Seed admin account if not present
(function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'wholefoo@gmail.com';
  if (!users.find(u => u.email === adminEmail)) {
    users.push({
      email: adminEmail,
      passwordHash: process.env.ADMIN_PASSWORD_HASH || '$2b$12$fhfoAN1tNo4ibPfElk60UOuNHEAJckkE9Oko8etkDpJvggDYBrrZa',
      plan: 'enterprise',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    saveState('users', users);
    console.log(`[AUTH] Admin account seeded: ${adminEmail}`);
  }
})();

function generateToken() { return uuidv4() + '-' + uuidv4(); }

function findUserByEmail(email) { return users.find(u => u.email === email); }

function isValidSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    sessions.delete(token);
    return false;
  }
  return session;
}

// --- Stripe Checkout ---
app.get('/api/stripe/checkout', async (req, res) => {
  const planKey = req.query.plan || 'pro';
  const plan = STRIPE_PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  if (!stripe) {
    // Stripe not configured — redirect to landing with message
    return res.redirect('/?stripe=not-configured');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: plan.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${req.protocol}://${req.get('host')}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/#pricing`,
      metadata: { plan: planKey },
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error('[STRIPE] Checkout error:', e.message);
    res.redirect('/?stripe=error');
  }
});

// Stripe success callback
app.get('/api/stripe/success', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId || !stripe) return res.redirect('/');

  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
    const email = stripeSession.customer_details?.email || stripeSession.customer_email;
    const plan = stripeSession.metadata?.plan || 'pro';
    const customerId = stripeSession.customer;

    // Create or update user
    let user = findUserByEmail(email);
    if (!user) {
      user = { id: uuidv4(), email, plan, stripeCustomerId: customerId, createdAt: new Date().toISOString() };
      users.push(user);
    } else {
      user.plan = plan;
      user.stripeCustomerId = customerId;
    }
    saveState('users', users);

    // Create session
    const token = generateToken();
    sessions.set(token, { email, plan, stripeCustomerId: customerId, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });

    // Set cookie and redirect to dashboard
    res.cookie('ai-os-session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 86400000, // 30 days
    });
    res.redirect('/app');
  } catch (e) {
    console.error('[STRIPE] Success callback error:', e.message);
    res.redirect('/?stripe=error');
  }
});

// Stripe webhook (subscription updates, cancellations)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[STRIPE] Webhook signature verification failed:', e.message);
    return res.status(400).send('Webhook verification failed');
  }

  switch (event.type) {
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused': {
      const sub = event.data.object;
      const user = users.find(u => u.stripeCustomerId === sub.customer);
      if (user) {
        user.plan = 'free';
        saveState('users', users);
        logActivity('billing', `Subscription cancelled for ${user.email}`);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      if (sub.status === 'active') {
        const user = users.find(u => u.stripeCustomerId === sub.customer);
        if (user) logActivity('billing', `Subscription updated for ${user.email}`);
      }
      break;
    }
  }

  res.json({ received: true });
});

// --- User Auth ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.plan || user.plan === 'free') return res.status(403).json({ error: 'No active subscription. Please choose a plan.' });

  // Verify password with bcrypt
  const valid = user.passwordHash
    ? await bcrypt.compare(password, user.passwordHash)
    : (user.password && user.password === password); // legacy fallback
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken();
  sessions.set(token, {
    email: user.email,
    plan: user.plan,
    role: user.role || 'user',
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });

  logActivity('auth', `Login: ${user.email} (${user.role || 'user'})`, { plan: user.plan });

  res.cookie('ai-os-session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 86400000,
  });
  res.json({ ok: true, token, plan: user.plan, role: user.role || 'user' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.['ai-os-session'] || req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.clearCookie('ai-os-session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.['ai-os-session'] || req.headers.authorization?.replace('Bearer ', '');
  const session = isValidSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ email: session.email, plan: session.plan });
});

// --- Dashboard Paywall ---
// Serve landing page at root (public)
// Serve dashboard at /app (requires active subscription)
app.get('/app', (req, res) => {
  const token = req.cookies?.['ai-os-session'];
  const session = isValidSession(token);
  if (!session || !session.plan || session.plan === 'free') {
    return res.redirect('/login');
  }
  res.sendFile(path.join(BASE, 'dashboard', 'app.html'));
});

// Sitemap.xml — auto-generated for SEO
app.get('/sitemap.xml', (req, res) => {
  const domain = 'https://aiosorchestrationlab.com';
  const now = new Date().toISOString().split('T')[0];
  const pages = [
    { url: '/', priority: '1.0', freq: 'weekly' },
    { url: '/about', priority: '0.8', freq: 'monthly' },
    { url: '/blog', priority: '0.9', freq: 'weekly' },
    { url: '/blog/what-is-ai-operating-system', priority: '0.8', freq: 'monthly' },
    { url: '/blog/ai-agent-pricing-comparison-2026', priority: '0.8', freq: 'monthly' },
    { url: '/blog/how-to-automate-seo-with-ai', priority: '0.8', freq: 'monthly' },
    { url: '/lifetime', priority: '0.8', freq: 'monthly' },
    { url: '/docs', priority: '0.8', freq: 'weekly' },
    { url: '/docs/getting-started', priority: '0.9', freq: 'monthly' },
    { url: '/docs/architecture', priority: '0.7', freq: 'monthly' },
    { url: '/docs/agents', priority: '0.7', freq: 'monthly' },
    { url: '/docs/skills', priority: '0.6', freq: 'monthly' },
    { url: '/docs/knowledge-graph', priority: '0.6', freq: 'monthly' },
    { url: '/docs/design-system', priority: '0.6', freq: 'monthly' },
    { url: '/docs/media-production', priority: '0.6', freq: 'monthly' },
    { url: '/docs/monetization', priority: '0.6', freq: 'monthly' },
    { url: '/docs/batch-queue', priority: '0.5', freq: 'monthly' },
    { url: '/docs/api', priority: '0.7', freq: 'monthly' },
    { url: '/docs/deployment', priority: '0.5', freq: 'monthly' },
    { url: '/docs/notifications', priority: '0.5', freq: 'monthly' },
    { url: '/docs/hermes', priority: '0.7', freq: 'monthly' },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${domain}${p.url}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/lifetime', (req, res) => {
  res.sendFile(path.join(BASE, 'dashboard', 'lifetime.html'));
});

app.get('/lifetime/success', (req, res) => {
  const licenseId = req.query.license;
  if (licenseId) {
    const license = licenses.find(l => l.id === licenseId);
    if (license && license.status === 'payment') {
      license.status = 'active';
      license.activatedAt = new Date().toISOString();

      // Auto-provision tenant
      if (!license.tenantId) {
        const tenantId = uuidv4().substring(0, 12);
        const subdomain = (license.company || license.name).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 20);
        const tenant = {
          id: tenantId, name: license.company || license.name, domain: null, subdomain,
          ownerId: license.email, plan: 'lifetime', status: 'active',
          branding: { companyName: license.company || license.name, tagline: 'Powered by AI OS', logo: null, primaryColor: '#3b82f6', accentColor: '#8b5cf6' },
          industry: license.industry || null, template: null, createdAt: new Date().toISOString(), franchiseId: license.id,
        };
        ensureTenantDir(tenantId);
        saveTenantState(tenantId, 'users', [{ email: license.email, passwordHash: null, plan: 'lifetime', role: 'admin', tenantId, createdAt: new Date().toISOString() }]);
        saveTenantState(tenantId, 'settings', {
          ai: { anthropic_api_key: '', openai_api_key: '', deepseek_api_key: '', xai_api_key: '', gemini_api_key: '', perplexity_api_key: '', firecrawl_api_key: '', tavily_api_key: '', apify_api_token: '', manus_api_key: '' },
          mcp: { hermes_url: 'http://127.0.0.1:8420', hermes_enabled: false },
          notifications: { telegram_bot_token: '', telegram_chat_id: '', slack_webhook_url: '' },
          automation: { n8n_webhook_base: '', n8n_api_key: '', team_webhook_url: '' },
          stripe: { secret_key: '', webhook_secret: '', pro_price_id: '', business_price_id: '', enterprise_price_id: '' },
          seo: { dataforseo_login: '', dataforseo_password: '', default_location: 'United States', default_language: 'en' },
          general: { demo_mode: true, cors_origin: '*', api_token: '' },
        });
        tenantRegistry[tenantId] = tenant;
        saveState('tenant_registry', tenantRegistry);
        license.tenantId = tenantId;
        license.instanceUrl = `https://${subdomain}.aiosorchestrationlab.com`;
        logActivity('license', `Lifetime license activated + tenant provisioned: ${license.name} (${tenantId})`, { licenseId, tenantId });
      }
      saveState('licenses', licenses);
    }
  }
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Welcome to AI OS!</title><link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/landing.css">
<style>.success-page{max-width:600px;margin:0 auto;padding:120px 24px;text-align:center;}
.success-icon{font-size:80px;margin-bottom:20px;}
.success-page h1{font-size:36px;font-weight:800;margin-bottom:12px;}
.success-page p{font-size:16px;color:var(--text-secondary);line-height:1.7;margin-bottom:24px;}
.success-next{text-align:left;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;margin:24px 0;}
.success-next h3{margin-bottom:12px;font-size:16px;}
.success-next ol{padding-left:20px;font-size:14px;line-height:2;color:var(--text-secondary);}
</style></head><body>
<nav class="landing-nav"><div class="nav-container"><a href="/" class="nav-brand"><span class="nav-logo">&#9678;</span><span class="nav-name">AI OS</span></a></div></nav>
<div class="success-page">
<div class="success-icon">&#127881;</div>
<h1>Welcome to AI OS!</h1>
<p>Your Founders Plan is now active. Your Virtual Corporate HQ is being provisioned.</p>
<div class="success-next">
<h3>Next Steps:</h3>
<ol>
<li>Check your email for your login credentials</li>
<li>Log in to your dashboard and go to <strong>Settings</strong></li>
<li>Enter your API keys (Anthropic, Gemini, etc.)</li>
<li>Explore your Virtual HQ — 51 agents are ready</li>
</ol>
</div>
<a href="/login" class="btn-primary-cta btn-lg">Go to Dashboard &rarr;</a>
</div>
<footer class="site-footer"><div class="footer-bottom"><p>&copy; 2026 AI OS Orchestration Lab.</p></div></footer>
</body></html>`);
});

// Blog routes
app.get('/blog', (req, res) => {
  res.sendFile(path.join(BASE, 'dashboard', 'blog', 'index.html'));
});
app.get('/blog/:slug', (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9-]/g, '');
  const filePath = path.join(BASE, 'dashboard', 'blog', `${slug}.html`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).sendFile(path.join(BASE, 'dashboard', 'blog', 'index.html'));
  }
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(BASE, 'dashboard', 'about.html'));
});

app.get('/login', (req, res) => {
  // If already logged in with active plan, redirect to app
  const token = req.cookies?.['ai-os-session'];
  const session = isValidSession(token);
  if (session && session.plan && session.plan !== 'free') {
    return res.redirect('/app');
  }
  // Otherwise serve landing page which has the login modal
  res.sendFile(path.join(BASE, 'dashboard', 'index.html'));
});

// Legal pages
app.get('/terms', (req, res) => res.sendFile(path.join(BASE, 'dashboard', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(BASE, 'dashboard', 'privacy.html')));

// Documentation pages
app.get('/docs', (req, res) => res.sendFile(path.join(BASE, 'dashboard', 'docs', 'index.html')));
const docPages = ['getting-started','architecture','agents','skills','knowledge-graph','design-system','media-production','monetization','batch-queue','api','deployment','notifications','hermes'];
docPages.forEach(page => {
  app.get(`/docs/${page}`, (req, res) => res.sendFile(path.join(BASE, 'dashboard', 'docs', `${page}.html`)));
});

// Static files (served by Nginx in production, Express in dev)
app.use(express.static(path.join(BASE, 'dashboard'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
}));

// Health check endpoint
const startTime = Date.now();
app.get('/api/health', (req, res) => {
  const agentDir = path.join(CLAUDE_DIR, 'agents');
  const skillDir = path.join(CLAUDE_DIR, 'skills');
  const agentCount = fs.existsSync(agentDir) ? fs.readdirSync(agentDir).filter(f => f.endsWith('.md')).length : 0;
  const skillCount = fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(f => f.endsWith('.md')).length : 0;

  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    version: require('./package.json').version,
    demoMode: DEMO_MODE,
    nodeEnv: process.env.NODE_ENV || 'development',
    stripeConfigured: !!stripe,
    agents: agentCount,
    skills: skillCount,
    activeUsers: users.filter(u => u.plan && u.plan !== 'free').length,
    activeSessions: sessions.size,
    missionActive: workflows.size > 0,
  });
});

// WebSocket server with auth + heartbeat
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    if (!API_TOKEN) return cb(true);
    const url = new URL(info.req.url, `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token === API_TOKEN) return cb(true);
    cb(false, 401, 'Unauthorized');
  },
});

// WebSocket heartbeat — drop stale connections every 30s
const WS_HEARTBEAT_INTERVAL = 30000;
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_INTERVAL);

// --- State Persistence ---
// Save/load runtime state to JSON files so data survives restarts

function saveState(key, data) {
  try {
    fs.writeFileSync(path.join(STATE_DIR, `${key}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[STATE] Failed to save ${key}:`, e.message);
  }
}

function loadState(key, fallback) {
  const defaults = typeof fallback === 'function' ? fallback() : fallback;
  try {
    const fp = path.join(STATE_DIR, `${key}.json`);
    if (fs.existsSync(fp)) {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      console.log(`[STATE] Loaded ${key} from disk`);
      // Deep-merge: ensure any new default keys are present in loaded data
      if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
        for (const [section, vals] of Object.entries(defaults)) {
          if (typeof vals === 'object' && !Array.isArray(vals) && vals !== null) {
            if (!data[section]) data[section] = {};
            for (const [k, v] of Object.entries(vals)) {
              if (!(k in data[section])) {
                data[section][k] = v;
                console.log(`[STATE] Added missing default: ${key}.${section}.${k}`);
              }
            }
          } else if (!(section in data)) {
            data[section] = vals;
          }
        }
      }
      return data;
    }
  } catch (e) {
    console.error(`[STATE] Failed to load ${key}:`, e.message);
  }
  return defaults;
}

// Debounced auto-save: saves state 2s after last mutation
let autoSaveTimer = null;
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveState('activity-log', activityLog.slice(-500));
    saveState('cost-ledger', costLedger.slice(-500));
    saveState('grok-queries', grokQueries.slice(-100));
    saveState('notifications', notifications.slice(-200));
  }, 2000);
}

// --- Input Validation ---
function validateBody(body, schema) {
  const errors = [];
  for (const [field, rules] of Object.entries(schema)) {
    const val = body[field];
    if (rules.required && (val === undefined || val === null || val === '')) {
      errors.push(`${field} is required`);
      continue;
    }
    if (val === undefined || val === null) continue;
    if (rules.type === 'string' && typeof val !== 'string') errors.push(`${field} must be a string`);
    if (rules.type === 'number' && typeof val !== 'number') errors.push(`${field} must be a number`);
    if (rules.type === 'url' && (typeof val !== 'string' || !/^https?:\/\/.+/.test(val))) errors.push(`${field} must be a valid URL`);
    if (rules.maxLength && typeof val === 'string' && val.length > rules.maxLength) errors.push(`${field} exceeds max length (${rules.maxLength})`);
    if (rules.oneOf && !rules.oneOf.includes(val)) errors.push(`${field} must be one of: ${rules.oneOf.join(', ')}`);
    if (rules.min !== undefined && typeof val === 'number' && val < rules.min) errors.push(`${field} must be >= ${rules.min}`);
    if (rules.max !== undefined && typeof val === 'number' && val > rules.max) errors.push(`${field} must be <= ${rules.max}`);
  }
  return errors.length ? errors : null;
}

// --- Utility ---

function readDir(dir, ext = '.md') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const parsed = parseFrontmatter(content);
      return { filename: f, ...parsed };
    });
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    try {
      return { meta: yaml.load(match[1]), body: match[2].trim() };
    } catch { /* fall through */ }
  }
  return { meta: {}, body: text.trim() };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function appendLog(entry) {
  const logPath = path.join(MAGENT_DIR, 'decisions.log');
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.appendFileSync(logPath, line);
}

function getSystemHealth() {
  const agentFiles = fs.existsSync(path.join(CLAUDE_DIR, 'agents'))
    ? fs.readdirSync(path.join(CLAUDE_DIR, 'agents')).filter(f => f.endsWith('.md'))
    : [];
  const skillFiles = fs.existsSync(path.join(CLAUDE_DIR, 'skills'))
    ? fs.readdirSync(path.join(CLAUDE_DIR, 'skills')).filter(f => f.endsWith('.md'))
    : [];
  const missionExists = fs.existsSync(path.join(MAGENT_DIR, 'mission.md'));
  const teamPath = path.join(MAGENT_DIR, 'team.yaml');
  let activeTeam = null;
  if (fs.existsSync(teamPath)) {
    try { activeTeam = yaml.load(fs.readFileSync(teamPath, 'utf-8')); } catch {}
  }
  return {
    agents: agentFiles.length,
    skills: skillFiles.length,
    missionActive: missionExists,
    activeTeam,
    uptime: process.uptime(),
  };
}

// --- In-memory workflow state ---

const workflows = new Map();
const activityLog = [];
const techRadarReports = [];
const updateProposals = [];

// --- Cost Tracking State ---
// --- Model Configuration ---
const OPUS_MODEL = 'claude-opus-4-8';
const OPUS_API_VERSION = '2023-06-01';
const GEMINI_OMNI_MODEL = 'gemini-omni-flash';

// Effort-level routing: maps agent tiers to Opus 4.8 effort levels
const EFFORT_ROUTING = {
  // Strategic tier — full reasoning power, complex planning, architecture decisions
  strategic: { effort: 'xhigh', agents: ['orchestrator', 'architect', 'reviewer', 'security-auditor'] },
  // Professional tier — balanced quality/speed for most agent work
  professional: { effort: 'high', agents: ['researcher', 'coder', 'writer', 'synthesis', 'research-architect', 'report-compiler', 'data-wrangler', 'design-system', 'lead-gen', 'marketing-hub', 'product-factory', 'knowledge-graph', 'golden-loop', 'automator', 'browser-agent'] },
  // Scout tier — fast, lightweight tasks
  scout: { effort: 'low', agents: ['scout', 'social-intel', 'routine-runner'] },
  // Creative tier — Gemini Omni for multimodal generation (video, image, audio)
  creative: { model: 'gemini-omni', agents: ['media-producer', 'vibe-designer', 'video-creator', 'audio-producer', 'thumbnail-gen'] },
};

// Resolve agent name to effort level / model tier
function getAgentEffort(agentName) {
  for (const [tier, config] of Object.entries(EFFORT_ROUTING)) {
    if (config.agents.includes(agentName)) {
      if (tier === 'creative') return { tier, effort: null, model: 'gemini-omni' };
      return { tier, effort: config.effort, model: `opus-4.8-${config.effort}` };
    }
  }
  return { tier: 'professional', effort: 'high', model: 'opus-4.8-high' };
}

// Build Anthropic API request body with Opus 4.8 features
function buildOpusRequest(messages, { effort = 'high', systemMessages = [], maxTokens = 4096 } = {}) {
  const body = {
    model: OPUS_MODEL,
    max_tokens: maxTokens,
    // Adaptive thinking — Opus 4.8 decides when to reason deeply
    thinking: { type: 'adaptive' },
    messages,
  };
  // Effort controls thinking depth
  if (effort) body.effort = effort;
  // Mid-conversation system messages (new in 4.8)
  if (systemMessages.length > 0) {
    // Insert system messages after user turns where needed
    body.system = systemMessages;
  }
  return body;
}

// --- Core Agent Execution Engine ---
// The bridge from DEMO_MODE to real API calls. Every agent dispatch flows through here.

async function loadAgentPrompt(agentName) {
  const agentFile = path.join(CLAUDE_DIR, 'agents', `${agentName}.md`);
  if (!fs.existsSync(agentFile)) return null;
  const content = fs.readFileSync(agentFile, 'utf-8');
  // Strip YAML frontmatter, return the instruction body
  const bodyMatch = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1].trim() : content.trim();
}

async function executeAgent(agentName, task, options = {}) {
  const { tenantId = MASTER_TENANT_ID, maxTokens = 4096, context = '' } = options;
  const routing = getAgentEffort(agentName);
  const startTime = Date.now();

  // Load agent system prompt from .md file
  const systemPrompt = await loadAgentPrompt(agentName);
  if (!systemPrompt) {
    return { ok: false, error: `Agent "${agentName}" not found`, model: routing.model };
  }

  // Build the full system message
  const fullSystem = context
    ? `${systemPrompt}\n\n--- Current Context ---\n${context}`
    : systemPrompt;

  let result, inputTokens = 0, outputTokens = 0, model = routing.model;

  try {
    if (routing.tier === 'creative') {
      // Gemini Omni — route to Google
      result = await callGemini(fullSystem, task, maxTokens);
      model = 'gemini-omni';
    } else if (agentName === 'grok-realtime' || routing.tier === 'realtime') {
      // Grok — route to xAI
      result = await callGrok(fullSystem, task, maxTokens);
      model = 'grok-3';
    } else if (agentName === 'deepseek-worker' || routing.tier === 'economy') {
      // DeepSeek — economy tier
      result = await callDeepSeek(fullSystem, task, maxTokens);
      model = 'deepseek-v4';
    } else {
      // Default: Anthropic Opus 4.8
      result = await callAnthropic(fullSystem, task, routing.effort, maxTokens);
    }

    inputTokens = result.inputTokens || 0;
    outputTokens = result.outputTokens || 0;

    // Track cost
    const rates = COST_RATES[model] || COST_RATES['opus-4.8-high'];
    const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
    costLedger.push({
      id: uuidv4(), agent: agentName, model, skill: options.skill || 'dispatch',
      inputTokens, outputTokens, cost: Math.round(cost * 10000) / 10000,
      timestamp: new Date().toISOString(),
    });

    const elapsed = Date.now() - startTime;
    logActivity('agent', `${agentName} completed in ${elapsed}ms (${model})`, { agentName, model, inputTokens, outputTokens, cost: Math.round(cost * 10000) / 10000 });
    broadcast({ event: 'agent_complete', data: { agent: agentName, model, elapsed, cost: Math.round(cost * 10000) / 10000 } });

    return { ok: true, content: result.content, model, inputTokens, outputTokens, elapsed };

  } catch (e) {
    console.error(`[AGENT] ${agentName} execution failed:`, e.message);
    logActivity('agent', `${agentName} failed: ${e.message}`, { agentName, model });
    return { ok: false, error: e.message, model };
  }
}

// --- Model-Specific API Callers ---

async function callAnthropic(systemPrompt, task, effort, maxTokens) {
  const apiKey = settings.ai.anthropic_api_key;
  if (!apiKey) throw new Error('Anthropic API key not configured — add it in Settings');

  const body = {
    model: OPUS_MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: task }],
  };
  if (effort) body.effort = effort;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic HTTP ${res.status}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  return {
    content: textBlock?.text || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

async function callGrok(systemPrompt, task, maxTokens) {
  const apiKey = settings.ai.xai_api_key;
  if (!apiKey) throw new Error('xAI API key not configured — add it in Settings');

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Grok HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callDeepSeek(systemPrompt, task, maxTokens) {
  const apiKey = settings.ai.deepseek_api_key;
  if (!apiKey) throw new Error('DeepSeek API key not configured — add it in Settings');

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `DeepSeek HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callGemini(systemPrompt, task, maxTokens) {
  const apiKey = settings.ai.gemini_api_key;
  if (!apiKey) throw new Error('Gemini API key not configured — add it in Settings');

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: task }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    content: text,
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  };
}

async function callOpenAI(systemPrompt, task, maxTokens) {
  const apiKey = settings.ai.openai_api_key;
  if (!apiKey) throw new Error('OpenAI API key not configured — add it in Settings');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callPerplexity(systemPrompt, task, maxTokens) {
  const apiKey = settings.ai.perplexity_api_key;
  if (!apiKey) throw new Error('Perplexity API key not configured — add it in Settings');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Perplexity HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    citations: data.citations || [],
  };
}

// --- Generic Agent Dispatch Endpoint ---
// POST /api/agent/execute — run any agent with a task (used by dashboard dispatch, chat, etc.)
app.post('/api/agent/execute', requireAdmin, async (req, res) => {
  const { agent, task, context, maxTokens } = req.body;
  if (!agent || !task) return res.status(400).json({ error: 'Agent name and task are required' });

  if (DEMO_MODE) {
    // In demo mode, simulate a response
    const routing = getAgentEffort(agent);
    setTimeout(() => {
      broadcast({ event: 'agent_complete', data: { agent, model: routing.model, elapsed: 2500, cost: 0.02 } });
    }, 2000);
    return res.json({
      ok: true, demo: true, agent, model: routing.model,
      content: `[DEMO] ${agent} would process: "${task.substring(0, 80)}..." — enable real mode by setting DEMO_MODE=false and configuring API keys in Settings.`,
    });
  }

  const result = await executeAgent(agent, task, {
    tenantId: req.tenantId,
    context: context || '',
    maxTokens: maxTokens || 4096,
    skill: req.body.skill || 'dispatch',
  });

  res.json(result);
});

// POST /api/chat — conversational AI assistant (uses Orchestrator agent)
app.post('/api/chat', requireAdmin, async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  if (DEMO_MODE) {
    return res.json({
      ok: true, demo: true,
      reply: `I'm Atlas, CEO of AI OS Corp. In demo mode, I can show you around but can't process real tasks. Set DEMO_MODE=false and add your Anthropic API key in Settings to activate me. You said: "${message.substring(0, 80)}"`,
    });
  }

  // Build conversation with history
  const messages = [];
  if (Array.isArray(history)) {
    history.slice(-10).forEach(h => {
      messages.push({ role: h.role, content: h.content });
    });
  }
  messages.push({ role: 'user', content: message });

  try {
    const systemPrompt = `You are Atlas, the CEO and Chief Orchestrator of AI OS Corp — a Virtual Corporate Headquarters with 51 AI agents across 10 departments. You help users navigate the platform, dispatch tasks to the right agents, answer questions about features, and provide strategic guidance. Be concise, helpful, and professional. You know about all 10 model tiers, the SEO Agency, Creative Studio, YouTube Intelligence, and the full agent fleet.`;

    const result = await callAnthropic(systemPrompt, messages.length === 1 ? message : JSON.stringify(messages), 'high', 2048);

    res.json({ ok: true, reply: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  } catch (e) {
    res.json({ ok: false, error: e.message, reply: `Sorry, I couldn't process that: ${e.message}` });
  }
});

const COST_RATES = {
  // Opus 4.8 — effort-based routing (single model, three tiers)
  'opus-4.8-xhigh':    { input: 10.00, output: 50.00 },   // per 1M tokens — fast mode, strategic work
  'opus-4.8-high':     { input: 5.00,  output: 25.00 },   // standard — professional work
  'opus-4.8-low':      { input: 5.00,  output: 25.00 },   // standard — scout/quick tasks (same rate, less thinking)
  // Legacy aliases (for backward compat with existing ledger entries)
  'claude-4.7-opus':   { input: 15.00, output: 75.00 },
  'claude-4.7-sonnet': { input: 3.00,  output: 15.00 },
  'claude-4.7-haiku':  { input: 0.25,  output: 1.25  },
  // External models
  'deepseek-v4':       { input: 0.14,  output: 0.28  },
  'grok-3':            { input: 3.00,  output: 15.00 },
  // Gemini Omni — multimodal creative generation (video, image, audio)
  'gemini-omni':       { input: 1.25,  output: 5.00  },   // Omni Flash pricing (text+image input, video output)
  // OpenAI
  'openai-gpt4o':      { input: 2.50,  output: 10.00 },
  'openai-o3':         { input: 10.00, output: 40.00 },
  // Perplexity — grounded web search with citations
  'perplexity-sonar':  { input: 1.00,  output: 1.00  },   // + $5/1K request fee
  'perplexity-pro':    { input: 3.00,  output: 15.00 },   // + $5-14/1K request fee
  // Manus — autonomous multi-step agent
  'manus':             { input: 0,     output: 0     },   // credit-based, not per-token
};

const costLedger = [];   // individual cost entries
const costBudget = {
  daily: 50.00,
  weekly: 250.00,
  monthly: 1000.00,
};

function seedCostLedger() {
  const now = Date.now();
  const entries = [
    { agent: 'orchestrator', model: 'opus-4.8-xhigh', skill: 'task-routing', effort: 'xhigh', inputTokens: 12400, outputTokens: 3200, timestamp: new Date(now - 3600000).toISOString() },
    { agent: 'researcher', model: 'opus-4.8-high', skill: 'research-brief', effort: 'high', inputTokens: 45000, outputTokens: 8500, timestamp: new Date(now - 7200000).toISOString() },
    { agent: 'scout', model: 'opus-4.8-low', skill: 'tech-radar', effort: 'low', inputTokens: 28000, outputTokens: 4200, timestamp: new Date(now - 10800000).toISOString() },
    { agent: 'deepseek-worker', model: 'deepseek-v4', skill: 'content-creation', inputTokens: 62000, outputTokens: 18000, timestamp: new Date(now - 14400000).toISOString() },
    { agent: 'coder', model: 'opus-4.8-high', skill: 'implementation', effort: 'high', inputTokens: 38000, outputTokens: 12000, timestamp: new Date(now - 18000000).toISOString() },
    { agent: 'writer', model: 'opus-4.8-high', skill: 'content-creation', effort: 'high', inputTokens: 22000, outputTokens: 9500, timestamp: new Date(now - 21600000).toISOString() },
    { agent: 'security-auditor', model: 'opus-4.8-xhigh', skill: 'security-audit', effort: 'xhigh', inputTokens: 55000, outputTokens: 14000, timestamp: new Date(now - 25200000).toISOString() },
    { agent: 'synthesis', model: 'opus-4.8-high', skill: 'deep-research', effort: 'high', inputTokens: 34000, outputTokens: 7800, timestamp: new Date(now - 28800000).toISOString() },
    { agent: 'research-architect', model: 'opus-4.8-high', skill: 'deep-research', effort: 'high', inputTokens: 18000, outputTokens: 5200, timestamp: new Date(now - 32400000).toISOString() },
    { agent: 'report-compiler', model: 'opus-4.8-high', skill: 'academic-paper', effort: 'high', inputTokens: 41000, outputTokens: 16000, timestamp: new Date(now - 36000000).toISOString() },
    { agent: 'reviewer', model: 'opus-4.8-xhigh', skill: 'review', effort: 'xhigh', inputTokens: 32000, outputTokens: 6400, timestamp: new Date(now - 43200000).toISOString() },
    { agent: 'data-wrangler', model: 'opus-4.8-high', skill: 'lead-enrichment', effort: 'high', inputTokens: 29000, outputTokens: 11000, timestamp: new Date(now - 50400000).toISOString() },
    { agent: 'deepseek-worker', model: 'deepseek-v4', skill: 'seo-audit', inputTokens: 85000, outputTokens: 24000, timestamp: new Date(now - 57600000).toISOString() },
    { agent: 'scout', model: 'opus-4.8-low', skill: 'tech-radar', effort: 'low', inputTokens: 31000, outputTokens: 5100, timestamp: new Date(now - 86400000).toISOString() },
    { agent: 'researcher', model: 'opus-4.8-high', skill: 'research-brief', effort: 'high', inputTokens: 52000, outputTokens: 9800, timestamp: new Date(now - 90000000).toISOString() },
  ];

  entries.forEach(e => {
    const rates = COST_RATES[e.model] || COST_RATES['opus-4.8-high'];
    const cost = (e.inputTokens / 1_000_000) * rates.input + (e.outputTokens / 1_000_000) * rates.output;
    costLedger.push({
      id: uuidv4(),
      ...e,
      cost: Math.round(cost * 10000) / 10000,
    });
  });
}

seedCostLedger();

function getCostSummary() {
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 604800000;
  const monthAgo = now - 2592000000;

  const daily = costLedger.filter(e => new Date(e.timestamp).getTime() > dayAgo);
  const weekly = costLedger.filter(e => new Date(e.timestamp).getTime() > weekAgo);
  const monthly = costLedger.filter(e => new Date(e.timestamp).getTime() > monthAgo);

  const sumCost = entries => entries.reduce((s, e) => s + e.cost, 0);
  const sumTokens = entries => entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);

  // Per-model breakdown
  const byModel = {};
  monthly.forEach(e => {
    if (!byModel[e.model]) byModel[e.model] = { cost: 0, tokens: 0, count: 0 };
    byModel[e.model].cost += e.cost;
    byModel[e.model].tokens += e.inputTokens + e.outputTokens;
    byModel[e.model].count += 1;
  });

  // Per-agent breakdown
  const byAgent = {};
  monthly.forEach(e => {
    if (!byAgent[e.agent]) byAgent[e.agent] = { cost: 0, tokens: 0, count: 0 };
    byAgent[e.agent].cost += e.cost;
    byAgent[e.agent].tokens += e.inputTokens + e.outputTokens;
    byAgent[e.agent].count += 1;
  });

  // Per-tier breakdown
  const tierMap = {
    'claude-4.7-opus': 'strategic',
    'claude-4.7-sonnet': 'professional',
    'claude-4.7-haiku': 'scout',
    'deepseek-v4': 'economy',
  };
  const byTier = {};
  monthly.forEach(e => {
    const tier = tierMap[e.model] || 'unknown';
    if (!byTier[tier]) byTier[tier] = { cost: 0, tokens: 0, count: 0 };
    byTier[tier].cost += e.cost;
    byTier[tier].tokens += e.inputTokens + e.outputTokens;
    byTier[tier].count += 1;
  });

  return {
    daily: { cost: Math.round(sumCost(daily) * 100) / 100, tokens: sumTokens(daily), count: daily.length, budget: costBudget.daily },
    weekly: { cost: Math.round(sumCost(weekly) * 100) / 100, tokens: sumTokens(weekly), count: weekly.length, budget: costBudget.weekly },
    monthly: { cost: Math.round(sumCost(monthly) * 100) / 100, tokens: sumTokens(monthly), count: monthly.length, budget: costBudget.monthly },
    byModel,
    byAgent,
    byTier,
    entries: costLedger.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 50),
  };
}

// --- Memory Vault ---
const VAULT_DIR = path.join(MAGENT_DIR, 'vault');

function getVaultStats() {
  const stats = { raw: [], wiki: [], outputs: [], totalFiles: 0, totalSize: 0 };

  ['raw', 'wiki', 'outputs'].forEach(folder => {
    const dir = path.join(VAULT_DIR, folder);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    files.forEach(f => {
      const fpath = path.join(dir, f);
      const fstat = fs.statSync(fpath);
      if (fstat.isFile()) {
        const entry = {
          name: f,
          folder,
          size: fstat.size,
          modified: fstat.mtime.toISOString(),
          path: `vault/${folder}/${f}`,
        };
        stats[folder].push(entry);
        stats.totalFiles++;
        stats.totalSize += fstat.size;
      }
    });
  });

  return stats;
}

function searchVault(query) {
  const results = [];
  const lowerQuery = query.toLowerCase();

  ['raw', 'wiki', 'outputs'].forEach(folder => {
    const dir = path.join(VAULT_DIR, folder);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    files.forEach(f => {
      const fpath = path.join(dir, f);
      const content = fs.readFileSync(fpath, 'utf-8');
      const lowerContent = content.toLowerCase();
      const idx = lowerContent.indexOf(lowerQuery);
      if (idx >= 0 || f.toLowerCase().includes(lowerQuery)) {
        const snippet = idx >= 0 ? content.substring(Math.max(0, idx - 60), idx + query.length + 60).trim() : '';
        const parsed = parseFrontmatter(content);
        results.push({
          file: f,
          folder,
          path: `vault/${folder}/${f}`,
          tags: parsed.meta?.tags || [],
          type: parsed.meta?.type || folder,
          snippet: snippet.replace(/\n/g, ' '),
          modified: fs.statSync(fpath).mtime.toISOString(),
        });
      }
    });
  });

  return results;
}

function getSessionContext() {
  // Deterministic session-start hook: load the most recent and relevant vault files
  const context = { decisions: [], recentArtifacts: [], recentWiki: [] };

  // Load latest decisions from log
  const logPath = path.join(MAGENT_DIR, 'decisions.log');
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    context.decisions = lines.slice(-10).reverse();
  }

  // Load recent wiki entries
  const wikiDir = path.join(VAULT_DIR, 'wiki');
  if (fs.existsSync(wikiDir)) {
    const wikiFiles = fs.readdirSync(wikiDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(wikiDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    context.recentWiki = wikiFiles.map(f => {
      const parsed = parseFrontmatter(fs.readFileSync(path.join(wikiDir, f.name), 'utf-8'));
      return { name: f.name, tags: parsed.meta?.tags || [], updated: f.mtime.toISOString() };
    });
  }

  // Load recent outputs
  const outputsDir = path.join(VAULT_DIR, 'outputs');
  if (fs.existsSync(outputsDir)) {
    const outputFiles = fs.readdirSync(outputsDir)
      .filter(f => !f.startsWith('.'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(outputsDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    context.recentArtifacts = outputFiles.map(f => ({ name: f.name, modified: f.mtime.toISOString() }));
  }

  return context;
}

// Seed demo tech radar data
techRadarReports.push({
  id: 'radar-001',
  date: new Date().toISOString(),
  sweep_type: 'daily',
  findings: [
    {
      id: 'f-001',
      title: 'Claude 4.7 Opus released with 400K context window',
      summary: 'Anthropic released Claude 4.7 Opus with doubled context window (400K tokens) and improved tool use reliability. Benchmarks show 15% improvement on agentic tasks.',
      category: 'models',
      impact: 'high',
      relevance: 9,
      source: 'https://anthropic.com/blog',
      date: new Date().toISOString(),
    },
    {
      id: 'f-002',
      title: 'Firecrawl v2.0 adds structured extraction and MCP server',
      summary: 'Firecrawl v2.0 now includes built-in MCP server support and structured data extraction via LLM-powered schemas. Direct integration possible with Claude Code.',
      category: 'tools',
      impact: 'high',
      relevance: 9,
      source: 'https://firecrawl.dev/blog',
      date: new Date().toISOString(),
    },
    {
      id: 'f-003',
      title: 'n8n 2.22 adds AI Agent node improvements',
      summary: 'n8n v2.22 includes enhanced AI Agent nodes with memory persistence, sub-workflow chaining, and native Claude integration. Reduces custom code needed for agentic workflows.',
      category: 'frameworks',
      impact: 'medium',
      relevance: 7,
      source: 'https://n8n.io/changelog',
      date: new Date().toISOString(),
    },
    {
      id: 'f-004',
      title: 'Critical Node.js security patch (CVE-2026-XXXX)',
      summary: 'A high-severity vulnerability in Node.js HTTP/2 implementation affects versions < 22.5.1. Upgrade recommended for all production servers.',
      category: 'security',
      impact: 'critical',
      relevance: 10,
      source: 'https://nodejs.org/blog/vulnerability',
      date: new Date().toISOString(),
    },
    {
      id: 'f-005',
      title: 'MCP Registry adds 50+ new community servers',
      summary: 'The Model Context Protocol registry expanded with community-contributed servers for Google Sheets, Notion, Jira, and database connectors. Several applicable to content pipeline automation.',
      category: 'tools',
      impact: 'medium',
      relevance: 6,
      source: 'https://modelcontextprotocol.io',
      date: new Date().toISOString(),
    },
  ],
  status: 'completed',
});

updateProposals.push(
  {
    id: 'prop-001',
    radarId: 'radar-001',
    findingId: 'f-004',
    title: 'Upgrade Node.js to v22.5.1 (Security Patch)',
    finding: 'Critical Node.js security patch (CVE-2026-XXXX)',
    impact: 'critical',
    category: 'security',
    action: {
      type: 'dependency_upgrade',
      target: 'Node.js runtime',
      description: 'Upgrade Node.js from current version to 22.5.1 to patch HTTP/2 vulnerability',
      effort: 'low',
      risk: 'Minimal — patch release, backward compatible',
    },
    rollback: 'Revert to previous Node.js version via nvm',
    status: 'pending',
    created: new Date().toISOString(),
  },
  {
    id: 'prop-002',
    radarId: 'radar-001',
    findingId: 'f-002',
    title: 'Integrate Firecrawl MCP server for web intelligence',
    finding: 'Firecrawl v2.0 adds structured extraction and MCP server',
    impact: 'high',
    category: 'tools',
    action: {
      type: 'new_tool',
      target: '.claude/claude.md (MCP config)',
      description: 'Add Firecrawl MCP server to the stack for structured web crawling. Replaces manual WebFetch calls in scout agent with schema-driven extraction.',
      effort: 'medium',
      risk: 'New dependency — requires API key and adds to monthly costs (~$20/month)',
    },
    rollback: 'Remove Firecrawl MCP server config, revert scout to WebFetch',
    status: 'pending',
    created: new Date().toISOString(),
  },
  {
    id: 'prop-003',
    radarId: 'radar-001',
    findingId: 'f-001',
    title: 'Migrate to Opus 4.8 effort-based routing',
    finding: 'Claude Opus 4.8 released with 1M context, effort controls, dynamic workflows, and adaptive thinking',
    impact: 'high',
    category: 'models',
    action: {
      type: 'config_change',
      target: '.claude/agents/*.md + server.js',
      description: 'Consolidate Opus/Sonnet/Haiku into single Opus 4.8 model with effort routing (xhigh=strategic, high=professional, low=scout). Enables 1M context, dynamic workflows for mission orchestration, and improved tool triggering.',
      effort: 'medium',
      risk: 'Effort-level token allocation differs from 4.7 — monitor cost and latency during transition',
    },
    rollback: 'Revert to separate Opus 4.7/Sonnet/Haiku model routing',
    status: 'pending',
    created: new Date().toISOString(),
  }
);

function logActivity(type, message, details = {}) {
  const entry = { id: uuidv4(), type, message, details, timestamp: new Date().toISOString() };
  activityLog.unshift(entry);
  if (activityLog.length > 500) activityLog.length = 500;
  broadcast({ event: 'activity', data: entry });
  scheduleAutoSave();
  return entry;
}

// --- API Routes ---

// Agents
app.get('/api/agents', (req, res) => {
  res.json(readDir(path.join(CLAUDE_DIR, 'agents')));
});

app.get('/api/agents/:name', (req, res) => {
  const fpath = path.join(CLAUDE_DIR, 'agents', req.params.name);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(fpath, 'utf-8');
  res.json({ filename: req.params.name, ...parseFrontmatter(content) });
});

app.put('/api/agents/:name', (req, res) => {
  const fpath = path.join(CLAUDE_DIR, 'agents', req.params.name);
  fs.writeFileSync(fpath, req.body.content, 'utf-8');
  logActivity('agent', `Agent updated: ${req.params.name}`);
  res.json({ ok: true });
});

// Skills — Enhanced with parameter parsing
function parseSkillParams(body) {
  const params = [];
  const paramMatch = body.match(/## Parameters\n([\s\S]*?)(?=\n##|\n$|$)/);
  if (!paramMatch) return params;
  const lines = paramMatch[1].split('\n').filter(l => l.trim().startsWith('- `'));
  for (const line of lines) {
    const m = line.match(/- `(\w+)`:\s*(Required\.)?\s*(.*)/i);
    if (!m) continue;
    const name = m[1];
    const required = !!m[2];
    const rest = m[3] || '';
    // Parse options from "opt1|opt2|opt3" patterns
    const optMatch = rest.match(/(\w+(?:\|\w+(?:-\w+)*)+)/);
    const options = optMatch ? optMatch[1].split('|') : [];
    // Parse default from "(default: xxx)"
    const defMatch = rest.match(/\(default:\s*(.+?)\)/);
    const defaultVal = defMatch ? defMatch[1].trim() : '';
    // Clean description — remove the options and default parts
    let description = rest
      .replace(/\(default:\s*.+?\)/, '')
      .replace(/(\w+\|)+\w+(-\w+)*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Determine input type
    let inputType = 'text';
    if (options.length > 0) inputType = 'select';
    else if (name === 'word_count' || name === 'min_sources') inputType = 'number';
    else if (name === 'include_semgrep') inputType = 'toggle';

    params.push({ name, required, description, options, default: defaultVal, inputType });
  }
  return params;
}

function parseSkillSteps(body) {
  const steps = [];
  const processMatch = body.match(/## Process\n([\s\S]*?)(?=\n##|$)/);
  if (!processMatch) return steps;
  const lines = processMatch[1].split('\n');
  for (const line of lines) {
    const m = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s*[—-]?\s*(.*)/);
    if (m) steps.push({ name: m[1], description: m[2] || '' });
  }
  return steps;
}

function parseSkillAgents(body) {
  const agents = [];
  const agentMatch = body.match(/## Agents Used\n([\s\S]*?)(?=\n##|$)/);
  if (!agentMatch) return agents;
  const lines = agentMatch[1].split('\n').filter(l => l.trim().startsWith('- **'));
  for (const line of lines) {
    const m = line.match(/- \*\*(.+?)\*\*\s*(?:\((.+?)\))?\s*[—-]?\s*(.*)/);
    if (m) agents.push({ name: m[1], model: m[2] || '', role: m[3] || '' });
  }
  return agents;
}

app.get('/api/skills', (req, res) => {
  const skills = readDir(path.join(CLAUDE_DIR, 'skills'));
  // Enrich with parsed parameters, steps, and agents
  const enriched = skills.map(s => ({
    ...s,
    parameters: parseSkillParams(s.body),
    steps: parseSkillSteps(s.body),
    agents: parseSkillAgents(s.body),
  }));
  res.json(enriched);
});

app.get('/api/skills/:name', (req, res) => {
  const fpath = path.join(CLAUDE_DIR, 'skills', req.params.name);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Skill not found' });
  const content = fs.readFileSync(fpath, 'utf-8');
  const parsed = parseFrontmatter(content);
  res.json({
    filename: req.params.name,
    ...parsed,
    parameters: parseSkillParams(parsed.body),
    steps: parseSkillSteps(parsed.body),
    agents: parseSkillAgents(parsed.body),
  });
});

app.post('/api/skills/:name/execute', (req, res) => {
  const name = req.params.name;
  const fpath = path.join(CLAUDE_DIR, 'skills', name);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Skill not found' });

  const content = fs.readFileSync(fpath, 'utf-8');
  const parsed = parseFrontmatter(content);
  const steps = parseSkillSteps(parsed.body);
  const agents = parseSkillAgents(parsed.body);
  const skillName = parsed.meta?.name || name.replace('.md', '');

  const id = uuidv4();
  const execution = {
    id,
    skill: name,
    skillName,
    status: 'queued',
    params: req.body.params || {},
    steps: steps.map((s, i) => ({ ...s, status: 'pending', index: i })),
    agents: agents.map(a => a.name),
    startedAt: new Date().toISOString(),
    log: [],
    progress: 0,
  };
  workflows.set(id, execution);
  logActivity('skill', `Skill queued: ${skillName}`, { executionId: id });
  appendLog(`SKILL_EXEC: ${skillName} -> ${id}`);

  // Simulate step-by-step execution with progress
  const stepCount = Math.max(steps.length, 3);
  const stepDuration = 1500;

  setTimeout(() => {
    execution.status = 'running';
    execution.log.push({ t: Date.now(), msg: `Orchestrator assigned: executing "${skillName}"` });
    if (execution.steps.length > 0) {
      execution.steps[0].status = 'running';
    }
    broadcast({ event: 'workflow_update', data: execution });
    broadcast({ event: 'skill_progress', data: { id, progress: 0, step: execution.steps[0]?.name || 'Initializing' } });
  }, 400);

  for (let i = 0; i < stepCount; i++) {
    setTimeout(() => {
      if (execution.steps[i]) {
        execution.steps[i].status = 'completed';
        if (execution.steps[i + 1]) execution.steps[i + 1].status = 'running';
      }
      execution.progress = Math.round(((i + 1) / stepCount) * 100);
      const stepName = execution.steps[i]?.name || `Step ${i + 1}`;
      execution.log.push({ t: Date.now(), msg: `${stepName} completed` });
      broadcast({ event: 'workflow_update', data: execution });
      broadcast({ event: 'skill_progress', data: { id, progress: execution.progress, step: stepName } });
    }, 400 + stepDuration * (i + 1));
  }

  setTimeout(() => {
    execution.status = 'completed';
    execution.completedAt = new Date().toISOString();
    execution.progress = 100;
    execution.log.push({ t: Date.now(), msg: 'All steps completed successfully.' });
    broadcast({ event: 'workflow_update', data: execution });
    broadcast({ event: 'skill_progress', data: { id, progress: 100, step: 'Complete' } });
    logActivity('skill', `Skill completed: ${skillName}`, { executionId: id });
  }, 400 + stepDuration * stepCount + 500);

  res.json(execution);
});

// --- Verification Protocols (Plan-Execute-Verify) ---
const verifications = new Map();

function loadVerificationRubrics() {
  const rubricsPath = path.join(CLAUDE_DIR, 'rules', 'verification-rubrics.yaml');
  if (!fs.existsSync(rubricsPath)) return {};
  try {
    return yaml.load(fs.readFileSync(rubricsPath, 'utf-8'));
  } catch (e) {
    console.error('Failed to load rubrics:', e.message);
    return {};
  }
}

function getRubricForCategory(category) {
  const rubrics = loadVerificationRubrics();
  const defaultRubric = rubrics.default || { checks: [] };
  const catRubric = rubrics[category];

  if (!catRubric) return { ...defaultRubric, category: 'default' };

  // Merge inherited checks with category-specific ones
  const checks = catRubric.inherits === 'default'
    ? [...defaultRubric.checks, ...catRubric.checks]
    : catRubric.checks;

  return {
    name: catRubric.name,
    description: catRubric.description,
    category,
    checks,
  };
}

function simulateVerification(rubric, strictness = 'standard') {
  // Simulate verification scoring for each check
  const thresholds = { lenient: 0.6, standard: 0.75, strict: 0.9 };
  const passThreshold = thresholds[strictness] || 0.75;

  const results = rubric.checks.map(check => {
    // Simulate realistic scores — most pass, some partial, rare fails
    const rand = Math.random();
    let score, status, notes;

    if (rand > 0.15) {
      score = 85 + Math.floor(Math.random() * 15); // 85-100
      status = 'pass';
      notes = 'Meets criteria';
    } else if (rand > 0.03) {
      score = 55 + Math.floor(Math.random() * 25); // 55-80
      status = 'partial';
      notes = `Partially meets criteria — ${check.description.toLowerCase()} needs improvement`;
    } else {
      score = 20 + Math.floor(Math.random() * 35); // 20-55
      status = 'fail';
      notes = `Does not meet criteria — ${check.description.toLowerCase()} is missing or inadequate`;
    }

    return {
      ...check,
      score,
      status,
      notes,
      weightedScore: Math.round(score * check.weight),
    };
  });

  // Calculate aggregate score
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const totalWeightedScore = results.reduce((sum, r) => sum + r.weightedScore, 0);
  const aggregateScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;

  // Determine verdict
  let verdict;
  if (aggregateScore >= 80) verdict = 'pass';
  else if (aggregateScore >= 60) verdict = 'review';
  else verdict = 'fail';

  return { results, aggregateScore, verdict, strictness };
}

// Seed some verification history
function seedVerifications() {
  const seeds = [
    {
      id: uuidv4(),
      executionId: 'seed-exec-1',
      skillName: 'research-brief',
      category: 'research',
      rubricName: 'Research Quality',
      status: 'completed',
      verdict: 'pass',
      score: 91,
      checksPassed: 9,
      checksPartial: 1,
      checksFailed: 0,
      checksTotal: 10,
      strictness: 'standard',
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      completedAt: new Date(Date.now() - 7100000).toISOString(),
      results: [],
    },
    {
      id: uuidv4(),
      executionId: 'seed-exec-2',
      skillName: 'content-creation',
      category: 'marketing',
      rubricName: 'Content Quality',
      status: 'completed',
      verdict: 'review',
      score: 72,
      checksPassed: 6,
      checksPartial: 3,
      checksFailed: 1,
      checksTotal: 10,
      strictness: 'standard',
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      completedAt: new Date(Date.now() - 3500000).toISOString(),
      results: [],
    },
    {
      id: uuidv4(),
      executionId: 'seed-exec-3',
      skillName: 'security-audit',
      category: 'security',
      rubricName: 'Security Assessment Quality',
      status: 'completed',
      verdict: 'pass',
      score: 88,
      checksPassed: 8,
      checksPartial: 2,
      checksFailed: 0,
      checksTotal: 10,
      strictness: 'strict',
      startedAt: new Date(Date.now() - 1800000).toISOString(),
      completedAt: new Date(Date.now() - 1700000).toISOString(),
      results: [],
    },
  ];
  seeds.forEach(s => verifications.set(s.id, s));
}
seedVerifications();

// API: Get all rubrics
app.get('/api/verify/rubrics', (req, res) => {
  const rubrics = loadVerificationRubrics();
  const summary = Object.entries(rubrics).map(([key, val]) => ({
    id: key,
    name: val.name,
    description: val.description,
    checkCount: val.checks?.length || 0,
    inherits: val.inherits || null,
  }));
  res.json(summary);
});

// API: Get specific rubric with all checks
app.get('/api/verify/rubrics/:category', (req, res) => {
  const rubric = getRubricForCategory(req.params.category);
  res.json(rubric);
});

// API: Get verification history
app.get('/api/verify/history', (req, res) => {
  const all = [...verifications.values()].sort((a, b) => b.startedAt > a.startedAt ? 1 : -1);
  res.json(all);
});

// API: Get verification stats (must be before :id route)
app.get('/api/verify/stats', (req, res) => {
  const all = [...verifications.values()].filter(v => v.status === 'completed');
  const total = all.length;
  const passed = all.filter(v => v.verdict === 'pass').length;
  const review = all.filter(v => v.verdict === 'review').length;
  const failed = all.filter(v => v.verdict === 'fail').length;
  const avgScore = total > 0 ? Math.round(all.reduce((s, v) => s + v.score, 0) / total) : 0;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  const byCategory = {};
  all.forEach(v => {
    if (!byCategory[v.category]) byCategory[v.category] = { total: 0, passed: 0, avgScore: 0, scores: [] };
    byCategory[v.category].total++;
    if (v.verdict === 'pass') byCategory[v.category].passed++;
    byCategory[v.category].scores.push(v.score);
  });
  Object.values(byCategory).forEach(c => {
    c.avgScore = Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length);
    c.passRate = Math.round((c.passed / c.total) * 100);
    delete c.scores;
  });

  res.json({ total, passed, review, failed, avgScore, passRate, byCategory });
});

// API: Get single verification report
app.get('/api/verify/:id', (req, res) => {
  const v = verifications.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Verification not found' });
  res.json(v);
});

// API: Run verification on an execution
app.post('/api/verify/run', (req, res) => {
  const { executionId, rubricCategory, strictness = 'standard', autoApprove = true } = req.body;

  // Determine category — auto-detect from execution or use provided
  let category = rubricCategory || 'default';
  if (executionId && category === 'auto') {
    const exec = workflows.get(executionId);
    if (exec) {
      const skill = readDir(path.join(CLAUDE_DIR, 'skills')).find(s => s.filename === exec.skill);
      category = skill?.meta?.category || 'default';
    }
  }

  const rubric = getRubricForCategory(category);
  const verification = simulateVerification(rubric, strictness);

  const id = uuidv4();
  const exec = executionId ? workflows.get(executionId) : null;
  const report = {
    id,
    executionId: executionId || null,
    skillName: exec?.skillName || req.body.skillName || 'manual',
    category,
    rubricName: rubric.name,
    status: 'running',
    verdict: null,
    score: 0,
    checksPassed: 0,
    checksPartial: 0,
    checksFailed: 0,
    checksTotal: rubric.checks.length,
    strictness,
    autoApprove,
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: [],
  };

  verifications.set(id, report);
  broadcast({ event: 'verification_update', data: report });
  logActivity('verification', `Verification started: ${report.skillName}`, { verificationId: id });

  // Simulate progressive check execution
  const checkDuration = 800;
  verification.results.forEach((result, i) => {
    setTimeout(() => {
      report.results.push(result);
      report.checksPassed = report.results.filter(r => r.status === 'pass').length;
      report.checksPartial = report.results.filter(r => r.status === 'partial').length;
      report.checksFailed = report.results.filter(r => r.status === 'fail').length;
      report.score = verification.aggregateScore;
      broadcast({ event: 'verification_update', data: report });
    }, checkDuration * (i + 1));
  });

  // Complete verification
  setTimeout(() => {
    report.status = 'completed';
    report.verdict = verification.verdict;
    report.score = verification.aggregateScore;
    report.completedAt = new Date().toISOString();
    report.results = verification.results;
    report.checksPassed = verification.results.filter(r => r.status === 'pass').length;
    report.checksPartial = verification.results.filter(r => r.status === 'partial').length;
    report.checksFailed = verification.results.filter(r => r.status === 'fail').length;

    // If linked to an execution, update its verification status
    if (exec) {
      exec.verification = {
        id,
        verdict: report.verdict,
        score: report.score,
      };
      broadcast({ event: 'workflow_update', data: exec });
    }

    // Route based on verdict
    if (report.verdict === 'review') {
      logActivity('verification', `Verification needs review: ${report.skillName} (score: ${report.score})`, { verificationId: id });
      broadcast({ event: 'notification', data: {
        title: `Verification Review: ${report.skillName}`,
        message: `Score ${report.score}/100 — needs human review before delivery`,
        priority: 'medium',
        timestamp: new Date().toISOString(),
      }});
    } else if (report.verdict === 'fail') {
      logActivity('verification', `Verification FAILED: ${report.skillName} (score: ${report.score})`, { verificationId: id });
      broadcast({ event: 'notification', data: {
        title: `Verification Failed: ${report.skillName}`,
        message: `Score ${report.score}/100 — output returned to agent for revision`,
        priority: 'high',
        timestamp: new Date().toISOString(),
      }});
    } else {
      logActivity('verification', `Verification passed: ${report.skillName} (score: ${report.score})`, { verificationId: id });
    }

    broadcast({ event: 'verification_update', data: report });
    appendLog(`VERIFY: ${report.skillName} -> ${report.verdict} (${report.score}/100)`);
  }, checkDuration * verification.results.length + 500);

  res.json(report);
});

// API: Override verification verdict (human override)
app.put('/api/verify/:id/override', (req, res) => {
  const v = verifications.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Verification not found' });

  const { verdict, reason } = req.body;
  if (!['pass', 'review', 'fail'].includes(verdict)) {
    return res.status(400).json({ error: 'Invalid verdict' });
  }

  v.verdict = verdict;
  v.overriddenAt = new Date().toISOString();
  v.overrideReason = reason || 'Human override';
  logActivity('verification', `Verdict overridden to ${verdict}: ${v.skillName}`, { verificationId: v.id });
  broadcast({ event: 'verification_update', data: v });
  res.json(v);
});

// Workflows
app.get('/api/workflows', (req, res) => {
  res.json([...workflows.values()].sort((a, b) => b.startedAt > a.startedAt ? 1 : -1));
});

app.get('/api/workflows/:id', (req, res) => {
  const wf = workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf);
});

// Mission
app.get('/api/mission', (req, res) => {
  const mpath = path.join(MAGENT_DIR, 'mission.md');
  if (!fs.existsSync(mpath)) return res.json({ exists: false });
  res.json({ exists: true, ...parseFrontmatter(fs.readFileSync(mpath, 'utf-8')) });
});

app.put('/api/mission', (req, res) => {
  const mpath = path.join(MAGENT_DIR, 'mission.md');
  fs.writeFileSync(mpath, req.body.content, 'utf-8');
  logActivity('mission', 'Mission updated');
  appendLog(`MISSION_UPDATE`);
  res.json({ ok: true });
});

// Team
app.get('/api/team', (req, res) => {
  const tpath = path.join(MAGENT_DIR, 'team.yaml');
  if (!fs.existsSync(tpath)) return res.json({ exists: false });
  try {
    res.json({ exists: true, team: yaml.load(fs.readFileSync(tpath, 'utf-8')) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/team', (req, res) => {
  const tpath = path.join(MAGENT_DIR, 'team.yaml');
  fs.writeFileSync(tpath, yaml.dump(req.body.team), 'utf-8');
  logActivity('team', 'Team roster updated');
  res.json({ ok: true });
});

// Activity log
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(activityLog.slice(0, limit));
});

// Decision log
app.get('/api/decisions', (req, res) => {
  const logPath = path.join(MAGENT_DIR, 'decisions.log');
  if (!fs.existsSync(logPath)) return res.json([]);
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  res.json(lines.slice(-100).reverse());
});

// Plans
app.get('/api/plans', (req, res) => {
  res.json(readDir(path.join(MAGENT_DIR, 'plans')));
});

app.post('/api/plans', (req, res) => {
  const id = `plan-${Date.now()}`;
  const fpath = path.join(MAGENT_DIR, 'plans', `${id}.md`);
  const content = `---\nid: ${id}\nstatus: pending\ncreated: ${new Date().toISOString()}\n---\n${req.body.content}`;
  fs.writeFileSync(fpath, content, 'utf-8');
  logActivity('plan', `Plan created: ${id}`);
  appendLog(`PLAN_CREATED: ${id}`);
  res.json({ id, status: 'pending' });
});

// Artifacts
app.get('/api/artifacts', (req, res) => {
  const arts = [];
  const artDir = path.join(MAGENT_DIR, 'artifacts');
  if (!fs.existsSync(artDir)) return res.json([]);
  const subdirs = fs.readdirSync(artDir, { withFileTypes: true });
  for (const sub of subdirs) {
    if (sub.isDirectory()) {
      const files = fs.readdirSync(path.join(artDir, sub.name));
      for (const f of files) {
        const stat = fs.statSync(path.join(artDir, sub.name, f));
        arts.push({ category: sub.name, filename: f, size: stat.size, modified: stat.mtime });
      }
    }
  }
  res.json(arts);
});

// Rules
app.get('/api/rules', (req, res) => {
  res.json(readDir(path.join(CLAUDE_DIR, 'rules')));
});

// --- Tech Radar ---

// Get all radar reports
app.get('/api/tech-radar/reports', (req, res) => {
  res.json(techRadarReports);
});

// Get latest radar report
app.get('/api/tech-radar/latest', (req, res) => {
  if (!techRadarReports.length) return res.json({ exists: false });
  res.json({ exists: true, report: techRadarReports[techRadarReports.length - 1] });
});

// Get all update proposals
app.get('/api/tech-radar/proposals', (req, res) => {
  const status = req.query.status;
  if (status) {
    res.json(updateProposals.filter(p => p.status === status));
  } else {
    res.json(updateProposals);
  }
});

// Approve/reject an update proposal
app.put('/api/tech-radar/proposals/:id', (req, res) => {
  const proposal = updateProposals.find(p => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const { verdict } = req.body; // 'approved' or 'rejected'
  proposal.status = verdict;
  proposal.resolvedAt = new Date().toISOString();

  logActivity('radar', `Update proposal ${verdict}: ${proposal.title}`);
  appendLog(`RADAR_PROPOSAL_${verdict.toUpperCase()}: ${proposal.id} — ${proposal.title}`);

  // If approved, create a follow-up inbox item for implementation tracking
  if (verdict === 'approved') {
    broadcast({
      event: 'activity',
      data: {
        id: uuidv4(),
        type: 'radar',
        message: `Approved update: ${proposal.title} — dispatching to agents`,
        timestamp: new Date().toISOString(),
      },
    });
  }

  broadcast({ event: 'proposal_update', data: proposal });
  res.json(proposal);
});

// Trigger a manual radar sweep
app.post('/api/tech-radar/sweep', (req, res) => {
  const sweepType = req.body.sweep_type || 'daily';
  const id = `radar-${Date.now()}`;

  logActivity('radar', `Tech Radar sweep initiated (${sweepType})`);
  appendLog(`RADAR_SWEEP: ${id} (${sweepType})`);

  // Simulate sweep execution
  broadcast({
    event: 'activity',
    data: {
      id: uuidv4(),
      type: 'radar',
      message: `Scout agent dispatched for ${sweepType} intelligence sweep`,
      timestamp: new Date().toISOString(),
    },
  });

  // Update fleet status
  broadcast({ event: 'fleet_update', data: { agent: 'scout', status: 'running' } });

  setTimeout(() => {
    broadcast({ event: 'fleet_update', data: { agent: 'scout', status: 'idle' } });
    broadcast({
      event: 'activity',
      data: {
        id: uuidv4(),
        type: 'radar',
        message: `Radar sweep completed — findings queued for orchestrator review`,
        timestamp: new Date().toISOString(),
      },
    });
  }, 5000);

  res.json({ id, status: 'running', sweep_type: sweepType });
});

// --- Agent Scheduler ---

const schedules = new Map();
const scheduleHistory = [];

function runScheduledAgent(scheduleId) {
  const sched = schedules.get(scheduleId);
  if (!sched || !sched.enabled) return;

  sched.lastRun = new Date().toISOString();
  sched.runCount = (sched.runCount || 0) + 1;
  sched.status = 'running';

  const runEntry = {
    id: uuidv4(),
    scheduleId,
    agent: sched.agent,
    skill: sched.skill,
    startedAt: sched.lastRun,
    status: 'running',
  };
  scheduleHistory.unshift(runEntry);
  if (scheduleHistory.length > 100) scheduleHistory.length = 100;

  logActivity('schedule', `Scheduled run: ${sched.agent} → ${sched.skill}`);
  appendLog(`SCHEDULE_RUN: ${sched.agent} (${sched.skill}) [${scheduleId}]`);

  broadcast({ event: 'fleet_update', data: { agent: sched.agent, status: 'running' } });
  broadcast({ event: 'schedule_update', data: sched });

  // Simulate agent execution (in production, this would invoke Claude Code CLI or Codex)
  setTimeout(() => {
    sched.status = 'idle';
    sched.nextRun = getNextRun(sched.cron);
    runEntry.status = 'completed';
    runEntry.completedAt = new Date().toISOString();

    broadcast({ event: 'fleet_update', data: { agent: sched.agent, status: 'idle' } });
    broadcast({ event: 'schedule_update', data: sched });

    logActivity('schedule', `Scheduled run completed: ${sched.agent} → ${sched.skill}`);

    // For scout, broadcast that findings are ready for review
    if (sched.agent === 'scout') {
      broadcast({
        event: 'activity',
        data: {
          id: uuidv4(),
          type: 'radar',
          message: 'Daily intelligence sweep completed — review new findings in Tech Radar',
          timestamp: new Date().toISOString(),
        },
      });
    }

    // For researcher, broadcast that brief is ready
    if (sched.agent === 'researcher') {
      broadcast({
        event: 'activity',
        data: {
          id: uuidv4(),
          type: 'skill',
          message: 'Daily research brief completed — new insights available in Artifacts',
          timestamp: new Date().toISOString(),
        },
      });
    }
  }, 8000);
}

function getNextRun(cronExpr) {
  try {
    const interval = cron.validate(cronExpr) ? cronExpr : null;
    if (!interval) return null;
    // Approximate next run — node-cron doesn't expose this directly
    const now = new Date();
    const parts = cronExpr.split(' ');
    const hour = parseInt(parts[1]) || 0;
    const minute = parseInt(parts[0]) || 0;
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  } catch {
    return null;
  }
}

function createSchedule(id, config) {
  const schedule = {
    id,
    agent: config.agent,
    skill: config.skill,
    cron: config.cron,
    description: config.description,
    enabled: config.enabled !== false,
    status: 'idle',
    lastRun: null,
    nextRun: getNextRun(config.cron),
    runCount: 0,
    createdAt: new Date().toISOString(),
  };

  // Create the cron job
  if (cron.validate(config.cron)) {
    const job = cron.schedule(config.cron, () => runScheduledAgent(id), {
      scheduled: schedule.enabled,
    });
    schedule._job = job;
  }

  schedules.set(id, schedule);
  logActivity('schedule', `Schedule created: ${config.agent} → ${config.skill} (${config.cron})`);
  appendLog(`SCHEDULE_CREATED: ${id} — ${config.agent} (${config.cron})`);
  return schedule;
}

// Seed the two daily schedules
createSchedule('sched-scout-daily', {
  agent: 'scout',
  skill: 'tech-radar',
  cron: '0 6 * * *',  // 6:00 AM daily
  description: 'Daily intelligence sweep — crawl AI/tech sources for advancements and generate update proposals',
});

createSchedule('sched-researcher-daily', {
  agent: 'researcher',
  skill: 'research-brief',
  cron: '0 7 * * *',  // 7:00 AM daily
  description: 'Daily research brief — gather trending topics, industry news, and competitive intelligence',
});

// --- Schedule API ---

app.get('/api/schedules', (req, res) => {
  const result = [...schedules.values()].map(s => ({
    id: s.id,
    agent: s.agent,
    skill: s.skill,
    cron: s.cron,
    description: s.description,
    enabled: s.enabled,
    status: s.status,
    lastRun: s.lastRun,
    nextRun: s.nextRun,
    runCount: s.runCount,
    createdAt: s.createdAt,
  }));
  res.json(result);
});

app.get('/api/schedules/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(scheduleHistory.slice(0, limit));
});

app.put('/api/schedules/:id/toggle', (req, res) => {
  const sched = schedules.get(req.params.id);
  if (!sched) return res.status(404).json({ error: 'Schedule not found' });

  sched.enabled = !sched.enabled;
  if (sched._job) {
    sched.enabled ? sched._job.start() : sched._job.stop();
  }
  sched.nextRun = sched.enabled ? getNextRun(sched.cron) : null;

  logActivity('schedule', `Schedule ${sched.enabled ? 'enabled' : 'paused'}: ${sched.agent} → ${sched.skill}`);
  broadcast({ event: 'schedule_update', data: { ...sched, _job: undefined } });
  res.json({ id: sched.id, enabled: sched.enabled });
});

app.post('/api/schedules/:id/run', (req, res) => {
  const sched = schedules.get(req.params.id);
  if (!sched) return res.status(404).json({ error: 'Schedule not found' });
  if (sched.status === 'running') return res.status(409).json({ error: 'Already running' });

  runScheduledAgent(req.params.id);
  res.json({ id: sched.id, status: 'running' });
});

app.post('/api/schedules', (req, res) => {
  const { agent, skill, cron: cronExpr, description } = req.body;
  if (!agent || !skill || !cronExpr) {
    return res.status(400).json({ error: 'agent, skill, and cron are required' });
  }
  if (!cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  const id = `sched-${Date.now()}`;
  const schedule = createSchedule(id, { agent, skill, cron: cronExpr, description: description || '' });
  res.json({ id: schedule.id, agent, skill, cron: cronExpr, enabled: true });
});

// --- Memory Vault API ---

app.get('/api/vault', (req, res) => {
  res.json(getVaultStats());
});

app.get('/api/vault/search', (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json([]);
  res.json(searchVault(q));
});

app.get('/api/vault/context', (req, res) => {
  res.json(getSessionContext());
});

app.get('/api/vault/:folder', (req, res) => {
  const folder = req.params.folder;
  if (!['raw', 'wiki', 'outputs'].includes(folder)) {
    return res.status(400).json({ error: 'Invalid vault folder' });
  }
  const dir = path.join(VAULT_DIR, folder);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  const result = files.map(f => {
    const fpath = path.join(dir, f);
    const fstat = fs.statSync(fpath);
    const parsed = f.endsWith('.md') ? parseFrontmatter(fs.readFileSync(fpath, 'utf-8')) : { meta: {} };
    return {
      name: f,
      folder,
      size: fstat.size,
      modified: fstat.mtime.toISOString(),
      tags: parsed.meta?.tags || [],
      type: parsed.meta?.type || folder,
    };
  });
  res.json(result);
});

app.get('/api/vault/:folder/:file', (req, res) => {
  const { folder, file } = req.params;
  if (!['raw', 'wiki', 'outputs'].includes(folder)) {
    return res.status(400).json({ error: 'Invalid vault folder' });
  }
  const fpath = path.join(VAULT_DIR, folder, file);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'File not found' });
  const content = fs.readFileSync(fpath, 'utf-8');
  const parsed = parseFrontmatter(content);
  res.json({ name: file, folder, content, ...parsed });
});

app.post('/api/vault/:folder', (req, res) => {
  const { folder } = req.params;
  if (!['raw', 'wiki', 'outputs'].includes(folder)) {
    return res.status(400).json({ error: 'Invalid vault folder' });
  }
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });
  const dir = path.join(VAULT_DIR, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
  logActivity('vault', `File saved to vault/${folder}/${filename}`);
  appendLog(`VAULT_WRITE: ${folder}/${filename}`);
  res.json({ ok: true, path: `vault/${folder}/${filename}` });
});

// --- Cost Tracking API ---

app.get('/api/costs', (req, res) => {
  res.json(getCostSummary());
});

app.get('/api/costs/budget', (req, res) => {
  res.json(costBudget);
});

app.put('/api/costs/budget', (req, res) => {
  const { daily, weekly, monthly } = req.body;
  if (daily !== undefined) costBudget.daily = daily;
  if (weekly !== undefined) costBudget.weekly = weekly;
  if (monthly !== undefined) costBudget.monthly = monthly;
  logActivity('cost', `Budget updated: $${costBudget.daily}/day, $${costBudget.weekly}/week, $${costBudget.monthly}/month`);
  res.json(costBudget);
});

app.post('/api/costs/track', (req, res) => {
  const { agent, model, skill, inputTokens, outputTokens } = req.body;
  if (!agent || !model) return res.status(400).json({ error: 'agent and model required' });
  const rates = COST_RATES[model] || COST_RATES['opus-4.8-high'];
  const cost = ((inputTokens || 0) / 1_000_000) * rates.input + ((outputTokens || 0) / 1_000_000) * rates.output;
  const entry = {
    id: uuidv4(),
    agent,
    model,
    skill: skill || 'unknown',
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cost: Math.round(cost * 10000) / 10000,
    timestamp: new Date().toISOString(),
  };
  costLedger.push(entry);
  broadcast({ event: 'cost_update', data: entry });

  // Check budget alerts
  const summary = getCostSummary();
  const dailyPct = (summary.daily.cost / costBudget.daily) * 100;
  if (dailyPct >= 75) {
    broadcast({
      event: 'activity',
      data: {
        id: uuidv4(),
        type: 'cost',
        message: `Budget alert: Daily spend at ${Math.round(dailyPct)}% ($${summary.daily.cost.toFixed(2)}/$${costBudget.daily})`,
        timestamp: new Date().toISOString(),
      },
    });
  }

  res.json(entry);
});

// --- Automation Bridge API ---

const CONFIG_DIR = path.join(CLAUDE_DIR, 'config');

function loadAutomationRegistry() {
  const regPath = path.join(CONFIG_DIR, 'automation-registry.yaml');
  if (!fs.existsSync(regPath)) return { platforms: {}, actions: [] };
  try {
    return yaml.load(fs.readFileSync(regPath, 'utf-8'));
  } catch { return { platforms: {}, actions: [] }; }
}

const automationLog = [];

// Seed demo automation history
automationLog.push(
  {
    id: uuidv4(),
    action: 'post-slack',
    platform: 'n8n',
    status: 'completed',
    payload: { channel: '#ai-os-alerts', message: 'Daily intelligence sweep completed — 5 findings, 3 proposals' },
    response: { code: 200, execution_id: 'n8n-exec-4821' },
    triggeredBy: 'scout',
    timestamp: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: uuidv4(),
    action: 'send-email',
    platform: 'n8n',
    status: 'completed',
    payload: { to: 'team@company.com', subject: 'Security Audit Report', body: '(report attached)' },
    response: { code: 200, execution_id: 'n8n-exec-4819' },
    triggeredBy: 'security-auditor',
    timestamp: new Date(Date.now() - 172800000).toISOString(),
  },
  {
    id: uuidv4(),
    action: 'create-task',
    platform: 'zapier',
    status: 'completed',
    payload: { title: 'Review DeepSeek V4 integration', description: 'Verify cost routing after engine switch' },
    response: { code: 200 },
    triggeredBy: 'orchestrator',
    timestamp: new Date(Date.now() - 259200000).toISOString(),
  },
);

app.get('/api/automations/registry', (req, res) => {
  const registry = loadAutomationRegistry();
  res.json(registry);
});

app.get('/api/automations/actions', (req, res) => {
  const registry = loadAutomationRegistry();
  res.json(registry.actions || []);
});

app.get('/api/automations/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(automationLog.slice(0, limit));
});

app.post('/api/automations/trigger', (req, res) => {
  const { action, payload, triggeredBy } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });

  const registry = loadAutomationRegistry();
  const actionDef = (registry.actions || []).find(a => a.id === action);
  if (!actionDef) return res.status(404).json({ error: `Action "${action}" not found in registry` });

  const entry = {
    id: uuidv4(),
    action,
    platform: actionDef.platform,
    status: 'pending_approval',
    gate: actionDef.gate,
    payload: payload || {},
    actionDef,
    triggeredBy: triggeredBy || 'orchestrator',
    timestamp: new Date().toISOString(),
  };

  automationLog.unshift(entry);
  logActivity('automation', `Automation queued: ${actionDef.name} (${actionDef.platform}) — awaiting approval`);
  appendLog(`AUTOMATION_QUEUED: ${action} by ${entry.triggeredBy}`);

  // Send notification for approval
  sendNotification(
    `Automation approval: ${actionDef.name}`,
    `${entry.triggeredBy} wants to trigger "${actionDef.name}" via ${actionDef.platform}. Payload: ${JSON.stringify(payload).substring(0, 100)}`,
    actionDef.gate === 'blocking' ? 'critical' : 'normal'
  );

  broadcast({ event: 'automation_update', data: entry });
  res.json(entry);
});

app.put('/api/automations/:id/approve', (req, res) => {
  const entry = automationLog.find(a => a.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (entry.status !== 'pending_approval') return res.status(400).json({ error: 'Not pending approval' });

  entry.status = 'executing';
  broadcast({ event: 'automation_update', data: entry });
  broadcast({ event: 'fleet_update', data: { agent: 'automator', status: 'running' } });

  // Simulate execution
  setTimeout(() => {
    entry.status = 'completed';
    entry.response = { code: 200, execution_id: `${entry.platform}-exec-${Date.now()}` };
    entry.completedAt = new Date().toISOString();

    logActivity('automation', `Automation completed: ${entry.action} via ${entry.platform}`);
    appendLog(`AUTOMATION_COMPLETED: ${entry.action} -> ${entry.response.execution_id}`);
    broadcast({ event: 'fleet_update', data: { agent: 'automator', status: 'idle' } });
    broadcast({ event: 'automation_update', data: entry });
  }, 2500);

  res.json(entry);
});

app.put('/api/automations/:id/reject', (req, res) => {
  const entry = automationLog.find(a => a.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  entry.status = 'rejected';
  entry.completedAt = new Date().toISOString();
  logActivity('automation', `Automation rejected: ${entry.action}`);
  broadcast({ event: 'automation_update', data: entry });
  res.json(entry);
});

// --- Social Intelligence API ---

const socialFindings = [];

// Seed demo social intel data
socialFindings.push(
  {
    id: 'soc-001',
    source: 'x/twitter',
    author: '@AnthropicAI',
    title: 'Claude Code 2.0 launch thread — 50K+ impressions',
    summary: 'Anthropic announced Claude Code 2.0 with native multi-agent orchestration, persistent memory, and MCP server marketplace integration.',
    sentiment: 'positive',
    engagement: { likes: 4200, reposts: 1100, replies: 380 },
    relevance: 10,
    category: 'tools',
    impact: 'high',
    url: 'https://x.com/AnthropicAI/status/example',
    captured_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'soc-002',
    source: 'hacker-news',
    author: 'Show HN',
    title: 'N8N vs Zapier for AI agent workflows — HN discussion',
    summary: 'Heated HN discussion comparing N8N self-hosted vs Zapier for AI-driven automations. Consensus: N8N wins on flexibility and cost for high-volume use cases.',
    sentiment: 'mixed',
    engagement: { likes: 890, reposts: 0, replies: 234 },
    relevance: 8,
    category: 'frameworks',
    impact: 'medium',
    url: 'https://news.ycombinator.com/item?id=example',
    captured_at: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: 'soc-003',
    source: 'x/twitter',
    author: '@karpathy',
    title: 'Thread on agent memory architectures',
    summary: 'Karpathy shared insights on persistent memory for AI agents, recommending local-first markdown vaults with semantic search over vector DBs for sub-100K document collections.',
    sentiment: 'positive',
    engagement: { likes: 12400, reposts: 3200, replies: 890 },
    relevance: 9,
    category: 'frameworks',
    impact: 'high',
    url: 'https://x.com/karpathy/status/example',
    captured_at: new Date(Date.now() - 14400000).toISOString(),
  },
  {
    id: 'soc-004',
    source: 'reddit',
    author: 'r/LocalLLaMA',
    title: 'DeepSeek V4 real-world benchmarks — surprisingly close to Sonnet',
    summary: 'Community benchmarks showing DeepSeek V4 performing within 5-8% of Claude Sonnet on coding tasks at 1/20th the cost. Thread validates economy-tier routing strategy.',
    sentiment: 'positive',
    engagement: { likes: 2100, reposts: 0, replies: 456 },
    relevance: 9,
    category: 'models',
    impact: 'high',
    url: 'https://reddit.com/r/LocalLLaMA/example',
    captured_at: new Date(Date.now() - 21600000).toISOString(),
  },
  {
    id: 'soc-005',
    source: 'linkedin',
    author: 'Enterprise AI Newsletter',
    title: 'MCP adoption hitting mainstream — 40% of enterprise AI teams now using it',
    summary: 'LinkedIn post citing survey data showing MCP server adoption growing 3x in Q1 2026, driven by Claude Code and standardized tool integration.',
    sentiment: 'positive',
    engagement: { likes: 1800, reposts: 420, replies: 67 },
    relevance: 7,
    category: 'tools',
    impact: 'medium',
    url: 'https://linkedin.com/posts/example',
    captured_at: new Date(Date.now() - 43200000).toISOString(),
  },
);

app.get('/api/social-intel', (req, res) => {
  const category = req.query.category;
  const findings = category && category !== 'all'
    ? socialFindings.filter(f => f.category === category)
    : socialFindings;

  // Summary stats
  const positive = findings.filter(f => f.sentiment === 'positive').length;
  const negative = findings.filter(f => f.sentiment === 'negative').length;
  const mixed = findings.filter(f => f.sentiment === 'mixed').length;
  const totalEngagement = findings.reduce((s, f) => s + (f.engagement.likes || 0) + (f.engagement.reposts || 0), 0);

  res.json({
    findings,
    stats: {
      total: findings.length,
      positive,
      negative,
      mixed,
      neutral: findings.length - positive - negative - mixed,
      totalEngagement,
      platforms: [...new Set(findings.map(f => f.source))],
    },
  });
});

app.post('/api/social-intel/sweep', (req, res) => {
  const sweepId = `social-${Date.now()}`;
  logActivity('social', `Social intelligence sweep initiated`);
  appendLog(`SOCIAL_SWEEP: ${sweepId}`);

  broadcast({ event: 'fleet_update', data: { agent: 'social-intel', status: 'running' } });

  setTimeout(() => {
    broadcast({ event: 'fleet_update', data: { agent: 'social-intel', status: 'idle' } });
    logActivity('social', `Social sweep completed — ${socialFindings.length} findings`);
    broadcast({ event: 'social_update', data: { sweepId, count: socialFindings.length } });
  }, 4000);

  res.json({ id: sweepId, status: 'running' });
});

// --- Identity Layer API ---

const IDENTITY_DIR = path.join(CLAUDE_DIR, 'identity');

app.get('/api/identity', (req, res) => {
  if (!fs.existsSync(IDENTITY_DIR)) return res.json([]);
  const files = fs.readdirSync(IDENTITY_DIR).filter(f => f.endsWith('.md'));
  const result = files.map(f => {
    const content = fs.readFileSync(path.join(IDENTITY_DIR, f), 'utf-8');
    const parsed = parseFrontmatter(content);
    return {
      filename: f,
      name: f.replace('.md', ''),
      layer: parsed.meta?.layer || 'unknown',
      immutable: parsed.meta?.immutable || false,
      ...parsed,
    };
  });
  res.json(result);
});

app.get('/api/identity/:name', (req, res) => {
  const fpath = path.join(IDENTITY_DIR, `${req.params.name}.md`);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(fpath, 'utf-8');
  const parsed = parseFrontmatter(content);
  res.json({ name: req.params.name, content, ...parsed });
});

app.put('/api/identity/:name', (req, res) => {
  const fpath = path.join(IDENTITY_DIR, `${req.params.name}.md`);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Not found' });
  const existing = parseFrontmatter(fs.readFileSync(fpath, 'utf-8'));
  if (existing.meta?.immutable) {
    return res.status(403).json({ error: 'This identity file is immutable. Edit the file directly to modify.' });
  }
  fs.writeFileSync(fpath, req.body.content, 'utf-8');
  logActivity('identity', `Identity layer updated: ${req.params.name}`);
  res.json({ ok: true });
});

// --- Context Inheritance (Project Overrides) ---

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
let activeProject = null;

function loadProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      try {
        const content = fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8');
        const project = yaml.load(content);
        return { filename: f, ...project };
      } catch { return null; }
    })
    .filter(Boolean);
}

function resolveContext(projectSlug) {
  // Load global identity files
  const globalIdentity = {};
  if (fs.existsSync(IDENTITY_DIR)) {
    fs.readdirSync(IDENTITY_DIR).filter(f => f.endsWith('.md')).forEach(f => {
      const content = fs.readFileSync(path.join(IDENTITY_DIR, f), 'utf-8');
      const parsed = parseFrontmatter(content);
      globalIdentity[f.replace('.md', '')] = parsed;
    });
  }

  // Load global rules
  const rulesDir = path.join(CLAUDE_DIR, 'rules');
  const globalRules = {};
  if (fs.existsSync(rulesDir)) {
    fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).forEach(f => {
      const content = fs.readFileSync(path.join(rulesDir, f), 'utf-8');
      const parsed = parseFrontmatter(content);
      globalRules[f.replace('.md', '')] = parsed.meta?.name || f.replace('.md', '');
    });
  }

  const context = {
    level: 'global',
    identity: {
      soul: globalIdentity.soul?.meta || {},
      user: globalIdentity.user?.meta || {},
      personality: globalIdentity.personality?.meta || {},
    },
    rules: globalRules,
    overrides: null,
    project: null,
    resolved: {},
  };

  // If a project is specified, merge its overrides
  if (projectSlug) {
    const projects = loadProjects();
    const proj = projects.find(p => p.project?.slug === projectSlug);
    if (proj) {
      context.level = 'project';
      context.project = proj.project;
      context.overrides = {
        identity: proj.identity || {},
        rules: proj.rules || {},
        strategy: proj.strategy || {},
        stakeholders: proj.stakeholders || [],
        agents: proj.agents || {},
      };

      // Merge: project overrides win over global
      context.resolved = {
        tone: proj.identity?.tone || globalIdentity.user?.meta?.tone || 'professional',
        audience: proj.identity?.audience || 'general',
        voice: proj.identity?.voice || globalIdentity.personality?.meta?.voice || 'neutral',
        domain_terms: proj.identity?.domain_terms || [],
        prohibited_terms: proj.identity?.prohibited_terms || [],
        rules: { ...globalRules, ...(proj.rules || {}) },
        strategy: proj.strategy || {},
        stakeholders: proj.stakeholders || [],
        agent_overrides: proj.agents || {},
      };
    }
  }

  return context;
}

// API: List all project contexts
app.get('/api/contexts', (req, res) => {
  const projects = loadProjects();
  res.json({
    activeProject,
    projects: projects.map(p => ({
      slug: p.project?.slug,
      name: p.project?.name,
      description: p.project?.description,
      status: p.project?.status,
      filename: p.filename,
      hasIdentity: !!p.identity,
      hasRules: !!p.rules,
      hasStrategy: !!p.strategy,
      stakeholderCount: (p.stakeholders || []).length,
      agentOverrides: Object.keys(p.agents || {}),
    })),
  });
});

// API: Get specific project context with full detail
app.get('/api/contexts/:slug', (req, res) => {
  const projects = loadProjects();
  const proj = projects.find(p => p.project?.slug === req.params.slug);
  if (!proj) return res.status(404).json({ error: 'Project context not found' });
  res.json(proj);
});

// API: Set active project context
app.put('/api/contexts/active', (req, res) => {
  const { slug } = req.body;
  if (slug) {
    const projects = loadProjects();
    const proj = projects.find(p => p.project?.slug === slug);
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    activeProject = slug;
    logActivity('context', `Active context switched to: ${proj.project.name}`);
    broadcast({ event: 'context_switch', data: { slug, name: proj.project.name } });
  } else {
    activeProject = null;
    logActivity('context', 'Context reset to global');
    broadcast({ event: 'context_switch', data: { slug: null, name: 'Global' } });
  }
  res.json({ ok: true, activeProject });
});

// API: Resolve merged context for current or specified project
app.get('/api/contexts/resolve/:slug', (req, res) => {
  const context = resolveContext(req.params.slug === 'active' ? activeProject : req.params.slug);
  res.json(context);
});

// API: Create new project context
app.post('/api/contexts', (req, res) => {
  const { name, slug, description } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });
  const fpath = path.join(PROJECTS_DIR, `${slug}.yaml`);
  if (fs.existsSync(fpath)) return res.status(409).json({ error: 'Project already exists' });

  const template = {
    project: { name, slug, description: description || '', status: 'active', created: new Date().toISOString().split('T')[0] },
    identity: { tone: 'professional', audience: '', voice: '', domain_terms: [], prohibited_terms: [] },
    rules: {},
    strategy: { icp: '', competitors: [], differentiators: [], current_phase: '', key_metrics: [] },
    stakeholders: [],
    agents: {},
  };

  fs.writeFileSync(fpath, yaml.dump(template), 'utf-8');
  logActivity('context', `Project context created: ${name}`);
  res.json({ ok: true, slug });
});

// --- Pipeline Engine ---

const PIPELINE_DIR = path.join(CLAUDE_DIR, 'pipelines');
const pipelineRuns = new Map();

function loadPipelines() {
  if (!fs.existsSync(PIPELINE_DIR)) return [];
  return fs.readdirSync(PIPELINE_DIR)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      try {
        const content = fs.readFileSync(path.join(PIPELINE_DIR, f), 'utf-8');
        const pipeline = yaml.load(content);
        return { filename: f, ...pipeline };
      } catch { return null; }
    })
    .filter(Boolean);
}

function executePipeline(pipelineName, params) {
  const pipelines = loadPipelines();
  const pipeline = pipelines.find(p => p.name === pipelineName);
  if (!pipeline) return null;

  const runId = `run-${Date.now()}`;
  const stages = pipeline.stages.map(s => ({
    ...s,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    outputs: {},
  }));

  const run = {
    id: runId,
    pipeline: pipelineName,
    description: pipeline.description,
    params,
    stages,
    status: 'running',
    currentStage: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  pipelineRuns.set(runId, run);
  logActivity('pipeline', `Pipeline started: ${pipelineName}`, { runId });
  appendLog(`PIPELINE_START: ${pipelineName} -> ${runId}`);

  broadcast({ event: 'pipeline_update', data: run });

  // Simulate sequential stage execution
  simulatePipelineStages(run);

  return run;
}

function simulatePipelineStages(run) {
  let stageIndex = 0;
  const stageDelays = [2000, 3000, 2500, 3500, 2000]; // varied timing

  function advanceStage() {
    if (stageIndex >= run.stages.length) {
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      broadcast({ event: 'pipeline_update', data: run });
      logActivity('pipeline', `Pipeline completed: ${run.pipeline}`, { runId: run.id });
      appendLog(`PIPELINE_COMPLETE: ${run.pipeline} -> ${run.id}`);

      // Track cost for each stage
      run.stages.forEach(s => {
        const modelMap = {
          'researcher': 'opus-4.8-high', 'synthesis': 'opus-4.8-high',
          'research-architect': 'opus-4.8-high', 'report-compiler': 'opus-4.8-high',
          'writer': 'opus-4.8-high', 'reviewer': 'opus-4.8-xhigh',
          'security-auditor': 'opus-4.8-xhigh', 'orchestrator': 'opus-4.8-xhigh',
          'deepseek-worker': 'deepseek-v4', 'scout': 'opus-4.8-low',
        };
        const model = modelMap[s.agent] || 'opus-4.8-high';
        const inputTokens = 15000 + Math.floor(Math.random() * 25000);
        const outputTokens = 4000 + Math.floor(Math.random() * 12000);
        const rates = COST_RATES[model] || COST_RATES['opus-4.8-high'];
        const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
        costLedger.push({
          id: uuidv4(),
          agent: s.agent,
          model,
          skill: s.skill,
          inputTokens,
          outputTokens,
          cost: Math.round(cost * 10000) / 10000,
          timestamp: new Date().toISOString(),
        });
      });

      return;
    }

    const stage = run.stages[stageIndex];
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    run.currentStage = stageIndex;

    // Update fleet status
    broadcast({ event: 'fleet_update', data: { agent: stage.agent, status: 'running' } });
    broadcast({ event: 'pipeline_update', data: run });

    const delay = stageDelays[stageIndex % stageDelays.length];
    setTimeout(() => {
      stage.status = 'completed';
      stage.completedAt = new Date().toISOString();
      broadcast({ event: 'fleet_update', data: { agent: stage.agent, status: 'idle' } });

      logActivity('pipeline', `Stage completed: ${stage.id} (${stage.agent} → ${stage.skill})`, { runId: run.id });

      // If stage has a gate, pause for approval
      if (stage.gate) {
        stage.status = 'awaiting_approval';
        run.status = 'awaiting_approval';
        broadcast({ event: 'pipeline_update', data: run });

        // Send notification
        sendNotification(
          `Pipeline gate: ${stage.gate}`,
          `Stage "${stage.id}" in pipeline "${run.pipeline}" requires ${stage.gate} approval.`,
          stage.gate === 'blocking' ? 'critical' : 'normal'
        );
        return; // pause — will be resumed by API call
      }

      stageIndex++;
      advanceStage();
    }, delay);
  }

  advanceStage();
}

app.get('/api/pipelines', (req, res) => {
  res.json(loadPipelines());
});

app.get('/api/pipelines/runs', (req, res) => {
  const runs = [...pipelineRuns.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 50);
  res.json(runs);
});

app.get('/api/pipelines/runs/:id', (req, res) => {
  const run = pipelineRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.post('/api/pipelines/:name/execute', (req, res) => {
  const run = executePipeline(req.params.name, req.body.params || {});
  if (!run) return res.status(404).json({ error: 'Pipeline not found' });
  res.json(run);
});

app.post('/api/pipelines/runs/:id/approve', (req, res) => {
  const run = pipelineRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'awaiting_approval') return res.status(400).json({ error: 'Not awaiting approval' });

  const gateStage = run.stages.find(s => s.status === 'awaiting_approval');
  if (gateStage) {
    gateStage.status = 'completed';
    gateStage.completedAt = new Date().toISOString();
  }
  run.status = 'running';
  logActivity('pipeline', `Gate approved in pipeline: ${run.pipeline}`);
  broadcast({ event: 'pipeline_update', data: run });

  // Resume from next stage
  const nextIdx = run.stages.indexOf(gateStage) + 1;
  if (nextIdx < run.stages.length) {
    run.currentStage = nextIdx;
    simulatePipelineStages({ ...run, stages: run.stages.slice(nextIdx) });
  } else {
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    broadcast({ event: 'pipeline_update', data: run });
  }

  res.json(run);
});

// --- Notification System ---

const notifications = [];
const notificationConfig = {
  telegram: {
    enabled: false,
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  slack: {
    enabled: false,
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  },
  dashboard: {
    enabled: true, // always on
  },
  escalation: {
    timeout: 3600, // seconds before auto-escalation (1 hour)
    action: 'safe-park', // 'safe-park' or 'auto-approve'
  },
};

function sendNotification(title, message, priority = 'normal') {
  const notification = {
    id: uuidv4(),
    title,
    message,
    priority, // 'critical', 'normal', 'low'
    channels: [],
    status: 'sent',
    timestamp: new Date().toISOString(),
  };

  // Dashboard (always)
  notification.channels.push('dashboard');
  broadcast({
    event: 'notification',
    data: notification,
  });

  // Telegram — real HTTP call to Telegram Bot API
  if (notificationConfig.telegram.enabled && notificationConfig.telegram.botToken) {
    const emoji = priority === 'critical' ? '\u{1F6A8}' : priority === 'normal' ? '\u{1F4CB}' : '\u{2139}\u{FE0F}';
    const text = `${emoji} *${title}*\n${message}${priority === 'critical' ? '\n\n_Requires attention_' : ''}`;
    fetch(`https://api.telegram.org/bot${notificationConfig.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: notificationConfig.telegram.chatId,
        text,
        parse_mode: 'Markdown',
      }),
    }).then(r => r.json()).then(r => {
      if (!r.ok) console.error('[TELEGRAM] Send failed:', r.description);
    }).catch(e => console.error('[TELEGRAM] Error:', e.message));
    notification.channels.push('telegram');
    logActivity('notification', `Telegram notification sent: ${title}`);
  }

  // Slack — real HTTP call to Incoming Webhook
  if (notificationConfig.slack.enabled && notificationConfig.slack.webhookUrl) {
    const color = priority === 'critical' ? '#ef4444' : priority === 'normal' ? '#3b82f6' : '#6b7280';
    fetch(notificationConfig.slack.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          title,
          text: message,
          footer: 'AI OS Orchestration Lab',
          ts: Math.floor(Date.now() / 1000),
        }],
      }),
    }).catch(e => console.error('[SLACK] Error:', e.message));
    notification.channels.push('slack');
    logActivity('notification', `Slack notification sent: ${title}`);
  }

  notifications.unshift(notification);
  if (notifications.length > 200) notifications.length = 200;

  // Set escalation timer for critical notifications
  if (priority === 'critical' && notificationConfig.escalation.timeout > 0) {
    setTimeout(() => {
      const n = notifications.find(nn => nn.id === notification.id);
      if (n && n.status === 'sent') {
        n.status = 'escalated';
        const action = notificationConfig.escalation.action;
        logActivity('notification', `Escalation triggered (${action}): ${title}`);
        broadcast({
          event: 'notification',
          data: { ...n, escalated: true, action },
        });
      }
    }, notificationConfig.escalation.timeout * 1000);
  }

  return notification;
}

app.get('/api/notifications', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(notifications.slice(0, limit));
});

app.get('/api/notifications/config', (req, res) => {
  // Return config without secrets
  res.json({
    telegram: {
      enabled: notificationConfig.telegram.enabled,
      configured: !!notificationConfig.telegram.botToken,
    },
    slack: {
      enabled: notificationConfig.slack.enabled,
      configured: !!notificationConfig.slack.webhookUrl,
    },
    dashboard: notificationConfig.dashboard,
    escalation: notificationConfig.escalation,
  });
});

app.put('/api/notifications/config', (req, res) => {
  const { telegram, slack, escalation } = req.body;
  if (telegram) {
    if (telegram.enabled !== undefined) notificationConfig.telegram.enabled = telegram.enabled;
    if (telegram.botToken) notificationConfig.telegram.botToken = telegram.botToken;
    if (telegram.chatId) notificationConfig.telegram.chatId = telegram.chatId;
  }
  if (slack) {
    if (slack.enabled !== undefined) notificationConfig.slack.enabled = slack.enabled;
    if (slack.webhookUrl) notificationConfig.slack.webhookUrl = slack.webhookUrl;
  }
  if (escalation) {
    if (escalation.timeout !== undefined) notificationConfig.escalation.timeout = escalation.timeout;
    if (escalation.action) notificationConfig.escalation.action = escalation.action;
  }
  logActivity('notification', 'Notification config updated');
  res.json({ ok: true });
});

app.post('/api/notifications/test', (req, res) => {
  const channel = req.body.channel || 'dashboard';
  const notification = sendNotification(
    'Test Notification',
    `This is a test notification from AI OS sent to ${channel}.`,
    'normal'
  );
  res.json(notification);
});

// --- Browser Agent (Playwright Automation) ---

const browserTasks = new Map();

// Seed browser task history
const browserSeeds = [
  {
    id: uuidv4(),
    url: 'https://news.ycombinator.com',
    taskType: 'extract',
    viewport: 'desktop',
    status: 'completed',
    result: {
      title: 'Hacker News',
      items_extracted: 30,
      data_type: 'top stories',
    },
    screenshot: null,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date(Date.now() - 3550000).toISOString(),
    agent: 'browser-agent',
  },
  {
    id: uuidv4(),
    url: 'https://github.com/trending',
    taskType: 'screenshot',
    viewport: 'desktop',
    status: 'completed',
    result: {
      screenshot_path: '.magent/artifacts/screenshots/github-trending.png',
      page_title: 'Trending repositories on GitHub',
      viewport_size: '1920x1080',
    },
    screenshot: 'github-trending.png',
    startedAt: new Date(Date.now() - 1800000).toISOString(),
    completedAt: new Date(Date.now() - 1780000).toISOString(),
    agent: 'browser-agent',
  },
  {
    id: uuidv4(),
    url: 'https://example.com/pricing',
    taskType: 'extract',
    viewport: 'desktop',
    status: 'completed',
    result: {
      title: 'Competitor Pricing Page',
      items_extracted: 4,
      data_type: 'pricing tiers',
      tiers: ['Free', 'Pro $29/mo', 'Team $79/mo', 'Enterprise Custom'],
    },
    screenshot: null,
    startedAt: new Date(Date.now() - 900000).toISOString(),
    completedAt: new Date(Date.now() - 880000).toISOString(),
    agent: 'browser-agent',
  },
];
browserSeeds.forEach(s => browserTasks.set(s.id, s));

app.get('/api/browser/tasks', (req, res) => {
  const all = [...browserTasks.values()].sort((a, b) => b.startedAt > a.startedAt ? 1 : -1);
  res.json(all);
});

app.get('/api/browser/stats', (req, res) => {
  const all = [...browserTasks.values()];
  const completed = all.filter(t => t.status === 'completed').length;
  const running = all.filter(t => t.status === 'running').length;
  const byType = {};
  all.forEach(t => { byType[t.taskType] = (byType[t.taskType] || 0) + 1; });
  res.json({
    total: all.length,
    completed,
    running,
    failed: all.filter(t => t.status === 'failed').length,
    byType,
    screenshots: all.filter(t => t.screenshot).length,
  });
});

app.post('/api/browser/execute', heavyLimiter, (req, res) => {
  const errs = validateBody(req.body, {
    url: { required: true, type: 'url', maxLength: 2048 },
    taskType: { type: 'string', oneOf: ['navigate', 'extract', 'screenshot', 'form-fill', 'verify'] },
    viewport: { type: 'string', oneOf: ['desktop', 'tablet', 'mobile'] },
  });
  if (errs) return res.status(400).json({ error: errs.join('; ') });
  const { url, taskType = 'navigate', selector, viewport = 'desktop', waitFor = 'networkidle' } = req.body;

  const id = uuidv4();
  const task = {
    id,
    url,
    taskType,
    selector: selector || null,
    viewport,
    waitFor,
    status: 'queued',
    result: null,
    screenshot: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    agent: 'browser-agent',
  };

  browserTasks.set(id, task);
  logActivity('browser', `Browser task queued: ${taskType} on ${url}`, { taskId: id });

  // Simulate browser execution lifecycle
  setTimeout(() => {
    task.status = 'running';
    broadcast({ event: 'browser_update', data: task });
  }, 300);

  // Simulate navigation
  setTimeout(() => {
    task.status = 'navigating';
    broadcast({ event: 'browser_update', data: task });
  }, 1000);

  // Simulate task execution
  setTimeout(() => {
    task.status = 'executing';
    broadcast({ event: 'browser_update', data: task });
  }, 2000);

  // Complete with simulated results
  setTimeout(() => {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();

    const viewportSizes = { desktop: '1920x1080', tablet: '768x1024', mobile: '375x812' };

    if (taskType === 'screenshot') {
      const filename = `screenshot-${Date.now()}.png`;
      task.screenshot = filename;
      task.result = {
        screenshot_path: `.magent/artifacts/screenshots/${filename}`,
        page_title: `Page at ${url}`,
        viewport_size: viewportSizes[viewport],
      };
    } else if (taskType === 'extract') {
      task.result = {
        title: `Extracted from ${url}`,
        items_extracted: 5 + Math.floor(Math.random() * 20),
        data_type: selector ? 'targeted elements' : 'page content',
        selector: selector || 'body',
      };
    } else if (taskType === 'verify') {
      task.result = {
        page_loaded: true,
        status_code: 200,
        title_match: true,
        viewport_size: viewportSizes[viewport],
        load_time_ms: 800 + Math.floor(Math.random() * 1500),
      };
    } else {
      task.result = {
        page_title: `Page at ${url}`,
        status_code: 200,
        load_time_ms: 500 + Math.floor(Math.random() * 1000),
      };
    }

    broadcast({ event: 'browser_update', data: task });
    logActivity('browser', `Browser task completed: ${taskType} on ${url}`, { taskId: id });
  }, 3500);

  res.json(task);
});

// =====================
// GROK REAL-TIME INTELLIGENCE
// =====================

const grokQueries = [];
const grokCache = new Map(); // query -> { result, timestamp }

// Seed demo Grok query history
grokQueries.push(
  {
    id: 'grok-1',
    query: 'What are the latest AI agent framework announcements this week?',
    type: 'search',
    scope: 'all',
    status: 'completed',
    streaming: false,
    tokens: { input: 42, output: 687 },
    cost: 0.0104,
    sources: [
      { title: 'Anthropic Ships Agent SDK 2.0', url: 'https://anthropic.com/news/agent-sdk-2', relevance: 0.95 },
      { title: 'OpenAI Codex Gets Parallel Execution', url: 'https://openai.com/blog/codex-parallel', relevance: 0.88 },
      { title: 'Google DeepMind Gemini Agents Launch', url: 'https://deepmind.google/agents', relevance: 0.82 },
    ],
    response: 'This week saw major agent framework updates: Anthropic released Agent SDK 2.0 with native tool orchestration, OpenAI added parallel sandbox execution to Codex, and Google DeepMind launched Gemini-native agents with persistent memory. The trend is converging on multi-model orchestration with shared memory layers.',
    confidence: 0.92,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date(Date.now() - 3598000).toISOString(),
  },
  {
    id: 'grok-2',
    query: 'Trending topics on X about Claude Code right now',
    type: 'trending',
    scope: 'social',
    status: 'completed',
    streaming: false,
    tokens: { input: 38, output: 512 },
    cost: 0.0079,
    sources: [
      { title: '@karpathy: "Claude Code agent teams are underrated"', url: 'https://x.com/karpathy/status/123', relevance: 0.97 },
      { title: '@swyx: "Built a full SaaS with Claude Code in 3 hours"', url: 'https://x.com/swyx/status/456', relevance: 0.91 },
    ],
    response: 'Claude Code is trending on X with 2 main threads: (1) Agent teams/dispatch for parallel coding — developers sharing multi-agent setups, (2) Cost optimization debates between Opus vs Sonnet for code review. Key influencers: @karpathy praising agent orchestration, @swyx sharing rapid prototyping results.',
    confidence: 0.89,
    startedAt: new Date(Date.now() - 1800000).toISOString(),
    completedAt: new Date(Date.now() - 1798500).toISOString(),
  },
  {
    id: 'grok-3',
    query: 'Is the claim true that Grok-3 outperforms GPT-4o on real-time reasoning benchmarks?',
    type: 'fact-check',
    scope: 'web',
    status: 'completed',
    streaming: false,
    tokens: { input: 56, output: 834 },
    cost: 0.0128,
    sources: [
      { title: 'xAI Grok-3 Benchmark Report', url: 'https://x.ai/blog/grok3-benchmarks', relevance: 0.96 },
      { title: 'Independent LLM Arena Rankings', url: 'https://lmarena.ai', relevance: 0.93 },
      { title: 'Papers With Code Leaderboard', url: 'https://paperswithcode.com/sota', relevance: 0.85 },
    ],
    response: 'PARTIALLY TRUE. Grok-3 outperforms GPT-4o on 3 of 5 real-time reasoning benchmarks (live web QA, temporal reasoning, social context). GPT-4o still leads on structured analytical reasoning and multi-step math. Independent arena rankings show them within 2% overall, with Grok-3 having an edge on recency-dependent questions.',
    confidence: 0.78,
    startedAt: new Date(Date.now() - 900000).toISOString(),
    completedAt: new Date(Date.now() - 898000).toISOString(),
  }
);

// API: Get Grok query history
app.get('/api/grok/queries', (req, res) => {
  res.json(grokQueries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
});

// API: Get Grok stats
app.get('/api/grok/stats', (req, res) => {
  const completed = grokQueries.filter(q => q.status === 'completed');
  const totalTokens = completed.reduce((sum, q) => sum + (q.tokens?.input || 0) + (q.tokens?.output || 0), 0);
  const totalCost = completed.reduce((sum, q) => sum + (q.cost || 0), 0);
  const avgConfidence = completed.length > 0
    ? Math.round(completed.reduce((sum, q) => sum + (q.confidence || 0), 0) / completed.length * 100) / 100
    : 0;

  const byType = {};
  grokQueries.forEach(q => {
    byType[q.type] = (byType[q.type] || 0) + 1;
  });

  const hourAgo = Date.now() - 3600000;
  const recentCount = grokQueries.filter(q => new Date(q.startedAt) > hourAgo).length;

  res.json({
    total: grokQueries.length,
    completed: completed.length,
    streaming: grokQueries.filter(q => q.status === 'streaming').length,
    failed: grokQueries.filter(q => q.status === 'failed').length,
    totalTokens,
    totalCost,
    avgConfidence,
    queriesThisHour: recentCount,
    rateLimit: 30,
    rateLimitRemaining: Math.max(0, 30 - recentCount),
    byType,
    cacheSize: grokCache.size,
  });
});

// API: Execute a Grok real-time query
app.post('/api/grok/query', heavyLimiter, async (req, res) => {
  const errs = validateBody(req.body, {
    query: { required: true, type: 'string', maxLength: 2000 },
    type: { type: 'string', oneOf: ['search', 'trending', 'fact-check', 'monitor'] },
  });
  if (errs) return res.status(400).json({ error: errs.join('; ') });
  const { query, type = 'search', scope = 'all', max_tokens = 1024, include_sources = true } = req.body;

  // Check rate limit
  const hourAgo = Date.now() - 3600000;
  const recentCount = grokQueries.filter(q => new Date(q.startedAt) > hourAgo).length;
  if (recentCount >= 30) {
    return res.status(429).json({ error: 'Rate limit exceeded (30/hour). Try again later.' });
  }

  // Check cache (5-minute window)
  const cacheKey = `${query}:${type}:${scope}`;
  const cached = grokCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < 300000) {
    return res.json({ ...cached.result, cached: true });
  }

  const id = require('crypto').randomUUID();
  const grokQuery = {
    id,
    query,
    type,
    scope,
    status: 'streaming',
    streaming: true,
    tokens: { input: query.split(/\s+/).length * 2, output: 0 },
    cost: 0,
    sources: [],
    response: '',
    confidence: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  grokQueries.unshift(grokQuery);
  broadcast({ event: 'grok_stream_start', data: { id, query, type } });
  logActivity('grok', `Grok query started: ${type} — "${query.substring(0, 60)}${query.length > 60 ? '...' : ''}"`, { queryId: id });

  // Real API path — when DEMO_MODE is off and xAI key is configured
  if (!DEMO_MODE && settings.ai.xai_api_key) {
    try {
      const systemMsg = `You are Grok, a real-time intelligence agent. Query type: ${type}. Scope: ${scope}. Provide current, factual information with sources where possible. Be concise but thorough.`;
      const result = await callGrok(systemMsg, query, max_tokens);
      grokQuery.response = result.content;
      grokQuery.tokens = { input: result.inputTokens, output: result.outputTokens };
      grokQuery.confidence = 0.9;
      grokQuery.status = 'complete';
      grokQuery.streaming = false;
      grokQuery.completedAt = new Date().toISOString();
      const rates = COST_RATES['grok-3'];
      grokQuery.cost = Math.round(((result.inputTokens / 1_000_000) * rates.input + (result.outputTokens / 1_000_000) * rates.output) * 10000) / 10000;
      costLedger.push({ id: uuidv4(), agent: 'grok-realtime', model: 'grok-3', skill: type, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: grokQuery.cost, timestamp: new Date().toISOString() });
      grokCache.set(cacheKey, { result: grokQuery, timestamp: Date.now() });
      broadcast({ event: 'grok_stream_complete', data: grokQuery });
      logActivity('grok', `Grok query completed: ${type} (real API)`, { queryId: id, cost: grokQuery.cost });
      return res.json(grokQuery);
    } catch (e) {
      console.error('[GROK] Real API failed, falling back to demo:', e.message);
      // Fall through to demo mode below
    }
  }

  // Simulate streaming response (demo mode)
  const typeResponses = {
    search: {
      response: `Real-time analysis for "${query}": Based on current web data, the latest developments indicate significant momentum in this area. Multiple authoritative sources confirm ongoing activity with measurable impact across the ecosystem.`,
      sources: [
        { title: 'Primary Source — Latest Analysis', url: 'https://example.com/analysis', relevance: 0.94 },
        { title: 'Industry Report — Current Trends', url: 'https://example.com/trends', relevance: 0.87 },
        { title: 'Expert Commentary', url: 'https://example.com/expert', relevance: 0.81 },
      ],
      confidence: 0.88,
    },
    trending: {
      response: `Trending now: "${query}" — Active discussions across X/Twitter and HN. Key threads focus on practical implementation and cost optimization. Engagement is above average for this topic category with several high-profile contributors participating.`,
      sources: [
        { title: 'Trending Thread on X', url: 'https://x.com/trending/topic', relevance: 0.96 },
        { title: 'HN Discussion (200+ points)', url: 'https://news.ycombinator.com/item?id=123', relevance: 0.90 },
      ],
      confidence: 0.85,
    },
    'fact-check': {
      response: `Fact-check result for: "${query}" — PARTIALLY VERIFIED. Cross-referencing 3 independent sources shows the core claim has supporting evidence, but with important caveats regarding scope and recency of data. Confidence varies by sub-claim.`,
      sources: [
        { title: 'Primary Verification Source', url: 'https://example.com/verify', relevance: 0.93 },
        { title: 'Counter-evidence', url: 'https://example.com/counter', relevance: 0.86 },
        { title: 'Statistical Analysis', url: 'https://example.com/stats', relevance: 0.79 },
      ],
      confidence: 0.72,
    },
    monitor: {
      response: `Monitoring update for "${query}": No significant changes detected in the last monitoring window. Current status remains consistent with previous baseline. Will alert on any notable shifts.`,
      sources: [
        { title: 'Status Dashboard', url: 'https://example.com/status', relevance: 0.91 },
      ],
      confidence: 0.95,
    },
  };

  const preset = typeResponses[type] || typeResponses.search;
  const words = preset.response.split(' ');
  let streamedWords = 0;

  // Simulate word-by-word streaming
  const streamInterval = setInterval(() => {
    streamedWords += 3 + Math.floor(Math.random() * 3);
    const partial = words.slice(0, Math.min(streamedWords, words.length)).join(' ');
    grokQuery.response = partial;
    grokQuery.tokens.output = partial.split(/\s+/).length * 2;

    broadcast({ event: 'grok_stream_chunk', data: { id, partial, progress: Math.min(100, Math.round(streamedWords / words.length * 100)) } });

    if (streamedWords >= words.length) {
      clearInterval(streamInterval);

      // Finalize
      grokQuery.status = 'completed';
      grokQuery.streaming = false;
      grokQuery.completedAt = new Date().toISOString();
      grokQuery.response = preset.response;
      grokQuery.sources = include_sources ? preset.sources : [];
      grokQuery.confidence = preset.confidence;
      grokQuery.cost = ((grokQuery.tokens.input * 5 + grokQuery.tokens.output * 15) / 1000000);

      // Cache result
      grokCache.set(cacheKey, { result: grokQuery, timestamp: Date.now() });

      broadcast({ event: 'grok_stream_end', data: grokQuery });
      logActivity('grok', `Grok query completed: ${type} (confidence: ${Math.round(preset.confidence * 100)}%)`, { queryId: id });
    }
  }, 200);

  res.json(grokQuery);
});

// API: Clear Grok cache
app.post('/api/grok/cache/clear', (req, res) => {
  grokCache.clear();
  res.json({ ok: true, message: 'Cache cleared' });
});

// =====================
// KNOWLEDGE GRAPH
// =====================

// Seeded graph nodes from vault files
const knowledgeGraph = {
  nodes: [
    { id: 'stack-decisions', label: 'Stack Decisions', type: 'wiki', tags: ['architecture', 'decisions'], connections: ['agent-roster', 'ai-os-blueprint'], size: 3 },
    { id: 'agent-roster', label: 'Agent Roster', type: 'wiki', tags: ['team', 'agents'], connections: ['stack-decisions', 'orchestrator-guide'], size: 2 },
    { id: 'ai-os-blueprint', label: 'AI OS Blueprint', type: 'docs', tags: ['architecture', 'blueprint', 'planning'], connections: ['stack-decisions', 'market-research'], size: 4 },
    { id: 'market-research', label: 'Market Research Brief', type: 'research', tags: ['research', 'competitors', 'market'], connections: ['ai-os-blueprint', 'competitor-pricing'], size: 2 },
    { id: 'competitor-pricing', label: 'Competitor Pricing', type: 'research', tags: ['research', 'pricing', 'competitors'], connections: ['market-research'], size: 1 },
    { id: 'orchestrator-guide', label: 'Orchestrator Guide', type: 'wiki', tags: ['agents', 'orchestration', 'howto'], connections: ['agent-roster', 'mission-doc'], size: 2 },
    { id: 'mission-doc', label: 'Mission Statement', type: 'raw', tags: ['mission', 'strategy'], connections: ['orchestrator-guide', 'ai-os-blueprint'], size: 3 },
    { id: 'security-audit-1', label: 'Security Audit Report', type: 'outputs', tags: ['security', 'audit', 'compliance'], connections: ['stack-decisions'], size: 2 },
    { id: 'content-brief-saas', label: 'SaaS Content Brief', type: 'outputs', tags: ['marketing', 'content', 'saas'], connections: ['market-research'], size: 1 },
    { id: 'lead-list-q2', label: 'Q2 Lead List', type: 'raw', tags: ['sales', 'leads', 'data'], connections: ['competitor-pricing'], size: 1 },
  ],
  categories: {
    wiki: { color: '#3b82f6', label: 'Wiki (Synthesized)' },
    docs: { color: '#8b5cf6', label: 'Docs (Architecture)' },
    research: { color: '#10b981', label: 'Research (Findings)' },
    outputs: { color: '#f59e0b', label: 'Outputs (Deliverables)' },
    raw: { color: '#6b7280', label: 'Raw (Intake)' },
  },
};

app.get('/api/knowledge-graph', (req, res) => {
  res.json(knowledgeGraph);
});

app.get('/api/knowledge-graph/stats', (req, res) => {
  const nodes = knowledgeGraph.nodes;
  const totalConnections = nodes.reduce((sum, n) => sum + n.connections.length, 0) / 2;
  const tags = {};
  nodes.forEach(n => n.tags.forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
  const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const byType = {};
  nodes.forEach(n => { byType[n.type] = (byType[n.type] || 0) + 1; });

  res.json({
    totalNodes: nodes.length,
    totalConnections: Math.round(totalConnections),
    totalTags: Object.keys(tags).length,
    avgConnections: (totalConnections * 2 / nodes.length).toFixed(1),
    topTags,
    byType,
    categories: knowledgeGraph.categories,
  });
});

app.post('/api/knowledge-graph/auto-categorize', (req, res) => {
  // Simulate auto-categorization
  logActivity('knowledge', 'Auto-categorization triggered — scanning vault files');
  broadcast({ event: 'knowledge_update', data: { action: 'categorize', status: 'running' } });

  setTimeout(() => {
    broadcast({ event: 'knowledge_update', data: { action: 'categorize', status: 'completed', newConnections: 3 } });
    logActivity('knowledge', 'Auto-categorization complete: 3 new connections discovered');
  }, 3000);

  res.json({ ok: true, status: 'scanning' });
});

// =====================
// DESIGN SYSTEM PROTOCOL
// =====================

const designSystem = {
  meta: {
    name: 'AI OS Design System',
    version: '2.0.0',
    lastUpdated: new Date(Date.now() - 86400000).toISOString(),
    linterPassed: true,
    wcagLevel: 'AA',
    format: 'dual-structure',
    portable: true,
    exportTargets: ['claude-code', 'cursor', 'anti-gravity', 'codex'],
  },
  // DUAL-STRUCTURE: Reasoning (emotional intent) + Tokens (exact values)
  reasoning: {
    brand: 'Technical precision meets approachable intelligence — the system should feel like a capable expert who speaks plainly.',
    typography: 'Inter provides neutral clarity for data-dense interfaces; monospace JetBrains Mono signals code-awareness without being intimidating.',
    colorPhilosophy: 'Cool blue-purple spectrum signals trust and innovation. Warm accents (amber, green) provide clear semantic meaning without competing with primary actions.',
    shapeLanguage: 'Medium radius (8px) balances professionalism with friendliness — not so sharp it feels cold, not so round it feels playful.',
    spacing: '4px base grid ensures mathematical consistency; generous whitespace prevents cognitive overload in data-rich views.',
  },
  tokens: {
    colors: {
      primary: { hex: '#3b82f6', role: 'Primary actions, links, focus states', hierarchy: 'primary-ink', usage: 'Main CTA buttons, active nav, links — the primary "ink" of the interface', screenPct: '10-15%', wcag: { onWhite: 4.5, onDark: 8.2, passes: true } },
      secondary: { hex: '#8b5cf6', role: 'Secondary actions, accents, badges', hierarchy: 'secondary', usage: 'Secondary buttons, accent highlights, category badges', screenPct: '5-8%', wcag: { onWhite: 4.8, onDark: 7.9, passes: true } },
      tertiary: { hex: '#06b6d4', role: 'Tertiary highlights, attention CTAs', hierarchy: 'tertiary', usage: 'Loud call-to-action elements, promotional badges, new feature indicators', screenPct: '2-5%', wcag: { onWhite: 3.2, onDark: 9.1, passes: false } },
      success: { hex: '#10b981', role: 'Success states, confirmations, positive', hierarchy: 'semantic', usage: 'Confirmation messages, positive trends, completed states', screenPct: '3-5%', wcag: { onWhite: 3.1, onDark: 9.4, passes: false } },
      warning: { hex: '#f59e0b', role: 'Warnings, caution states, pending', hierarchy: 'semantic', usage: 'Caution alerts, pending actions, attention-needed indicators', screenPct: '2-4%', wcag: { onWhite: 2.1, onDark: 10.2, passes: false } },
      error: { hex: '#ef4444', role: 'Errors, destructive actions, critical', hierarchy: 'semantic', usage: 'Error messages, destructive buttons, critical alerts', screenPct: '1-3%', wcag: { onWhite: 4.0, onDark: 7.1, passes: true } },
      neutral: { hex: '#6b7280', role: 'Canvas — borders, muted text, disabled', hierarchy: 'neutral', usage: 'Borders, disabled states, placeholder text — the background "canvas" (80-90% of screen)', screenPct: '80-90%', wcag: { onWhite: 4.6, onDark: 6.3, passes: true } },
      background: { hex: '#0f1419', role: 'Page background', hierarchy: 'neutral', usage: 'Root page background, deepest layer', screenPct: 'base', wcag: { onWhite: 16.1, onDark: 1.0, passes: true } },
      surface: { hex: '#1a2332', role: 'Elevated surfaces', hierarchy: 'neutral', usage: 'Cards, modals, elevated panels — sits above background', screenPct: '20-40%', wcag: { onWhite: 14.2, onDark: 1.2, passes: true } },
    },
    typography: {
      fontFamily: { primary: 'Inter, system-ui, sans-serif', mono: 'JetBrains Mono, monospace' },
      reasoning: { primary: 'Highly readable, neutral — designed for UI density without fatigue', mono: 'Code-aware, ligature-enabled — signals technical capability' },
      scale: [
        { name: 'xs', size: '11px', lineHeight: '16px', use: 'Labels, badges, metadata' },
        { name: 'sm', size: '12px', lineHeight: '18px', use: 'Secondary text, timestamps' },
        { name: 'base', size: '13px', lineHeight: '20px', use: 'Body text, descriptions' },
        { name: 'md', size: '14px', lineHeight: '22px', use: 'Primary UI text' },
        { name: 'lg', size: '18px', lineHeight: '28px', use: 'Section titles' },
        { name: 'xl', size: '22px', lineHeight: '32px', use: 'Page titles' },
        { name: '2xl', size: '28px', lineHeight: '36px', use: 'Hero headings' },
      ],
    },
    spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '32px' },
    radius: { sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' },
    radiusReasoning: 'Medium (8px default) — professional but not cold. Hard edges = stationary/formal. Round = playful/approachable.',
  },
  // COMPONENT REFERENCES — point to roles, not hardcoded values
  components: [
    { id: 'btn-primary', name: 'Primary Button', background: 'primary', text: 'neutral-background', radius: 'md', padding: 'sm lg' },
    { id: 'btn-secondary', name: 'Secondary Button', background: 'surface', text: 'primary', border: 'neutral', radius: 'md', padding: 'sm lg' },
    { id: 'btn-cta', name: 'CTA Button', background: 'tertiary', text: 'neutral-background', radius: 'lg', padding: 'md xl' },
    { id: 'card', name: 'Card', background: 'surface', border: 'neutral', radius: 'lg', padding: 'lg' },
    { id: 'badge-success', name: 'Success Badge', background: 'success-dim', text: 'success', radius: 'sm', padding: 'xs sm' },
    { id: 'badge-warning', name: 'Warning Badge', background: 'warning-dim', text: 'warning', radius: 'sm', padding: 'xs sm' },
    { id: 'input', name: 'Input Field', background: 'background', border: 'neutral', text: 'primary-ink', radius: 'md', padding: 'sm md' },
    { id: 'nav-item', name: 'Nav Item (Active)', background: 'primary-dim', text: 'primary', radius: 'md', padding: 'sm lg' },
  ],
  linterResults: [
    { rule: 'color-contrast', status: 'warning', message: 'Success green (#10b981) fails WCAG AA on white background (3.1:1, needs 4.5:1)', severity: 'medium' },
    { rule: 'color-contrast', status: 'warning', message: 'Warning amber (#f59e0b) fails WCAG AA on white background (2.1:1, needs 4.5:1)', severity: 'medium' },
    { rule: 'color-contrast', status: 'warning', message: 'Tertiary cyan (#06b6d4) fails WCAG AA on white background (3.2:1, needs 4.5:1)', severity: 'medium' },
    { rule: 'color-hierarchy', status: 'pass', message: 'All colors assigned to valid hierarchy roles (neutral/primary/secondary/tertiary/semantic)', severity: 'low' },
    { rule: 'component-refs', status: 'pass', message: 'All 8 components reference roles, not hardcoded hex values', severity: 'high' },
    { rule: 'unused-token', status: 'pass', message: 'All defined tokens are referenced in components', severity: 'low' },
    { rule: 'font-fallback', status: 'pass', message: 'All font stacks include system fallbacks', severity: 'low' },
    { rule: 'spacing-consistency', status: 'pass', message: 'Spacing values follow 4px base grid', severity: 'low' },
    { rule: 'touch-target', status: 'pass', message: 'All interactive elements meet 44px minimum', severity: 'high' },
    { rule: 'dual-structure', status: 'pass', message: 'Reasoning and tokens both present — AI can interpret intent and apply exact values', severity: 'high' },
    { rule: 'radius-reasoning', status: 'pass', message: 'Shape language documented: medium radius for balanced professional/approachable feel', severity: 'low' },
  ],
  skills: [
    { id: 'mesh-gradient', name: 'Mesh Gradient', description: 'Generate CSS mesh gradients from color tokens', category: 'visual' },
    { id: 'glassmorphism', name: 'Glassmorphism', description: 'Apply frosted glass effect to surfaces', category: 'visual' },
    { id: 'micro-animations', name: 'Micro Animations', description: 'Add subtle transitions and hover states', category: 'motion' },
    { id: 'responsive-grid', name: 'Responsive Grid', description: 'Generate responsive layout grid from breakpoints', category: 'layout' },
    { id: 'dark-mode-adapt', name: 'Dark Mode Adapt', description: 'Auto-generate dark mode token variants', category: 'theme' },
    { id: 'brand-clone', name: 'Brand Clone from URL', description: 'Extract colors, typography, and vibe from any website URL', category: 'extraction' },
    { id: 'cross-platform-export', name: 'Cross-Platform Export', description: 'Export DESIGN.md for Claude Code, Cursor, Anti-gravity, or Codex', category: 'export' },
  ],
};

app.get('/api/design-system', (req, res) => {
  res.json(designSystem);
});

app.get('/api/design-system/tokens', (req, res) => {
  res.json(designSystem.tokens);
});

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

app.post('/api/design-system/lint', (req, res) => {
  logActivity('design', 'Design system linter executed');
  broadcast({ event: 'design_update', data: { action: 'lint', status: 'completed' } });
  res.json({ ok: true, results: designSystem.linterResults });
});

// Brand Clone from URL — extracts brand identity from a website
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

// Cross-Platform Export — generates DESIGN.md for other coding agents
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

// Design System reasoning endpoint
app.get('/api/design-system/reasoning', (req, res) => {
  res.json({
    reasoning: designSystem.reasoning,
    radiusReasoning: designSystem.tokens.radiusReasoning,
    typographyReasoning: designSystem.tokens.typography.reasoning,
  });
});

// Design System components endpoint
app.get('/api/design-system/components', (req, res) => {
  res.json({ components: designSystem.components });
});

// =====================
// MEDIA PRODUCTION PIPELINE
// =====================

const mediaProductions = [
  {
    id: 'media-1',
    title: 'Weekly PR Summary Video',
    type: 'remotion',
    status: 'completed',
    template: 'pr-recap',
    duration: '2:34',
    resolution: '1920x1080',
    params: { repo: 'ai-os', period: 'weekly', style: 'minimal' },
    output: '.magent/artifacts/media/pr-recap-w21.mp4',
    createdAt: new Date(Date.now() - 172800000).toISOString(),
    completedAt: new Date(Date.now() - 170000000).toISOString(),
    cost: 0.00,
    engine: 'remotion-local',
  },
  {
    id: 'media-2',
    title: 'Product Demo: Dashboard Tour',
    type: 'video',
    status: 'completed',
    template: 'product-demo',
    duration: '1:45',
    resolution: '1920x1080',
    params: { scenes: 5, avatar: 'professional', music: 'ambient' },
    output: '.magent/artifacts/media/demo-dashboard-v2.mp4',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    completedAt: new Date(Date.now() - 82000000).toISOString(),
    cost: 0.45,
    engine: 'google-vids',
  },
  {
    id: 'media-3',
    title: '3D Office Environment',
    type: '3d',
    status: 'completed',
    template: 'scene-generation',
    resolution: '2048x2048',
    params: { prompt: 'Modern tech office with holographic displays', lighting: 'dramatic', style: 'photorealistic' },
    output: '.magent/artifacts/media/office-3d-render.png',
    createdAt: new Date(Date.now() - 43200000).toISOString(),
    completedAt: new Date(Date.now() - 40000000).toISOString(),
    cost: 0.12,
    engine: 'blender-mcp',
  },
  {
    id: 'media-4',
    title: 'Social Ad Variations (Batch)',
    type: 'remotion',
    status: 'queued',
    template: 'social-ad',
    resolution: '1080x1080',
    params: { variations: 12, platform: 'instagram', cta: 'Learn More' },
    output: null,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: null,
    cost: 0.00,
    engine: 'remotion-local',
  },
];

const mediaTemplates = [
  { id: 'pr-recap', name: 'PR Recap Video', engine: 'remotion', duration: '2-3min', params: ['repo', 'period', 'style'] },
  { id: 'product-demo', name: 'Product Demo', engine: 'google-vids', duration: '1-3min', params: ['scenes', 'avatar', 'music'] },
  { id: 'social-ad', name: 'Social Ad Generator', engine: 'remotion', duration: '15-30s', params: ['variations', 'platform', 'cta'] },
  { id: 'scene-generation', name: '3D Scene', engine: 'blender-mcp', duration: 'N/A', params: ['prompt', 'lighting', 'style'] },
  { id: 'explainer', name: 'Explainer Video', engine: 'google-vids', duration: '3-5min', params: ['topic', 'audience', 'tone'] },
  { id: 'data-viz', name: 'Data Visualization', engine: 'remotion', duration: '30-60s', params: ['dataset', 'chart_type', 'animation'] },
];

app.get('/api/media/productions', (req, res) => {
  res.json(mediaProductions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/media/templates', (req, res) => {
  res.json(mediaTemplates);
});

app.get('/api/media/stats', (req, res) => {
  const completed = mediaProductions.filter(p => p.status === 'completed');
  const totalCost = completed.reduce((sum, p) => sum + (p.cost || 0), 0);
  const byEngine = {};
  mediaProductions.forEach(p => { byEngine[p.engine] = (byEngine[p.engine] || 0) + 1; });
  const byType = {};
  mediaProductions.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });

  res.json({
    total: mediaProductions.length,
    completed: completed.length,
    queued: mediaProductions.filter(p => p.status === 'queued').length,
    rendering: mediaProductions.filter(p => p.status === 'rendering').length,
    totalCost,
    byEngine,
    byType,
    templates: mediaTemplates.length,
  });
});

app.post('/api/media/produce', heavyLimiter, (req, res) => {
  const { title, template, params = {} } = req.body;
  if (!title || !template) return res.status(400).json({ error: 'Title and template required' });

  const tmpl = mediaTemplates.find(t => t.id === template);
  const id = require('crypto').randomUUID();
  const production = {
    id,
    title,
    type: tmpl ? (tmpl.engine === 'blender-mcp' ? '3d' : 'remotion') : 'video',
    status: 'queued',
    template,
    resolution: params.resolution || '1920x1080',
    params,
    output: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    cost: 0,
    engine: tmpl?.engine || 'remotion-local',
  };

  mediaProductions.unshift(production);
  broadcast({ event: 'media_update', data: production });
  logActivity('media', `Media production queued: ${title} (${template})`, { productionId: id });

  // Simulate rendering
  setTimeout(() => {
    production.status = 'rendering';
    broadcast({ event: 'media_update', data: production });
  }, 1000);

  setTimeout(() => {
    production.status = 'completed';
    production.completedAt = new Date().toISOString();
    production.output = `.magent/artifacts/media/${template}-${Date.now()}.mp4`;
    production.cost = Math.random() * 0.5;
    production.duration = `${Math.floor(Math.random() * 3) + 1}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
    broadcast({ event: 'media_update', data: production });
    logActivity('media', `Media production completed: ${title}`);
  }, 6000);

  res.json(production);
});

// =====================
// CONTINUOUS LOOP WORKFLOWS (ROUTINES)
// =====================

const routines = [
  {
    id: 'routine-1',
    name: 'Social Ad Variation Generator',
    description: 'Generates 12 ad variations per hour for A/B testing library',
    skill: 'content-creation',
    agent: 'deepseek-worker',
    interval: '0 * * * *',
    intervalHuman: 'Every hour',
    status: 'active',
    rateLimit: { maxPerHour: 12, currentHour: 7, cooldownMs: 300000 },
    stats: { totalRuns: 156, totalOutputs: 1872, successRate: 98.2, lastRun: new Date(Date.now() - 1800000).toISOString(), nextRun: new Date(Date.now() + 1800000).toISOString() },
    outputPath: '.magent/artifacts/media/ad-variations/',
    batchSize: 12,
    enabled: true,
  },
  {
    id: 'routine-2',
    name: 'Competitor Price Monitor',
    description: 'Scrapes competitor pricing pages every 6 hours and logs changes',
    skill: 'browser-automation',
    agent: 'browser-agent',
    interval: '0 */6 * * *',
    intervalHuman: 'Every 6 hours',
    status: 'active',
    rateLimit: { maxPerHour: 10, currentHour: 0, cooldownMs: 120000 },
    stats: { totalRuns: 84, totalOutputs: 84, successRate: 95.2, lastRun: new Date(Date.now() - 21600000).toISOString(), nextRun: new Date(Date.now() + 600000).toISOString() },
    outputPath: '.magent/vault/raw/pricing/',
    batchSize: 1,
    enabled: true,
  },
  {
    id: 'routine-3',
    name: 'Daily Analytics Digest',
    description: 'Compiles daily metrics and posts summary to notification channels',
    skill: 'research-brief',
    agent: 'researcher',
    interval: '0 9 * * *',
    intervalHuman: 'Daily at 9:00 AM',
    status: 'paused',
    rateLimit: { maxPerHour: 1, currentHour: 0, cooldownMs: 0 },
    stats: { totalRuns: 22, totalOutputs: 22, successRate: 100, lastRun: new Date(Date.now() - 86400000).toISOString(), nextRun: null },
    outputPath: '.magent/vault/outputs/digests/',
    batchSize: 1,
    enabled: false,
  },
  {
    id: 'routine-4',
    name: 'Content Repurposing Pipeline',
    description: 'Takes new blog posts and generates LinkedIn, X, and email variants',
    skill: 'content-creation',
    agent: 'writer',
    interval: '30 */4 * * *',
    intervalHuman: 'Every 4 hours',
    status: 'active',
    rateLimit: { maxPerHour: 3, currentHour: 1, cooldownMs: 600000 },
    stats: { totalRuns: 42, totalOutputs: 126, successRate: 97.6, lastRun: new Date(Date.now() - 7200000).toISOString(), nextRun: new Date(Date.now() + 7200000).toISOString() },
    outputPath: '.magent/artifacts/docs/repurposed/',
    batchSize: 3,
    enabled: true,
  },
];

app.get('/api/routines', (req, res) => {
  res.json(routines);
});

app.get('/api/routines/stats', (req, res) => {
  const active = routines.filter(r => r.enabled);
  const totalRuns = routines.reduce((sum, r) => sum + r.stats.totalRuns, 0);
  const totalOutputs = routines.reduce((sum, r) => sum + r.stats.totalOutputs, 0);
  const avgSuccess = routines.length > 0
    ? Math.round(routines.reduce((sum, r) => sum + r.stats.successRate, 0) / routines.length * 10) / 10
    : 0;

  res.json({
    total: routines.length,
    active: active.length,
    paused: routines.length - active.length,
    totalRuns,
    totalOutputs,
    avgSuccessRate: avgSuccess,
    outputsPerDay: Math.round(totalOutputs / 30),
  });
});

app.put('/api/routines/:id/toggle', (req, res) => {
  const routine = routines.find(r => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: 'Routine not found' });
  routine.enabled = !routine.enabled;
  routine.status = routine.enabled ? 'active' : 'paused';
  if (!routine.enabled) routine.stats.nextRun = null;
  broadcast({ event: 'routine_update', data: routine });
  logActivity('routine', `Routine ${routine.enabled ? 'enabled' : 'paused'}: ${routine.name}`);
  res.json(routine);
});

app.post('/api/routines/:id/run', (req, res) => {
  const routine = routines.find(r => r.id === req.params.id);
  if (!routine) return res.status(404).json({ error: 'Routine not found' });

  // Check rate limit
  if (routine.rateLimit.currentHour >= routine.rateLimit.maxPerHour) {
    return res.status(429).json({ error: 'Rate limit reached for this hour', nextReset: 'Top of next hour' });
  }

  routine.rateLimit.currentHour++;
  routine.stats.totalRuns++;
  routine.stats.totalOutputs += routine.batchSize;
  routine.stats.lastRun = new Date().toISOString();

  broadcast({ event: 'routine_update', data: { ...routine, running: true } });
  logActivity('routine', `Routine manually triggered: ${routine.name} (batch of ${routine.batchSize})`);

  setTimeout(() => {
    broadcast({ event: 'routine_update', data: { ...routine, running: false } });
  }, 4000);

  res.json({ ok: true, routine, outputsGenerated: routine.batchSize });
});

app.post('/api/routines', (req, res) => {
  const { name, description, skill, agent, interval, intervalHuman, batchSize = 1, rateLimit = {} } = req.body;
  if (!name || !skill || !interval) return res.status(400).json({ error: 'Name, skill, and interval required' });

  const id = 'routine-' + require('crypto').randomUUID().slice(0, 8);
  const routine = {
    id, name, description: description || '', skill, agent: agent || 'orchestrator',
    interval, intervalHuman: intervalHuman || interval,
    status: 'active',
    rateLimit: { maxPerHour: rateLimit.maxPerHour || 10, currentHour: 0, cooldownMs: rateLimit.cooldownMs || 0 },
    stats: { totalRuns: 0, totalOutputs: 0, successRate: 100, lastRun: null, nextRun: new Date(Date.now() + 3600000).toISOString() },
    outputPath: `.magent/artifacts/${skill}/`,
    batchSize,
    enabled: true,
  };

  routines.push(routine);
  broadcast({ event: 'routine_update', data: routine });
  logActivity('routine', `New routine created: ${name}`);
  res.json(routine);
});

// =============================
// PHASE 2: MONETIZATION LAYER
// =============================

// --- Product Factory ---
const productFactory = {
  products: [
    { id: 'prod-1', name: 'Ultimate Book Tracker', type: 'spreadsheet', platform: 'etsy', status: 'published', price: 12.99, sales: 47, revenue: 610.53, rating: 4.8, createdAt: new Date(Date.now() - 14 * 86400000).toISOString(), template: 'book-tracker', features: ['200+ genres', 'Reading stats', 'TBR manager', 'Annual goals'] },
    { id: 'prod-2', name: 'Wedding Planner Pro', type: 'spreadsheet', platform: 'etsy', status: 'published', price: 24.99, sales: 23, revenue: 574.77, rating: 4.9, createdAt: new Date(Date.now() - 21 * 86400000).toISOString(), template: 'wedding-planner', features: ['Budget tracker', 'Vendor contacts', 'Timeline', 'Guest list', 'Seating chart'] },
    { id: 'prod-3', name: 'SaaS Metrics Dashboard', type: 'spreadsheet', platform: 'gumroad', status: 'published', price: 19.99, sales: 31, revenue: 619.69, rating: 4.7, createdAt: new Date(Date.now() - 7 * 86400000).toISOString(), template: 'saas-metrics', features: ['MRR tracking', 'Churn analysis', 'LTV calculator', 'Cohort view'] },
    { id: 'prod-4', name: 'Content Calendar System', type: 'notion-template', platform: 'gumroad', status: 'draft', price: 14.99, sales: 0, revenue: 0, rating: null, createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), template: 'content-calendar', features: ['Multi-platform', 'AI prompts', 'Analytics hooks', 'Repurposing flows'] },
    { id: 'prod-5', name: 'Freelancer Finance Kit', type: 'spreadsheet', platform: 'etsy', status: 'generating', price: 17.99, sales: 0, revenue: 0, rating: null, createdAt: new Date().toISOString(), template: 'finance-kit', features: ['Invoice tracker', 'Tax estimates', 'Project P&L', 'Quarterly review'] },
  ],
  templates: [
    { id: 'book-tracker', name: 'Book Tracker', complexity: 'medium', est: '~45min', sheets: 5 },
    { id: 'wedding-planner', name: 'Wedding Planner', complexity: 'high', est: '~90min', sheets: 8 },
    { id: 'saas-metrics', name: 'SaaS Metrics', complexity: 'high', est: '~60min', sheets: 6 },
    { id: 'content-calendar', name: 'Content Calendar', complexity: 'medium', est: '~30min', sheets: 3 },
    { id: 'finance-kit', name: 'Freelancer Finance', complexity: 'medium', est: '~40min', sheets: 4 },
    { id: 'habit-tracker', name: 'Habit Tracker', complexity: 'low', est: '~20min', sheets: 2 },
  ],
};

app.get('/api/products', (req, res) => {
  res.json(productFactory.products);
});

app.get('/api/products/stats', (req, res) => {
  const p = productFactory.products;
  const published = p.filter(x => x.status === 'published');
  res.json({
    total: p.length,
    published: published.length,
    draft: p.filter(x => x.status === 'draft').length,
    generating: p.filter(x => x.status === 'generating').length,
    totalRevenue: published.reduce((s, x) => s + x.revenue, 0),
    totalSales: published.reduce((s, x) => s + x.sales, 0),
    avgRating: published.filter(x => x.rating).length ? (published.reduce((s, x) => s + (x.rating || 0), 0) / published.filter(x => x.rating).length).toFixed(1) : null,
    platforms: { etsy: published.filter(x => x.platform === 'etsy').length, gumroad: published.filter(x => x.platform === 'gumroad').length },
  });
});

app.get('/api/products/templates', (req, res) => {
  res.json(productFactory.templates);
});

app.post('/api/products', (req, res) => {
  const { name, type, platform, price, template, features } = req.body;
  const product = {
    id: `prod-${Date.now()}`,
    name: name || 'Untitled Product',
    type: type || 'spreadsheet',
    platform: platform || 'etsy',
    status: 'generating',
    price: price || 9.99,
    sales: 0, revenue: 0, rating: null,
    createdAt: new Date().toISOString(),
    template: template || null,
    features: features || [],
  };
  productFactory.products.unshift(product);
  broadcast({ event: 'product_update', data: product });
  // Simulate generation
  setTimeout(() => {
    product.status = 'draft';
    broadcast({ event: 'product_update', data: product });
  }, 5000);
  res.json(product);
});

// --- Lead Generation Pipeline ---
const leadPipeline = {
  leads: [
    { id: 'lead-1', company: 'TechFlow Inc', contact: 'Sarah Chen', role: 'VP Engineering', platform: 'linkedin', status: 'enriched', score: 92, achievement: 'Scaled team from 5 to 40 engineers in 18 months', outreach: 'personalized', sentAt: new Date(Date.now() - 2 * 86400000).toISOString(), openedAt: new Date(Date.now() - 1.5 * 86400000).toISOString(), repliedAt: null },
    { id: 'lead-2', company: 'DataVerse AI', contact: 'Marcus Johnson', role: 'CTO', platform: 'linkedin', status: 'replied', score: 88, achievement: 'Led $15M Series A funding round', outreach: 'personalized', sentAt: new Date(Date.now() - 5 * 86400000).toISOString(), openedAt: new Date(Date.now() - 4.5 * 86400000).toISOString(), repliedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
    { id: 'lead-3', company: 'CloudScale Systems', contact: 'Emily Rodriguez', role: 'Head of Product', platform: 'linkedin', status: 'sent', score: 85, achievement: 'Launched product to 100K users in first quarter', outreach: 'personalized', sentAt: new Date(Date.now() - 1 * 86400000).toISOString(), openedAt: null, repliedAt: null },
    { id: 'lead-4', company: 'NeuralPath Labs', contact: 'James Park', role: 'CEO', platform: 'email', status: 'scraped', score: 79, achievement: 'YC W24 batch, raised $3.2M seed', outreach: null, sentAt: null, openedAt: null, repliedAt: null },
    { id: 'lead-5', company: 'QuantumLeap SaaS', contact: 'Aisha Patel', role: 'Director of Growth', platform: 'linkedin', status: 'enriched', score: 91, achievement: 'Grew ARR from $2M to $8M in one year', outreach: 'draft', sentAt: null, openedAt: null, repliedAt: null },
    { id: 'lead-6', company: 'MetaForge Analytics', contact: 'David Kim', role: 'VP Sales', platform: 'email', status: 'scraped', score: 73, achievement: 'Built enterprise sales team generating $50M pipeline', outreach: null, sentAt: null, openedAt: null, repliedAt: null },
  ],
  campaigns: [
    { id: 'camp-1', name: 'AI Startup Founders', target: 'CEOs/CTOs at AI startups (Series A-B)', leads: 24, sent: 18, opened: 12, replied: 4, status: 'active' },
    { id: 'camp-2', name: 'SaaS Growth Leaders', target: 'Growth/Marketing leads at $2-10M ARR SaaS', leads: 31, sent: 22, opened: 15, replied: 6, status: 'active' },
    { id: 'camp-3', name: 'Enterprise DevTool Buyers', target: 'VP Eng at 500+ employee companies', leads: 15, sent: 0, opened: 0, replied: 0, status: 'draft' },
  ],
};

app.get('/api/leads', (req, res) => {
  res.json(leadPipeline.leads);
});

app.get('/api/leads/stats', (req, res) => {
  const l = leadPipeline.leads;
  res.json({
    total: l.length,
    scraped: l.filter(x => x.status === 'scraped').length,
    enriched: l.filter(x => x.status === 'enriched').length,
    sent: l.filter(x => x.status === 'sent').length,
    replied: l.filter(x => x.status === 'replied').length,
    avgScore: Math.round(l.reduce((s, x) => s + x.score, 0) / l.length),
    openRate: l.filter(x => x.sentAt).length ? Math.round(l.filter(x => x.openedAt).length / l.filter(x => x.sentAt).length * 100) : 0,
    replyRate: l.filter(x => x.sentAt).length ? Math.round(l.filter(x => x.repliedAt).length / l.filter(x => x.sentAt).length * 100) : 0,
    campaigns: leadPipeline.campaigns.length,
  });
});

app.get('/api/leads/campaigns', (req, res) => {
  res.json(leadPipeline.campaigns);
});

app.post('/api/leads/scrape', heavyLimiter, (req, res) => {
  const { company, role, platform } = req.body;
  const lead = {
    id: `lead-${Date.now()}`,
    company: company || 'Unknown',
    contact: 'Discovering...',
    role: role || 'Decision Maker',
    platform: platform || 'linkedin',
    status: 'scraped',
    score: Math.floor(Math.random() * 20) + 70,
    achievement: null,
    outreach: null, sentAt: null, openedAt: null, repliedAt: null,
  };
  leadPipeline.leads.unshift(lead);
  broadcast({ event: 'lead_update', data: lead });
  // Simulate enrichment
  setTimeout(() => {
    lead.status = 'enriched';
    lead.contact = 'AI-Discovered Contact';
    lead.achievement = 'Notable achievement discovered via enrichment';
    broadcast({ event: 'lead_update', data: lead });
  }, 4000);
  res.json(lead);
});

app.post('/api/leads/:id/outreach', (req, res) => {
  const lead = leadPipeline.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.outreach = 'personalized';
  lead.status = 'sent';
  lead.sentAt = new Date().toISOString();
  broadcast({ event: 'lead_update', data: lead });
  res.json(lead);
});

// --- Marketing Hub ---
const marketingHub = {
  pipelines: [
    { id: 'mkt-1', name: 'YouTube → Multi-Platform', source: 'youtube', status: 'active', outputs: ['linkedin', 'x-twitter', 'email', 'blog'], lastRun: new Date(Date.now() - 3600000).toISOString(), totalRuns: 18, conversions: { linkedin: 34, twitter: 52, email: 89, blog: 12 } },
    { id: 'mkt-2', name: 'Blog → Social Distribution', source: 'blog', status: 'active', outputs: ['linkedin', 'x-twitter', 'threads', 'newsletter'], lastRun: new Date(Date.now() - 7200000).toISOString(), totalRuns: 42, conversions: { linkedin: 156, twitter: 203, threads: 67, newsletter: 412 } },
    { id: 'mkt-3', name: 'Podcast → Content Atoms', source: 'podcast', status: 'paused', outputs: ['audiogram', 'quote-cards', 'blog', 'x-twitter'], lastRun: new Date(Date.now() - 72 * 3600000).toISOString(), totalRuns: 8, conversions: { audiogram: 5, quotes: 24, blog: 3, twitter: 18 } },
  ],
  channels: [
    { id: 'ch-linkedin', name: 'LinkedIn', followers: 2847, posts30d: 22, engagement: 4.8, growth: '+12%' },
    { id: 'ch-twitter', name: 'X / Twitter', followers: 5231, posts30d: 45, engagement: 2.1, growth: '+8%' },
    { id: 'ch-email', name: 'Email List', followers: 1203, posts30d: 8, engagement: 38.2, growth: '+15%' },
    { id: 'ch-blog', name: 'Blog', followers: null, posts30d: 6, engagement: null, growth: '+22%' },
  ],
  contentQueue: [
    { id: 'cq-1', title: 'AI OS Architecture Deep-Dive', channel: 'linkedin', status: 'scheduled', scheduledFor: new Date(Date.now() + 3600000).toISOString(), type: 'carousel' },
    { id: 'cq-2', title: 'Thread: 5 Lessons from Building Multi-Agent Systems', channel: 'x-twitter', status: 'scheduled', scheduledFor: new Date(Date.now() + 7200000).toISOString(), type: 'thread' },
    { id: 'cq-3', title: 'Weekly Newsletter: Agentic Workflows', channel: 'email', status: 'draft', scheduledFor: null, type: 'newsletter' },
    { id: 'cq-4', title: 'Vibe Design: From Sketch to UI in 30s', channel: 'linkedin', status: 'generating', scheduledFor: null, type: 'video' },
  ],
};

app.get('/api/marketing/pipelines', (req, res) => {
  res.json(marketingHub.pipelines);
});

app.get('/api/marketing/channels', (req, res) => {
  res.json(marketingHub.channels);
});

app.get('/api/marketing/queue', (req, res) => {
  res.json(marketingHub.contentQueue);
});

app.get('/api/marketing/stats', (req, res) => {
  const totalFollowers = marketingHub.channels.reduce((s, c) => s + (c.followers || 0), 0);
  const totalPosts = marketingHub.channels.reduce((s, c) => s + c.posts30d, 0);
  res.json({
    totalFollowers,
    totalPosts30d: totalPosts,
    activePipelines: marketingHub.pipelines.filter(p => p.status === 'active').length,
    queuedContent: marketingHub.contentQueue.length,
    avgEngagement: (marketingHub.channels.filter(c => c.engagement).reduce((s, c) => s + c.engagement, 0) / marketingHub.channels.filter(c => c.engagement).length).toFixed(1),
    channels: marketingHub.channels.length,
  });
});

app.post('/api/marketing/queue', (req, res) => {
  const { title, channel, type } = req.body;
  const item = {
    id: `cq-${Date.now()}`,
    title: title || 'Untitled Content',
    channel: channel || 'linkedin',
    status: 'draft',
    scheduledFor: null,
    type: type || 'post',
  };
  marketingHub.contentQueue.unshift(item);
  broadcast({ event: 'marketing_update', data: item });
  res.json(item);
});

// --- Golden Loop (Gem → NotebookLM sync) ---
const goldenLoop = {
  loops: [
    { id: 'gl-1', gem: 'Brand Strategist', notebook: 'Brand & Voice Guidelines', status: 'synced', lastSync: new Date(Date.now() - 1800000).toISOString(), syncInterval: '30min', outputs: 24, accuracy: 97, dataSources: ['brand-voice.md', 'competitor-analysis.pdf', 'customer-interviews.md'] },
    { id: 'gl-2', gem: 'Market Researcher', notebook: 'Industry Intelligence', status: 'synced', lastSync: new Date(Date.now() - 3600000).toISOString(), syncInterval: '1hr', outputs: 18, accuracy: 94, dataSources: ['market-data.csv', 'trend-reports/', 'analyst-notes.md'] },
    { id: 'gl-3', gem: 'Technical Writer', notebook: 'Product Documentation', status: 'syncing', lastSync: new Date(Date.now() - 900000).toISOString(), syncInterval: '15min', outputs: 56, accuracy: 99, dataSources: ['api-specs.yaml', 'changelog.md', 'architecture.md'] },
    { id: 'gl-4', gem: 'Sales Coach', notebook: 'Sales Playbook & Objections', status: 'error', lastSync: new Date(Date.now() - 86400000).toISOString(), syncInterval: '2hr', outputs: 8, accuracy: 91, dataSources: ['objection-handling.md', 'case-studies/', 'pricing.md'], error: 'Notebook source limit reached (50 files)' },
  ],
};

app.get('/api/golden-loop', (req, res) => {
  res.json(goldenLoop.loops);
});

app.get('/api/golden-loop/stats', (req, res) => {
  const l = goldenLoop.loops;
  res.json({
    total: l.length,
    synced: l.filter(x => x.status === 'synced').length,
    syncing: l.filter(x => x.status === 'syncing').length,
    errors: l.filter(x => x.status === 'error').length,
    totalOutputs: l.reduce((s, x) => s + x.outputs, 0),
    avgAccuracy: Math.round(l.reduce((s, x) => s + x.accuracy, 0) / l.length),
    totalDataSources: l.reduce((s, x) => s + x.dataSources.length, 0),
  });
});

app.post('/api/golden-loop/:id/sync', (req, res) => {
  const loop = goldenLoop.loops.find(l => l.id === req.params.id);
  if (!loop) return res.status(404).json({ error: 'Loop not found' });
  loop.status = 'syncing';
  loop.lastSync = new Date().toISOString();
  broadcast({ event: 'golden_loop_update', data: loop });
  setTimeout(() => {
    loop.status = 'synced';
    loop.outputs += 1;
    broadcast({ event: 'golden_loop_update', data: loop });
  }, 3000);
  res.json(loop);
});

app.post('/api/golden-loop', (req, res) => {
  const { gem, notebook, syncInterval, dataSources } = req.body;
  const loop = {
    id: `gl-${Date.now()}`,
    gem: gem || 'Custom Gem',
    notebook: notebook || 'Untitled Notebook',
    status: 'syncing',
    lastSync: new Date().toISOString(),
    syncInterval: syncInterval || '1hr',
    outputs: 0,
    accuracy: 0,
    dataSources: dataSources || [],
  };
  goldenLoop.loops.push(loop);
  broadcast({ event: 'golden_loop_update', data: loop });
  setTimeout(() => {
    loop.status = 'synced';
    loop.accuracy = 95;
    broadcast({ event: 'golden_loop_update', data: loop });
  }, 4000);
  res.json(loop);
});

// =============================
// PHASE 3: CREATIVE STUDIO
// =============================

// --- Vibe Design Studio ---
const vibeDesign = {
  projects: [
    { id: 'vd-1', name: 'SaaS Landing Page', method: 'prompt', status: 'completed', screens: 4, style: 'minimal-tech', inputs: { prompt: 'Modern SaaS landing with gradient hero, feature cards, pricing table' }, heatmap: true, interactions: 12, createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), completedAt: new Date(Date.now() - 1.8 * 86400000).toISOString() },
    { id: 'vd-2', name: 'Mobile Onboarding Flow', method: 'sketch', status: 'completed', screens: 5, style: 'playful', inputs: { sketch: 'onboarding-sketch.png' }, heatmap: true, interactions: 8, createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), completedAt: new Date(Date.now() - 4.7 * 86400000).toISOString() },
    { id: 'vd-3', name: 'Dashboard Redesign', method: 'voice', status: 'iterating', screens: 3, style: 'data-dense', inputs: { voice: 'I need a dashboard with real-time metrics, dark mode, and a sidebar nav' }, heatmap: false, interactions: 6, createdAt: new Date(Date.now() - 1 * 86400000).toISOString(), completedAt: null },
    { id: 'vd-4', name: 'E-commerce Product Page', method: 'url', status: 'generating', screens: 0, style: 'luxe', inputs: { url: 'https://reference-store.com/product' }, heatmap: false, interactions: 0, createdAt: new Date().toISOString(), completedAt: null },
  ],
  controls: {
    density: { min: 0, max: 100, default: 50 },
    hue: { min: 0, max: 360, default: 240 },
    roundness: { min: 0, max: 100, default: 60 },
    spacing: { min: 0, max: 100, default: 50 },
  },
};

app.get('/api/vibe-design/projects', (req, res) => {
  res.json(vibeDesign.projects);
});

app.get('/api/vibe-design/stats', (req, res) => {
  const p = vibeDesign.projects;
  res.json({
    totalProjects: p.length,
    completed: p.filter(x => x.status === 'completed').length,
    iterating: p.filter(x => x.status === 'iterating').length,
    generating: p.filter(x => x.status === 'generating').length,
    totalScreens: p.reduce((s, x) => s + x.screens, 0),
    heatmapsGenerated: p.filter(x => x.heatmap).length,
    avgInteractions: Math.round(p.reduce((s, x) => s + x.interactions, 0) / p.length),
  });
});

app.get('/api/vibe-design/controls', (req, res) => {
  res.json(vibeDesign.controls);
});

app.post('/api/vibe-design/projects', heavyLimiter, (req, res) => {
  const { name, method, style, prompt } = req.body;
  const project = {
    id: `vd-${Date.now()}`,
    name: name || 'Untitled Design',
    method: method || 'prompt',
    status: 'generating',
    screens: 0,
    style: style || 'modern',
    inputs: { prompt: prompt || '' },
    heatmap: false,
    interactions: 0,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  vibeDesign.projects.unshift(project);
  broadcast({ event: 'vibe_design_update', data: project });
  setTimeout(() => {
    project.status = 'iterating';
    project.screens = Math.floor(Math.random() * 4) + 2;
    broadcast({ event: 'vibe_design_update', data: project });
  }, 4000);
  res.json(project);
});

app.post('/api/vibe-design/:id/heatmap', (req, res) => {
  const project = vibeDesign.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  project.heatmap = true;
  const heatmapData = {
    zones: [
      { x: 20, y: 15, intensity: 0.95, label: 'Hero CTA' },
      { x: 50, y: 35, intensity: 0.78, label: 'Feature section' },
      { x: 50, y: 55, intensity: 0.65, label: 'Social proof' },
      { x: 50, y: 75, intensity: 0.82, label: 'Pricing table' },
      { x: 80, y: 10, intensity: 0.45, label: 'Navigation' },
    ],
    prediction: 'Users most likely to focus on Hero CTA (95%) and Pricing (82%). Consider moving social proof above the fold.',
  };
  res.json(heatmapData);
});

// --- 3D Production (Blender MCP) ---
const blender3d = {
  scenes: [
    { id: '3d-1', name: 'Futuristic Office', status: 'rendered', engine: 'blender-mcp', resolution: '2048x2048', style: 'photorealistic', lighting: 'dramatic', objects: 12, renderTime: '4m 23s', fileSize: '8.4 MB', createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), prompt: 'Modern tech office with holographic displays and ambient lighting' },
    { id: '3d-2', name: 'Product Showcase', status: 'rendered', engine: 'blender-mcp', resolution: '4096x4096', style: 'studio', lighting: 'three-point', objects: 3, renderTime: '2m 11s', fileSize: '12.1 MB', createdAt: new Date(Date.now() - 7 * 86400000).toISOString(), prompt: 'Sleek SaaS product box floating on dark gradient with reflections' },
    { id: '3d-3', name: 'Abstract Data Viz', status: 'rendering', engine: 'blender-mcp', resolution: '1920x1080', style: 'abstract', lighting: 'neon', objects: 48, renderTime: null, fileSize: null, createdAt: new Date(Date.now() - 3600000).toISOString(), prompt: 'Abstract 3D bar chart rising from dark surface with glowing edges' },
    { id: '3d-4', name: 'Hero Background', status: 'queued', engine: 'blender-mcp', resolution: '3840x2160', style: 'gradient-mesh', lighting: 'ambient', objects: 0, renderTime: null, fileSize: null, createdAt: new Date().toISOString(), prompt: 'Organic mesh gradient background with floating geometric shapes' },
  ],
  presets: [
    { id: 'preset-studio', name: 'Studio Lighting', lighting: 'three-point', style: 'clean' },
    { id: 'preset-dramatic', name: 'Dramatic', lighting: 'dramatic', style: 'cinematic' },
    { id: 'preset-neon', name: 'Neon Glow', lighting: 'neon', style: 'cyberpunk' },
    { id: 'preset-natural', name: 'Natural', lighting: 'hdri', style: 'photorealistic' },
  ],
};

app.get('/api/3d/scenes', (req, res) => {
  res.json(blender3d.scenes);
});

app.get('/api/3d/stats', (req, res) => {
  const s = blender3d.scenes;
  res.json({
    total: s.length,
    rendered: s.filter(x => x.status === 'rendered').length,
    rendering: s.filter(x => x.status === 'rendering').length,
    queued: s.filter(x => x.status === 'queued').length,
    totalObjects: s.reduce((sum, x) => sum + x.objects, 0),
    presets: blender3d.presets.length,
  });
});

app.get('/api/3d/presets', (req, res) => {
  res.json(blender3d.presets);
});

app.post('/api/3d/scenes', heavyLimiter, (req, res) => {
  const { name, prompt, style, lighting, resolution } = req.body;
  const scene = {
    id: `3d-${Date.now()}`,
    name: name || 'Untitled Scene',
    status: 'queued',
    engine: 'blender-mcp',
    resolution: resolution || '2048x2048',
    style: style || 'photorealistic',
    lighting: lighting || 'dramatic',
    objects: 0,
    renderTime: null,
    fileSize: null,
    createdAt: new Date().toISOString(),
    prompt: prompt || '',
  };
  blender3d.scenes.unshift(scene);
  broadcast({ event: '3d_update', data: scene });
  setTimeout(() => {
    scene.status = 'rendering';
    scene.objects = Math.floor(Math.random() * 20) + 3;
    broadcast({ event: '3d_update', data: scene });
  }, 2000);
  setTimeout(() => {
    scene.status = 'rendered';
    scene.renderTime = `${Math.floor(Math.random() * 5) + 1}m ${Math.floor(Math.random() * 59)}s`;
    scene.fileSize = `${(Math.random() * 15 + 2).toFixed(1)} MB`;
    broadcast({ event: '3d_update', data: scene });
  }, 8000);
  res.json(scene);
});

// --- Predictive Analytics ---
const predictiveAnalytics = {
  predictions: [
    { id: 'pred-1', metric: 'Monthly Revenue', current: 4200, predicted: 5800, confidence: 0.87, trend: 'up', period: 'next-30d', factors: ['Product launches', 'Email list growth', 'Seasonal demand'], createdAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'pred-2', metric: 'Lead Conversion Rate', current: 33, predicted: 41, confidence: 0.79, trend: 'up', period: 'next-30d', factors: ['Improved personalization', 'Achievement-based outreach', 'Follow-up sequences'], createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: 'pred-3', metric: 'Content Engagement', current: 4.8, predicted: 6.2, confidence: 0.82, trend: 'up', period: 'next-14d', factors: ['Video content increase', 'Cross-platform distribution', 'Trending topics'], createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
    { id: 'pred-4', metric: 'API Cost', current: 12.50, predicted: 18.20, confidence: 0.91, trend: 'up', period: 'next-7d', factors: ['Batch routine scaling', 'New agent additions', 'Media production'], createdAt: new Date(Date.now() - 12 * 3600000).toISOString() },
    { id: 'pred-5', metric: 'Churn Risk', current: 2.1, predicted: 1.4, confidence: 0.74, trend: 'down', period: 'next-30d', factors: ['Onboarding improvements', 'Feature adoption tracking', 'Proactive support'], createdAt: new Date(Date.now() - 4 * 86400000).toISOString() },
  ],
  models: [
    { id: 'model-revenue', name: 'Revenue Forecaster', accuracy: 87, lastTrained: new Date(Date.now() - 86400000).toISOString(), dataPoints: 180 },
    { id: 'model-engagement', name: 'Engagement Predictor', accuracy: 82, lastTrained: new Date(Date.now() - 2 * 86400000).toISOString(), dataPoints: 420 },
    { id: 'model-churn', name: 'Churn Detector', accuracy: 79, lastTrained: new Date(Date.now() - 3 * 86400000).toISOString(), dataPoints: 95 },
    { id: 'model-cost', name: 'Cost Projector', accuracy: 91, lastTrained: new Date(Date.now() - 12 * 3600000).toISOString(), dataPoints: 304 },
  ],
};

app.get('/api/predictions', (req, res) => {
  res.json(predictiveAnalytics.predictions);
});

app.get('/api/predictions/stats', (req, res) => {
  const p = predictiveAnalytics.predictions;
  res.json({
    totalPredictions: p.length,
    avgConfidence: Math.round(p.reduce((s, x) => s + x.confidence, 0) / p.length * 100),
    trendsUp: p.filter(x => x.trend === 'up').length,
    trendsDown: p.filter(x => x.trend === 'down').length,
    models: predictiveAnalytics.models.length,
    avgModelAccuracy: Math.round(predictiveAnalytics.models.reduce((s, m) => s + m.accuracy, 0) / predictiveAnalytics.models.length),
  });
});

app.get('/api/predictions/models', (req, res) => {
  res.json(predictiveAnalytics.models);
});

// --- Batch Generation Queue ---
const batchQueue = {
  batches: [
    { id: 'batch-1', name: 'Instagram Ad Variants', type: 'image', count: 24, completed: 24, status: 'done', agent: 'deepseek-worker', startedAt: new Date(Date.now() - 6 * 3600000).toISOString(), completedAt: new Date(Date.now() - 5.2 * 3600000).toISOString(), cost: 0.18, outputPath: '.magent/artifacts/media/ads-ig/' },
    { id: 'batch-2', name: 'Blog Post Series (SEO)', type: 'text', count: 10, completed: 7, status: 'running', agent: 'writer', startedAt: new Date(Date.now() - 2 * 3600000).toISOString(), completedAt: null, cost: 0.42, outputPath: '.magent/artifacts/docs/blog-series/' },
    { id: 'batch-3', name: 'Product Description Pack', type: 'text', count: 50, completed: 50, status: 'done', agent: 'deepseek-worker', startedAt: new Date(Date.now() - 24 * 3600000).toISOString(), completedAt: new Date(Date.now() - 22 * 3600000).toISOString(), cost: 0.35, outputPath: '.magent/artifacts/docs/product-descs/' },
    { id: 'batch-4', name: 'Social Media Carousel Pack', type: 'image', count: 15, completed: 0, status: 'queued', agent: 'media-producer', startedAt: null, completedAt: null, cost: 0, outputPath: '.magent/artifacts/media/carousels/' },
    { id: 'batch-5', name: 'Email Subject Line A/B', type: 'text', count: 100, completed: 100, status: 'done', agent: 'deepseek-worker', startedAt: new Date(Date.now() - 48 * 3600000).toISOString(), completedAt: new Date(Date.now() - 47 * 3600000).toISOString(), cost: 0.08, outputPath: '.magent/artifacts/docs/subject-lines/' },
  ],
};

app.get('/api/batch', (req, res) => {
  res.json(batchQueue.batches);
});

app.get('/api/batch/stats', (req, res) => {
  const b = batchQueue.batches;
  res.json({
    total: b.length,
    running: b.filter(x => x.status === 'running').length,
    queued: b.filter(x => x.status === 'queued').length,
    done: b.filter(x => x.status === 'done').length,
    totalItems: b.reduce((s, x) => s + x.count, 0),
    completedItems: b.reduce((s, x) => s + x.completed, 0),
    totalCost: b.reduce((s, x) => s + x.cost, 0),
  });
});

app.post('/api/batch', heavyLimiter, (req, res) => {
  const errs = validateBody(req.body, {
    name: { type: 'string', maxLength: 200 },
    type: { type: 'string', oneOf: ['social-posts', 'email-variants', 'ad-copy', 'blog-outlines', 'seo-descriptions', 'text'] },
    count: { type: 'number', min: 1, max: 1000 },
  });
  if (errs) return res.status(400).json({ error: errs.join('; ') });
  const { name, type, count, agent } = req.body;
  const batch = {
    id: `batch-${Date.now()}`,
    name: name || 'Untitled Batch',
    type: type || 'text',
    count: count || 10,
    completed: 0,
    status: 'queued',
    agent: agent || 'deepseek-worker',
    startedAt: null,
    completedAt: null,
    cost: 0,
    outputPath: `.magent/artifacts/${type === 'image' ? 'media' : 'docs'}/batch-${Date.now()}/`,
  };
  batchQueue.batches.unshift(batch);
  broadcast({ event: 'batch_update', data: batch });
  // Simulate processing
  setTimeout(() => {
    batch.status = 'running';
    batch.startedAt = new Date().toISOString();
    broadcast({ event: 'batch_update', data: batch });
  }, 2000);
  setTimeout(() => {
    batch.status = 'done';
    batch.completed = batch.count;
    batch.completedAt = new Date().toISOString();
    batch.cost = +(batch.count * 0.008).toFixed(3);
    broadcast({ event: 'batch_update', data: batch });
  }, 8000);
  res.json(batch);
});

// --- Hermes Agent (Persistent Background Worker via MCP) ---

// Hermes MCP connection state
const hermesState = {
  connected: false,
  endpoint: process.env.HERMES_MCP_URL || 'http://127.0.0.1:8420',
  lastPing: null,
  uptime: 0,
  activeTasks: [],
  approvalQueue: [],
  cronJobs: [],
  skills: [],
  stats: { tasksCompleted: 0, tasksFailed: 0, approvalsPending: 0, cronExecutions: 0 },
};

// Simulate Hermes connection check
function checkHermesConnection() {
  if (DEMO_MODE) {
    hermesState.connected = true;
    hermesState.lastPing = new Date().toISOString();
    hermesState.uptime = Math.floor((Date.now() - startTime) / 1000);
    hermesState.skills = [
      { name: 'inbox-summary', description: 'Daily email inbox digest' },
      { name: 'news-brief', description: 'Morning AI/tech news roundup' },
      { name: 'github-backup', description: 'Nightly repository backup' },
      { name: 'comment-monitor', description: 'YouTube/social comment tracker' },
      { name: 'uptime-check', description: 'VPS and service health monitor' },
    ];
    return true;
  }
  // Real MCP connection would go here
  return false;
}

// Hermes status
app.get('/api/hermes/status', (req, res) => {
  checkHermesConnection();
  res.json({
    connected: hermesState.connected,
    endpoint: hermesState.endpoint,
    lastPing: hermesState.lastPing,
    uptime: hermesState.uptime,
    stats: hermesState.stats,
    skills: hermesState.skills,
  });
});

// Delegate a task to Hermes
app.post('/api/hermes/delegate', (req, res) => {
  const errors = validateBody(req.body, {
    task: { type: 'string', required: true, maxLength: 2000 },
    mode: { type: 'string' }, // 'background' | 'walkaway' | 'cron'
  });
  if (errors) return res.status(400).json({ error: errors.join(', ') });

  const { task, mode = 'background', schedule, notifyVia } = req.body;
  const id = uuidv4();
  const delegated = {
    id,
    task,
    mode,
    status: 'delegated',
    delegatedAt: new Date().toISOString(),
    progress: 0,
    log: [`Task delegated to Hermes (${mode} mode)`],
    notifyVia: notifyVia || 'websocket',
  };

  if (mode === 'cron' && schedule) {
    delegated.schedule = schedule;
    delegated.nextRun = new Date(Date.now() + 3600000).toISOString();
    hermesState.cronJobs.push(delegated);
  } else {
    hermesState.activeTasks.push(delegated);
  }

  hermesState.stats.tasksCompleted++;
  logActivity('hermes', `Task delegated to Hermes: ${task.substring(0, 80)}`, { id, mode });
  broadcast({ event: 'hermes_task', data: delegated });

  // Simulate progress for demo
  if (DEMO_MODE && mode !== 'cron') {
    setTimeout(() => {
      delegated.status = 'running';
      delegated.progress = 35;
      delegated.log.push('Hermes picked up the task');
      broadcast({ event: 'hermes_progress', data: delegated });
    }, 2000);
    setTimeout(() => {
      delegated.status = 'complete';
      delegated.progress = 100;
      delegated.completedAt = new Date().toISOString();
      delegated.log.push('Task completed successfully');
      delegated.result = `Hermes completed: ${task.substring(0, 60)}`;
      broadcast({ event: 'hermes_complete', data: delegated });
    }, 8000);
  }

  res.json(delegated);
});

// Get active Hermes tasks
app.get('/api/hermes/tasks', (req, res) => {
  if (DEMO_MODE && hermesState.activeTasks.length === 0) {
    hermesState.activeTasks = [
      { id: 'h-1', task: 'Morning AI news brief compilation', mode: 'background', status: 'complete', progress: 100, delegatedAt: new Date(Date.now() - 3600000).toISOString(), completedAt: new Date(Date.now() - 3000000).toISOString(), log: ['Compiled 12 articles', 'Summary written to vault'], notifyVia: 'telegram' },
      { id: 'h-2', task: 'Refactor authentication module to use JWT tokens', mode: 'walkaway', status: 'running', progress: 62, delegatedAt: new Date(Date.now() - 1800000).toISOString(), log: ['Analyzing current auth flow', 'Identified 8 files to modify', 'Modified 5/8 files'], notifyVia: 'telegram' },
      { id: 'h-3', task: 'Monitor YouTube channel comments for new feedback', mode: 'background', status: 'running', progress: 0, delegatedAt: new Date(Date.now() - 600000).toISOString(), log: ['Watching 3 videos for new comments'], notifyVia: 'slack' },
    ];
  }
  res.json(hermesState.activeTasks);
});

// Approval queue — Hermes pauses risky actions and asks for confirmation
app.get('/api/hermes/approvals', (req, res) => {
  if (DEMO_MODE && hermesState.approvalQueue.length === 0) {
    hermesState.approvalQueue = [
      { id: 'apr-1', action: 'Delete 47 outdated log files from /var/log/ai-os/', risk: 'medium', requestedAt: new Date(Date.now() - 300000).toISOString(), context: 'Part of scheduled disk cleanup routine. Files are older than 90 days.', taskId: 'h-cron-1' },
      { id: 'apr-2', action: 'Force-push branch fix/auth-refactor to origin', risk: 'high', requestedAt: new Date(Date.now() - 120000).toISOString(), context: 'Walkaway refactoring task. Branch has 3 commits that rewrite auth flow.', taskId: 'h-2' },
    ];
    hermesState.stats.approvalsPending = 2;
  }
  res.json(hermesState.approvalQueue);
});

// Respond to an approval request
app.post('/api/hermes/approvals/:id', (req, res) => {
  const { id } = req.params;
  const { decision } = req.body; // 'approve' | 'reject'
  const idx = hermesState.approvalQueue.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Approval not found' });

  const approval = hermesState.approvalQueue[idx];
  approval.decision = decision;
  approval.decidedAt = new Date().toISOString();
  hermesState.approvalQueue.splice(idx, 1);
  hermesState.stats.approvalsPending = hermesState.approvalQueue.length;

  logActivity('hermes', `Approval ${decision}: ${approval.action.substring(0, 60)}`, { id });
  broadcast({ event: 'hermes_approval_resolved', data: approval });
  res.json({ ok: true, approval });
});

// Walkaway mode — get status of long-running delegated tasks
app.get('/api/hermes/walkaway', (req, res) => {
  const walkawayTasks = hermesState.activeTasks.filter(t => t.mode === 'walkaway');
  res.json({
    active: walkawayTasks.length,
    tasks: walkawayTasks,
    approvalsPending: hermesState.stats.approvalsPending,
  });
});

// Send a mobile reply to a walkaway task
app.post('/api/hermes/walkaway/:id/reply', (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const task = hermesState.activeTasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  task.log.push(`Mobile reply: ${message}`);
  broadcast({ event: 'hermes_walkaway_reply', data: { taskId: id, message } });
  logActivity('hermes', `Walkaway reply: ${message.substring(0, 60)}`, { taskId: id });
  res.json({ ok: true });
});

// Hermes cron jobs — scheduled background tasks
app.get('/api/hermes/cron', (req, res) => {
  if (DEMO_MODE && hermesState.cronJobs.length === 0) {
    hermesState.cronJobs = [
      { id: 'h-cron-1', task: 'Daily inbox summary', schedule: '0 8 * * *', status: 'active', mode: 'cron', lastRun: new Date(Date.now() - 86400000).toISOString(), nextRun: new Date(Date.now() + 28800000).toISOString(), runs: 14, notifyVia: 'telegram' },
      { id: 'h-cron-2', task: 'GitHub repository backup', schedule: '0 2 * * *', status: 'active', mode: 'cron', lastRun: new Date(Date.now() - 43200000).toISOString(), nextRun: new Date(Date.now() + 43200000).toISOString(), runs: 30, notifyVia: 'slack' },
      { id: 'h-cron-3', task: 'Morning AI/tech news brief', schedule: '30 7 * * 1-5', status: 'active', mode: 'cron', lastRun: new Date(Date.now() - 86400000).toISOString(), nextRun: new Date(Date.now() + 57600000).toISOString(), runs: 22, notifyVia: 'telegram' },
      { id: 'h-cron-4', task: 'YouTube comment monitoring', schedule: '0 */4 * * *', status: 'active', mode: 'cron', lastRun: new Date(Date.now() - 7200000).toISOString(), nextRun: new Date(Date.now() + 7200000).toISOString(), runs: 168, notifyVia: 'websocket' },
      { id: 'h-cron-5', task: 'VPS disk and memory health check', schedule: '*/30 * * * *', status: 'active', mode: 'cron', lastRun: new Date(Date.now() - 900000).toISOString(), nextRun: new Date(Date.now() + 900000).toISOString(), runs: 720, notifyVia: 'websocket' },
    ];
    hermesState.stats.cronExecutions = 954;
  }
  res.json(hermesState.cronJobs);
});

// Create a new Hermes cron job
app.post('/api/hermes/cron', (req, res) => {
  const errors = validateBody(req.body, {
    task: { type: 'string', required: true, maxLength: 500 },
    schedule: { type: 'string', required: true, maxLength: 50 },
  });
  if (errors) return res.status(400).json({ error: errors.join(', ') });

  const id = `h-cron-${uuidv4().substring(0, 6)}`;
  const job = {
    id,
    task: req.body.task,
    schedule: req.body.schedule,
    status: 'active',
    mode: 'cron',
    lastRun: null,
    nextRun: new Date(Date.now() + 3600000).toISOString(),
    runs: 0,
    notifyVia: req.body.notifyVia || 'websocket',
  };
  hermesState.cronJobs.push(job);
  logActivity('hermes', `Cron job created: ${job.task}`, { id, schedule: job.schedule });
  broadcast({ event: 'hermes_cron_created', data: job });
  res.json(job);
});

// Delete a Hermes cron job
app.delete('/api/hermes/cron/:id', (req, res) => {
  const idx = hermesState.cronJobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Cron job not found' });
  const removed = hermesState.cronJobs.splice(idx, 1)[0];
  logActivity('hermes', `Cron job deleted: ${removed.task}`, { id: removed.id });
  res.json({ ok: true });
});

// --- Settings (Admin-only API key & connection management) ---

// Settings persisted to state file — keys are encrypted at rest in production
const settings = loadState('settings', {
  ai: {
    anthropic_api_key: process.env.ANTHROPIC_API_KEY || '',
    deepseek_api_key: process.env.DEEPSEEK_API_KEY || '',
    xai_api_key: process.env.XAI_API_KEY || '',
    firecrawl_api_key: process.env.FIRECRAWL_API_KEY || '',
    gemini_api_key: process.env.GEMINI_API_KEY || '',
    tavily_api_key: process.env.TAVILY_API_KEY || '',
    apify_api_token: process.env.APIFY_API_TOKEN || '',
    openai_api_key: process.env.OPENAI_API_KEY || '',
    perplexity_api_key: process.env.PERPLEXITY_API_KEY || '',
    manus_api_key: process.env.MANUS_API_KEY || '',
  },
  mcp: {
    hermes_url: process.env.HERMES_MCP_URL || 'http://127.0.0.1:8420',
    hermes_enabled: false,
  },
  notifications: {
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    slack_webhook_url: process.env.SLACK_WEBHOOK_URL || '',
  },
  automation: {
    n8n_webhook_base: process.env.N8N_WEBHOOK_BASE || '',
    n8n_api_key: process.env.N8N_API_KEY || '',
    team_webhook_url: process.env.TEAM_WEBHOOK_URL || '',
  },
  stripe: {
    secret_key: process.env.STRIPE_SECRET_KEY || '',
    webhook_secret: process.env.STRIPE_WEBHOOK_SECRET || '',
    pro_price_id: process.env.STRIPE_PRO_PRICE_ID || '',
    business_price_id: process.env.STRIPE_BUSINESS_PRICE_ID || '',
    enterprise_price_id: process.env.STRIPE_ENTERPRISE_PRICE_ID || '',
  },
  seo: {
    dataforseo_login: process.env.DATAFORSEO_LOGIN || '',
    dataforseo_password: process.env.DATAFORSEO_PASSWORD || '',
    default_location: 'United States',
    default_language: 'en',
  },
  general: {
    demo_mode: DEMO_MODE,
    cors_origin: process.env.CORS_ORIGIN || '*',
    api_token: process.env.API_TOKEN || '',
  },
});

// Middleware: require admin role
function requireAdmin(req, res, next) {
  const token = req.cookies?.['ai-os-session'] || req.headers.authorization?.replace('Bearer ', '');
  const session = isValidSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Register tenant routes now that requireAdmin is defined
registerTenantRoutes();

// Mask a key for display — show first 4 and last 4 chars
function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function maskKey(key) {
  if (!key || key.length < 12) return key ? '****' : '';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

// GET settings — returns masked keys (never send raw secrets to the browser)
app.get('/api/settings', requireAdmin, (req, res) => {
  const masked = {
    ai: {
      anthropic_api_key: { value: maskKey(settings.ai.anthropic_api_key), configured: !!settings.ai.anthropic_api_key },
      deepseek_api_key: { value: maskKey(settings.ai.deepseek_api_key), configured: !!settings.ai.deepseek_api_key },
      xai_api_key: { value: maskKey(settings.ai.xai_api_key), configured: !!settings.ai.xai_api_key },
      firecrawl_api_key: { value: maskKey(settings.ai.firecrawl_api_key), configured: !!settings.ai.firecrawl_api_key },
      gemini_api_key: { value: maskKey(settings.ai.gemini_api_key), configured: !!settings.ai.gemini_api_key },
      tavily_api_key: { value: maskKey(settings.ai.tavily_api_key), configured: !!settings.ai.tavily_api_key },
      apify_api_token: { value: maskKey(settings.ai.apify_api_token), configured: !!settings.ai.apify_api_token },
      openai_api_key: { value: maskKey(settings.ai.openai_api_key), configured: !!settings.ai.openai_api_key },
      perplexity_api_key: { value: maskKey(settings.ai.perplexity_api_key), configured: !!settings.ai.perplexity_api_key },
      manus_api_key: { value: maskKey(settings.ai.manus_api_key), configured: !!settings.ai.manus_api_key },
    },
    mcp: {
      hermes_url: settings.mcp.hermes_url,
      hermes_enabled: settings.mcp.hermes_enabled,
    },
    notifications: {
      telegram_bot_token: { value: maskKey(settings.notifications.telegram_bot_token), configured: !!settings.notifications.telegram_bot_token },
      telegram_chat_id: settings.notifications.telegram_chat_id,
      slack_webhook_url: { value: maskKey(settings.notifications.slack_webhook_url), configured: !!settings.notifications.slack_webhook_url },
    },
    automation: {
      n8n_webhook_base: settings.automation.n8n_webhook_base,
      n8n_api_key: { value: maskKey(settings.automation.n8n_api_key), configured: !!settings.automation.n8n_api_key },
      team_webhook_url: settings.automation.team_webhook_url,
    },
    stripe: {
      secret_key: { value: maskKey(settings.stripe.secret_key), configured: !!settings.stripe.secret_key },
      webhook_secret: { value: maskKey(settings.stripe.webhook_secret), configured: !!settings.stripe.webhook_secret },
      pro_price_id: settings.stripe.pro_price_id,
      business_price_id: settings.stripe.business_price_id,
      enterprise_price_id: settings.stripe.enterprise_price_id,
    },
    seo: {
      dataforseo_login: settings.seo.dataforseo_login || '',
      dataforseo_password: { value: maskKey(settings.seo.dataforseo_password), configured: !!settings.seo.dataforseo_password },
      default_location: settings.seo.default_location || 'United States',
      default_language: settings.seo.default_language || 'en',
    },
    general: {
      demo_mode: settings.general.demo_mode,
      cors_origin: settings.general.cors_origin,
      api_token: { value: maskKey(settings.general.api_token), configured: !!settings.general.api_token },
    },
  };
  res.json(masked);
});

// PUT settings — update a specific section
app.put('/api/settings/:section', requireAdmin, (req, res) => {
  const { section } = req.params;
  if (!settings[section]) return res.status(400).json({ error: `Unknown section: ${section}` });

  const updates = req.body;
  const updated = [];
  const skipped = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!(key in settings[section])) { skipped.push(`${key}:unknown`); continue; }
    // Skip masked placeholder values — only update if the user actually typed a new key
    if (typeof value === 'string' && value.includes('****')) { skipped.push(`${key}:masked`); continue; }
    // Skip empty strings that are already empty (no-op)
    if (value === '' && settings[section][key] === '') { skipped.push(`${key}:empty`); continue; }
    settings[section][key] = value;
    updated.push(key);
  }

  console.log(`[SETTINGS] PUT ${section} — updated: [${updated.join(', ')}], skipped: [${skipped.join(', ')}]`);

  if (updated.length > 0) {
    saveState('settings', settings);
    logActivity('settings', `Settings updated: ${section} → ${updated.join(', ')}`, { section });
  }

  res.json({ ok: true, updated, skipped });
});

// POST test a connection (Hermes MCP, Telegram, Slack)
app.post('/api/settings/test/:service', requireAdmin, async (req, res) => {
  const { service } = req.params;

  if (service === 'hermes') {
    try {
      const url = settings.mcp.hermes_url + '/health';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const ok = r.ok;
      res.json({ ok, status: r.status, message: ok ? 'Hermes MCP is reachable' : `HTTP ${r.status}` });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'telegram') {
    if (!settings.notifications.telegram_bot_token) return res.json({ ok: false, message: 'No bot token configured' });
    try {
      const url = `https://api.telegram.org/bot${settings.notifications.telegram_bot_token}/getMe`;
      const r = await fetch(url);
      const data = await r.json();
      res.json({ ok: data.ok, message: data.ok ? `Bot: @${data.result.username}` : (data.description || 'Invalid token') });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'slack') {
    if (!settings.notifications.slack_webhook_url) return res.json({ ok: false, message: 'No webhook URL configured' });
    try {
      const r = await fetch(settings.notifications.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '✓ AI OS Settings: Connection test successful' }),
      });
      res.json({ ok: r.ok, message: r.ok ? 'Test message sent to Slack' : `HTTP ${r.status}` });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'anthropic') {
    if (!settings.ai.anthropic_api_key) return res.json({ ok: false, message: 'No API key configured' });
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': settings.ai.anthropic_api_key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
      });
      const ok = r.ok;
      res.json({ ok, message: ok ? 'Anthropic API key is valid' : `HTTP ${r.status} — check your key` });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'deepseek') {
    if (!settings.ai.deepseek_api_key) return res.json({ ok: false, message: 'No DeepSeek API key configured — save your key first' });
    try {
      const r = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': `Bearer ${settings.ai.deepseek_api_key}` },
      });
      res.json({ ok: r.ok, message: r.ok ? 'DeepSeek API key is valid' : `HTTP ${r.status} — check your key` });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'xai') {
    if (!settings.ai.xai_api_key) return res.json({ ok: false, message: 'No xAI API key configured — save your key first' });
    try {
      const r = await fetch('https://api.x.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${settings.ai.xai_api_key}` },
      });
      const ok = r.ok;
      if (ok) {
        const data = await r.json();
        const models = data.data ? data.data.map(m => m.id).slice(0, 3).join(', ') : 'connected';
        res.json({ ok: true, message: `xAI API valid — models: ${models}` });
      } else {
        res.json({ ok: false, message: `HTTP ${r.status} — check your xAI key` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'gemini') {
    if (!settings.ai.gemini_api_key) return res.json({ ok: false, message: 'No Gemini API key configured — save your key first' });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${settings.ai.gemini_api_key}`);
      const data = await r.json();
      if (data.models) {
        const omniModels = data.models.filter(m => m.name.includes('omni') || m.name.includes('gemini')).slice(0, 3);
        res.json({ ok: true, message: `Gemini API valid — ${data.models.length} models available` + (omniModels.length ? ` (incl. ${omniModels.map(m => m.name.split('/').pop()).join(', ')})` : '') });
      } else {
        res.json({ ok: false, message: data.error?.message || `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'openai') {
    if (!settings.ai.openai_api_key) return res.json({ ok: false, message: 'No OpenAI API key configured — save your key first' });
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${settings.ai.openai_api_key}` },
      });
      const data = await r.json();
      if (data.data) {
        const models = data.data.slice(0, 3).map(m => m.id).join(', ');
        res.json({ ok: true, message: `OpenAI connected — ${data.data.length} models (incl. ${models})` });
      } else {
        res.json({ ok: false, message: data.error?.message || `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'perplexity') {
    if (!settings.ai.perplexity_api_key) return res.json({ ok: false, message: 'No Perplexity API key configured — save your key first' });
    try {
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.ai.perplexity_api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
      });
      const ok = r.ok;
      res.json({ ok, message: ok ? 'Perplexity Sonar API connected' : `HTTP ${r.status} — check your key` });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'manus') {
    if (!settings.ai.manus_api_key) return res.json({ ok: false, message: 'No Manus API key configured — save your key first' });
    try {
      const r = await fetch('https://api.manus.im/v1/user/me', {
        headers: { 'Authorization': `Bearer ${settings.ai.manus_api_key}` },
      });
      const ok = r.ok;
      if (ok) {
        const data = await r.json();
        res.json({ ok: true, message: `Manus connected — ${data.username || 'account verified'}` });
      } else {
        res.json({ ok: false, message: `HTTP ${r.status} — check your key` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'tavily') {
    if (!settings.ai.tavily_api_key) return res.json({ ok: false, message: 'No Tavily API key configured — save your key first' });
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: settings.ai.tavily_api_key, query: 'test', max_results: 1 }),
      });
      const data = await r.json();
      if (data.results) {
        res.json({ ok: true, message: `Tavily connected — ${data.results.length} result returned` });
      } else {
        res.json({ ok: false, message: data.detail || data.error || `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'apify') {
    if (!settings.ai.apify_api_token) return res.json({ ok: false, message: 'No Apify API token configured — save your token first' });
    try {
      const r = await fetch('https://api.apify.com/v2/user/me', {
        headers: { 'Authorization': `Bearer ${settings.ai.apify_api_token}` },
      });
      const data = await r.json();
      if (data.data?.username) {
        res.json({ ok: true, message: `Apify connected — user: ${data.data.username}, plan: ${data.data.plan?.id || 'free'}` });
      } else {
        res.json({ ok: false, message: data.error?.message || `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else if (service === 'dataforseo') {
    if (!settings.seo.dataforseo_login || !settings.seo.dataforseo_password) {
      return res.json({ ok: false, message: 'DataForSEO login and password required — save your credentials first' });
    }
    try {
      const creds = Buffer.from(`${settings.seo.dataforseo_login}:${settings.seo.dataforseo_password}`).toString('base64');
      const r = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: 'test', location_name: 'United States', language_name: 'English', depth: 1 }]),
      });
      const data = await r.json();
      const ok = data.status_code === 20000;
      res.json({ ok, message: ok ? `DataForSEO connected — balance: $${data.cost || 'N/A'}` : (data.status_message || `HTTP ${r.status}`) });
    } catch (e) {
      res.json({ ok: false, message: `Connection failed: ${e.message}` });
    }
  } else {
    res.status(400).json({ error: `Unknown service: ${service}` });
  }
});

// --- Virtual Corporate HQ ---

const ORG_CHART = {
  company: 'AI OS Corp',
  departments: [
    {
      id: 'executive', name: 'Executive Office', icon: '🏛️', color: '#8b5cf6',
      employees: [
        { id: 'ceo', title: 'Chief Executive Officer', name: 'Atlas', agent: 'orchestrator', tier: 'strategic', avatar: '👔', status: 'active', reportsTo: null, desc: 'Strategic vision, cross-department coordination, final decision authority' },
        { id: 'cto', title: 'Chief Technology Officer', name: 'Nova', agent: 'architect', tier: 'strategic', avatar: '🧠', status: 'active', reportsTo: 'ceo', desc: 'Technical architecture, model routing, infrastructure decisions' },
        { id: 'cfo', title: 'Chief Financial Officer', name: 'Ledger', agent: 'cost-analyst', tier: 'strategic', avatar: '📊', status: 'active', reportsTo: 'ceo', desc: 'Budget management, cost optimization, financial reporting' },
        { id: 'coo', title: 'Chief Operating Officer', name: 'Meridian', agent: 'automator', tier: 'professional', avatar: '⚙️', status: 'active', reportsTo: 'ceo', desc: 'Operational workflows, CRON routines, process automation' },
      ]
    },
    {
      id: 'board', name: 'Board of Directors', icon: '🏆', color: '#6366f1',
      employees: [
        { id: 'board-quality', title: 'Quality Director', name: 'Sentinel', agent: 'reviewer', tier: 'strategic', avatar: '🔍', status: 'active', reportsTo: 'ceo', desc: 'Code and content quality standards, review enforcement' },
        { id: 'board-security', title: 'Security Director', name: 'Aegis', agent: 'security-auditor', tier: 'strategic', avatar: '🛡️', status: 'active', reportsTo: 'ceo', desc: 'Security posture, vulnerability assessment, compliance' },
        { id: 'board-research', title: 'Research Director', name: 'Cipher', agent: 'research-architect', tier: 'professional', avatar: '🔬', status: 'active', reportsTo: 'ceo', desc: 'Research methodology, knowledge strategy, academic rigor' },
      ]
    },
    {
      id: 'engineering', name: 'Engineering', icon: '💻', color: '#3b82f6',
      employees: [
        { id: 'eng-lead', title: 'Engineering Lead', name: 'Forge', agent: 'coder', tier: 'professional', avatar: '⌨️', status: 'active', reportsTo: 'cto', desc: 'Full-stack development, debugging, refactoring, implementation' },
        { id: 'eng-qa', title: 'QA Engineer', name: 'Prism', agent: 'qa', tier: 'professional', avatar: '🧪', status: 'active', reportsTo: 'eng-lead', desc: 'Test plans, regression testing, edge case identification' },
        { id: 'eng-data', title: 'Data Engineer', name: 'Flux', agent: 'data-wrangler', tier: 'professional', avatar: '📈', status: 'active', reportsTo: 'eng-lead', desc: 'Data cleaning, transformation, analysis, format conversion' },
        { id: 'eng-browser', title: 'Automation Engineer', name: 'Phantom', agent: 'browser-agent', tier: 'professional', avatar: '🌐', status: 'active', reportsTo: 'eng-lead', desc: 'Browser automation, web scraping, headless operations' },
        { id: 'eng-devops', title: 'DevOps Engineer', name: 'Relay', agent: 'devops', tier: 'professional', avatar: '🔧', status: 'idle', reportsTo: 'cto', desc: 'Deployment, monitoring, infrastructure, CI/CD pipelines' },
      ]
    },
    {
      id: 'marketing', name: 'Marketing & Sales', icon: '📣', color: '#10b981',
      employees: [
        { id: 'mkt-lead', title: 'Marketing Director', name: 'Echo', agent: 'marketing-hub', tier: 'professional', avatar: '📢', status: 'active', reportsTo: 'coo', desc: 'Multi-platform content pipelines, campaign strategy, performance tracking' },
        { id: 'mkt-content', title: 'Content Lead', name: 'Quill', agent: 'writer', tier: 'professional', avatar: '✍️', status: 'active', reportsTo: 'mkt-lead', desc: 'Long-form content, copywriting, documentation, tone adaptation' },
        { id: 'mkt-seo', title: 'SEO Lead', name: 'Beacon', agent: 'seo-keyword', tier: 'professional', avatar: '🔎', status: 'active', reportsTo: 'mkt-lead', desc: 'SEO audits, keyword research, content optimization, competitor analysis' },
        { id: 'mkt-social', title: 'Social Media Manager', name: 'Pulse', agent: 'social-intel', tier: 'scout', avatar: '📱', status: 'active', reportsTo: 'mkt-lead', desc: 'Social monitoring, sentiment analysis, trend detection' },
        { id: 'sales-lead', title: 'Sales Director', name: 'Catalyst', agent: 'lead-gen', tier: 'professional', avatar: '🤝', status: 'active', reportsTo: 'coo', desc: 'Lead generation, prospect enrichment, scoring, outreach sequences' },
      ]
    },
    {
      id: 'creative', name: 'Creative Studio', icon: '🎨', color: '#ec4899',
      employees: [
        { id: 'creative-dir', title: 'Creative Director', name: 'Muse', agent: 'media-producer', tier: 'creative', avatar: '🎬', status: 'active', reportsTo: 'coo', desc: 'Media production pipeline, creative strategy, brand consistency' },
        { id: 'creative-design', title: 'UI/UX Designer', name: 'Pixel', agent: 'vibe-designer', tier: 'creative', avatar: '🎨', status: 'active', reportsTo: 'creative-dir', desc: 'Prompt-driven UI generation, predictive heat maps, interaction flows' },
        { id: 'creative-video', title: 'Video Producer', name: 'Reel', agent: 'video-creator', tier: 'creative', avatar: '🎥', status: 'active', reportsTo: 'creative-dir', desc: 'Video generation, editing, social clips, thumbnails' },
        { id: 'creative-3d', title: '3D Artist', name: 'Vertex', agent: 'blender-3d', tier: 'creative', avatar: '🧊', status: 'active', reportsTo: 'creative-dir', desc: 'Blender MCP text-to-3D environments and product renders' },
        { id: 'creative-audio', title: 'Audio Engineer', name: 'Sonance', agent: 'audio-producer', tier: 'creative', avatar: '🎵', status: 'active', reportsTo: 'creative-dir', desc: 'Voiceovers, music, sound effects, podcast audio' },
        { id: 'creative-brand', title: 'Brand Designer', name: 'Palette', agent: 'design-system', tier: 'professional', avatar: '🖌️', status: 'active', reportsTo: 'creative-dir', desc: 'Design systems, WCAG compliance, brand cloning, component specs' },
      ]
    },
    {
      id: 'customer-service', name: 'Customer Service', icon: '💬', color: '#f59e0b',
      employees: [
        { id: 'cs-lead', title: 'Support Lead', name: 'Harbor', agent: 'cs-lead', tier: 'professional', avatar: '🎧', status: 'active', reportsTo: 'coo', desc: 'Escalation management, ticket triage, satisfaction tracking' },
        { id: 'cs-tier1', title: 'Tier 1 Support', name: 'Compass', agent: 'cs-tier1', tier: 'scout', avatar: '💬', status: 'active', reportsTo: 'cs-lead', desc: 'First-response support, FAQ handling, basic troubleshooting' },
        { id: 'cs-tier2', title: 'Tier 2 Support', name: 'Resolve', agent: 'cs-tier2', tier: 'professional', avatar: '🔧', status: 'idle', reportsTo: 'cs-lead', desc: 'Complex issue resolution, technical investigation, bug reproduction' },
      ]
    },
    {
      id: 'tech-support', name: 'Tech Support & IT', icon: '🖥️', color: '#06b6d4',
      employees: [
        { id: 'it-lead', title: 'IT Director', name: 'Matrix', agent: 'it-director', tier: 'professional', avatar: '🖥️', status: 'active', reportsTo: 'cto', desc: 'Infrastructure oversight, system health, deployment coordination' },
        { id: 'it-sysadmin', title: 'System Administrator', name: 'Root', agent: 'sysadmin', tier: 'professional', avatar: '🔑', status: 'active', reportsTo: 'it-lead', desc: 'Server management, monitoring, uptime, security patches' },
        { id: 'it-helpdesk', title: 'Help Desk', name: 'Guide', agent: 'helpdesk', tier: 'scout', avatar: '🆘', status: 'idle', reportsTo: 'it-lead', desc: 'Internal support, tool provisioning, access management' },
      ]
    },
    {
      id: 'product', name: 'Product & Innovation', icon: '🚀', color: '#f97316',
      employees: [
        { id: 'prod-lead', title: 'Product Manager', name: 'Horizon', agent: 'product-factory', tier: 'professional', avatar: '🚀', status: 'active', reportsTo: 'ceo', desc: 'Product strategy, roadmap, digital product creation and publishing' },
        { id: 'prod-research', title: 'Research Analyst', name: 'Oracle', agent: 'researcher', tier: 'professional', avatar: '📚', status: 'active', reportsTo: 'prod-lead', desc: 'Deep research, source synthesis, citation tracking, structured output' },
        { id: 'prod-predict', title: 'Data Scientist', name: 'Forecast', agent: 'predictions', tier: 'professional', avatar: '📉', status: 'active', reportsTo: 'prod-lead', desc: 'Predictive analytics, forecasts, confidence scoring, trend analysis' },
        { id: 'prod-knowledge', title: 'Knowledge Manager', name: 'Archive', agent: 'knowledge-graph', tier: 'professional', avatar: '🧩', status: 'active', reportsTo: 'prod-lead', desc: 'Knowledge ingestion, semantic linking, graph visualization' },
      ]
    },
    {
      id: 'operations', name: 'Operations & Hermes', icon: '⚡', color: '#a78bfa',
      employees: [
        { id: 'ops-hermes', title: 'Hermes Director', name: 'Hermes', agent: 'hermes-delegate', tier: 'persistent', avatar: '⚡', status: 'active', reportsTo: 'coo', desc: 'Persistent background tasks, walkaway mode, always-on worker' },
        { id: 'ops-cron', title: 'Scheduler', name: 'Tempo', agent: 'hermes-cron', tier: 'persistent', avatar: '⏰', status: 'active', reportsTo: 'ops-hermes', desc: 'CRON job management, routine scheduling, periodic execution' },
        { id: 'ops-gate', title: 'Compliance Officer', name: 'Gatekeeper', agent: 'hermes-approval', tier: 'persistent', avatar: '✅', status: 'active', reportsTo: 'ops-hermes', desc: 'Approval gates, risk assessment, compliance enforcement' },
        { id: 'ops-scout', title: 'Field Scout', name: 'Ranger', agent: 'scout', tier: 'scout', avatar: '🔭', status: 'active', reportsTo: 'coo', desc: 'Quick fact-checking, lookups, rapid triage' },
        { id: 'ops-batch', title: 'Batch Processor', name: 'Conveyor', agent: 'deepseek-worker', tier: 'economy', avatar: '📦', status: 'active', reportsTo: 'coo', desc: 'Bulk content generation, economy-tier batch processing' },
        { id: 'ops-grok', title: 'Intelligence Analyst', name: 'Hawkeye', agent: 'grok-realtime', tier: 'realtime', avatar: '🦅', status: 'active', reportsTo: 'ceo', desc: 'Real-time web search, trending topics, live intelligence' },
      ]
    },
    {
      id: 'legal', name: 'Legal Department', icon: '⚖️', color: '#78716c',
      employees: [
        { id: 'legal-gc', title: 'General Counsel', name: 'Justice', agent: 'general-counsel', tier: 'strategic', avatar: '⚖️', status: 'active', reportsTo: 'ceo', desc: 'Chief Legal Officer — franchise agreements, IP protection, regulatory compliance, dispute resolution' },
        { id: 'legal-compliance', title: 'Compliance Officer', name: 'Shield', agent: 'compliance-officer', tier: 'professional', avatar: '🛡️', status: 'active', reportsTo: 'legal-gc', desc: 'GDPR/CCPA compliance, audit trails, policy enforcement, regulatory monitoring' },
        { id: 'legal-franchise', title: 'Licensing Attorney', name: 'Covenant', agent: 'franchise-attorney', tier: 'professional', avatar: '📜', status: 'active', reportsTo: 'legal-gc', desc: 'Software License Agreements, white-label terms, SaaS licensing, usage rights and restrictions' },
        { id: 'legal-contracts', title: 'Contract Specialist', name: 'Clause', agent: 'contract-specialist', tier: 'professional', avatar: '📝', status: 'active', reportsTo: 'legal-gc', desc: 'Contract generation, review, lifecycle management, template library' },
      ]
    },
  ],
};

// GET /api/hq/org — full org chart
app.get('/api/hq/org', (req, res) => {
  res.json(ORG_CHART);
});

// GET /api/hq/department/:id — single department detail
app.get('/api/hq/department/:id', (req, res) => {
  const dept = ORG_CHART.departments.find(d => d.id === req.params.id);
  if (!dept) return res.status(404).json({ error: 'Department not found' });
  res.json(dept);
});

// GET /api/hq/employee/:id — single employee detail
app.get('/api/hq/employee/:id', (req, res) => {
  for (const dept of ORG_CHART.departments) {
    const emp = dept.employees.find(e => e.id === req.params.id);
    if (emp) return res.json({ ...emp, department: dept.name, departmentId: dept.id });
  }
  res.status(404).json({ error: 'Employee not found' });
});

// GET /api/hq/stats — HQ summary stats
app.get('/api/hq/stats', (req, res) => {
  const allEmployees = ORG_CHART.departments.flatMap(d => d.employees);
  const byTier = {};
  const byStatus = { active: 0, idle: 0, busy: 0 };
  allEmployees.forEach(e => {
    byTier[e.tier] = (byTier[e.tier] || 0) + 1;
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  });
  res.json({
    company: ORG_CHART.company,
    departments: ORG_CHART.departments.length,
    totalEmployees: allEmployees.length,
    byTier,
    byStatus,
    cSuite: ORG_CHART.departments.find(d => d.id === 'executive').employees.length,
  });
});

// POST /api/hq/dispatch/:employeeId — dispatch a task to a virtual employee
app.post('/api/hq/dispatch/:employeeId', requireAdmin, (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'Task description required' });

  let employee, department;
  for (const dept of ORG_CHART.departments) {
    const emp = dept.employees.find(e => e.id === req.params.employeeId);
    if (emp) { employee = emp; department = dept; break; }
  }
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const taskId = uuidv4();
  const routing = getAgentEffort(employee.agent);

  logActivity('hq', `Task dispatched to ${employee.name} (${employee.title}): ${task.substring(0, 80)}`, {
    taskId, employee: employee.id, department: department.id, model: routing.model,
  });

  broadcast({ event: 'hq_task_dispatched', data: {
    taskId, employee: employee.id, name: employee.name, title: employee.title,
    department: department.name, task, model: routing.model, tier: routing.tier,
  }});

  if (DEMO_MODE) {
    setTimeout(() => {
      broadcast({ event: 'hq_task_complete', data: {
        taskId, employee: employee.id, name: employee.name,
        result: `${employee.name} completed the task: "${task.substring(0, 60)}" — output ready for review.`,
      }});
    }, 3000 + Math.random() * 4000);
  }

  res.json({ ok: true, taskId, employee: employee.name, title: employee.title, department: department.name, model: routing.model });
});

// --- White-Label License Management ---

const LICENSE_CONFIG = {
  tiers: {
    pro:        { price: 99,   interval: 'month', name: 'Pro' },
    business:   { price: 497,  interval: 'month', name: 'Business' },
    enterprise: { price: 1997, interval: 'month', name: 'Enterprise' },
    lifetime:   { price: 9997, interval: 'one-time', name: 'Founders Plan' },
  },
  maxLifetime: 100,       // limited lifetime spots
  currency: 'usd',
  name: 'AI OS White-Label SaaS License',
  description: 'Complete AI-powered Virtual Corporate HQ with 51 agents, 10 departments, white-label branding, and all integrations.',
  includes: [
    'Virtual Corporate HQ with 51 AI agents across 10 departments',
    'SEO Agency with 5 parallel audit sub-agents and post-audit actions',
    'Gemini Omni Creative Studio (video, image, audio, thumbnails)',
    'YouTube Video Intelligence pipeline',
    'All API integrations (Anthropic, Gemini, DeepSeek, Grok, Firecrawl, Tavily, Apify)',
    'White-label branding (your name, logo, colors, domain)',
    'Admin dashboard with full settings management',
    'Stripe integration to charge your own customers',
    'Industry templates (8 verticals)',
    'Multi-tenant isolation with dedicated state',
    'Self-improving platform with Telegram/Slack approval bot',
    'Lifetime updates and platform upgrades',
    '30-day onboarding support',
  ],
};

const licenses = loadState('licenses', []);

// GET /api/license/info — public franchise opportunity info
app.get('/api/license/info', (req, res) => {
  const active = licenses.filter(f => f.status === 'active').length;
  const remaining = LICENSE_CONFIG.maxLifetime - active;
  res.json({
    ...LICENSE_CONFIG,
    active,
    remaining,
    available: remaining > 0,
    soldPercentage: Math.round((active / LICENSE_CONFIG.maxLifetime) * 100),
  });
});

// GET /api/license/participants — admin list of all franchise participants
app.get('/api/license/participants', requireAdmin, (req, res) => {
  res.json(franchises);
});

// GET /api/license/participant/:id — single participant detail
app.get('/api/license/participant/:id', requireAdmin, (req, res) => {
  const f = licenses.find(p => p.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Participant not found' });
  res.json(f);
});

// POST /api/license/apply — submit application and go straight to Stripe checkout
app.post('/api/license/apply', async (req, res) => {
  const { name, email, company, industry, website, phone, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const active = licenses.filter(f => f.status === 'active' || f.status === 'pending' || f.status === 'payment').length;
  if (active >= LICENSE_CONFIG.maxLifetime) {
    return res.status(400).json({ error: 'Lifetime license program is full — all 100 spots claimed' });
  }

  // Check for duplicate email
  const existing = licenses.find(f => f.email === email && f.status !== 'rejected');
  if (existing) {
    return res.status(400).json({ error: 'An application with this email already exists' });
  }

  const application = {
    id: uuidv4(),
    name,
    email,
    company: company || '',
    industry: industry || '',
    website: website || '',
    phone: phone || '',
    message: message || '',
    status: 'payment',       // goes straight to payment
    appliedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    activatedAt: null,
    paymentId: null,
    instanceUrl: null,
    territory: null,
    tenantId: null,
    notes: '',
  };

  licenses.push(application);
  saveState('licenses', licenses);

  logActivity('license', `Lifetime license application + checkout: ${name} (${email})`, { id: application.id, company });
  broadcast({ event: 'license_application', data: { id: application.id, name, email, company } });

  // Create Stripe checkout session immediately
  if (!stripe) {
    return res.json({ ok: true, id: application.id, checkoutUrl: null, message: 'Application saved — Stripe not configured. Admin will send payment link.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: LICENSE_CONFIG.name + ' — Founders Plan',
            description: 'One-time payment. Everything in Enterprise, forever. ' + LICENSE_CONFIG.description,
          },
          unit_amount: LICENSE_CONFIG.tiers.lifetime.price * 100, // cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://${req.headers.host || 'aiosorchestrationlab.com'}/lifetime/success?session_id={CHECKOUT_SESSION_ID}&license=${application.id}`,
      cancel_url: `https://${req.headers.host || 'aiosorchestrationlab.com'}/lifetime?cancelled=true`,
      customer_email: email,
      metadata: {
        license_id: application.id,
        participant_name: name,
        company: company || '',
        industry: industry || '',
      },
    });

    application.paymentId = session.id;
    saveState('licenses', licenses);

    res.json({ ok: true, id: application.id, checkoutUrl: session.url });
  } catch (e) {
    console.error('[STRIPE] Lifetime checkout error:', e.message);
    res.json({ ok: true, id: application.id, checkoutUrl: null, message: 'Application saved — payment link will be sent separately. Error: ' + e.message });
  }
});

// PUT /api/license/participant/:id — admin update participant (approve, reject, activate, notes)
app.put('/api/license/participant/:id', requireAdmin, (req, res) => {
  const f = licenses.find(p => p.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Participant not found' });

  const { status, notes, territory, instanceUrl } = req.body;

  if (status) {
    const validTransitions = {
      pending: ['approved', 'rejected'],
      approved: ['payment', 'rejected'],
      payment: ['active', 'rejected'],
      active: ['suspended'],
      suspended: ['active'],
      rejected: ['pending'],
    };
    if (!validTransitions[f.status]?.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${f.status} to ${status}` });
    }
    f.status = status;
    if (status === 'approved') f.approvedAt = new Date().toISOString();
    if (status === 'active') {
      f.activatedAt = new Date().toISOString();

      // Auto-provision tenant for newly activated license
      if (!f.tenantId) {
        const tenantId = uuidv4().substring(0, 12);
        const subdomain = (f.company || f.name).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 20);
        const tenant = {
          id: tenantId,
          name: f.company || f.name,
          domain: null,
          subdomain,
          ownerId: f.email,
          plan: 'franchise',
          status: 'active',
          branding: {
            companyName: f.company || f.name,
            tagline: 'Powered by AI OS',
            logo: null,
            primaryColor: '#3b82f6',
            accentColor: '#8b5cf6',
          },
          industry: f.industry || null,
          template: null,
          createdAt: new Date().toISOString(),
          franchiseId: f.id,
        };

        ensureTenantDir(tenantId);
        // Seed tenant admin
        saveTenantState(tenantId, 'users', [{
          email: f.email, passwordHash: null, plan: 'franchise', role: 'admin', tenantId, createdAt: new Date().toISOString(),
        }]);
        // Seed empty settings
        saveTenantState(tenantId, 'settings', {
          ai: { anthropic_api_key: '', openai_api_key: '', deepseek_api_key: '', xai_api_key: '', gemini_api_key: '', perplexity_api_key: '', firecrawl_api_key: '', tavily_api_key: '', apify_api_token: '', manus_api_key: '' },
          mcp: { hermes_url: 'http://127.0.0.1:8420', hermes_enabled: false },
          notifications: { telegram_bot_token: '', telegram_chat_id: '', slack_webhook_url: '' },
          automation: { n8n_webhook_base: '', n8n_api_key: '', team_webhook_url: '' },
          stripe: { secret_key: '', webhook_secret: '', pro_price_id: '', business_price_id: '', enterprise_price_id: '' },
          seo: { dataforseo_login: '', dataforseo_password: '', default_location: 'United States', default_language: 'en' },
          general: { demo_mode: true, cors_origin: '*', api_token: '' },
        });

        tenantRegistry[tenantId] = tenant;
        saveState('tenant_registry', tenantRegistry);

        f.tenantId = tenantId;
        f.instanceUrl = `https://${subdomain}.${tenantRegistry[MASTER_TENANT_ID]?.domain || 'aiosorchestrationlab.com'}`;

        logActivity('license', `Tenant auto-provisioned for ${f.name}: ${tenantId} (${subdomain})`, { franchiseId: f.id, tenantId });
        broadcast({ event: 'tenant_provisioned', data: { id: tenantId, name: tenant.name, subdomain, franchiseId: f.id } });
      }
    }
  }

  if (notes !== undefined) f.notes = notes;
  if (territory) f.territory = territory;
  if (instanceUrl) f.instanceUrl = instanceUrl;

  saveState('licenses', licenses);
  logActivity('license', `Franchise ${f.status}: ${f.name} (${f.email})`, { id: f.id, status: f.status });
  broadcast({ event: 'license_updated', data: { id: f.id, status: f.status, name: f.name } });

  res.json({ ok: true, participant: f });
});

// POST /api/license/checkout/:id — generate Stripe checkout for franchise fee
app.post('/api/license/checkout/:id', async (req, res) => {
  const f = licenses.find(p => p.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Participant not found' });
  if (f.status !== 'approved') return res.status(400).json({ error: 'Application must be approved before payment' });

  if (DEMO_MODE) {
    f.status = 'payment';
    f.paymentId = `demo_pay_${uuidv4().substring(0, 8)}`;
    saveState('licenses', licenses);
    return res.json({
      ok: true,
      checkoutUrl: '#demo-checkout',
      message: 'Demo mode — Stripe checkout simulated',
      paymentId: f.paymentId,
    });
  }

  // Real Stripe checkout (when configured)
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: LICENSE_CONFIG.name,
            description: `White-label lifetime license — ${LICENSE_CONFIG.description}`,
          },
          unit_amount: LICENSE_CONFIG.tiers.lifetime.price * 100, // cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://${req.headers.host}/license/success?session_id={CHECKOUT_SESSION_ID}&participant=${f.id}`,
      cancel_url: `https://${req.headers.host}/license/cancel?participant=${f.id}`,
      customer_email: f.email,
      metadata: { license_id: f.id, participant_name: f.name },
    });

    f.status = 'payment';
    f.paymentId = session.id;
    saveState('licenses', licenses);

    res.json({ ok: true, checkoutUrl: session.url, paymentId: session.id });
  } catch (e) {
    res.json({ ok: false, error: `Stripe error: ${e.message}` });
  }
});

// GET /api/license/stats — license program stats
app.get('/api/license/stats', requireAdmin, (req, res) => {
  const byStatus = {};
  licenses.forEach(f => { byStatus[f.status] = (byStatus[f.status] || 0) + 1; });

  const active = byStatus.active || 0;
  const revenue = active * LICENSE_CONFIG.tiers.lifetime.price;
  const remaining = LICENSE_CONFIG.maxLifetime - active - (byStatus.pending || 0) - (byStatus.approved || 0) - (byStatus.payment || 0);

  res.json({
    total: licenses.length,
    byStatus,
    active,
    remaining: Math.max(0, remaining),
    maxParticipants: LICENSE_CONFIG.maxLifetime,
    fee: LICENSE_CONFIG.tiers.lifetime.price,
    totalRevenue: revenue,
    projectedRevenue: LICENSE_CONFIG.maxLifetime * LICENSE_CONFIG.tiers.lifetime.price,
    fillRate: Math.round((active / LICENSE_CONFIG.maxLifetime) * 100),
  });
});

// --- Self-Improving Platform (Telegram/Slack Approval Bot) ---

const pendingApprovals = loadState('pending_approvals', []);

// Proposal types the platform can generate
const PROPOSAL_TYPES = {
  'dependency-update': { icon: '📦', label: 'Dependency Update', risk: 'low' },
  'model-upgrade': { icon: '🧠', label: 'Model Upgrade', risk: 'medium' },
  'cost-optimization': { icon: '💰', label: 'Cost Optimization', risk: 'low' },
  'new-skill': { icon: '✨', label: 'New Skill', risk: 'low' },
  'bug-fix': { icon: '🔧', label: 'Bug Fix', risk: 'medium' },
  'security-patch': { icon: '🛡️', label: 'Security Patch', risk: 'high' },
  'content-refresh': { icon: '📄', label: 'Content Refresh', risk: 'low' },
  'config-change': { icon: '⚙️', label: 'Config Change', risk: 'medium' },
  'feature-proposal': { icon: '🚀', label: 'Feature Proposal', risk: 'medium' },
};

// --- Auto-Apply Execution Engine ---
// Safety: git commit before every change, blocked files list, rollback support

const BLOCKED_PATHS = [
  'server.js',            // Don't let it modify itself (except config sections)
  '.env',                 // Never touch credentials directly
  '.magent/state/users.json',  // Never modify auth
  'node_modules/',
];

const SAFE_OPERATIONS = {
  'dependency-update': true,
  'model-upgrade': true,
  'cost-optimization': true,
  'config-change': true,
  'content-refresh': true,
  'new-skill': true,
  'security-patch': true,
  'bug-fix': false,        // Requires manual review of diff
  'feature-proposal': false, // Too broad for auto-apply
};

async function applyProposal(proposal) {
  const results = { steps: [], success: false, rollbackCommit: null };

  // Safety check: is this type allowed for auto-apply?
  if (!SAFE_OPERATIONS[proposal.type]) {
    results.steps.push({ action: 'blocked', reason: `Type "${proposal.type}" requires manual application` });
    return results;
  }

  try {
    // Step 1: Git snapshot before changes (for rollback)
    try {
      const { execSync } = require('child_process');
      const gitStatus = execSync('git status --porcelain', { cwd: BASE, encoding: 'utf-8' }).trim();
      if (gitStatus) {
        execSync('git add -A && git commit -m "Auto-save before platform self-improvement"', { cwd: BASE, encoding: 'utf-8' });
      }
      const commitHash = execSync('git rev-parse HEAD', { cwd: BASE, encoding: 'utf-8' }).trim();
      results.rollbackCommit = commitHash;
      results.steps.push({ action: 'git-snapshot', commit: commitHash });
    } catch (gitErr) {
      results.steps.push({ action: 'git-snapshot', warning: 'Git snapshot failed — proceeding without rollback point' });
    }

    // Step 2: Execute based on type
    switch (proposal.type) {
      case 'dependency-update': {
        const { execSync } = require('child_process');
        // Parse package name from title or description
        const pkgMatch = (proposal.title + ' ' + proposal.description).match(/(?:update|upgrade)\s+(\S+)/i);
        if (pkgMatch) {
          const pkg = pkgMatch[1].replace(/[^a-zA-Z0-9@/_-]/g, '');
          execSync(`npm update ${pkg}`, { cwd: BASE, encoding: 'utf-8', timeout: 60000 });
          results.steps.push({ action: 'npm-update', package: pkg, success: true });
        } else {
          execSync('npm update', { cwd: BASE, encoding: 'utf-8', timeout: 120000 });
          results.steps.push({ action: 'npm-update', package: 'all', success: true });
        }
        break;
      }

      case 'security-patch': {
        const { execSync } = require('child_process');
        const output = execSync('npm audit fix --force 2>&1 || true', { cwd: BASE, encoding: 'utf-8', timeout: 120000 });
        results.steps.push({ action: 'npm-audit-fix', output: output.substring(0, 500), success: true });
        break;
      }

      case 'model-upgrade': {
        // Update model ID in the config — only touches the OPUS_MODEL constant
        if (proposal.diff && proposal.diff.includes('const OPUS_MODEL')) {
          const newModelMatch = proposal.diff.match(/const OPUS_MODEL\s*=\s*'([^']+)'/);
          if (newModelMatch) {
            const serverContent = fs.readFileSync(path.join(BASE, 'server.js'), 'utf-8');
            const updated = serverContent.replace(/const OPUS_MODEL\s*=\s*'[^']+'/, `const OPUS_MODEL = '${newModelMatch[1]}'`);
            fs.writeFileSync(path.join(BASE, 'server.js'), updated);
            results.steps.push({ action: 'model-update', newModel: newModelMatch[1], success: true });
          }
        } else {
          results.steps.push({ action: 'model-update', warning: 'No model ID found in diff — provide diff with const OPUS_MODEL line' });
        }
        break;
      }

      case 'cost-optimization': {
        // Update effort routing or cost rates in settings
        if (proposal.diff) {
          results.steps.push({ action: 'cost-optimization', note: 'Config change applied via settings update', success: true });
          // Parse key=value pairs from description
          const kvMatches = proposal.description.matchAll(/(\w+)\s*[=:]\s*(\w+)/g);
          for (const m of kvMatches) {
            if (m[1] === 'demo_mode') {
              settings.general.demo_mode = m[2] === 'true';
              saveState('settings', settings);
              results.steps.push({ action: 'config-set', key: m[1], value: m[2], success: true });
            }
          }
        }
        break;
      }

      case 'config-change': {
        // Apply key-value config changes to settings
        if (proposal.diff) {
          const lines = proposal.diff.split('\n');
          for (const line of lines) {
            const kvMatch = line.match(/^\+?\s*(\w+)\.(\w+)\s*[=:]\s*(.+)$/);
            if (kvMatch) {
              const [, section, key, value] = kvMatch;
              if (settings[section] && key in settings[section]) {
                const parsedVal = value.trim() === 'true' ? true : value.trim() === 'false' ? false : value.trim().replace(/['"]/g, '');
                settings[section][key] = parsedVal;
                results.steps.push({ action: 'config-set', key: `${section}.${key}`, value: parsedVal, success: true });
              }
            }
          }
          saveState('settings', settings);
        }
        break;
      }

      case 'content-refresh': {
        // Update a specific file if target path is provided and not blocked
        const targetMatch = (proposal.description + ' ' + (proposal.diff || '')).match(/(?:file|target|path):\s*(\S+)/i);
        if (targetMatch) {
          const targetFile = targetMatch[1];
          // Safety: check blocked paths
          if (BLOCKED_PATHS.some(bp => targetFile.includes(bp))) {
            results.steps.push({ action: 'file-update', blocked: true, reason: `Path "${targetFile}" is protected` });
            break;
          }
          const fullPath = path.join(BASE, targetFile);
          if (fs.existsSync(fullPath) && proposal.diff) {
            // Apply simple replacements from diff format
            let content = fs.readFileSync(fullPath, 'utf-8');
            const removals = proposal.diff.match(/^- (.+)$/gm) || [];
            const additions = proposal.diff.match(/^\+ (.+)$/gm) || [];
            removals.forEach((r, i) => {
              const oldText = r.substring(2);
              const newText = additions[i] ? additions[i].substring(2) : '';
              content = content.replace(oldText, newText);
            });
            fs.writeFileSync(fullPath, content);
            results.steps.push({ action: 'file-update', file: targetFile, success: true });
          }
        }
        break;
      }

      case 'new-skill': {
        // Create a new skill file in .claude/skills/
        const nameMatch = (proposal.title + ' ' + proposal.description).match(/skill:\s*(\S+)/i) ||
                          proposal.title.match(/(?:add|create|new)\s+(\S+)\s+skill/i);
        if (nameMatch && proposal.diff) {
          const skillName = nameMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '');
          const skillPath = path.join(CLAUDE_DIR, 'skills', `${skillName}.md`);
          if (!fs.existsSync(skillPath)) {
            fs.writeFileSync(skillPath, proposal.diff);
            results.steps.push({ action: 'new-skill', file: `${skillName}.md`, success: true });
          } else {
            results.steps.push({ action: 'new-skill', warning: `Skill "${skillName}" already exists` });
          }
        }
        break;
      }

      default:
        results.steps.push({ action: 'unknown-type', type: proposal.type });
    }

    // Step 3: Git commit the changes
    try {
      const { execSync } = require('child_process');
      const gitStatus = execSync('git status --porcelain', { cwd: BASE, encoding: 'utf-8' }).trim();
      if (gitStatus) {
        execSync(`git add -A && git commit -m "Self-improvement: ${proposal.title.replace(/"/g, '\\"').substring(0, 60)}"`, { cwd: BASE, encoding: 'utf-8' });
        results.steps.push({ action: 'git-commit', success: true });
      }
    } catch (gitErr) {
      results.steps.push({ action: 'git-commit', warning: 'Git commit failed' });
    }

    // Step 4: Restart PM2 if needed
    const needsRestart = ['dependency-update', 'security-patch', 'model-upgrade', 'config-change'].includes(proposal.type);
    if (needsRestart) {
      try {
        const { execSync } = require('child_process');
        execSync('pm2 restart ai-os --update-env 2>/dev/null || true', { encoding: 'utf-8', timeout: 10000 });
        results.steps.push({ action: 'pm2-restart', success: true });
      } catch (restartErr) {
        results.steps.push({ action: 'pm2-restart', warning: 'Restart failed — may need manual restart' });
      }
    }

    results.success = true;
  } catch (e) {
    results.steps.push({ action: 'error', message: e.message });
    // Attempt rollback
    if (results.rollbackCommit) {
      try {
        const { execSync } = require('child_process');
        execSync(`git reset --hard ${results.rollbackCommit}`, { cwd: BASE, encoding: 'utf-8' });
        results.steps.push({ action: 'rollback', commit: results.rollbackCommit, success: true });
      } catch (rollbackErr) {
        results.steps.push({ action: 'rollback', error: 'Rollback failed — manual intervention required' });
      }
    }
  }

  return results;
}

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

// --- Telegram Bot Integration ---
async function sendTelegramMessage(text) {
  const token = settings.notifications?.telegram_bot_token;
  const chatId = settings.notifications?.telegram_chat_id;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[TELEGRAM] Send failed:', e.message);
  }
}

async function sendTelegramApproval(proposal) {
  const token = settings.notifications?.telegram_bot_token;
  const chatId = settings.notifications?.telegram_chat_id;
  if (!token || !chatId) return;

  const riskEmoji = proposal.risk === 'high' ? '🔴' : proposal.risk === 'medium' ? '🟡' : '🟢';
  const text = `${proposal.icon} <b>Platform Update Proposal</b>\n\n` +
    `<b>${proposal.title}</b>\n` +
    `Type: ${proposal.typeLabel}\n` +
    `Risk: ${riskEmoji} ${proposal.risk}\n\n` +
    (proposal.description ? `${proposal.description}\n\n` : '') +
    (proposal.diff ? `<pre>${proposal.diff.substring(0, 500)}</pre>\n\n` : '') +
    `Reply with:\n` +
    `✅ <code>/approve ${proposal.id.substring(0, 8)}</code>\n` +
    `❌ <code>/reject ${proposal.id.substring(0, 8)}</code>`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('[TELEGRAM] Approval send failed:', e.message);
  }
}

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

// --- Slack Integration ---
async function sendSlackMessage(text) {
  const url = settings.notifications?.slack_webhook_url;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[SLACK] Send failed:', e.message);
  }
}

async function sendSlackApproval(proposal) {
  const url = settings.notifications?.slack_webhook_url;
  if (!url) return;

  const riskEmoji = proposal.risk === 'high' ? '🔴' : proposal.risk === 'medium' ? '🟡' : '🟢';
  const text = `${proposal.icon} *Platform Update Proposal*\n\n` +
    `*${proposal.title}*\n` +
    `Type: ${proposal.typeLabel} | Risk: ${riskEmoji} ${proposal.risk}\n` +
    (proposal.description ? `${proposal.description}\n` : '') +
    `\nApprove/reject in the dashboard → Platform view`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[SLACK] Approval send failed:', e.message);
  }
}

// --- Automated Self-Improvement Checks (runs on startup and via CRON) ---
function checkForSelfImprovements() {
  // Check for outdated dependencies
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf-8'));
    const depCount = Object.keys(pkg.dependencies || {}).length;
    // In production, this would run `npm outdated --json` and propose updates
    console.log(`[SELF-IMPROVE] Checked ${depCount} dependencies`);
  } catch (e) {}

  // Check model availability
  console.log(`[SELF-IMPROVE] Current model: ${OPUS_MODEL}`);

  // Check agent count
  const agentDir = path.join(CLAUDE_DIR, 'agents');
  const agentCount = fs.existsSync(agentDir) ? fs.readdirSync(agentDir).filter(f => f.endsWith('.md')).length : 0;
  console.log(`[SELF-IMPROVE] ${agentCount} agents, ${Object.keys(tenantRegistry).length} tenants`);
}

// Run on startup
checkForSelfImprovements();

// --- YouTube Video Analysis ---

const { execFile } = require('child_process');
const YT_ANALYSIS_DIR = path.join(BASE, '.magent', 'artifacts', 'youtube');
if (!fs.existsSync(YT_ANALYSIS_DIR)) fs.mkdirSync(YT_ANALYSIS_DIR, { recursive: true });

const ytAnalyses = loadState('yt_analyses', []);

// POST /api/youtube/analyze — start a YouTube video analysis
app.post('/api/youtube/analyze', requireAdmin, async (req, res) => {
  const { url, frameInterval, analysisType } = req.body;
  if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

  // Validate YouTube URL
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
  if (!ytMatch) return res.status(400).json({ error: 'Invalid YouTube URL — must be a youtube.com or youtu.be link' });

  const videoId = ytMatch[1];
  const analysisId = uuidv4();
  const interval = frameInterval || 10; // seconds between frames
  const type = analysisType || 'full'; // full, visual-only, transcript-only

  const analysis = {
    id: analysisId,
    videoId,
    url: url.trim(),
    status: 'processing',
    type,
    frameInterval: interval,
    startedAt: new Date().toISOString(),
    completedAt: null,
    videoInfo: null,
    transcript: null,
    frames: [],
    visualAnalysis: [],
    summary: null,
    insights: null,
  };

  ytAnalyses.push(analysis);
  broadcast({ event: 'yt_analysis_started', data: { id: analysisId, videoId } });
  logActivity('youtube', `Video analysis started: ${videoId}`, { analysisId, type });

  // Real YouTube analysis pipeline
  if (!DEMO_MODE && settings.ai.anthropic_api_key) {
    runRealYouTubeAnalysis(analysis, analysisId, interval, type).catch(e => {
      console.error('[YOUTUBE] Real analysis failed:', e.message);
      analysis.status = 'complete';
      analysis.completedAt = new Date().toISOString();
      analysis.summary = { overview: `Analysis failed: ${e.message}`, keyTopics: [], contentType: 'Error', technicalLevel: 'N/A', actionability: 'N/A' };
      analysis.insights = [{ type: 'extraction', insight: `Pipeline error: ${e.message}. Ensure yt-dlp and ffmpeg are installed on the server.`, confidence: 1.0 }];
      saveState('yt_analyses', ytAnalyses);
      broadcast({ event: 'yt_analysis_complete', data: { id: analysisId, videoId: analysis.videoId } });
    });
  }
  else if (DEMO_MODE) {
    // Simulate the analysis pipeline
    const steps = [
      { delay: 1500, status: 'fetching_info', msg: 'Fetching video metadata...' },
      { delay: 3000, status: 'extracting_frames', msg: `Extracting frames every ${interval}s...` },
      { delay: 5000, status: 'transcribing', msg: 'Extracting transcript...' },
      { delay: 7000, status: 'analyzing_frames', msg: 'Claude Vision analyzing frames...' },
      { delay: 9500, status: 'synthesizing', msg: 'Synthesizing visual + transcript analysis...' },
      { delay: 11000, status: 'complete', msg: 'Analysis complete' },
    ];

    steps.forEach(step => {
      setTimeout(() => {
        analysis.status = step.status;
        broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: step.status, msg: step.msg } });

        if (step.status === 'complete') {
          analysis.completedAt = new Date().toISOString();
          analysis.videoInfo = generateYTVideoInfo(videoId);
          analysis.transcript = generateYTTranscript();
          analysis.frames = generateYTFrames(interval);
          analysis.visualAnalysis = generateYTVisualAnalysis(analysis.frames);
          analysis.summary = generateYTSummary(analysis);
          analysis.insights = generateYTInsights(analysis);
          saveState('yt_analyses', ytAnalyses);
          broadcast({ event: 'yt_analysis_complete', data: { id: analysisId, videoId } });
          logActivity('youtube', `Video analysis complete: ${videoId}`, { analysisId });

          // Track cost
          const inputTokens = 15000 + analysis.frames.length * 2000;
          const outputTokens = 5000 + analysis.frames.length * 500;
          const rates = COST_RATES['opus-4.8-high'];
          costLedger.push({
            id: uuidv4(), agent: 'youtube-analyzer', model: 'opus-4.8-high', skill: 'video-analysis',
            inputTokens, outputTokens,
            cost: Math.round(((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output) * 10000) / 10000,
            timestamp: new Date().toISOString(),
          });
        }
      }, step.delay);
    });
  }

  res.json({ ok: true, analysisId, videoId, type });
});

// GET /api/youtube/analyses — list all analyses
app.get('/api/youtube/analyses', requireAdmin, (req, res) => {
  res.json(ytAnalyses.map(a => ({
    id: a.id, videoId: a.videoId, url: a.url, status: a.status, type: a.type,
    startedAt: a.startedAt, completedAt: a.completedAt,
    title: a.videoInfo?.title || null,
    duration: a.videoInfo?.duration || null,
    frameCount: a.frames?.length || 0,
  })));
});

// GET /api/youtube/analysis/:id — full analysis detail
app.get('/api/youtube/analysis/:id', requireAdmin, (req, res) => {
  const analysis = ytAnalyses.find(a => a.id === req.params.id);
  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
  res.json(analysis);
});

// DELETE /api/youtube/analysis/:id
app.delete('/api/youtube/analysis/:id', requireAdmin, (req, res) => {
  const idx = ytAnalyses.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Analysis not found' });
  ytAnalyses.splice(idx, 1);
  saveState('yt_analyses', ytAnalyses);
  res.json({ ok: true });
});

// --- Real YouTube Analysis Pipeline ---

async function runRealYouTubeAnalysis(analysis, analysisId, interval, type) {
  const videoId = analysis.videoId;
  const videoDir = path.join(YT_ANALYSIS_DIR, videoId);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  // Step 1: Fetch video info via yt-dlp
  broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: 'fetching_info', msg: 'Fetching video metadata...' } });
  analysis.status = 'fetching_info';

  try {
    const { execSync } = require('child_process');
    const infoJson = execSync(`yt-dlp --dump-json --no-download "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`, { encoding: 'utf-8', timeout: 30000 });
    const info = JSON.parse(infoJson);
    analysis.videoInfo = {
      title: info.title || 'Unknown',
      channel: info.uploader || info.channel || 'Unknown',
      duration: `${Math.floor((info.duration || 0) / 60)}:${String((info.duration || 0) % 60).padStart(2, '0')}`,
      durationSeconds: info.duration || 0,
      publishedAt: info.upload_date ? `${info.upload_date.substring(0,4)}-${info.upload_date.substring(4,6)}-${info.upload_date.substring(6,8)}` : null,
      views: info.view_count || 0,
      likes: info.like_count || 0,
      thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      videoId,
    };
  } catch (e) {
    // Fallback to basic info
    analysis.videoInfo = { title: `Video ${videoId}`, channel: 'Unknown', duration: 'Unknown', durationSeconds: 0, views: 0, likes: 0, thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, videoId };
  }

  // Step 2: Extract frames with ffmpeg
  if (type !== 'transcript-only') {
    broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: 'extracting_frames', msg: `Downloading and extracting frames every ${interval}s...` } });
    analysis.status = 'extracting_frames';

    try {
      const { execSync } = require('child_process');
      // Download video (low quality for speed)
      execSync(`yt-dlp -f "worst[ext=mp4]" -o "${path.join(videoDir, 'video.mp4')}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`, { timeout: 120000 });
      // Extract frames
      execSync(`ffmpeg -i "${path.join(videoDir, 'video.mp4')}" -vf "fps=1/${interval}" "${path.join(videoDir, 'frame_%04d.jpg')}" -y 2>/dev/null`, { timeout: 120000 });

      const frameFiles = fs.readdirSync(videoDir).filter(f => f.startsWith('frame_') && f.endsWith('.jpg')).sort();
      analysis.frames = frameFiles.map((f, i) => ({
        timestamp: i * interval,
        timecode: `${Math.floor(i * interval / 60)}:${String((i * interval) % 60).padStart(2, '0')}`,
        file: f,
      }));
    } catch (e) {
      console.error('[YOUTUBE] Frame extraction failed:', e.message);
      analysis.frames = [];
    }
  }

  // Step 3: Extract transcript
  if (type !== 'visual-only') {
    broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: 'transcribing', msg: 'Extracting transcript...' } });
    analysis.status = 'transcribing';

    try {
      const { execSync } = require('child_process');
      execSync(`yt-dlp --write-auto-sub --sub-lang en --skip-download -o "${path.join(videoDir, 'subs')}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`, { timeout: 30000 });

      // Try to parse the subtitle file
      const subFiles = fs.readdirSync(videoDir).filter(f => f.includes('subs') && (f.endsWith('.vtt') || f.endsWith('.srt')));
      if (subFiles.length > 0) {
        const subContent = fs.readFileSync(path.join(videoDir, subFiles[0]), 'utf-8');
        // Simple VTT/SRT parser — extract text lines
        const lines = subContent.split('\n').filter(l => l.trim() && !l.includes('-->') && !l.match(/^\d+$/) && !l.startsWith('WEBVTT') && !l.startsWith('Kind:') && !l.startsWith('Language:'));
        const fullText = [...new Set(lines.map(l => l.replace(/<[^>]+>/g, '').trim()))].filter(Boolean).join(' ');

        // Build segments (approximate)
        const words = fullText.split(/\s+/);
        const wordsPerSegment = Math.ceil(words.length / Math.max(Math.ceil((analysis.videoInfo?.durationSeconds || 300) / 30), 1));
        const segments = [];
        for (let i = 0; i < words.length; i += wordsPerSegment) {
          const segWords = words.slice(i, i + wordsPerSegment);
          const segIndex = Math.floor(i / wordsPerSegment);
          segments.push({ start: segIndex * 30, end: (segIndex + 1) * 30, text: segWords.join(' ') });
        }

        analysis.transcript = { language: 'en', segments, fullText };
      } else {
        analysis.transcript = { language: 'en', segments: [], fullText: 'Transcript not available for this video.' };
      }
    } catch (e) {
      analysis.transcript = { language: 'en', segments: [], fullText: 'Failed to extract transcript.' };
    }
  }

  // Step 4: Analyze frames with Claude Vision
  if (type !== 'transcript-only' && analysis.frames.length > 0 && settings.ai.anthropic_api_key) {
    broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: 'analyzing_frames', msg: `Claude Vision analyzing ${analysis.frames.length} frames...` } });
    analysis.status = 'analyzing_frames';

    const visualAnalysis = [];
    // Analyze a sample of frames (max 10 to control cost)
    const sampleFrames = analysis.frames.length <= 10 ? analysis.frames : analysis.frames.filter((_, i) => i % Math.ceil(analysis.frames.length / 10) === 0).slice(0, 10);

    for (const frame of sampleFrames) {
      try {
        const imagePath = path.join(videoDir, frame.file);
        const imageData = fs.readFileSync(imagePath).toString('base64');

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': settings.ai.anthropic_api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: OPUS_MODEL,
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
                { type: 'text', text: 'Describe this video frame in one sentence. Note: what scene is shown, what elements are visible (people, screens, text, diagrams, code, UI), and any on-screen text you can read. Format: scene|elements|onScreenText' }
              ],
            }],
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data.content?.[0]?.text || '';
          const parts = text.split('|').map(s => s.trim());
          visualAnalysis.push({
            timestamp: frame.timestamp,
            timecode: frame.timecode,
            scene: parts[0] || text,
            elements: (parts[1] || '').split(',').map(e => e.trim()).filter(Boolean),
            onScreenText: parts[2] || '',
          });
        }
      } catch (e) {
        visualAnalysis.push({ timestamp: frame.timestamp, timecode: frame.timecode, scene: 'Analysis failed', elements: [], onScreenText: '' });
      }
    }

    analysis.visualAnalysis = visualAnalysis;
  }

  // Step 5: Synthesize summary using Claude
  broadcast({ event: 'yt_analysis_progress', data: { id: analysisId, status: 'synthesizing', msg: 'Synthesizing analysis...' } });
  analysis.status = 'synthesizing';

  try {
    const transcriptSnippet = (analysis.transcript?.fullText || '').substring(0, 2000);
    const frameDescriptions = (analysis.visualAnalysis || []).map(v => `[${v.timecode}] ${v.scene}`).join('\n');

    const synthesisResult = await callAnthropic(
      'You are a video analysis expert. Summarize this YouTube video based on the transcript and visual frame descriptions provided.',
      `Video: ${analysis.videoInfo?.title || 'Unknown'} by ${analysis.videoInfo?.channel || 'Unknown'}\n\nTranscript excerpt:\n${transcriptSnippet}\n\nFrame descriptions:\n${frameDescriptions}\n\nProvide:\n1. A 2-3 sentence overview\n2. Key topics (comma separated)\n3. Content type (Tutorial, Review, Demo, etc)\n4. Technical level (Beginner, Intermediate, Advanced)\n5. Actionability (High, Medium, Low)\n\nFormat each on its own line labeled: overview: / topics: / type: / level: / actionability:`,
      'high', 500
    );

    const lines = synthesisResult.content.split('\n');
    const getField = (label) => { const l = lines.find(l => l.toLowerCase().startsWith(label)); return l ? l.substring(l.indexOf(':') + 1).trim() : ''; };

    analysis.summary = {
      overview: getField('overview') || `Analysis of "${analysis.videoInfo?.title}"`,
      keyTopics: (getField('topics') || '').split(',').map(t => t.trim()).filter(Boolean),
      contentType: getField('type') || 'Video',
      technicalLevel: getField('level') || 'N/A',
      actionability: getField('actionability') || 'N/A',
    };

    // Generate insights
    analysis.insights = [];
    if (analysis.visualAnalysis?.length > 0) {
      const withText = analysis.visualAnalysis.filter(v => v.onScreenText);
      if (withText.length > 0) {
        analysis.insights.push({ type: 'visual', insight: `${withText.length} frames contain on-screen text not captured in the spoken transcript`, confidence: 0.9 });
      }
      analysis.insights.push({ type: 'visual', insight: `${analysis.visualAnalysis.length} frames analyzed — visual content adds context beyond audio`, confidence: 0.85 });
    }
    if (analysis.transcript?.fullText?.length > 100) {
      analysis.insights.push({ type: 'content', insight: `Transcript contains ${analysis.transcript.fullText.split(/\s+/).length} words of spoken content`, confidence: 0.95 });
    }
  } catch (e) {
    analysis.summary = { overview: `Video: ${analysis.videoInfo?.title || 'Unknown'}`, keyTopics: [], contentType: 'Video', technicalLevel: 'N/A', actionability: 'N/A' };
    analysis.insights = [{ type: 'extraction', insight: `Synthesis failed: ${e.message}`, confidence: 1.0 }];
  }

  // Complete
  analysis.status = 'complete';
  analysis.completedAt = new Date().toISOString();

  // Track cost
  const frameCost = (analysis.visualAnalysis?.length || 0) * 0.01; // ~$0.01 per frame
  costLedger.push({
    id: uuidv4(), agent: 'youtube-analyzer', model: 'opus-4.8-high', skill: 'video-analysis',
    inputTokens: 5000 + (analysis.visualAnalysis?.length || 0) * 1500,
    outputTokens: 2000 + (analysis.visualAnalysis?.length || 0) * 300,
    cost: Math.round((0.05 + frameCost) * 10000) / 10000,
    timestamp: new Date().toISOString(),
  });

  saveState('yt_analyses', ytAnalyses);
  broadcast({ event: 'yt_analysis_complete', data: { id: analysisId, videoId } });
  logActivity('youtube', `Video analysis complete (real): ${analysis.videoInfo?.title || videoId}`, { analysisId });

  // Cleanup video file to save disk space (keep frames and subs)
  try { fs.unlinkSync(path.join(videoDir, 'video.mp4')); } catch {}
}

// --- YouTube Demo Data Generators ---
function generateYTVideoInfo(videoId) {
  const titles = [
    'Building AI Agents That Actually Work in Production',
    'The Future of Multi-Agent Systems - Complete Guide',
    'How to Deploy Node.js Apps on VPS - Full Tutorial',
    'SEO Masterclass: From Zero to 10K Monthly Visitors',
    'Product Demo: AI-Powered Dashboard Walkthrough',
  ];
  return {
    title: titles[Math.floor(Math.random() * titles.length)],
    channel: 'AI Engineering Hub',
    duration: `${8 + Math.floor(Math.random() * 25)}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
    durationSeconds: 480 + Math.floor(Math.random() * 1500),
    publishedAt: new Date(Date.now() - Math.random() * 90 * 86400000).toISOString(),
    views: Math.floor(Math.random() * 500000) + 1000,
    likes: Math.floor(Math.random() * 15000) + 50,
    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    videoId,
  };
}

function generateYTTranscript() {
  const segments = [];
  const topics = [
    'Welcome to this deep dive into building production-ready AI agents.',
    'The key challenge with multi-agent systems is coordination between models.',
    'Let me show you how effort-based routing works in practice.',
    'Here on screen you can see the dashboard with real-time agent status.',
    'Notice how the orchestrator delegates tasks to specialized sub-agents.',
    'Cost optimization is critical — we use low effort for scout tasks and xhigh for strategic decisions.',
    'The SEO agency module runs five parallel audits simultaneously.',
    'Each finding is scored by severity and mapped to an action plan.',
    'For the deployment, we use PM2 with Nginx as a reverse proxy.',
    'The WebSocket connection streams live updates to the dashboard.',
    'Let me demonstrate the content brief generation from audit data.',
    'And finally, the meta tag optimizer shows before-and-after comparisons.',
  ];
  let time = 0;
  topics.forEach((text, i) => {
    segments.push({ start: time, end: time + 25 + Math.floor(Math.random() * 20), text });
    time += 30 + Math.floor(Math.random() * 30);
  });
  return { language: 'en', segments, fullText: topics.join(' ') };
}

function generateYTFrames(interval) {
  const frames = [];
  const totalSeconds = 480 + Math.floor(Math.random() * 600);
  for (let t = 0; t < totalSeconds; t += interval) {
    frames.push({
      timestamp: t,
      timecode: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      description: null, // filled by visual analysis
    });
  }
  return frames;
}

function generateYTVisualAnalysis(frames) {
  const descriptions = [
    { scene: 'Title card / intro animation with channel branding', elements: ['logo', 'title text', 'subscribe button'], onScreenText: 'Building AI Agents in Production' },
    { scene: 'Speaker at desk with monitor showing code editor', elements: ['person', 'monitor', 'code editor', 'terminal'], onScreenText: 'server.js — line 524' },
    { scene: 'Dashboard view showing agent fleet status panel', elements: ['dashboard UI', 'agent cards', 'status indicators', 'charts'], onScreenText: '39 Active Agents | 7 Model Tiers' },
    { scene: 'Terminal showing PM2 process list with running services', elements: ['terminal', 'process table', 'CPU/memory stats'], onScreenText: 'pm2 status — ai-os online' },
    { scene: 'Architecture diagram with model routing flow', elements: ['flowchart', 'arrows', 'model tier boxes'], onScreenText: 'Opus 4.8 xhigh → high → low' },
    { scene: 'SEO audit results showing composite score and findings', elements: ['score badge', 'findings list', 'severity indicators'], onScreenText: 'Composite Score: 67/100' },
    { scene: 'Split screen comparing before/after meta tags', elements: ['comparison table', 'old values', 'new values', 'change badges'], onScreenText: 'Optimized: +3 changes per page' },
    { scene: 'Cost dashboard showing spending by model tier', elements: ['bar chart', 'tier breakdown', 'daily spend'], onScreenText: 'Daily: $3.42 | Monthly: $89.50' },
    { scene: 'Browser automation recording showing form interaction', elements: ['browser window', 'cursor movement', 'form fields'], onScreenText: 'Playwright — automated form fill' },
    { scene: 'Closing card with call-to-action and social links', elements: ['subscribe CTA', 'social links', 'next video thumbnail'], onScreenText: 'Subscribe for more AI tutorials' },
  ];

  return frames.map((frame, i) => {
    const desc = descriptions[i % descriptions.length];
    return {
      timestamp: frame.timestamp,
      timecode: frame.timecode,
      ...desc,
    };
  });
}

function generateYTSummary(analysis) {
  const info = analysis.videoInfo;
  const frameCount = analysis.frames.length;
  return {
    overview: `"${info.title}" is a ${info.duration} video by ${info.channel} covering AI agent architecture and deployment. ` +
      `The video includes code walkthroughs, dashboard demonstrations, and architecture diagrams. ` +
      `${frameCount} frames were analyzed across ${analysis.visualAnalysis.filter(v => v.elements.includes('code editor') || v.elements.includes('terminal')).length} coding scenes ` +
      `and ${analysis.visualAnalysis.filter(v => v.elements.includes('dashboard UI') || v.elements.includes('charts')).length} dashboard demonstrations.`,
    keyTopics: [
      'Multi-agent orchestration architecture',
      'Effort-based model routing (Opus 4.8)',
      'SEO agency with parallel sub-agents',
      'VPS deployment with PM2 + Nginx',
      'Real-time dashboard with WebSocket updates',
      'Cost optimization across model tiers',
    ],
    contentType: 'Tutorial / Technical Walkthrough',
    technicalLevel: 'Intermediate to Advanced',
    actionability: 'High — includes step-by-step implementation details',
  };
}

function generateYTInsights(analysis) {
  return [
    { type: 'visual', insight: 'Video contains significant screen recordings of code — transcript alone would miss the implementation details shown on screen', confidence: 0.92 },
    { type: 'visual', insight: `${analysis.visualAnalysis.filter(v => v.onScreenText).length} frames contain on-screen text not captured in the spoken transcript`, confidence: 0.88 },
    { type: 'content', insight: 'Architecture diagrams at 3:20 and 7:45 provide visual context that complements the verbal explanation', confidence: 0.85 },
    { type: 'content', insight: 'The demo section (5:00-9:30) shows the actual dashboard UI — useful for design reference', confidence: 0.90 },
    { type: 'seo', insight: `Video has ${analysis.videoInfo.views.toLocaleString()} views with ${analysis.videoInfo.likes.toLocaleString()} likes — strong engagement ratio`, confidence: 0.95 },
    { type: 'extraction', insight: 'Key code snippets visible on screen could be extracted for documentation purposes', confidence: 0.78 },
  ];
}

// --- Gemini Omni Creative Endpoints ---

// POST /api/omni/generate — multimodal content generation
app.post('/api/omni/generate', requireAdmin, async (req, res) => {
  const { type, prompt, inputs } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  const validTypes = ['video', 'image', 'audio', 'thumbnail', 'social-clip'];
  const outputType = validTypes.includes(type) ? type : 'video';

  const jobId = uuidv4();
  const job = {
    id: jobId,
    type: outputType,
    prompt,
    inputs: inputs || {},
    status: 'processing',
    progress: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  };

  logActivity('omni', `Omni ${outputType} generation started`, { jobId, prompt: prompt.substring(0, 80) });
  broadcast({ event: 'omni_job_started', data: { id: jobId, type: outputType } });

  if (DEMO_MODE) {
    // Simulate progressive generation
    const steps = [
      { progress: 20, status: 'analyzing', msg: 'Analyzing input modalities...' },
      { progress: 45, status: 'composing', msg: `Composing ${outputType} elements...` },
      { progress: 70, status: 'rendering', msg: `Rendering ${outputType} output...` },
      { progress: 90, status: 'finalizing', msg: 'Applying SynthID watermark & quality check...' },
      { progress: 100, status: 'complete', msg: 'Generation complete' },
    ];

    steps.forEach((step, i) => {
      setTimeout(() => {
        job.progress = step.progress;
        job.status = step.status;
        broadcast({ event: 'omni_job_progress', data: { id: jobId, ...step } });

        if (step.progress === 100) {
          job.status = 'complete';
          job.completedAt = new Date().toISOString();
          job.result = generateOmniResult(outputType, prompt);
          broadcast({ event: 'omni_job_complete', data: { id: jobId, type: outputType, result: job.result } });
          logActivity('omni', `Omni ${outputType} complete: ${prompt.substring(0, 50)}`, { jobId });

          // Track cost
          const inputTokens = 2000 + Math.floor(Math.random() * 5000);
          const outputTokens = outputType === 'video' ? 50000 + Math.floor(Math.random() * 100000) : 10000 + Math.floor(Math.random() * 20000);
          const rates = COST_RATES['gemini-omni'];
          const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
          costLedger.push({
            id: uuidv4(), agent: `omni-${outputType}`, model: 'gemini-omni', skill: `${outputType}-generation`,
            inputTokens, outputTokens, cost: Math.round(cost * 10000) / 10000, timestamp: new Date().toISOString(),
          });
        }
      }, (i + 1) * 1500);
    });
  }

  res.json({ ok: true, jobId, type: outputType, status: 'processing' });
});

// GET /api/omni/job/:id — check generation job status
app.get('/api/omni/job/:id', requireAdmin, (req, res) => {
  // In demo mode, return simulated status from broadcast events
  res.json({ ok: true, message: 'Job status available via WebSocket events' });
});

// GET /api/omni/capabilities — list available Omni generation types
app.get('/api/omni/capabilities', (req, res) => {
  res.json({
    model: GEMINI_OMNI_MODEL,
    configured: !!settings.ai.gemini_api_key,
    capabilities: [
      { type: 'video', label: 'Video Generation', desc: 'Text/image/audio → video with physics simulation', maxDuration: '60s', formats: ['mp4', 'webm'] },
      { type: 'image', label: 'Image Generation & Editing', desc: 'Text/image → edited or generated images', formats: ['png', 'jpg', 'webp'] },
      { type: 'audio', label: 'Audio & Voiceover', desc: 'Text → natural speech, music, sound effects', formats: ['mp3', 'wav'] },
      { type: 'thumbnail', label: 'Thumbnail Generation', desc: 'Content context → optimized thumbnail images', formats: ['png', 'jpg'] },
      { type: 'social-clip', label: 'Social Media Clips', desc: 'Long content → short-form vertical video clips', maxDuration: '30s', formats: ['mp4'] },
    ],
  });
});

// Demo result generator for Omni outputs
function generateOmniResult(type, prompt) {
  const base = {
    prompt,
    model: GEMINI_OMNI_MODEL,
    watermark: 'SynthID',
    generatedAt: new Date().toISOString(),
  };

  switch (type) {
    case 'video':
      return { ...base, duration: `${8 + Math.floor(Math.random() * 22)}s`, resolution: '1080p', fps: 30, format: 'mp4', size: `${2 + Math.floor(Math.random() * 8)}MB`, scenes: Math.floor(Math.random() * 4) + 2, hasAudio: true, preview: 'Demo mode — video generation simulated' };
    case 'image':
      return { ...base, resolution: '1024x1024', format: 'png', size: `${200 + Math.floor(Math.random() * 800)}KB`, variants: 3, preview: 'Demo mode — image generation simulated' };
    case 'audio':
      return { ...base, duration: `${15 + Math.floor(Math.random() * 45)}s`, format: 'mp3', sampleRate: '44.1kHz', voice: 'Natural (en-US)', size: `${100 + Math.floor(Math.random() * 400)}KB`, preview: 'Demo mode — audio generation simulated' };
    case 'thumbnail':
      return { ...base, resolution: '1280x720', format: 'png', variants: 4, optimizedFor: 'YouTube', size: `${150 + Math.floor(Math.random() * 350)}KB`, preview: 'Demo mode — thumbnail generation simulated' };
    case 'social-clip':
      return { ...base, duration: `${10 + Math.floor(Math.random() * 20)}s`, resolution: '1080x1920', format: 'mp4', platform: 'Instagram Reels / TikTok / Shorts', size: `${1 + Math.floor(Math.random() * 4)}MB`, preview: 'Demo mode — social clip generation simulated' };
    default:
      return { ...base, preview: 'Demo mode — generation simulated' };
  }
}

// --- SEO Agency Endpoints ---

// In-memory SEO audit state
const seoAudits = loadState('seo_audits', []);

// POST /api/seo/audit — launch a full SEO audit for a domain
app.post('/api/seo/audit', requireAdmin, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const auditId = uuidv4();
  const audit = {
    id: auditId,
    domain: domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    compositeScore: null,
    agents: {
      keyword:    { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
      technical:  { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
      competitor: { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
      content:    { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
      backlink:   { status: 'running', score: null, findings: [], startedAt: new Date().toISOString() },
    },
    quickWins: [],
    actionPlan: [],
    executiveSummary: '',
  };

  seoAudits.push(audit);
  broadcast({ event: 'seo_audit_started', data: { id: auditId, domain: audit.domain } });
  logActivity('seo', `SEO audit started: ${audit.domain}`, { auditId });

  // Real DataForSEO audit path
  if (!DEMO_MODE && settings.seo.dataforseo_login && settings.seo.dataforseo_password) {
    runRealSeoAudit(audit, auditId).catch(e => {
      console.error('[SEO] Real audit failed:', e.message);
      // Mark failed agents and complete with partial data
      const agentNames = ['keyword', 'technical', 'competitor', 'content', 'backlink'];
      agentNames.forEach(name => {
        if (audit.agents[name].status === 'running') {
          audit.agents[name].status = 'error';
          audit.agents[name].findings = [{ severity: 'critical', issue: `DataForSEO error: ${e.message}`, recommendation: 'Check DataForSEO credentials in Settings and ensure sufficient API credits.' }];
        }
      });
      audit.status = 'complete';
      audit.completedAt = new Date().toISOString();
      const scores = agentNames.map(n => audit.agents[n].score || 0);
      audit.compositeScore = Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.filter(s => s > 0).length, 1));
      audit.executiveSummary = `Audit partially completed with errors. ${e.message}`;
      audit.quickWins = generateQuickWins(audit);
      audit.actionPlan = generateActionPlan(audit);
      saveState('seo_audits', seoAudits);
      broadcast({ event: 'seo_audit_complete', data: { auditId, compositeScore: audit.compositeScore } });
    });
  }
  // Simulate parallel agent execution (demo mode)
  else if (DEMO_MODE) {
    const agentNames = ['keyword', 'technical', 'competitor', 'content', 'backlink'];
    const delays = [2000, 3000, 2500, 3500, 4000];

    agentNames.forEach((name, i) => {
      setTimeout(() => {
        const score = 40 + Math.floor(Math.random() * 50);
        audit.agents[name].status = 'complete';
        audit.agents[name].score = score;
        audit.agents[name].completedAt = new Date().toISOString();
        audit.agents[name].findings = generateSeoFindings(name, audit.domain);
        broadcast({ event: 'seo_agent_complete', data: { auditId, agent: name, score } });

        // Check if all agents are done
        const allDone = agentNames.every(n => audit.agents[n].status === 'complete');
        if (allDone) {
          const scores = agentNames.map(n => audit.agents[n].score);
          audit.compositeScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
          audit.status = 'complete';
          audit.completedAt = new Date().toISOString();
          audit.executiveSummary = generateExecutiveSummary(audit);
          audit.quickWins = generateQuickWins(audit);
          audit.actionPlan = generateActionPlan(audit);
          saveState('seo_audits', seoAudits);
          broadcast({ event: 'seo_audit_complete', data: { auditId, compositeScore: audit.compositeScore } });
          logActivity('seo', `SEO audit complete: ${audit.domain} — score ${audit.compositeScore}/100`, { auditId });
        }
      }, delays[i]);
    });
  }

  res.json({ ok: true, auditId, domain: audit.domain });
});

// GET /api/seo/audits — list all audits
app.get('/api/seo/audits', requireAdmin, (req, res) => {
  res.json(seoAudits.map(a => ({
    id: a.id, domain: a.domain, status: a.status,
    compositeScore: a.compositeScore, startedAt: a.startedAt, completedAt: a.completedAt,
  })));
});

// GET /api/seo/audit/:id — get full audit detail
app.get('/api/seo/audit/:id', requireAdmin, (req, res) => {
  const audit = seoAudits.find(a => a.id === req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  res.json(audit);
});

// POST /api/seo/report/:id — generate PDF report (returns download URL)
app.post('/api/seo/report/:id', requireAdmin, (req, res) => {
  const audit = seoAudits.find(a => a.id === req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

  // In demo mode, return a simulated report URL
  const reportId = uuidv4();
  logActivity('seo', `PDF report generated: ${audit.domain}`, { auditId: audit.id, reportId });
  res.json({
    ok: true,
    reportId,
    filename: `SEO-Audit-${audit.domain}-${new Date().toISOString().split('T')[0]}.pdf`,
    message: DEMO_MODE ? 'Demo mode — PDF generation simulated' : 'Report generated',
  });
});

// DELETE /api/seo/audit/:id — delete an audit
app.delete('/api/seo/audit/:id', requireAdmin, (req, res) => {
  const idx = seoAudits.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Audit not found' });
  seoAudits.splice(idx, 1);
  saveState('seo_audits', seoAudits);
  res.json({ ok: true });
});

// POST /api/seo/briefs/:id — generate content briefs from audit keyword data
app.post('/api/seo/briefs/:id', requireAdmin, (req, res) => {
  const audit = seoAudits.find(a => a.id === req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

  const d = audit.domain;
  const briefs = [
    { title: `Complete Guide to ${d.split('.')[0].replace(/-/g, ' ')} Services in [City]`, targetKeyword: `${d.split('.')[0]} services near me`, wordCount: 2000, intent: 'commercial', outline: ['Introduction & local context', 'Services overview', 'Why choose local providers', 'Pricing guide', 'FAQ section', 'Call to action'], priority: 'high' },
    { title: `How to Choose the Right ${capitalize(d.split('.')[0].replace(/-/g, ' '))} Company`, targetKeyword: `how to choose ${d.split('.')[0].replace(/-/g, ' ')}`, wordCount: 1500, intent: 'informational', outline: ['Key factors to consider', 'Red flags to avoid', 'Questions to ask', 'Licensing & insurance checklist', 'Cost comparison tips'], priority: 'high' },
    { title: `${capitalize(d.split('.')[0].replace(/-/g, ' '))} vs Competitors: Honest Comparison`, targetKeyword: `${d.split('.')[0]} reviews`, wordCount: 1800, intent: 'commercial', outline: ['Overview of options', 'Feature comparison table', 'Pricing breakdown', 'Pros and cons', 'Our recommendation'], priority: 'medium' },
    { title: `Top 10 ${capitalize(d.split('.')[0].replace(/-/g, ' '))} Tips for Homeowners`, targetKeyword: `${d.split('.')[0]} tips`, wordCount: 1200, intent: 'informational', outline: ['Quick wins list', 'Maintenance schedule', 'When to call a professional', 'Cost-saving strategies', 'Common mistakes'], priority: 'medium' },
    { title: `${capitalize(d.split('.')[0].replace(/-/g, ' '))} Cost Guide [${new Date().getFullYear()}]`, targetKeyword: `${d.split('.')[0]} cost`, wordCount: 1600, intent: 'transactional', outline: ['Average costs by service type', 'Factors affecting price', 'Hidden fees to watch for', 'How to get quotes', 'Financing options'], priority: 'high' },
  ];

  logActivity('seo', `Content briefs generated: ${audit.domain} (${briefs.length} briefs)`, { auditId: audit.id });
  res.json({ ok: true, domain: audit.domain, briefs });
});

// POST /api/seo/calendar/:id — generate content calendar from audit
app.post('/api/seo/calendar/:id', requireAdmin, (req, res) => {
  const audit = seoAudits.find(a => a.id === req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

  const d = audit.domain;
  const base = d.split('.')[0].replace(/-/g, ' ');
  const now = new Date();
  const weeks = [];

  for (let w = 0; w < 12; w++) {
    const weekDate = new Date(now.getTime() + w * 7 * 86400000);
    const weekLabel = `Week ${w + 1} — ${weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const items = [];

    if (w < 2) {
      items.push({ type: 'fix', title: 'Fix critical technical issues', priority: 'critical', effort: '2-4 hours' });
      items.push({ type: 'optimize', title: 'Optimize title tags & meta descriptions for top 10 pages', priority: 'high', effort: '1-2 hours' });
    } else if (w < 4) {
      items.push({ type: 'content', title: `Publish: "Complete Guide to ${capitalize(base)} Services"`, priority: 'high', effort: '4-6 hours' });
      items.push({ type: 'optimize', title: 'Add schema markup to service pages', priority: 'medium', effort: '1 hour' });
    } else if (w < 6) {
      items.push({ type: 'content', title: `Publish: "${capitalize(base)} Cost Guide ${now.getFullYear()}"`, priority: 'high', effort: '3-4 hours' });
      items.push({ type: 'link', title: 'Submit to 10 local business directories', priority: 'medium', effort: '2 hours' });
    } else if (w < 8) {
      items.push({ type: 'content', title: `Publish: "How to Choose the Right ${capitalize(base)} Company"`, priority: 'medium', effort: '3-4 hours' });
      items.push({ type: 'content', title: `Publish: "Top 10 ${capitalize(base)} Tips"`, priority: 'medium', effort: '2-3 hours' });
    } else if (w < 10) {
      items.push({ type: 'link', title: 'Guest post outreach to 5 industry blogs', priority: 'medium', effort: '3-4 hours' });
      items.push({ type: 'content', title: `Publish comparison article: "${capitalize(base)} vs Competitors"`, priority: 'medium', effort: '4-5 hours' });
    } else {
      items.push({ type: 'analyze', title: 'Review ranking changes and traffic growth', priority: 'high', effort: '1 hour' });
      items.push({ type: 'content', title: 'Publish FAQ page from top customer questions', priority: 'medium', effort: '2 hours' });
      items.push({ type: 'optimize', title: 'Update internal links across all new content', priority: 'low', effort: '1 hour' });
    }
    weeks.push({ week: weekLabel, items });
  }

  logActivity('seo', `Content calendar generated: ${audit.domain} (12 weeks)`, { auditId: audit.id });
  res.json({ ok: true, domain: audit.domain, weeks });
});

// POST /api/seo/meta/:id — generate optimized meta tags
app.post('/api/seo/meta/:id', requireAdmin, (req, res) => {
  const audit = seoAudits.find(a => a.id === req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(400).json({ error: 'Audit not yet complete' });

  const d = audit.domain;
  const base = capitalize(d.split('.')[0].replace(/-/g, ' '));
  const pages = [
    { page: 'Homepage', url: `https://${d}/`, currentTitle: `${base} - Home`, currentDesc: '', optimizedTitle: `${base} | Professional Services in [City] | Licensed & Insured`, optimizedDesc: `${base} offers trusted, affordable services in [City]. Licensed, insured, 5-star rated. Get a free quote today. Call (555) 123-4567.`, changes: ['Added location keyword', 'Added trust signals', 'Added CTA with phone number'] },
    { page: 'Services', url: `https://${d}/services`, currentTitle: `Services - ${base}`, currentDesc: '', optimizedTitle: `Our ${base} Services | Residential & Commercial | [City]`, optimizedDesc: `Full-service ${base.toLowerCase()} for homes and businesses in [City]. Same-day appointments, upfront pricing, satisfaction guaranteed.`, changes: ['Added service scope', 'Added location', 'Added urgency & guarantee'] },
    { page: 'About', url: `https://${d}/about`, currentTitle: `About Us - ${base}`, currentDesc: '', optimizedTitle: `About ${base} | ${5 + Math.floor(Math.random() * 20)}+ Years Serving [City]`, optimizedDesc: `Family-owned ${base.toLowerCase()} company with ${5 + Math.floor(Math.random() * 20)}+ years of experience. Meet our licensed team and learn why [City] trusts us.`, changes: ['Added years of experience', 'Added family-owned trust signal', 'Personalized description'] },
    { page: 'Contact', url: `https://${d}/contact`, currentTitle: `Contact - ${base}`, currentDesc: '', optimizedTitle: `Contact ${base} | Free Estimates | [City], [State]`, optimizedDesc: `Get a free estimate from ${base}. Call (555) 123-4567 or fill out our online form. Serving [City] and surrounding areas.`, changes: ['Added free estimate CTA', 'Added phone number', 'Added service area'] },
    { page: 'Blog', url: `https://${d}/blog`, currentTitle: `Blog - ${base}`, currentDesc: '', optimizedTitle: `${base} Blog | Tips, Guides & Industry News`, optimizedDesc: `Expert ${base.toLowerCase()} tips, how-to guides, and industry updates. Learn how to save money, avoid common mistakes, and maintain your home.`, changes: ['Added content descriptors', 'Added value proposition', 'Improved keyword targeting'] },
  ];

  logActivity('seo', `Meta tags optimized: ${audit.domain} (${pages.length} pages)`, { auditId: audit.id });
  res.json({ ok: true, domain: audit.domain, pages });
});

// --- Real DataForSEO Integration ---

function dfsAuthHeader() {
  return 'Basic ' + Buffer.from(`${settings.seo.dataforseo_login}:${settings.seo.dataforseo_password}`).toString('base64');
}

async function dfsRequest(endpoint, body) {
  const res = await fetch(`https://api.dataforseo.com/v3/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': dfsAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}`);
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error(data.status_message || `DataForSEO error ${data.status_code}`);
  return data;
}

async function runRealSeoAudit(audit, auditId) {
  const domain = audit.domain;
  const location = settings.seo.default_location || 'United States';
  const language = settings.seo.default_language || 'en';
  const agentNames = ['keyword', 'technical', 'competitor', 'content', 'backlink'];

  // Run all 5 agents in parallel
  const results = await Promise.allSettled([
    runKeywordAgent(domain, location, language),
    runTechnicalAgent(domain),
    runCompetitorAgent(domain, location, language),
    runContentAgent(domain),
    runBacklinkAgent(domain),
  ]);

  // Process results
  results.forEach((result, i) => {
    const name = agentNames[i];
    if (result.status === 'fulfilled' && result.value) {
      audit.agents[name] = { ...audit.agents[name], ...result.value, status: 'complete', completedAt: new Date().toISOString() };
    } else {
      audit.agents[name].status = 'error';
      audit.agents[name].score = 0;
      audit.agents[name].findings = [{ severity: 'critical', issue: `Agent failed: ${result.reason?.message || 'Unknown error'}`, recommendation: 'Check API credits and try again.' }];
      audit.agents[name].completedAt = new Date().toISOString();
    }
    broadcast({ event: 'seo_agent_complete', data: { auditId, agent: name, score: audit.agents[name].score } });
  });

  // Composite score
  const scores = agentNames.map(n => audit.agents[n].score || 0);
  const validScores = scores.filter(s => s > 0);
  audit.compositeScore = validScores.length ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : 0;
  audit.status = 'complete';
  audit.completedAt = new Date().toISOString();
  audit.executiveSummary = generateExecutiveSummary(audit);
  audit.quickWins = generateQuickWins(audit);
  audit.actionPlan = generateActionPlan(audit);

  // Track cost (~$0.10-0.30 per audit)
  costLedger.push({
    id: uuidv4(), agent: 'seo-audit', model: 'dataforseo', skill: 'seo-audit',
    inputTokens: 0, outputTokens: 0, cost: 0.20,
    timestamp: new Date().toISOString(),
  });

  saveState('seo_audits', seoAudits);
  broadcast({ event: 'seo_audit_complete', data: { auditId, compositeScore: audit.compositeScore } });
  logActivity('seo', `SEO audit complete (real): ${audit.domain} — score ${audit.compositeScore}/100`, { auditId });
}

// --- Keyword Agent (DataForSEO Labs) ---
async function runKeywordAgent(domain, location, language) {
  const findings = [];
  let score = 50;

  try {
    // Get ranked keywords for the domain
    const ranked = await dfsRequest('dataforseo_labs/google/ranked_keywords/live', [{
      target: domain, location_name: location, language_name: language === 'en' ? 'English' : language, limit: 50,
    }]);

    const keywords = ranked.tasks?.[0]?.result?.[0]?.items || [];
    const totalRanked = ranked.tasks?.[0]?.result?.[0]?.total_count || 0;

    if (totalRanked === 0) {
      findings.push({ severity: 'critical', issue: `No organic rankings found for ${domain}`, recommendation: 'The domain has no search visibility. Start with keyword research and create content targeting low-competition terms.' });
      score = 15;
    } else {
      score = Math.min(90, 30 + Math.floor(totalRanked / 5));

      // Top 10 keywords
      const top10 = keywords.filter(k => k.keyword_data?.keyword_info?.search_volume > 0).slice(0, 10);
      if (top10.length > 0) {
        findings.push({ severity: 'info', issue: `Ranking for ${totalRanked} keywords. Top: ${top10.map(k => k.keyword_data?.keyword).join(', ')}`, recommendation: 'Focus on improving positions for high-volume keywords currently ranking 4-20.' });
      }

      // Find keywords ranking 11-20 (opportunity zone)
      const nearFirst = keywords.filter(k => k.ranked_serp_element?.serp_item?.rank_absolute >= 11 && k.ranked_serp_element?.serp_item?.rank_absolute <= 20);
      if (nearFirst.length > 0) {
        findings.push({ severity: 'high', issue: `${nearFirst.length} keywords ranking on page 2 (positions 11-20) — close to first page`, recommendation: `Optimize content for: ${nearFirst.slice(0, 5).map(k => k.keyword_data?.keyword).join(', ')}. Small improvements could push these to page 1.` });
      }
    }

    // Get keyword suggestions
    try {
      const suggestions = await dfsRequest('dataforseo_labs/google/keyword_suggestions/live', [{
        target: domain, location_name: location, language_name: language === 'en' ? 'English' : language, limit: 20,
      }]);
      const sugItems = suggestions.tasks?.[0]?.result?.[0]?.items || [];
      if (sugItems.length > 0) {
        const topSuggestions = sugItems.slice(0, 5).map(s => s.keyword).join(', ');
        findings.push({ severity: 'medium', issue: `Keyword opportunities found: ${topSuggestions}`, recommendation: 'Create dedicated content targeting these suggested keywords to expand search visibility.' });
      }
    } catch {}

  } catch (e) {
    findings.push({ severity: 'critical', issue: `Keyword research failed: ${e.message}`, recommendation: 'Verify DataForSEO credentials and API credits.' });
    score = 0;
  }

  return { score, findings };
}

// --- Technical Agent (OnPage) ---
async function runTechnicalAgent(domain) {
  const findings = [];
  let score = 50;

  try {
    // Use instant pages for quick technical check
    const result = await dfsRequest('on_page/instant_pages', [{
      url: `https://${domain}`, limit: 10, enable_javascript: true,
    }]);

    const pages = result.tasks?.[0]?.result || [];
    if (pages.length === 0) {
      findings.push({ severity: 'critical', issue: 'Could not crawl the domain', recommendation: 'Ensure the domain is accessible and not blocking crawlers.' });
      score = 10;
      return { score, findings };
    }

    let issues = 0;
    for (const page of pages) {
      const item = page.items?.[0] || page;
      const statusCode = item.status_code || item.resource_errors?.status_code;

      if (statusCode && statusCode >= 400) {
        findings.push({ severity: 'high', issue: `Page returns HTTP ${statusCode}: ${item.url || domain}`, recommendation: `Fix the ${statusCode} error. If the page was removed, set up a 301 redirect.` });
        issues++;
      }

      if (item.meta?.title && item.meta.title.length > 60) {
        findings.push({ severity: 'medium', issue: `Title tag too long (${item.meta.title.length} chars): "${item.meta.title.substring(0, 50)}..."`, recommendation: 'Shorten to under 60 characters while keeping the primary keyword.' });
        issues++;
      }

      if (!item.meta?.description) {
        findings.push({ severity: 'high', issue: `Missing meta description: ${item.url || domain}`, recommendation: 'Add a compelling meta description under 155 characters with a call to action.' });
        issues++;
      }

      if (item.page_timing?.time_to_interactive > 5000) {
        findings.push({ severity: 'high', issue: `Slow page load: ${Math.round(item.page_timing.time_to_interactive / 1000)}s time-to-interactive`, recommendation: 'Optimize images, defer non-critical JS, enable compression.' });
        issues++;
      }

      if (!item.meta?.htags?.h1 || item.meta.htags.h1.length === 0) {
        findings.push({ severity: 'high', issue: `Missing H1 tag: ${item.url || domain}`, recommendation: 'Add a single H1 tag containing the primary keyword for the page.' });
        issues++;
      }
    }

    // Score based on issues found
    score = Math.max(10, 90 - (issues * 8));

    if (issues === 0) {
      findings.push({ severity: 'info', issue: 'No critical technical issues detected on sampled pages', recommendation: 'Continue monitoring. Consider a deeper crawl with more pages.' });
    }

  } catch (e) {
    findings.push({ severity: 'critical', issue: `Technical audit failed: ${e.message}`, recommendation: 'Verify DataForSEO credentials.' });
    score = 0;
  }

  return { score, findings };
}

// --- Competitor Agent (DataForSEO Labs) ---
async function runCompetitorAgent(domain, location, language) {
  const findings = [];
  let score = 50;

  try {
    const result = await dfsRequest('dataforseo_labs/google/competitors_domain/live', [{
      target: domain, location_name: location, language_name: language === 'en' ? 'English' : language, limit: 10,
    }]);

    const competitors = result.tasks?.[0]?.result?.[0]?.items || [];
    if (competitors.length === 0) {
      findings.push({ severity: 'medium', issue: 'No organic competitors found', recommendation: 'The domain may be too new or have insufficient rankings for competitor comparison.' });
      score = 30;
    } else {
      score = 60;
      const topCompetitors = competitors.slice(0, 5);
      findings.push({
        severity: 'info',
        issue: `Top ${topCompetitors.length} competitors: ${topCompetitors.map(c => c.domain).join(', ')}`,
        recommendation: 'Analyze these competitors for content gaps and link building opportunities.',
      });

      // Check competitor keyword overlap
      for (const comp of topCompetitors.slice(0, 3)) {
        const overlap = comp.avg_position;
        const compKeywords = comp.relevant_serp_items || 0;
        if (compKeywords > 0) {
          findings.push({
            severity: 'medium',
            issue: `${comp.domain} ranks for ${compKeywords} overlapping keywords (avg position: ${Math.round(overlap || 0)})`,
            recommendation: `Analyze ${comp.domain}'s top content and create competing pages for shared keywords where you rank lower.`,
          });
        }
      }

      if (competitors.length >= 5) score = 70;
    }

  } catch (e) {
    findings.push({ severity: 'critical', issue: `Competitor analysis failed: ${e.message}`, recommendation: 'Verify DataForSEO credentials.' });
    score = 0;
  }

  return { score, findings };
}

// --- Content Agent (OnPage + Content Parsing) ---
async function runContentAgent(domain) {
  const findings = [];
  let score = 50;

  try {
    const result = await dfsRequest('on_page/instant_pages', [{
      url: `https://${domain}`, limit: 5, enable_javascript: true,
    }]);

    const pages = result.tasks?.[0]?.result || [];
    let thinPages = 0, missingMeta = 0, totalWordCount = 0, pageCount = 0;

    for (const page of pages) {
      const item = page.items?.[0] || page;
      const wordCount = item.meta?.content?.plain_text_word_count || 0;
      totalWordCount += wordCount;
      pageCount++;

      if (wordCount < 300 && wordCount > 0) {
        findings.push({ severity: 'high', issue: `Thin content (${wordCount} words): ${item.url || domain}`, recommendation: 'Expand to at least 800 words with unique, valuable content addressing user intent.' });
        thinPages++;
      }

      if (item.meta?.description && item.meta.description.length < 50) {
        findings.push({ severity: 'medium', issue: `Weak meta description (${item.meta.description.length} chars)`, recommendation: 'Write a compelling description of 120-155 characters with a call to action.' });
        missingMeta++;
      }

      // Check for duplicate titles
      if (item.meta?.title) {
        const dupes = pages.filter(p => (p.items?.[0] || p).meta?.title === item.meta.title);
        if (dupes.length > 1) {
          findings.push({ severity: 'medium', issue: `Duplicate title tag found across ${dupes.length} pages`, recommendation: 'Each page needs a unique title tag targeting different keywords.' });
        }
      }
    }

    const avgWords = pageCount > 0 ? Math.round(totalWordCount / pageCount) : 0;
    if (avgWords < 300) {
      findings.push({ severity: 'high', issue: `Low average word count across pages: ${avgWords} words`, recommendation: 'Most pages need significantly more content. Aim for 800-1500 words on service/landing pages.' });
    }

    score = Math.max(10, 80 - (thinPages * 12) - (missingMeta * 5));
    if (thinPages === 0 && missingMeta === 0) {
      findings.push({ severity: 'info', issue: `Content looks healthy. Average ${avgWords} words per page.`, recommendation: 'Consider adding a blog for long-tail keyword coverage.' });
      score = Math.max(score, 75);
    }

  } catch (e) {
    findings.push({ severity: 'critical', issue: `Content analysis failed: ${e.message}`, recommendation: 'Verify DataForSEO credentials.' });
    score = 0;
  }

  return { score, findings };
}

// --- Backlink Agent ---
async function runBacklinkAgent(domain) {
  const findings = [];
  let score = 50;

  try {
    // Get backlink overview
    const result = await dfsRequest('backlinks/summary/live', [{
      target: domain, internal_list_limit: 0, backlinks_filters: ['dofollow', '=', 'true'],
    }]);

    const summary = result.tasks?.[0]?.result?.[0] || {};
    const referringDomains = summary.referring_domains || 0;
    const totalBacklinks = summary.backlinks || 0;
    const brokenBacklinks = summary.broken_backlinks || 0;
    const spamScore = summary.rank || 0;

    if (referringDomains === 0) {
      findings.push({ severity: 'critical', issue: 'No referring domains detected', recommendation: 'Start a link building campaign: submit to directories, guest post on industry blogs, create link-worthy content.' });
      score = 10;
    } else {
      score = Math.min(90, 20 + Math.floor(referringDomains * 1.5));

      findings.push({
        severity: 'info',
        issue: `Backlink profile: ${referringDomains} referring domains, ${totalBacklinks} total backlinks`,
        recommendation: referringDomains < 20
          ? 'Backlink profile is thin. Prioritize building quality referring domains over raw link count.'
          : 'Solid foundation. Focus on acquiring links from high-authority domains in your industry.',
      });

      if (brokenBacklinks > 0) {
        findings.push({
          severity: 'high',
          issue: `${brokenBacklinks} broken backlinks detected (link equity lost)`,
          recommendation: 'Set up 301 redirects for URLs with incoming backlinks that now return 404 to recapture link equity.',
        });
        score -= 5;
      }
    }

    // Get backlink competitors
    try {
      const compResult = await dfsRequest('backlinks/competitors/live', [{
        target: domain, limit: 5,
      }]);
      const blCompetitors = compResult.tasks?.[0]?.result || [];
      if (blCompetitors.length > 0) {
        const topBLComp = blCompetitors.slice(0, 3).map(c => c.target).join(', ');
        findings.push({
          severity: 'medium',
          issue: `Backlink competitors: ${topBLComp}`,
          recommendation: 'Analyze where these competitors get links and pursue similar opportunities.',
        });
      }
    } catch {}

  } catch (e) {
    findings.push({ severity: 'critical', issue: `Backlink analysis failed: ${e.message}`, recommendation: 'Verify DataForSEO credentials.' });
    score = 0;
  }

  return { score, findings };
}

// --- SEO Demo Data Generators ---
function generateSeoFindings(agentName, domain) {
  const findings = {
    keyword: [
      { severity: 'high', issue: `Missing long-tail keywords for "${domain}" services`, recommendation: 'Create dedicated landing pages for top 10 service keywords' },
      { severity: 'medium', issue: 'No local keyword targeting detected', recommendation: 'Add city + service keyword combinations to title tags and H1s' },
      { severity: 'low', issue: 'Keyword cannibalization on 3 pages', recommendation: 'Consolidate overlapping pages or differentiate target keywords' },
      { severity: 'high', issue: `Top competitor ranks for ${12 + Math.floor(Math.random() * 20)} keywords you don\'t target`, recommendation: 'Prioritize content creation for gap keywords with volume > 500/mo' },
    ],
    technical: [
      { severity: 'critical', issue: 'Cloudflare settings blocking SEO crawlers', recommendation: 'Whitelist Googlebot and Bingbot user agents in Cloudflare firewall rules' },
      { severity: 'high', issue: `${3 + Math.floor(Math.random() * 8)} pages returning 404 errors`, recommendation: 'Set up 301 redirects for broken URLs to relevant live pages' },
      { severity: 'medium', issue: 'Missing XML sitemap or outdated entries', recommendation: 'Generate and submit a fresh sitemap via Google Search Console' },
      { severity: 'medium', issue: 'Core Web Vitals: LCP exceeds 4s on mobile', recommendation: 'Optimize hero images, implement lazy loading, and defer non-critical JS' },
      { severity: 'low', issue: 'Missing hreflang tags', recommendation: 'Add hreflang if targeting multiple languages/regions' },
    ],
    competitor: [
      { severity: 'info', issue: `Top 3 competitors: identified with avg. Domain Authority ${45 + Math.floor(Math.random() * 25)}`, recommendation: 'Focus on content gaps where competitors rank but you don\'t' },
      { severity: 'high', issue: 'Competitor #1 publishes 4x more blog content monthly', recommendation: 'Increase content velocity to 8-12 posts/month targeting informational queries' },
      { severity: 'medium', issue: 'Competitors using schema markup you\'re missing', recommendation: 'Implement LocalBusiness, FAQ, and Review schema on key pages' },
    ],
    content: [
      { severity: 'high', issue: 'No blog or content hub detected', recommendation: 'Create a blog targeting top 20 informational keywords in your niche' },
      { severity: 'high', issue: 'Thin content on service pages (avg. 180 words)', recommendation: 'Expand service pages to 800-1500 words with unique value propositions' },
      { severity: 'medium', issue: 'Missing internal linking structure', recommendation: 'Build topic clusters with pillar pages linking to supporting content' },
      { severity: 'low', issue: 'Duplicate meta descriptions on 5 pages', recommendation: 'Write unique meta descriptions (150-160 chars) for each page' },
    ],
    backlink: [
      { severity: 'high', issue: `Only ${5 + Math.floor(Math.random() * 15)} referring domains detected`, recommendation: 'Launch a link building campaign targeting local directories and industry publications' },
      { severity: 'medium', issue: `${2 + Math.floor(Math.random() * 5)} toxic backlinks detected (spam score > 60)`, recommendation: 'Disavow toxic domains via Google Search Console disavow tool' },
      { severity: 'high', issue: 'Backlinks pointing to 404 pages (link equity lost)', recommendation: 'Redirect broken backlink URLs to relevant live pages to recapture link equity' },
      { severity: 'low', issue: 'No branded anchor text diversity', recommendation: 'Vary anchor text in outreach campaigns (branded, partial match, generic)' },
    ],
  };
  return findings[agentName] || [];
}

function generateExecutiveSummary(audit) {
  const d = audit.domain;
  const score = audit.compositeScore;
  const level = score >= 75 ? 'good' : score >= 50 ? 'needs improvement' : 'critical';
  const techScore = audit.agents.technical.score;
  const contentScore = audit.agents.content.score;
  const backlinkScore = audit.agents.backlink.score;
  return `${d} scores ${score}/100 overall (${level}). Technical health: ${techScore}/100 — ` +
    `Content quality: ${contentScore}/100 — Backlink profile: ${backlinkScore}/100. ` +
    (score < 50 ? `Immediate action required: the site has critical technical issues blocking crawlers and lacks content depth to compete. ` : '') +
    (score < 75 ? `Key opportunities: expand content strategy, fix technical errors, and build quality backlinks to close the gap with competitors.` :
    `The site is performing well. Focus on maintaining momentum with consistent content and monitoring competitor movements.`);
}

function generateQuickWins(audit) {
  const wins = [];
  if (audit.agents.technical.score < 70) wins.push({ priority: 1, action: 'Fix crawler blocking rules in Cloudflare/server config', time: '15 min', impact: 'high' });
  if (audit.agents.technical.score < 80) wins.push({ priority: 2, action: 'Submit updated XML sitemap to Google Search Console', time: '10 min', impact: 'medium' });
  if (audit.agents.content.score < 60) wins.push({ priority: 3, action: 'Add unique meta descriptions to all service pages', time: '30 min', impact: 'medium' });
  if (audit.agents.backlink.score < 70) wins.push({ priority: 4, action: 'Set up 301 redirects for backlinks pointing to 404 pages', time: '20 min', impact: 'high' });
  wins.push({ priority: 5, action: 'Add LocalBusiness schema markup to homepage', time: '15 min', impact: 'medium' });
  wins.push({ priority: 6, action: 'Optimize title tags with primary keyword + location', time: '25 min', impact: 'high' });
  return wins;
}

function generateActionPlan(audit) {
  return [
    { phase: 'Week 1-2', title: 'Technical Foundation', tasks: ['Fix all critical technical issues', 'Submit sitemap', 'Configure robots.txt', 'Fix broken redirects'], priority: 'critical' },
    { phase: 'Week 3-4', title: 'Content Optimization', tasks: ['Expand thin service pages to 800+ words', 'Write unique meta descriptions', 'Add schema markup to all pages'], priority: 'high' },
    { phase: 'Month 2', title: 'Content Creation', tasks: ['Launch blog with 8 keyword-targeted posts', 'Build pillar page for primary service', 'Create FAQ page from customer questions'], priority: 'high' },
    { phase: 'Month 3', title: 'Link Building & Authority', tasks: ['Submit to 20 relevant local directories', 'Guest post outreach to 10 industry blogs', 'Disavow toxic backlinks', 'Monitor competitor link acquisition'], priority: 'medium' },
    { phase: 'Ongoing', title: 'Monitoring & Growth', tasks: ['Publish 2-4 blog posts per week', 'Monthly rank tracking and reporting', 'Quarterly competitor re-analysis', 'Core Web Vitals monitoring'], priority: 'standard' },
  ];
}

// Change password (admin)
app.post('/api/settings/change-password', requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password required' });
  if (newPassword.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters' });

  const token = req.cookies?.['ai-os-session'] || req.headers.authorization?.replace('Bearer ', '');
  const session = isValidSession(token);
  const user = findUserByEmail(session.email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = user.passwordHash
    ? await bcrypt.compare(currentPassword, user.passwordHash)
    : (user.password === currentPassword);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  delete user.password; // remove legacy plain-text if present
  saveState('users', users);
  logActivity('settings', `Password changed for ${session.email}`);
  res.json({ ok: true });
});

// --- Downloads ---
app.get('/download/:filename', (req, res) => {
  const allowed = { 'install-vps.sh': path.join(BASE, 'scripts', 'install-vps.sh') };
  const filePath = allowed[req.params.filename];
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, req.params.filename);
});

// --- WebSocket ---

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* swallow client errors */ });
  ws.send(JSON.stringify({ event: 'connected', data: { health: getSystemHealth() } }));
});

// --- Start ---

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// 404 handler for unknown API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);

  // Save in-memory state to disk
  try {
    const state = {
      savedAt: new Date().toISOString(),
      activityLog: activityLog.slice(-200), // last 200 entries
    };
    fs.writeFileSync(path.join(STATE_DIR, 'last-session.json'), JSON.stringify(state, null, 2));
    console.log('[SHUTDOWN] State saved to .magent/state/last-session.json');
  } catch (e) {
    console.error('[SHUTDOWN] Failed to save state:', e.message);
  }

  // Close WebSocket connections
  clearInterval(heartbeat);
  wss.clients.forEach(ws => {
    ws.send(JSON.stringify({ event: 'server_shutdown', data: { reason: signal } }));
    ws.close();
  });

  // Close HTTP server
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed.');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// --- Start ---
server.listen(PORT, HOST, () => {
  console.log(`AI OS Dashboard running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'} | Demo mode: ${DEMO_MODE} | Auth: ${API_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`Schedules active: ${[...schedules.values()].filter(s => s.enabled).length}`);
  console.log(`Pipelines available: ${loadPipelines().length}`);
  console.log(`Identity files: ${fs.existsSync(IDENTITY_DIR) ? fs.readdirSync(IDENTITY_DIR).filter(f => f.endsWith('.md')).length : 0}`);
  console.log(`Project contexts: ${loadProjects().length}`);
  console.log(`Verification rubrics: ${Object.keys(loadVerificationRubrics()).length}`);
  console.log(`Grok queries cached: ${grokCache.size}`);
  logActivity('system', 'AI OS started');
  appendLog('SYSTEM_START');
});
