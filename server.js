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

// --- Security & Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:"],
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
    amount: 4900, // $49
  },
  enterprise: {
    name: 'Enterprise',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise_placeholder',
    amount: 19900, // $199
  },
};

// In-memory user/session store (replace with DB in production)
const users = loadState('users', []);
const sessions = new Map(); // token -> { email, plan, stripeCustomerId, expiresAt }

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
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.plan || user.plan === 'free') return res.status(403).json({ error: 'No active subscription. Please choose a plan.' });

  // Simple password check (in production, use bcrypt + hashed passwords)
  if (user.password && user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken();
  sessions.set(token, { email: user.email, plan: user.plan, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });

  res.cookie('ai-os-session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 86400000,
  });
  res.json({ ok: true, token, plan: user.plan });
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

// Static files (served by Nginx in production, Express in dev)
app.use(express.static(path.join(BASE, 'dashboard'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
}));

// Health check endpoint
const startTime = Date.now();
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    version: require('./package.json').version,
    demoMode: DEMO_MODE,
    nodeEnv: process.env.NODE_ENV || 'development',
    stripeConfigured: !!stripe,
    activeUsers: users.filter(u => u.plan && u.plan !== 'free').length,
    activeSessions: sessions.size,
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
  try {
    const fp = path.join(STATE_DIR, `${key}.json`);
    if (fs.existsSync(fp)) {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      console.log(`[STATE] Loaded ${key} from disk`);
      return data;
    }
  } catch (e) {
    console.error(`[STATE] Failed to load ${key}:`, e.message);
  }
  return typeof fallback === 'function' ? fallback() : fallback;
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
const COST_RATES = {
  'claude-4.7-opus':   { input: 15.00, output: 75.00 },   // per 1M tokens
  'claude-4.7-sonnet': { input: 3.00,  output: 15.00 },
  'claude-4.7-haiku':  { input: 0.25,  output: 1.25  },
  'deepseek-v4':       { input: 0.14,  output: 0.28  },
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
    { agent: 'orchestrator', model: 'claude-4.7-opus', skill: 'task-routing', inputTokens: 12400, outputTokens: 3200, timestamp: new Date(now - 3600000).toISOString() },
    { agent: 'researcher', model: 'claude-4.7-sonnet', skill: 'research-brief', inputTokens: 45000, outputTokens: 8500, timestamp: new Date(now - 7200000).toISOString() },
    { agent: 'scout', model: 'claude-4.7-haiku', skill: 'tech-radar', inputTokens: 28000, outputTokens: 4200, timestamp: new Date(now - 10800000).toISOString() },
    { agent: 'deepseek-worker', model: 'deepseek-v4', skill: 'content-creation', inputTokens: 62000, outputTokens: 18000, timestamp: new Date(now - 14400000).toISOString() },
    { agent: 'coder', model: 'claude-4.7-sonnet', skill: 'implementation', inputTokens: 38000, outputTokens: 12000, timestamp: new Date(now - 18000000).toISOString() },
    { agent: 'writer', model: 'claude-4.7-sonnet', skill: 'content-creation', inputTokens: 22000, outputTokens: 9500, timestamp: new Date(now - 21600000).toISOString() },
    { agent: 'security-auditor', model: 'claude-4.7-opus', skill: 'security-audit', inputTokens: 55000, outputTokens: 14000, timestamp: new Date(now - 25200000).toISOString() },
    { agent: 'synthesis', model: 'claude-4.7-sonnet', skill: 'deep-research', inputTokens: 34000, outputTokens: 7800, timestamp: new Date(now - 28800000).toISOString() },
    { agent: 'research-architect', model: 'claude-4.7-sonnet', skill: 'deep-research', inputTokens: 18000, outputTokens: 5200, timestamp: new Date(now - 32400000).toISOString() },
    { agent: 'report-compiler', model: 'claude-4.7-sonnet', skill: 'academic-paper', inputTokens: 41000, outputTokens: 16000, timestamp: new Date(now - 36000000).toISOString() },
    { agent: 'reviewer', model: 'claude-4.7-opus', skill: 'review', inputTokens: 32000, outputTokens: 6400, timestamp: new Date(now - 43200000).toISOString() },
    { agent: 'data-wrangler', model: 'claude-4.7-sonnet', skill: 'lead-enrichment', inputTokens: 29000, outputTokens: 11000, timestamp: new Date(now - 50400000).toISOString() },
    { agent: 'deepseek-worker', model: 'deepseek-v4', skill: 'seo-audit', inputTokens: 85000, outputTokens: 24000, timestamp: new Date(now - 57600000).toISOString() },
    { agent: 'scout', model: 'claude-4.7-haiku', skill: 'tech-radar', inputTokens: 31000, outputTokens: 5100, timestamp: new Date(now - 86400000).toISOString() },
    { agent: 'researcher', model: 'claude-4.7-sonnet', skill: 'research-brief', inputTokens: 52000, outputTokens: 9800, timestamp: new Date(now - 90000000).toISOString() },
  ];

  entries.forEach(e => {
    const rates = COST_RATES[e.model] || COST_RATES['claude-4.7-sonnet'];
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
    title: 'Update agent model references to Claude 4.7 Opus',
    finding: 'Claude 4.7 Opus released with 400K context window',
    impact: 'high',
    category: 'models',
    action: {
      type: 'config_change',
      target: '.claude/agents/*.md',
      description: 'Update Opus-tier agents (orchestrator, architect, reviewer, safety) from 4.6-opus to 4.7-opus. Doubles available context window for complex planning tasks.',
      effort: 'low',
      risk: 'Model behavior may differ — run integration test workflow after upgrade',
    },
    rollback: 'Revert model references to claude-4.6-opus in agent files',
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
  const rates = COST_RATES[model] || COST_RATES['claude-4.7-sonnet'];
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
          'researcher': 'claude-4.7-sonnet', 'synthesis': 'claude-4.7-sonnet',
          'research-architect': 'claude-4.7-sonnet', 'report-compiler': 'claude-4.7-sonnet',
          'writer': 'claude-4.7-sonnet', 'reviewer': 'claude-4.7-opus',
          'security-auditor': 'claude-4.7-opus', 'orchestrator': 'claude-4.7-opus',
          'deepseek-worker': 'deepseek-v4', 'scout': 'claude-4.7-haiku',
        };
        const model = modelMap[s.agent] || 'claude-4.7-sonnet';
        const inputTokens = 15000 + Math.floor(Math.random() * 25000);
        const outputTokens = 4000 + Math.floor(Math.random() * 12000);
        const rates = COST_RATES[model] || COST_RATES['claude-4.7-sonnet'];
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
app.post('/api/grok/query', heavyLimiter, (req, res) => {
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

  // Simulate streaming response
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
