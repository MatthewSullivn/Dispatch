/**
 * Dispatch — Express server and API routes.
 *
 * Serves the dashboard, initializes agents, and exposes the API:
 *   - POST /api/goal: Submit a goal for autonomous execution
 *   - GET /api/balances: USDC balances for all agent wallets
 *   - GET /api/transactions: On-chain USDC transactions (all agents)
 *   - GET /api/registry: Service marketplace listings
 *   - GET /api/escrows: Checkout session escrow status
 *   - GET /api/reasoning: Agent decision-making log
 *   - GET /api/events/stream: Real-time SSE stream
 *   - GET /api/audit: Complete audit trail
 *
 * Rate limited and budget-capped. All constants defined in config.js.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { AGENTS, RATE_LIMITS, BUDGET, SYSTEM } = require('./config');
const meshEvents = require('./event-bus');
const ServiceRegistry = require('./registry');
const EscrowManager = require('./escrow');
const OrchestratorAgent = require('./agents/orchestrator');
const ResearchAgent = require('./agents/research-agent');
const WriterAgent = require('./agents/writer-agent');
const ValidatorAgent = require('./agents/validator-agent');

// Actions that carry decision-making context for the reasoning log
const REASONING_ACTIONS = new Set([
  'subtasks_planned', 'agent_discovered', 'dispatching_task',
  'budget_exceeded', 'payment_initiated', 'payment_completed',
  'escrow_created', 'escrow_released', 'goal_received', 'goal_completed',
  'dynamic_planning', 'validation_result', 'research_empty',
]);

// ── App Setup ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '100kb' }));

// Security headers — prevent clickjacking, MIME sniffing, and XSS
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS — allow dashboard origin, block unknown cross-origin requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [
    `http://localhost:${SYSTEM.port}`,
    SYSTEM.deployedUrl,
  ].filter(Boolean);
  if (!origin || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API key authentication for write endpoints (POST /api/goal)
const API_KEY = process.env.DISPATCH_API_KEY || null;
app.use('/api/goal', (req, res, next) => {
  if (!API_KEY) return next(); // No key configured — open access
  if (req.method !== 'POST') return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
});

// Request timeout middleware — prevent long-running requests from hanging
app.use((req, res, next) => {
  res.setTimeout(120000, () => {
    if (!res.headersSent) res.status(504).json({ error: 'Request timeout' });
  });
  next();
});

// Serve Next.js static export (out/) if it exists, otherwise fall back to public/
const fs = require('fs');
const outDir = path.join(__dirname, '..', 'out');
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(fs.existsSync(outDir) ? outDir : publicDir));

// ── Core State ───────────────────────────────────────────────────

const registry = new ServiceRegistry();
const escrowManager = new EscrowManager();
const pendingApprovals = [];
const masterTimeline = [];
const sseClients = new Set();

// Capture all agent events into the rolling timeline and SSE stream
meshEvents.on('agent-event', (event) => {
  masterTimeline.push(event);
  if (masterTimeline.length > SYSTEM.maxTimelineEvents) masterTimeline.shift();

  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
});

/**
 * Callback invoked when a payment exceeds the Locus spending threshold.
 */
function onApprovalNeeded(approval) {
  pendingApprovals.push(approval);
  meshEvents.emit('agent-event', {
    timestamp: approval.timestamp,
    agent: approval.agent,
    action: 'approval_required',
    type: 'approval',
    amount: approval.amount,
    task: approval.task,
    approvalUrl: approval.approvalUrl,
  });
}

// ── Agent Initialization ─────────────────────────────────────────

let orchestrator, researcher, writer, validator;

/**
 * Create agents from config, register workers, and populate the
 * service registry. All agent definitions live in config.js.
 */
