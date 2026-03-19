/**
 * Agent Mesh — Express server and API routes.
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

// Actions that carry decision-making context for the reasoning log
const REASONING_ACTIONS = new Set([
  'subtasks_planned', 'agent_discovered', 'dispatching_task',
  'budget_exceeded', 'payment_initiated', 'payment_completed',
  'escrow_created', 'escrow_released', 'goal_received', 'goal_completed',
]);

// ── App Setup ────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

let orchestrator, researcher, writer;

/**
 * Create agents from config, register workers, and populate the
 * service registry. All agent definitions live in config.js.
 */
function initAgents() {
  const rConf = AGENTS.researcher;
  const wConf = AGENTS.writer;
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
  orchestrator.setBudget(BUDGET.defaultTotal, BUDGET.defaultPerTask);

  // Register services from config
  if (rConf.service) researcher.registerService(registry, rConf.service);
  if (wConf.service) writer.registerService(registry, wConf.service);

  console.log('Agents initialized:');
  console.log(`  Orchestrator: ${oConf.walletAddress}`);
  console.log(`  Researcher:   ${rConf.walletAddress}`);
  console.log(`  Writer:       ${wConf.walletAddress}`);
  console.log(`  Services:     ${registry.getAll().length} registered`);
}

/** Helper: iterate over all agent instances. */
function allAgents() {
  return [
    { name: 'orchestrator', agent: orchestrator },
    { name: 'researcher', agent: researcher },
    { name: 'writer', agent: writer },
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
    },
    services: registry.getAll().length,
    escrows: escrowManager.getAll().length,
    pendingApprovals: pendingApprovals.length,
  });
});

// Rate limiting state
let lastGoalTime = 0;
const goalHourWindow = [];

/** Submit a goal for the mesh to execute. Rate limited and budget-capped. */
app.post('/api/goal', async (req, res) => {
  const { goal, budget, maxPerTask } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal is required' });

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
    res.status(500).json({ error: err.message });
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
      balances[name] = { error: err.message };
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
  res.json({ results: registry.discover(q) });
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

/** Webhook endpoint for Locus checkout session status changes. */
app.post('/api/webhooks/checkout', (req, res) => {
  meshEvents.emit('agent-event', {
    timestamp: new Date().toISOString(),
    agent: 'locus',
    action: 'checkout_webhook',
    type: 'escrow',
    data: req.body,
  });
  res.json({ received: true });
});

/** Complete audit trail for all agents. */
app.get('/api/audit', (req, res) => {
  const workerAudits = {};
  if (researcher) workerAudits.researcher = researcher.getAuditTrail();
  if (writer) workerAudits.writer = writer.getAuditTrail();
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

/** Agent names, roles, and wallet addresses. */
app.get('/api/agents', (req, res) => {
  res.json({
    agents: allAgents().map(({ agent }) => ({
      name: agent?.name,
      role: agent?.role,
      wallet: agent?.walletAddress,
    })),
  });
});

/** On-chain USDC transactions aggregated from all agent wallets. */
app.get('/api/transactions', async (req, res) => {
  try {
    const all = [];
    await Promise.all(allAgents().map(async ({ name, agent }) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────

try {
  initAgents();
} catch (err) {
  console.warn('Agent init failed:', err.message);
}

app.listen(SYSTEM.port, () => {
  console.log(`Agent Mesh running on http://localhost:${SYSTEM.port}`);
});
