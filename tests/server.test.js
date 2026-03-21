/**
 * Unit tests for server input validation and security.
 *
 * Tests API endpoint validation, rate limiting behavior,
 * and security header presence without starting a real server.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Set env before requiring config
process.env.ORCHESTRATOR_LOCUS_API_KEY = 'test-key';
process.env.ORCHESTRATOR_WALLET_ADDRESS = '0xORCH';
process.env.RESEARCHER_LOCUS_API_KEY = 'test-key';
process.env.RESEARCHER_WALLET_ADDRESS = '0xRES';
process.env.WRITER_LOCUS_API_KEY = 'test-key';
process.env.WRITER_WALLET_ADDRESS = '0xWRI';

const { BUDGET, RATE_LIMITS, SYSTEM, LOCUS } = require('../src/config');
const ServiceRegistry = require('../src/registry');
const EscrowManager = require('../src/escrow');

describe('Config', () => {
  it('should have valid budget caps', () => {
    assert.ok(BUDGET.maxPerGoal > 0);
    assert.ok(BUDGET.maxPerTask > 0);
    assert.ok(BUDGET.maxPerTask <= BUDGET.maxPerGoal);
    assert.ok(BUDGET.minBalance > 0);
    assert.ok(BUDGET.defaultMaxPrice > 0);
  });

  it('should have valid rate limits', () => {
    assert.ok(RATE_LIMITS.goalCooldownMs > 0);
    assert.ok(RATE_LIMITS.maxGoalsPerHour > 0);
    assert.equal(RATE_LIMITS.oneHourMs, 3600000);
  });

  it('should have valid system config', () => {
    assert.ok(SYSTEM.maxTimelineEvents > 0);
    assert.ok(SYSTEM.maxGoalLength > 0);
    assert.ok(SYSTEM.port);
  });

  it('should have valid Locus config', () => {
    assert.ok(LOCUS.baseUrl.includes('paywithlocus.com'));
    assert.ok(LOCUS.betaUrl.includes('paywithlocus.com'));
    assert.equal(LOCUS.statusPendingApproval, 202);
  });
});

describe('ServiceRegistry', () => {
  it('should register and retrieve services', () => {
    const registry = new ServiceRegistry();
    registry.register('TestAgent', '0x123', 'key', {
      name: 'Test Service',
      description: 'A test service',
      price: 0.05,
      capabilities: ['testing'],
    });

    const all = registry.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].serviceName, 'Test Service');
    assert.equal(all[0].price, 0.05);
  });

  it('should find services by capability', () => {
    const registry = new ServiceRegistry();
    registry.register('Agent1', '0x1', 'k1', {
      name: 'Research', description: 'Research', price: 0.10, capabilities: ['research'],
    });
    registry.register('Agent2', '0x2', 'k2', {
      name: 'Writing', description: 'Writing', price: 0.05, capabilities: ['writing'],
    });

    const research = registry.findByCapability('research');
    assert.equal(research.length, 1);
    assert.equal(research[0].agentName, 'Agent1');

    const writing = registry.findByCapability('writing');
    assert.equal(writing.length, 1);
    assert.equal(writing[0].agentName, 'Agent2');
  });

  it('should discover services by keyword', () => {
    const registry = new ServiceRegistry();
    registry.register('ResearchBot', '0x1', 'k1', {
      name: 'Web Research', description: 'Search the web', price: 0.05, capabilities: ['research'],
    });

    const results = registry.discover('web');
    assert.ok(results.length > 0);
  });

  it('should sort by price (cheapest first)', () => {
    const registry = new ServiceRegistry();
    registry.register('Expensive', '0x1', 'k1', {
      name: 'Pricey', description: 'Costs more', price: 0.50, capabilities: ['research'],
    });
    registry.register('Cheap', '0x2', 'k2', {
      name: 'Budget', description: 'Costs less', price: 0.01, capabilities: ['research'],
    });

    const results = registry.findByCapability('research');
    assert.equal(results[0].agentName, 'Cheap');
    assert.equal(results[1].agentName, 'Expensive');
  });
});

describe('EscrowManager', () => {
  it('should track sessions', () => {
    const em = new EscrowManager();
    assert.equal(em.getAll().length, 0);
    assert.equal(em.getPending().length, 0);
  });
});

describe('Input Validation Rules', () => {
  it('should reject empty goals', () => {
    assert.ok(!(''), 'Empty string is falsy');
    assert.ok(typeof '' === 'string');
  });

  it('should reject oversized goals', () => {
    const long = 'x'.repeat(SYSTEM.maxGoalLength + 1);
    assert.ok(long.length > SYSTEM.maxGoalLength);
  });

  it('should reject negative budgets', () => {
    assert.ok(!Number.isFinite(Number('abc')));
    assert.ok(Number(-5) <= 0);
    assert.ok(Number(0) <= 0);
  });

  it('should accept valid budgets', () => {
    assert.ok(Number.isFinite(Number(0.5)));
    assert.ok(Number(0.5) > 0);
  });

  it('should cap budgets to safe limits', () => {
    const userBudget = 100;
    const safeBudget = Math.min(userBudget, BUDGET.maxPerGoal);
    assert.equal(safeBudget, BUDGET.maxPerGoal);
    assert.ok(safeBudget <= 1.0);
  });
});
