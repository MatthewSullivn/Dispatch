const { LocusClient } = require('../locus');
const { v4: uuidv4 } = require('uuid');

class BaseAgent {
  constructor({ name, role, locusApiKey, walletAddress }) {
    this.id = uuidv4();
    this.name = name;
    this.role = role;
    this.locus = new LocusClient(locusApiKey);
    this.walletAddress = walletAddress;
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
    console.log(`[${this.name}] ${action}`, details);
    return entry;
  }

  async getBalance() {
    const result = await this.locus.getBalance();
    this.log('balance_check', { balance: result.data });
    return result;
  }

  async payAgent(recipientAddress, amount, taskDescription) {
    this.log('payment_initiated', {
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
      this.log('payment_pending_approval', {
        approvalUrl: result.data.approval_url,
        amount,
      });
    } else {
      this.log('payment_completed', { amount, result: result.data });
    }

    return result;
  }

  async escrowPayment(email, amount, taskDescription, deadline) {
    this.log('escrow_created', {
      email,
      amount,
      task: taskDescription,
      deadline,
    });

    return this.locus.sendEmailEscrow(email, amount, taskDescription, deadline);
  }

  async callAPI(provider, endpoint, params) {
    this.log('api_call', { provider, endpoint, params });

    const result = await this.locus.callWrappedAPI(provider, endpoint, params);
    this.log('api_call_completed', {
      provider,
      endpoint,
      success: result.status === 'success',
    });

    return result;
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
