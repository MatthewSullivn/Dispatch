/**
 * Escrow manager for Agent Mesh.
 *
 * Wraps Locus checkout sessions to implement escrow between agents:
 *   1. Orchestrator creates a checkout session (locks funds)
 *   2. Worker agent runs preflight (verifies session is valid)
 *   3. After work is delivered, orchestrator releases payment (agent/pay)
 *
 * If escrow creation fails, the orchestrator falls back to direct
 * wallet-to-wallet payment or email escrow.
 */
const meshEvents = require('./event-bus');

class EscrowManager {
  constructor() {
    /** @type {Map<string, object>} Active escrow sessions by session ID */
    this.sessions = new Map();
  }

  /**
   * Create a checkout session to escrow funds before work begins.
   * @param {LocusClient} locusClient - Buyer's Locus client
   * @param {object} params - Escrow parameters
   * @param {number} params.amount - USDC amount to lock
   * @param {string} params.description - What the escrow is for
   * @param {string} params.buyerAgent - Name of the paying agent
   * @param {string} params.sellerAgent - Name of the receiving agent
   * @param {object} params.metadata - Additional metadata
   * @returns {object} Session with sessionId, status, amount
   */
  async createEscrow(locusClient, { amount, description, buyerAgent, sellerAgent, metadata = {} }) {
    meshEvents.emit('agent-event', {
      timestamp: new Date().toISOString(),
      agent: buyerAgent,
      action: 'escrow_created',
      type: 'escrow',
      amount,
      description,
      seller: sellerAgent,
    });

    // Only pass webhookUrl if we have a deployed HTTPS URL (localhost causes 500)
    const deployedUrl = process.env.DEPLOYED_URL;
    const webhookUrl = deployedUrl && deployedUrl.startsWith('https')
      ? `${deployedUrl}/api/webhooks/checkout`
      : undefined;

    const result = await locusClient.createCheckoutSession(
      amount,
      description,
      webhookUrl,
      { ...metadata, buyerAgent, sellerAgent }
    );

    const sessionData = result.data?.data || result.data;
    const sessionId = sessionData?.id || sessionData?.sessionId || sessionData?.session_id;

    const session = {
      sessionId,
      checkoutUrl: sessionData?.checkoutUrl,
      status: 'pending',
      amount,
      description,
      buyerAgent,
      sellerAgent,
      createdAt: new Date().toISOString(),
    };
    if (sessionId) this.sessions.set(sessionId, session);

    return session;
  }

  /**
   * Worker agent verifies an escrow session via preflight check.
   * Updates the session status to 'preflight_ok' or 'preflight_failed'.
   * @param {LocusClient} workerLocusClient - Worker's Locus client
   * @param {string} sessionId - Checkout session to verify
   */
  async preflight(workerLocusClient, sessionId) {
    const session = this.sessions.get(sessionId);
    const result = await workerLocusClient.checkoutPreflight(sessionId);
    const preflightData = result.data?.data || result.data;

    if (session) {
      session.status = preflightData?.canPay ? 'preflight_ok' : 'preflight_failed';
    }

    meshEvents.emit('agent-event', {
      timestamp: new Date().toISOString(),
      agent: session?.sellerAgent || 'worker',
      action: 'escrow_verified',
      type: 'escrow',
      sessionId,
      canPay: preflightData?.canPay,
      amount: session?.amount,
    });

    return result;
  }

  /**
   * Release escrowed funds after work is delivered.
   * Buyer agent pays out the checkout session.
   * @param {LocusClient} buyerLocusClient - Buyer's Locus client
   * @param {string} sessionId - Checkout session to release
   */
  async releasePayment(buyerLocusClient, sessionId) {
    const session = this.sessions.get(sessionId);

    const result = await buyerLocusClient.checkoutPay(sessionId);
    if (session) {
      session.status = 'released';
      session.paidAt = new Date().toISOString();
    }

    meshEvents.emit('agent-event', {
      timestamp: new Date().toISOString(),
      agent: session?.buyerAgent || 'orchestrator',
      action: 'escrow_released',
      type: 'escrow',
      sessionId,
      amount: session?.amount,
      seller: session?.sellerAgent,
    });

    return result;
  }

  /** Get all escrow sessions. */
  getAll() {
    return Array.from(this.sessions.values());
  }

  /** Get sessions that are still pending or awaiting release. */
  getPending() {
    return this.getAll().filter(s => s.status === 'pending' || s.status === 'preflight_ok');
  }
}

module.exports = EscrowManager;
