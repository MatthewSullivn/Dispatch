require('dotenv').config();
const express = require('express');
const path = require('path');
const meshEvents = require('./event-bus');
const ServiceRegistry = require('./registry');
const EscrowManager = require('./escrow');
const OrchestratorAgent = require('./agents/orchestrator');
const ResearchAgent = require('./agents/research-agent');
const WriterAgent = require('./agents/writer-agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Core State ---

const registry = new ServiceRegistry();
const escrowManager = new EscrowManager();
const pendingApprovals = [];
const masterTimeline = [];

// Capture all events into timeline
meshEvents.on('agent-event', (event) => {
  masterTimeline.push(event);
  // Keep last 500 events
  if (masterTimeline.length > 500) masterTimeline.shift();
});

// SSE clients
const sseClients = new Set();

meshEvents.on('agent-event', (event) => {
  const data = JSON.stringify(event);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
});

// Approval handler
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

// --- Agent Initialization ---

let orchestrator, researcher, writer;

function initAgents() {
  researcher = new ResearchAgent({
    name: 'MeshResearcher',
    locusApiKey: process.env.RESEARCHER_LOCUS_API_KEY,
    walletAddress: process.env.RESEARCHER_WALLET_ADDRESS,
    onApprovalNeeded,
  });

  writer = new WriterAgent({
    name: 'MeshWriter',
    locusApiKey: process.env.WRITER_LOCUS_API_KEY,
    walletAddress: process.env.WRITER_WALLET_ADDRESS,
    onApprovalNeeded,
  });

  orchestrator = new OrchestratorAgent({
    name: 'MeshOrchestrator',
    locusApiKey: process.env.ORCHESTRATOR_LOCUS_API_KEY,
    walletAddress: process.env.ORCHESTRATOR_WALLET_ADDRESS,
    onApprovalNeeded,
    registry,
    escrowManager,
  });

  orchestrator.registerWorker(researcher);
  orchestrator.registerWorker(writer);
  orchestrator.setBudget(5.0, 1.0);

  // Register services in the marketplace
  researcher.registerService(registry, {
    name: 'Web Research',
    description: 'Search the web, scrape websites, and gather data using Exa, Firecrawl, and Grok via Locus wrapped APIs',
    price: 0.05,
    capabilities: ['research', 'search', 'scrape', 'data-gathering'],
  });

  writer.registerService(registry, {
    name: 'Report Synthesis',
    description: 'Synthesize research findings into professional reports using Gemini or Grok LLMs via Locus wrapped APIs',
    price: 0.05,
    capabilities: ['writing', 'synthesis', 'report', 'summarization'],
  });

  console.log('Agents initialized:');
  console.log(`  Orchestrator: ${process.env.ORCHESTRATOR_WALLET_ADDRESS}`);
  console.log(`  Researcher:   ${process.env.RESEARCHER_WALLET_ADDRESS}`);
  console.log(`  Writer:       ${process.env.WRITER_WALLET_ADDRESS}`);
  console.log(`  Services:     ${registry.getAll().length} registered`);
}

// --- API Routes ---

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

// Rate limiting for goal submissions
let lastGoalTime = 0;
let goalCount = 0;
const GOAL_COOLDOWN_MS = 30000; // 30 seconds between goals
const MAX_GOALS_PER_HOUR = 10;
const goalHourWindow = [];

// Submit a goal
app.post('/api/goal', async (req, res) => {
  const { goal, budget, maxPerTask } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  // Rate limit: 30s cooldown
  const now = Date.now();
  if (now - lastGoalTime < GOAL_COOLDOWN_MS) {
    const wait = Math.ceil((GOAL_COOLDOWN_MS - (now - lastGoalTime)) / 1000);
    return res.status(429).json({ error: `Rate limited. Try again in ${wait}s.` });
  }

  // Rate limit: max per hour
  const oneHourAgo = now - 3600000;
  while (goalHourWindow.length && goalHourWindow[0] < oneHourAgo) goalHourWindow.shift();
  if (goalHourWindow.length >= MAX_GOALS_PER_HOUR) {
    return res.status(429).json({ error: 'Rate limited. Max 10 goals per hour.' });
  }

  lastGoalTime = now;
  goalHourWindow.push(now);

  // Cap budget to prevent abuse
  const safeBudget = Math.min(budget || orchestrator.budget.total, 1.0);
  const safePerTask = Math.min(maxPerTask || orchestrator.budget.perTask, 0.25);
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

// Balances
app.get('/api/balances', async (req, res) => {
  const balances = {};
  const agents = [
    { name: 'orchestrator', agent: orchestrator },
    { name: 'researcher', agent: researcher },
    { name: 'writer', agent: writer },
  ];

  await Promise.all(agents.map(async ({ name, agent }) => {
    try {
      const bal = await agent.getBalance();
      balances[name] = bal.data?.data || bal.data;
    } catch (err) {
      balances[name] = { error: err.message };
    }
  }));

  res.json({ balances });
});

// Service Registry
app.get('/api/registry', (req, res) => {
  res.json({ services: registry.getAll() });
});

app.get('/api/registry/discover', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  res.json({ results: registry.discover(q) });
});

// Escrow
app.get('/api/escrows', (req, res) => {
  res.json({ escrows: escrowManager.getAll() });
});

// Approvals
app.get('/api/approvals', (req, res) => {
  res.json({ approvals: pendingApprovals });
});

// Timeline
app.get('/api/timeline', (req, res) => {
  res.json({ events: masterTimeline });
});

// SSE stream
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

// Webhook for checkout status changes
app.post('/api/webhooks/checkout', (req, res) => {
  console.log('Checkout webhook:', req.body);
  meshEvents.emit('agent-event', {
    timestamp: new Date().toISOString(),
    agent: 'locus',
    action: 'checkout_webhook',
    type: 'escrow',
    data: req.body,
  });
  res.json({ received: true });
});

// Audit trail
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

// Reasoning log — agent decision-making alongside transactions
app.get('/api/reasoning', (req, res) => {
  const reasoningEvents = masterTimeline.filter(e =>
    e.reasoning || ['subtasks_planned', 'agent_discovered', 'dispatching_task',
      'budget_exceeded', 'payment_initiated', 'payment_completed', 'escrow_created',
      'escrow_released', 'goal_received', 'goal_completed'].includes(e.action)
  );
  res.json({ reasoning: reasoningEvents });
});

// Agent info
app.get('/api/agents', (req, res) => {
  res.json({
    agents: [
      { name: orchestrator?.name, role: 'orchestrator', wallet: orchestrator?.walletAddress },
      { name: researcher?.name, role: 'researcher', wallet: researcher?.walletAddress },
      { name: writer?.name, role: 'writer', wallet: writer?.walletAddress },
    ],
  });
});

// Transactions from all agents
app.get('/api/transactions', async (req, res) => {
  try {
    const agents = [
      { name: 'orchestrator', agent: orchestrator },
      { name: 'researcher', agent: researcher },
      { name: 'writer', agent: writer },
    ];
    const all = [];
    await Promise.all(agents.map(async ({ name, agent }) => {
      try {
        const result = await agent.locus.getTransactions();
        const txns = result.data?.data?.transactions || result.data?.transactions || [];
        txns.forEach(tx => { tx._agent = name; all.push(tx); });
      } catch (err) {
        console.warn(`Failed to fetch ${name} transactions:`, err.message);
      }
    }));
    // Sort by date descending
    all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ transactions: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---

const PORT = process.env.PORT || 3000;

try {
  initAgents();
} catch (err) {
  console.warn('Agent init failed:', err.message);
}

app.listen(PORT, () => {
  console.log(`Agent Mesh running on http://localhost:${PORT}`);
});
