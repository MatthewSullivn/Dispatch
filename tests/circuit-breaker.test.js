/**
 * Unit tests for the Locus API circuit breaker.
 *
 * Tests the closed → open → half-open → closed state transitions.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// We need to test the CircuitBreaker class from locus.js
// Since it's not exported directly, we test it through LocusClient behavior
process.env.ORCHESTRATOR_LOCUS_API_KEY = 'test-key';
process.env.ORCHESTRATOR_WALLET_ADDRESS = '0xORCH';
process.env.RESEARCHER_LOCUS_API_KEY = 'test-key';
process.env.RESEARCHER_WALLET_ADDRESS = '0xRES';

const { LocusClient } = require('../src/locus');

describe('Circuit Breaker', () => {
  let client;

  beforeEach(() => {
    client = new LocusClient('test-key', false);
  });

  it('should start in closed state', () => {
    assert.equal(client.breaker.state, 'closed');
    assert.equal(client.breaker.failures, 0);
    assert.ok(client.breaker.canRequest());
  });

  it('should allow requests when closed', () => {
    assert.ok(client.breaker.canRequest());
  });

  it('should count failures without tripping below threshold', () => {
    client.breaker.onFailure();
    client.breaker.onFailure();
    client.breaker.onFailure();
    assert.equal(client.breaker.failures, 3);
    assert.equal(client.breaker.state, 'closed');
    assert.ok(client.breaker.canRequest());
  });

  it('should trip open after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      client.breaker.onFailure();
    }
    assert.equal(client.breaker.state, 'open');
    assert.ok(!client.breaker.canRequest());
  });

  it('should reset on success', () => {
    client.breaker.onFailure();
    client.breaker.onFailure();
    client.breaker.onFailure();
    client.breaker.onSuccess();
    assert.equal(client.breaker.failures, 0);
    assert.equal(client.breaker.state, 'closed');
  });

  it('should transition to half-open after reset timeout', () => {
    for (let i = 0; i < 5; i++) {
      client.breaker.onFailure();
    }
    assert.equal(client.breaker.state, 'open');
    // Simulate time passing beyond reset window
    client.breaker.openedAt = Date.now() - 31000;
    assert.ok(client.breaker.canRequest());
    assert.equal(client.breaker.state, 'half-open');
  });

  it('should close from half-open on success', () => {
    for (let i = 0; i < 5; i++) {
      client.breaker.onFailure();
    }
    client.breaker.openedAt = Date.now() - 31000;
    client.breaker.canRequest(); // transitions to half-open
    client.breaker.onSuccess();
    assert.equal(client.breaker.state, 'closed');
    assert.equal(client.breaker.failures, 0);
  });
});
