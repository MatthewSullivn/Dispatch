const { LocusClient } = require('../locus');
const { v4: uuidv4 } = require('uuid');
const meshEvents = require('../event-bus');

class BaseAgent {
  constructor({ name, role, locusApiKey, walletAddress, onApprovalNeeded }) {
    this.id = uuidv4();
    this.name = name;
    this.role = role;
    this.locus = new LocusClient(locusApiKey);
    this.locusApiKey = locusApiKey;
    this.walletAddress = walletAddress;
    this.agentEmail = null; // Set for email escrow support
    this.onApprovalNeeded = onApprovalNeeded || null;
    this.taskLog = [];
  }

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
    console.log(`[${this.name}] ${action}`, JSON.stringify(details).slice(0, 200));
    return entry;
  }

  async getBalance() {
    const result = await this.locus.getBalance();
    return result;
  }

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
      const approvalUrl = result.data?.approval_url || result.data?.data?.approval_url;
      // Locus beta returns 202 but auto-approves under threshold
      // If no approval URL, treat as auto-approved
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
        this.log('payment_sent', {
          type: 'payment',
          amount,
          to: recipientAddress,
          result: result.data?.data || result.data,
        });
      }
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

  async payAgentViaEmail(email, amount, taskDescription) {
    this.log('email_escrow_initiated', {
      type: 'payment',
      to: email,
      amount,
      task: taskDescription,
      reasoning: `Using email escrow as alternative payment rail. Recipient can claim USDC via email link.`,
    });

    const result = await this.locus.sendEmailEscrow(
      email,
      amount,
      `Agent Mesh payment: ${taskDescription}`
    );

    this.log('email_escrow_sent', {
      type: 'payment',
      amount,
      to: email,
      result: result.data?.data || result.data,
    });

    return result;
  }

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

  registerService(registry, serviceDef) {
    return registry.register(this.name, this.walletAddress, this.locusApiKey, serviceDef);
  }

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
