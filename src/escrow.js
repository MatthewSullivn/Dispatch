const meshEvents = require('./event-bus');

class EscrowManager {
  constructor() {
    this.sessions = new Map();
  }

  async createEscrow(locusClient, { amount, description, buyerAgent, sellerAgent, webhookUrl, metadata = {} }) {
    const event = {
      timestamp: new Date().toISOString(),
      agent: buyerAgent,
      action: 'escrow_creating',
      type: 'escrow',
      amount,
      description,
      seller: sellerAgent,
    };
    meshEvents.emit('agent-event', event);

    try {
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
        status: 'pending',
        amount,
        description,
        buyerAgent,
        sellerAgent,
        createdAt: new Date().toISOString(),
        rawData: sessionData,
      };
      if (sessionId) this.sessions.set(sessionId, session);

      meshEvents.emit('agent-event', {
        timestamp: session.createdAt,
        agent: buyerAgent,
        action: 'escrow_created',
        type: 'escrow',
        sessionId,
        amount,
        seller: sellerAgent,
      });

      return session;
    } catch (err) {
      meshEvents.emit('agent-event', {
        timestamp: new Date().toISOString(),
        agent: buyerAgent,
        action: 'escrow_failed',
        type: 'escrow',
        error: err.message,
        amount,
      });
      throw err;
    }
  }

  async preflight(locusClient, sessionId) {
    const session = this.sessions.get(sessionId);
    try {
      const result = await locusClient.checkoutPreflight(sessionId);
      if (session) session.status = 'preflight_ok';

      meshEvents.emit('agent-event', {
        timestamp: new Date().toISOString(),
        agent: session?.sellerAgent || 'unknown',
        action: 'escrow_preflight',
        type: 'escrow',
        sessionId,
        status: 'ok',
      });

      return result;
    } catch (err) {
      if (session) session.status = 'preflight_failed';
      throw err;
    }
  }

  async releasePayment(locusClient, sessionId) {
    const session = this.sessions.get(sessionId);

    meshEvents.emit('agent-event', {
      timestamp: new Date().toISOString(),
      agent: session?.buyerAgent || 'unknown',
      action: 'escrow_releasing',
      type: 'escrow',
      sessionId,
      amount: session?.amount,
    });

    try {
      const result = await locusClient.checkoutPay(sessionId);
      if (session) {
        session.status = 'released';
        session.paidAt = new Date().toISOString();
      }

      meshEvents.emit('agent-event', {
        timestamp: new Date().toISOString(),
        agent: session?.buyerAgent || 'unknown',
        action: 'escrow_released',
        type: 'escrow',
        sessionId,
        amount: session?.amount,
        seller: session?.sellerAgent,
      });

      return result;
    } catch (err) {
      if (session) session.status = 'release_failed';

      meshEvents.emit('agent-event', {
        timestamp: new Date().toISOString(),
        agent: session?.buyerAgent || 'unknown',
        action: 'escrow_release_failed',
        type: 'escrow',
        sessionId,
        error: err.message,
      });
      throw err;
    }
  }

  getAll() {
    return Array.from(this.sessions.values());
  }

  getPending() {
    return this.getAll().filter(s => s.status === 'pending' || s.status === 'preflight_ok');
  }
}

module.exports = EscrowManager;