function initAgents() {
  const rConf = AGENTS.researcher;
  const wConf = AGENTS.writer;
  const vConf = AGENTS.validator;
  const oConf = AGENTS.orchestrator;

  researcher = new ResearchAgent({
    name: rConf.name,
    locusApiKey: rConf.locusApiKey,
    walletAddress: rConf.walletAddress,
    onApprovalNeeded,
  });
  researcher.agentEmail = rConf.email;

  writer = new WriterAgent({
    name: wConf.name,
    locusApiKey: wConf.locusApiKey,
    walletAddress: wConf.walletAddress,
    onApprovalNeeded,
  });
  writer.agentEmail = wConf.email;

  validator = new ValidatorAgent({
    name: vConf.name,
    locusApiKey: vConf.locusApiKey,
    walletAddress: vConf.walletAddress,
    onApprovalNeeded,
  });
  validator.agentEmail = vConf.email;

  orchestrator = new OrchestratorAgent({
    name: oConf.name,
    locusApiKey: oConf.locusApiKey,
    walletAddress: oConf.walletAddress,
    onApprovalNeeded,
    registry,
    escrowManager,
  });

  orchestrator.registerWorker(researcher);
  orchestrator.registerWorker(writer);
  orchestrator.registerWorker(validator);
  orchestrator.setBudget(BUDGET.defaultTotal, BUDGET.defaultPerTask);

  // Register services from config
  if (rConf.service) researcher.registerService(registry, rConf.service);
  if (wConf.service) writer.registerService(registry, wConf.service);
  if (vConf.service) validator.registerService(registry, vConf.service);

  console.log('Agents initialized:');
  console.log(`  Orchestrator: ${oConf.walletAddress}`);
  console.log(`  Researcher:   ${rConf.walletAddress}`);
  console.log(`  Writer:       ${wConf.walletAddress}`);
  console.log(`  Validator:    ${vConf.walletAddress}`);
  console.log(`  Services:     ${registry.getAll().length} registered`);
}

/** Helper: iterate over all agent instances. */
function allAgents() {
  return [
    { name: 'orchestrator', agent: orchestrator },
    { name: 'researcher', agent: researcher },
    { name: 'writer', agent: writer },
    { name: 'validator', agent: validator },
  ];
}

// ── API Routes ───────────────────────────────────────────────────

/** System health and agent status. */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    agents: {
      orchestrator: { name: orchestrator?.name, wallet: orchestrator?.walletAddress },
      researcher: { name: researcher?.name, wallet: researcher?.walletAddress },
      writer: { name: writer?.name, wallet: writer?.walletAddress },
      validator: { name: validator?.name, wallet: validator?.walletAddress },
    },
    services: registry.getAll().length,
    escrows: escrowManager.getAll().length,
    pendingApprovals: pendingApprovals.length,
  });
});

// Rate limiting state — per-IP to prevent single-client abuse
let lastGoalTime = 0;
const goalHourWindow = [];
const ipGoalCounts = new Map();

// Clean stale IP entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMITS.oneHourMs;
  for (const [ip, times] of ipGoalCounts) {
    const valid = times.filter((t) => t > cutoff);
    if (valid.length === 0) ipGoalCounts.delete(ip);
    else ipGoalCounts.set(ip, valid);
  }
}, 600000);

