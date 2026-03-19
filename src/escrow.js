const meshEvents = require('./event-bus');

class EscrowManager {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Full escrow flow:
   * 1. Orchestrator creates checkout session (holds funds description)
   * 2. Worker agent does preflight (verifies session is valid)
   * 3. After work is done, orchestrator releases payment (agent/pay)
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

    // Create checkout session — no webhook for localhost (causes 500)
    // Only pass webhookUrl if we have a deployed HTTPS URL
    const deployedUrl = process.env.DEPLOYED_URL;
    const webhookUrl = deployedUrl && deployedUrl.startsWith('https')
      ? `${deployedUrl}/api/webhooks/checkout`
      : undefined;

    const body = {
      amount: String(amount),
      description,
      metadata: { ...metadata, buyerAgent, sellerAgent },
    };
    if (webhookUrl) body.webhookUrl = webhookUrl;

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

  getAll() {
    return Array.from(this.sessions.values());
  }

  getPending() {
    return this.getAll().filter(s => s.status === 'pending' || s.status === 'preflight_ok');
  }
}

module.exports = EscrowManager;
