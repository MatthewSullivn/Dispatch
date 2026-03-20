/**
 * Base agent class for Dispatch.
 *
 * Every agent (orchestrator, researcher, writer) extends BaseAgent.
 * Provides core capabilities:
 *   - Locus wallet integration (balance, payments, email escrow)
 *   - Pay-per-use wrapped API calls (billed to agent's wallet)
 *   - Service registration in the marketplace
 *   - Structured audit trail logging with event bus emission
 */
const { LocusClient } = require('../locus');
const { v4: uuidv4 } = require('uuid');
const meshEvents = require('../event-bus');

const LOG_DETAIL_LIMIT = 200;

class BaseAgent {
  /**
   * @param {object} config
   * @param {string} config.name - Agent display name
   * @param {string} config.role - Agent role (orchestrator, researcher, writer)
   * @param {string} config.locusApiKey - Locus API key for this agent's wallet
   * @param {string} config.walletAddress - Agent's wallet address on Base
   * @param {function} [config.onApprovalNeeded] - Callback when payment exceeds spending threshold
   */
  constructor({ name, role, locusApiKey, walletAddress, onApprovalNeeded }) {
    this.id = uuidv4();
    this.name = name;
    this.role = role;
    this.locus = new LocusClient(locusApiKey);
    this.locusApiKey = locusApiKey;
    this.walletAddress = walletAddress;
    this.agentEmail = null;
    this.onApprovalNeeded = onApprovalNeeded || null;
    this.taskLog = [];
  }

  /**
   * Log an action to the audit trail and emit it on the global event bus.
   * All agent activity flows through this method for full auditability.
   * @param {string} action - Action identifier (e.g. 'payment_initiated', 'api_call')
   * @param {object} details - Structured details about the action
   */
  log(action, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      agent: this.name,
      role: this.role,
      action,
      ...details,
    };
    this.taskLog.push(entry);
    meshEvents.emit('agent-event', entry);
    console.log(`[${this.name}] ${action}`, JSON.stringify(details).slice(0, LOG_DETAIL_LIMIT));
    return entry;
  }

  /** Get USDC balance for this agent's Locus wallet. */
  async getBalance() {
    return this.locus.getBalance();
  }

  /**
   * Send USDC payment to another agent's wallet.
   * Handles three outcomes: success, auto-approved (202 without URL),
   * or pending human approval (202 with approval URL).
   * @param {string} recipientAddress - Destination wallet on Base
   * @param {number} amount - USDC amount
   * @param {string} taskDescription - Why this payment is being made
   */
  async payAgent(recipientAddress, amount, taskDescription) {
    this.log('payment_initiated', {
      type: 'payment',
      to: recipientAddress,
      amount,
      task: taskDescription,
    });

    const result = await this.locus.sendPayment(
      recipientAddress,
      amount,
      `Payment for: ${taskDescription}`
    );

    if (result.status === 'pending_approval') {
      this._handlePendingApproval(result, recipientAddress, amount, taskDescription);
    } else {
      this.log('payment_completed', {
        type: 'payment',
        amount,
        to: recipientAddress,
        result: result.data?.data || result.data,
      });
    }

    return result;
  }

  /**
   * Handle 202 response from Locus spending controls.
   * If an approval URL is present, the payment needs human review.
   * Otherwise, Locus auto-approved it under the threshold.
   * @private
   */
  _handlePendingApproval(result, recipientAddress, amount, taskDescription) {
    const approvalUrl = result.data?.approval_url || result.data?.data?.approval_url;

    if (approvalUrl) {
      this.log('payment_pending_approval', {
        type: 'approval',
        approvalUrl,
        amount,
        task: taskDescription,
      });
      if (this.onApprovalNeeded) {
        this.onApprovalNeeded({
          agent: this.name,
          amount,
          task: taskDescription,
          approvalUrl,
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      // Locus beta returns 202 but auto-approves payments under the threshold
      this.log('payment_sent', {
        type: 'payment',
        amount,
        to: recipientAddress,
        result: result.data?.data || result.data,
      });
    }
  }

  /**
   * Send USDC via email escrow as a fallback payment method.
   * Recipient claims funds through an email link.
   * @param {string} email - Recipient email address
   * @param {number} amount - USDC amount
   * @param {string} taskDescription - Why this payment is being made
   */
  async payAgentViaEmail(email, amount, taskDescription) {
    this.log('email_escrow_initiated', {
      type: 'payment',
      to: email,
      amount,
      task: taskDescription,
      reasoning: 'Using email escrow as alternative payment rail. Recipient can claim USDC via email link.',
    });

    const result = await this.locus.sendEmailEscrow(
      email,
      amount,
      `Dispatch payment: ${taskDescription}`
    );

    this.log('email_escrow_sent', {
      type: 'payment',
      amount,
      to: email,
      result: result.data?.data || result.data,
    });

    return result;
  }

  /**
   * Call a wrapped API through Locus's pay-per-use proxy.
   * The API call cost is billed in USDC to this agent's wallet.
   * @param {string} provider - API provider (exa, firecrawl, gemini, grok)
   * @param {string} endpoint - Provider endpoint (search, chat, scrape)
   * @param {object} params - Request parameters
   */
  async callAPI(provider, endpoint, params) {
    this.log('api_call', { type: 'api', provider, endpoint });

    const result = await this.locus.callWrappedAPI(provider, endpoint, params);
    this.log('api_call_completed', {
      type: 'api',
      provider,
      endpoint,
      success: result.status === 'success',
    });

    return result;
  }

  /**
   * Register this agent's service in the marketplace registry.
   * @param {ServiceRegistry} registry - The service registry instance
   * @param {object} serviceDef - Service definition (name, description, price, capabilities)
   */
  registerService(registry, serviceDef) {
    return registry.register(this.name, this.walletAddress, this.locusApiKey, serviceDef);
  }

  /**
   * Get the full audit trail for this agent.
   * Returns agent identity and complete log of all actions taken.
   */
  getAuditTrail() {
    return {
      agentId: this.id,
      agentName: this.name,
      role: this.role,
      wallet: this.walletAddress,
      log: this.taskLog,
    };
  }
}

module.exports = BaseAgent;
