require('dotenv').config();
const express = require('express');
const path = require('path');
const OrchestratorAgent = require('./agents/orchestrator');
const ResearchAgent = require('./agents/research-agent');
const WriterAgent = require('./agents/writer-agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Agent Initialization ---

let orchestrator, researcher, writer;

function initAgents() {
  orchestrator = new OrchestratorAgent({
    name: 'MeshOrchestrator',
    locusApiKey: process.env.ORCHESTRATOR_LOCUS_API_KEY,
    walletAddress: process.env.ORCHESTRATOR_WALLET_ADDRESS,
  });

  researcher = new ResearchAgent({
    name: 'MeshResearcher',
    locusApiKey: process.env.RESEARCHER_LOCUS_API_KEY,
    walletAddress: process.env.RESEARCHER_WALLET_ADDRESS,
  });

  writer = new WriterAgent({
    name: 'MeshWriter',
    locusApiKey: process.env.WRITER_LOCUS_API_KEY,
    walletAddress: process.env.WRITER_WALLET_ADDRESS,
  });

  orchestrator.registerWorker(researcher);
  orchestrator.registerWorker(writer);
  orchestrator.setBudget(5.0, 1.0);

  console.log('Agents initialized:');
  console.log(`  Orchestrator: ${process.env.ORCHESTRATOR_WALLET_ADDRESS}`);
  console.log(`  Researcher:   ${process.env.RESEARCHER_WALLET_ADDRESS}`);
  console.log(`  Writer:       ${process.env.WRITER_WALLET_ADDRESS}`);
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
  });
});

// Submit a goal — streams progress events via SSE
app.post('/api/goal', async (req, res) => {
  const { goal, budget, maxPerTask } = req.body;

  if (!goal) {
    return res.status(400).json({ error: 'goal is required' });
  }

  if (budget || maxPerTask) {
    orchestrator.setBudget(
      budget || orchestrator.budget.total,
      maxPerTask || orchestrator.budget.perTask
    );
  }

  try {
    const results = await orchestrator.executeGoal(goal);
    res.json({
      success: true,
      goal,
      report: results.report,
      audit: results.audit,
    });
  } catch (err) {
    console.error('Goal execution failed:', err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/agents', (req, res) => {
  res.json({
    agents: [
      { name: orchestrator?.name, role: 'orchestrator', wallet: orchestrator?.walletAddress },
      { name: researcher?.name, role: 'researcher', wallet: researcher?.walletAddress },
      { name: writer?.name, role: 'writer', wallet: writer?.walletAddress },
    ],
  });
});

app.get('/api/transactions', async (req, res) => {
  try {
    const txns = await orchestrator.locus.getTransactions();
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const apis = await orchestrator.locus.listWrappedAPIs();
    res.json(apis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---

const PORT = process.env.PORT || 3000;

try {
  initAgents();
} catch (err) {
  console.warn('Agent init failed (run setup first?):', err.message);
}

app.listen(PORT, () => {
  console.log(`Agent Mesh running on http://localhost:${PORT}`);
});