/** Submit a goal for the mesh to execute. Rate limited and budget-capped. */
app.post('/api/goal', async (req, res) => {
  const { goal, budget, maxPerTask } = req.body;
  if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal is required' });
  if (goal.length > SYSTEM.maxGoalLength) return res.status(400).json({ error: `goal must be under ${SYSTEM.maxGoalLength} characters` });
  if (budget !== undefined && (!Number.isFinite(Number(budget)) || Number(budget) <= 0))
    return res.status(400).json({ error: 'budget must be a positive number' });
  if (maxPerTask !== undefined && (!Number.isFinite(Number(maxPerTask)) || Number(maxPerTask) <= 0))
    return res.status(400).json({ error: 'maxPerTask must be a positive number' });

  const now = Date.now();

  // Rate limit: cooldown between goals
  if (now - lastGoalTime < RATE_LIMITS.goalCooldownMs) {
    const wait = Math.ceil((RATE_LIMITS.goalCooldownMs - (now - lastGoalTime)) / 1000);
    return res.status(429).json({ error: `Rate limited. Try again in ${wait}s.` });
  }

  // Rate limit: max goals per hour
  while (goalHourWindow.length && goalHourWindow[0] < now - RATE_LIMITS.oneHourMs) goalHourWindow.shift();
  if (goalHourWindow.length >= RATE_LIMITS.maxGoalsPerHour) {
    return res.status(429).json({ error: `Rate limited. Max ${RATE_LIMITS.maxGoalsPerHour} goals per hour.` });
  }

  // Rate limit: per-IP tracking
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const ipTimes = ipGoalCounts.get(clientIp) || [];
  const recentIpGoals = ipTimes.filter(t => t > now - RATE_LIMITS.oneHourMs);
  if (recentIpGoals.length >= RATE_LIMITS.maxGoalsPerHour) {
    return res.status(429).json({ error: `Rate limited. Max ${RATE_LIMITS.maxGoalsPerHour} goals per hour per client.` });
  }
  recentIpGoals.push(now);
  ipGoalCounts.set(clientIp, recentIpGoals);

  lastGoalTime = now;
  goalHourWindow.push(now);

  // Cap budget to prevent abuse
  const safeBudget = Math.min(budget || orchestrator.budget.total, BUDGET.maxPerGoal);
  const safePerTask = Math.min(maxPerTask || orchestrator.budget.perTask, BUDGET.maxPerTask);
  if (budget || maxPerTask) {
    orchestrator.setBudget(safeBudget, safePerTask);
  }

  try {
    const results = await orchestrator.executeGoal(goal);
    res.json({ success: true, goal, report: results.report, audit: results.audit });
  } catch (err) {
    console.error('Goal failed:', err);
    res.status(500).json({ error: 'Goal execution failed. Check server logs for details.' });
  }
});

/** USDC balances for all agent wallets. */
app.get('/api/balances', async (req, res) => {
  const balances = {};
  await Promise.all(allAgents().map(async ({ name, agent }) => {
    try {
      const bal = await agent.getBalance();
      balances[name] = bal.data?.data || bal.data;
    } catch (err) {
      balances[name] = { error: 'Balance check failed' };
    }
  }));
  res.json({ balances });
});

/** All registered services in the marketplace. */
app.get('/api/registry', (req, res) => {
  res.json({ services: registry.getAll() });
});

/** Search services by keyword. */
app.get('/api/registry/discover', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  if (typeof q !== 'string' || q.length > 200) return res.status(400).json({ error: 'query must be a string under 200 characters' });
  res.json({ results: registry.discover(q) });
});

/**
 * Register an external agent's service in the marketplace.
 * Allows third-party agents to join the mesh by advertising capabilities.
 * The orchestrator will discover and hire them if they offer the best price.
 */
app.post('/api/registry/register', (req, res) => {
  const { agentName, walletAddress, service } = req.body;
  if (!agentName || typeof agentName !== 'string' || agentName.length > 100)
    return res.status(400).json({ error: 'agentName is required (string, max 100 chars)' });
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress))
    return res.status(400).json({ error: 'walletAddress must be a valid Ethereum address' });
  if (!service?.name || !service?.price || !Array.isArray(service?.capabilities))
    return res.status(400).json({ error: 'service must include name, price, and capabilities array' });
  if (typeof service.price !== 'number' || service.price <= 0 || service.price > 10)
    return res.status(400).json({ error: 'service.price must be between 0 and 10 USDC' });

  const entry = registry.register(agentName, walletAddress, '', {
    name: String(service.name).slice(0, 100),
    description: String(service.description || '').slice(0, 500),
    price: service.price,
    capabilities: service.capabilities.slice(0, 10).map(c => String(c).slice(0, 50)),
  });

  res.json({ success: true, serviceId: entry.id, message: 'Service registered. The orchestrator will discover it automatically.' });
});

/** All escrow sessions and their current status. */
app.get('/api/escrows', (req, res) => {
  res.json({ escrows: escrowManager.getAll() });
});

/** Payments held by Locus spending controls for human review. */
app.get('/api/approvals', (req, res) => {
  res.json({ approvals: pendingApprovals });
});

/** Full event timeline (rolling buffer). */
app.get('/api/timeline', (req, res) => {
  res.json({ events: masterTimeline });
});

/** Server-Sent Events stream for real-time dashboard updates. */
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ action: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/** Verify Locus webhook signature (HMAC-SHA256). */
function verifyWebhookSignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

