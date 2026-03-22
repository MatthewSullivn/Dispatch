/**
 * Escrow manager for Dispatch.
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
const { LOCUS } = require('./config');

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

    const successUrl = deployedUrl ? `${deployedUrl}/?checkout=success` : undefined;
    const cancelUrl = deployedUrl ? `${deployedUrl}/?checkout=cancel` : undefined;

    const result = await locusClient.createCheckoutSession(
      amount,
      description,
      webhookUrl,
      { ...metadata, buyerAgent, sellerAgent },
      {
        enabled: true,
        fields: {
          creditorName: `Dispatch — ${sellerAgent}`,
          lineItems: [{ description, amount: String(amount) }],
          subtotal: String(amount),
          supportEmail: 'dispatch@mesh.ai',
        },
      },
      successUrl,
      cancelUrl
    );

    const sessionData = result.data?.data || result.data;
    const sessionId = sessionData?.id || sessionData?.sessionId || sessionData?.session_id;

    const session = {
      sessionId,
      checkoutUrl: sessionData?.checkoutUrl || sessionData?.checkout_url
        || (sessionId ? `${LOCUS.checkoutUrl}/${sessionId}` : undefined),
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
   * Worker (buyer) pays the checkout session created by the orchestrator (merchant).
   * @param {LocusClient} payerLocusClient - Worker/buyer's Locus client (has funds)
   * @param {string} sessionId - Checkout session to release
   * @param {LocusClient} merchantLocusClient - Orchestrator/merchant's Locus client (for polling)
   */
  async releasePayment(payerLocusClient, sessionId, merchantLocusClient = null) {
    const session = this.sessions.get(sessionId);

    const result = await payerLocusClient.checkoutPay(sessionId);
    const payData = result.data?.data || result.data;
    const txId = payData?.transactionId;

    if (session) {
      session.status = 'released';
      session.paidAt = new Date().toISOString();
    }

    meshEvents.emit('agent-event', {
      timestamp: new Date().toISOString(),
      agent: session?.buyerAgent || 'worker',
      action: 'escrow_released',
      type: 'escrow',
      sessionId,
      amount: session?.amount,
      seller: session?.sellerAgent,
    });

    // Poll for on-chain confirmation (non-blocking best-effort)
    if (txId && merchantLocusClient) {
      this._pollConfirmation(merchantLocusClient, txId, sessionId).catch(() => {});
    }

    return result;
  }

  /**
   * Poll the checkout payment status until confirmed or timeout.
   * Updates the session status when payment is confirmed on-chain.
   * @private
   */
  async _pollConfirmation(sellerLocusClient, txId, sessionId, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const result = await sellerLocusClient.checkoutStatus(txId);
        const data = result.data?.data || result.data;
        if (data?.status === 'confirmed' || data?.status === 'PAID') {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.status = 'paid';
            session.paymentTxHash = data.txHash || data.paymentTxHash;
          }
          meshEvents.emit('agent-event', {
            timestamp: new Date().toISOString(),
            agent: 'locus',
            action: 'checkout_confirmed',
            type: 'escrow',
            sessionId,
            txHash: data.txHash || data.paymentTxHash,
          });
          return;
        }
      } catch { /* seller may not have access, continue */ }
    }
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
