/**
 * Unit tests for the Orchestrator agent.
 *
 * Uses Node's built-in test runner (node --test).
 * Tests budget management, subtask planning, agent discovery,
 * and the payment lifecycle with mock workers.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock environment before requiring config
process.env.ORCHESTRATOR_LOCUS_API_KEY = 'test-orch-key';
process.env.ORCHESTRATOR_WALLET_ADDRESS = '0xORCH';
process.env.RESEARCHER_LOCUS_API_KEY = 'test-res-key';
process.env.RESEARCHER_WALLET_ADDRESS = '0xRES';
process.env.WRITER_LOCUS_API_KEY = 'test-wri-key';
process.env.WRITER_WALLET_ADDRESS = '0xWRI';
process.env.VALIDATOR_LOCUS_API_KEY = 'test-val-key';
process.env.VALIDATOR_WALLET_ADDRESS = '0xVAL';

const OrchestratorAgent = require('../src/agents/orchestrator');
const ServiceRegistry = require('../src/registry');
const EscrowManager = require('../src/escrow');

/** Create a mock worker agent with controllable behavior. */
function createMockWorker(role, name, wallet) {
  return {
    id: `mock-${role}`,
    name,
    role,
    walletAddress: wallet,
    agentEmail: `${role}@test.com`,
    locus: {
      getBalance: async () => ({ status: 'success', data: { usdc_balance: '10.00' } }),
      getTransactions: async () => ({ status: 'success', data: { transactions: [] } }),
      checkoutPreflight: async () => ({ status: 'success', data: { canPay: true } }),
    },
    taskLog: [],
    research: async (query) => ({
      query,
      scrapedData: 'Mock scraped data',
      searchResults: 'Mock search results',
      supplementaryResults: null,
      timestamp: new Date().toISOString(),
    }),
    validate: async (findings) => ({
      validated: true,
      report: 'All findings verified.',
      provider: 'mock',
      sourcesChecked: findings.length,
      timestamp: new Date().toISOString(),
    }),
    synthesize: async (findings) => ({
      report: 'Mock synthesized report based on ' + findings.length + ' sources.',
      format: 'report',
      provider: 'mock',
      sourcesUsed: findings.length,
      timestamp: new Date().toISOString(),
    }),
    registerService: (registry, def) => registry.register(name, wallet, 'test-key', def),
    getAuditTrail: () => ({ agentId: `mock-${role}`, agentName: name, role, wallet, log: [] }),
    log: () => {},
  };
}