/** Webhook endpoint for Locus checkout session status changes. */
app.post('/api/webhooks/checkout', express.text({ type: '*/*' }), (req, res) => {
  const webhookSecret = process.env.LOCUS_WEBHOOK_SECRET;
  const signature = req.headers['x-signature-256'];

  // Verify signature if secret is configured
  if (webhookSecret && !verifyWebhookSignature(
    typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    signature, webhookSecret
  )) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const event = body.event;
  const data = body.data || {};

  // Update escrow session status based on webhook event
  if (event === 'checkout.session.paid' && data.sessionId) {
    const session = escrowManager.sessions.get(data.sessionId);
    if (session) {
      session.status = 'paid';
      session.paidAt = data.paidAt || new Date().toISOString();
      session.paymentTxHash = data.paymentTxHash;
      session.payerAddress = data.payerAddress;
    }
  } else if (event === 'checkout.session.expired' && data.sessionId) {
    const session = escrowManager.sessions.get(data.sessionId);
    if (session) session.status = 'expired';
  }

  meshEvents.emit('agent-event', {
    timestamp: body.timestamp || new Date().toISOString(),
    agent: 'locus',
    action: 'checkout_webhook',
    type: 'escrow',
    sessionId: data.sessionId,
    event,
    amount: data.amount,
    paymentTxHash: data.paymentTxHash,
    payerAddress: data.payerAddress,
  });
  res.json({ received: true });
});

/** Complete audit trail for all agents. */
app.get('/api/audit', (req, res) => {
  const workerAudits = {};
  if (researcher) workerAudits.researcher = researcher.getAuditTrail();
  if (writer) workerAudits.writer = writer.getAuditTrail();
  if (validator) workerAudits.validator = validator.getAuditTrail();
  res.json({
    orchestrator: orchestrator?.getAuditTrail(),
    workers: workerAudits,
    budget: orchestrator?.budget,
    tasks: orchestrator?.tasks,
  });
});

/** Agent decision-making log with reasoning context. */
app.get('/api/reasoning', (req, res) => {
  const reasoningEvents = masterTimeline.filter(e =>
    e.reasoning || REASONING_ACTIONS.has(e.action)
  );
  res.json({ reasoning: reasoningEvents });
});

/** Agent names, roles, wallet addresses, and reputation scores. */
app.get('/api/agents', (req, res) => {
  res.json({
    agents: allAgents().map(({ agent }) => ({
      name: agent?.name,
      role: agent?.role,
      wallet: agent?.walletAddress,
      reputation: registry.getReputation(agent?.name),
    })),
  });
});

/** Agent reputation scores from task completion history. */
app.get('/api/reputation', (req, res) => {
  res.json({ reputations: registry.getAllReputations() });
});

/** On-chain USDC transactions aggregated from all agent wallets. */
app.get('/api/transactions', async (req, res) => {
  try {
    const all = [];
    const fetchedWallets = new Set();
    // Deduplicate: validator shares researcher's wallet, so only fetch once
    await Promise.all(allAgents().map(async ({ name, agent }) => {
      if (fetchedWallets.has(agent.walletAddress)) return;
      fetchedWallets.add(agent.walletAddress);
      try {
        const result = await agent.locus.getTransactions();
        const txns = result.data?.data?.transactions || result.data?.transactions || [];
        txns.forEach(tx => { tx._agent = name; all.push(tx); });
      } catch (err) {
        console.warn(`Failed to fetch ${name} transactions:`, err.message);
      }
    }));
    all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ transactions: all });
  } catch (err) {
    console.error('Transaction fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch transactions.' });
  }
});

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  const staticRoot = fs.existsSync(outDir) ? outDir : publicDir;
  res.sendFile(path.join(staticRoot, 'index.html'));
});

// ── Centralized Error Handler ─────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── Start ────────────────────────────────────────────────────────

try {
  initAgents();
} catch (err) {
  console.warn('Agent init failed:', err.message);
}

app.listen(SYSTEM.port, () => {
  console.log(`Dispatch running on http://localhost:${SYSTEM.port}`);
});