describe('OrchestratorAgent', () => {
  let orchestrator, registry, escrowManager, researcher, writer, validator;

  beforeEach(() => {
    registry = new ServiceRegistry();
    escrowManager = new EscrowManager();

    orchestrator = new OrchestratorAgent({
      name: 'TestOrchestrator',
      locusApiKey: 'test-orch-key',
      walletAddress: '0xORCH',
      registry,
      escrowManager,
    });

    // Mock the orchestrator's Locus client
    orchestrator.locus = {
      getBalance: async () => ({ status: 'success', data: { usdc_balance: '10.00' } }),
      sendPayment: async () => ({ status: 'success', data: { tx_hash: '0xABC' } }),
      sendEmailEscrow: async () => ({ status: 'success', data: {} }),
      createCheckoutSession: async () => ({ status: 'success', data: { id: 'session-1', checkoutUrl: 'https://example.com' } }),
      checkoutPay: async () => ({ status: 'success', data: {} }),
    };

    researcher = createMockWorker('researcher', 'MockResearcher', '0xRES');
    writer = createMockWorker('writer', 'MockWriter', '0xWRI');
    validator = createMockWorker('validator', 'MockValidator', '0xVAL');

    orchestrator.registerWorker(researcher);
    orchestrator.registerWorker(writer);
    orchestrator.registerWorker(validator);

    // Register services
    researcher.registerService(registry, {
      name: 'Web Research',
      description: 'Search and scrape',
      price: 0.05,
      capabilities: ['research'],
    });
    writer.registerService(registry, {
      name: 'Report Synthesis',
      description: 'Write reports',
      price: 0.05,
      capabilities: ['writing'],
    });
    validator.registerService(registry, {
      name: 'Fact Checking',
      description: 'Validate research',
      price: 0.03,
      capabilities: ['validation'],
    });
  });

  describe('setBudget', () => {
    it('should set budget correctly', () => {
      orchestrator.setBudget(5.0, 1.0);
      assert.equal(orchestrator.budget.total, 5.0);
      assert.equal(orchestrator.budget.perTask, 1.0);
      assert.equal(orchestrator.budget.spent, 0);
    });

    it('should reset spent on new budget', () => {
      orchestrator.budget.spent = 2.0;
      orchestrator.setBudget(10.0, 2.0);
      assert.equal(orchestrator.budget.spent, 0);
    });
  });

  describe('registerWorker', () => {
    it('should register workers by role', () => {
      assert.equal(orchestrator.workers.size, 3);
      assert.ok(orchestrator.workers.has('researcher'));
      assert.ok(orchestrator.workers.has('writer'));
      assert.ok(orchestrator.workers.has('validator'));
    });
  });

  describe('_planSubtasks', () => {
    it('should plan 3 subtasks: research, validate, write', () => {
      orchestrator.setBudget(5.0, 1.0);
      const tasks = orchestrator._planSubtasks('Test goal');
      assert.equal(tasks.length, 3);
      assert.equal(tasks[0].type, 'research');
      assert.equal(tasks[1].type, 'validate');
      assert.equal(tasks[2].type, 'write');
    });

    it('should use registry prices when available', () => {
      orchestrator.setBudget(5.0, 1.0);
      const tasks = orchestrator._planSubtasks('Test goal');
      assert.equal(tasks[0].payment, 0.05); // from registry
      assert.equal(tasks[2].payment, 0.05); // from registry
    });

    it('should include goal in task descriptions', () => {
      orchestrator.setBudget(5.0, 1.0);
      const tasks = orchestrator._planSubtasks('DeFi analysis');
      assert.ok(tasks[0].description.includes('DeFi analysis'));
      assert.ok(tasks[2].description.includes('DeFi analysis'));
    });
  });

  describe('_findAgent', () => {
    it('should find researcher via registry', () => {
      const agent = orchestrator._findAgent('research');
      assert.equal(agent.name, 'MockResearcher');
    });

    it('should find writer via registry', () => {
      const agent = orchestrator._findAgent('write');
      assert.equal(agent.name, 'MockWriter');
    });

    it('should find validator via registry', () => {
      const agent = orchestrator._findAgent('validate');
      assert.equal(agent.name, 'MockValidator');
    });

    it('should fall back to role map if not in registry', () => {
      orchestrator.registry = null;
      const agent = orchestrator._findAgent('research');
      assert.equal(agent.name, 'MockResearcher');
    });
  });

  describe('executeGoal', () => {
    it('should execute a full goal pipeline', async () => {
      orchestrator.setBudget(5.0, 1.0);
      const result = await orchestrator.executeGoal('Test DeFi analysis');

      assert.ok(result.report);
      assert.ok(result.audit);
      assert.ok(result.validation);
      assert.equal(result.audit.summary.totalTasks, 3);
    });

    it('should track budget spending', async () => {
      orchestrator.setBudget(5.0, 1.0);
      await orchestrator.executeGoal('Budget test');

      assert.ok(orchestrator.budget.spent > 0);
      assert.ok(orchestrator.budget.spent <= orchestrator.budget.total);
    });

    it('should skip tasks when budget exceeded', async () => {
      orchestrator.setBudget(0.04, 0.04); // Only enough for 1 task
      const result = await orchestrator.executeGoal('Low budget test');

      const skipped = orchestrator.tasks.filter(t => t.status === 'skipped_budget');
      assert.ok(skipped.length > 0, 'Should have skipped at least one task');
    });

    it('should generate complete audit trail', async () => {
      orchestrator.setBudget(5.0, 1.0);
      const result = await orchestrator.executeGoal('Audit test');

      assert.ok(result.audit.orchestrator);
      assert.ok(result.audit.workers);
      assert.ok(result.audit.budget);
      assert.ok(result.audit.summary);
      assert.equal(typeof result.audit.summary.totalSpent, 'number');
      assert.equal(typeof result.audit.summary.remainingBudget, 'number');
    });
  });
});
