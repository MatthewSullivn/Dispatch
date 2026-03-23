/**
 * Orchestrator agent for Dispatch.
 *
 * Coordinates the full goal execution pipeline:
 *   1. Verify wallet balance via Locus
 *   2. Plan subtasks (research + synthesis)
 *   3. Discover the cheapest agent for each task from the registry
 *   4. Worker creates escrow via Locus checkout session (merchant)
 *   5. Orchestrator preflight verifies escrow (buyer)
 *   6. Worker executes the task
 *   7. Orchestrator releases payment (escrow, direct, or email escrow fallback)
 *   8. Generate full audit trail
 *
 * Payment priority: checkout escrow > direct wallet > email escrow.
 * No funds move until work is delivered.
 */
const BaseAgent = require('./base-agent');
const { BUDGET } = require('../config');

// Minimum USDC balance required to start a goal
const MIN_BALANCE_USDC = BUDGET.minBalance;

// Default price cap when no registry price is available
const DEFAULT_MAX_PRICE = BUDGET.defaultMaxPrice;

// Task type to registry capability mapping
const CAPABILITY_MAP = { research: 'research', validate: 'validation', write: 'writing' };

// Task type to worker role mapping
const ROLE_MAP = { research: 'researcher', validate: 'validator', write: 'writer' };

/**
 * Orchestrator agent — discovers workers, manages budget, and handles
 * the escrow-pay-verify lifecycle for each subtask.
 */
class OrchestratorAgent extends BaseAgent {
  /**
   * @param {object} config
   * @param {ServiceRegistry} [config.registry] - Service marketplace for agent discovery
   * @param {EscrowManager} [config.escrowManager] - Manages Locus checkout escrow
   */
  constructor(config) {
    super({ ...config, role: 'orchestrator' });
    this.workers = new Map();
    this.registry = config.registry || null;
    this.escrowManager = config.escrowManager || null;
    this.budget = { total: 0, spent: 0, perTask: 0 };
    this.tasks = [];
  }

  /**
   * Register a worker agent that can receive tasks.
   * @param {BaseAgent} agent - Worker agent to register
   */
  registerWorker(agent) {
    this.workers.set(agent.role, agent);
    this.log('worker_registered', {
      name: agent.name,
      role: agent.role,
      wallet: agent.walletAddress,
    });
  }

  /**
   * Set the budget for a goal execution.
   * @param {number} totalBudget - Maximum USDC to spend
   * @param {number} maxPerTask - Maximum USDC per individual task
   */
  setBudget(totalBudget, maxPerTask) {
    this.budget = { total: totalBudget, spent: 0, perTask: maxPerTask };
    this.log('budget_set', { total: totalBudget, maxPerTask });
  }

  /**
   * Execute a user goal end-to-end.
   * Plans subtasks, discovers agents, escrows funds, dispatches work,
   * releases payment, and generates a full audit trail.
   * @param {string} goal - The user's objective
   * @returns {object} Results including report, research findings, and audit trail
   */
  async executeGoal(goal) {
    this._resetState();
    this.log('goal_received', { goal });

    await this._verifyBalance();

    const subtasks = this._planSubtasks(goal);
    this.log('subtasks_planned', {
      count: subtasks.length,
      reasoning: `Decomposed goal into ${subtasks.length} subtasks: ${subtasks.map(t => t.type).join(', ')}. Total estimated cost: $${subtasks.reduce((s, t) => s + t.payment, 0).toFixed(2)} USDC.`,
    });

    const results = {};
    const researchFindings = [];

    for (const task of subtasks) {
      await this._executeSubtask(task, goal, results, researchFindings);
    }

    results.research = researchFindings;
    results.audit = this._generateAudit();

    this.log('goal_completed', {
      goal,
      totalSpent: this.budget.spent,
      tasksCompleted: this.tasks.filter(t => t.status === 'completed').length,
    });

    // Submit usage feedback to Locus (non-blocking)
    if (this.locus.submitFeedback) {
      this.locus.submitFeedback(
        `Dispatch goal completed: ${this.tasks.filter(t => t.status === 'completed').length}/${this.tasks.length} tasks, $${this.budget.spent.toFixed(2)} spent`,
        { goal, tasks: this.tasks.length, spent: this.budget.spent }
      ).catch(() => {});
    }

    return results;
  }

  // ── Private: Goal execution steps ──────────────────────────────

  /** Reset per-run state so each goal starts clean. */
  _resetState() {
    this.tasks = [];
    this.taskLog = [];
    for (const [, agent] of this.workers) {
      agent.taskLog = [];
    }
    this.budget.spent = 0;
  }

  /** Verify the orchestrator wallet has sufficient USDC to operate. */
  async _verifyBalance() {
    try {
      const balResult = await this.getBalance();
      const balance = parseFloat(balResult.data?.data?.usdc_balance || balResult.data?.usdc_balance || '0');
      this.log('balance_verified', { balance, wallet: this.walletAddress });
      if (balance < MIN_BALANCE_USDC) {
        throw new Error(`Orchestrator wallet balance too low ($${balance.toFixed(2)} USDC). Fund wallet before running goals.`);
      }
    } catch (err) {
      if (err.message.includes('too low')) throw err;
      // Balance check API failed — log warning but continue with caution
      this.log('balance_check_warning', {
        error: err.message,
        reasoning: 'Could not verify wallet balance via Locus API. Proceeding with caution — payments may fail if balance is insufficient.',
      });
    }
  }

  /**
   * Execute a single subtask: find agent, escrow, work, pay.
   * @param {object} task - Subtask definition
   * @param {string} goal - Parent goal for metadata
   * @param {object} results - Accumulates results across tasks
   * @param {Array} researchFindings - Accumulates research output
   */
  async _executeSubtask(task, goal, results, researchFindings) {
    // Budget gate
    if (this.budget.spent + task.payment > this.budget.total) {
      this.log('budget_exceeded', { spent: this.budget.spent, taskCost: task.payment });
      if (task.type === 'validate') this.log('validation_skipped', { reason: 'Budget exceeded' });
      task.status = 'skipped_budget';
      this.tasks.push(task);
      return;
    }

    // Discover the right agent
    const agent = this._findAgent(task.type);
    if (!agent) {
      this.log('no_agent_found', { type: task.type });
      if (task.type === 'validate') this.log('validation_skipped', { reason: 'No validator agent found' });
      task.status = 'no_agent';
      this.tasks.push(task);
      return;
    }

    this.log('dispatching_task', {
      type: 'dispatch',
      task: task.description,
      to: agent.name,
      budget: task.payment,
      reasoning: `Dispatching "${task.type}" to ${agent.name}. Budget allocation: $${task.payment} of $${(this.budget.total - this.budget.spent).toFixed(2)} remaining.`,
    });

    // Escrow → Work → Pay
    const escrowSession = await this._createEscrow(task, agent, goal);
    const workDone = await this._executeWork(task, agent, results, researchFindings);
    if (workDone) {
      await this._releasePayment(task, agent, escrowSession);
    }

    this.tasks.push(task);

    // Record outcome for reputation scoring
    if (this.registry) {
      const success = task.status === 'completed' || task.status === 'completed_via_email';
      this.registry.recordOutcome(agent.name, success, success ? task.payment : 0);
    }
  }

  /**
   * Create escrow via Locus checkout session. Returns null if escrow
   * creation fails (payment falls back to direct wallet transfer).
   */
  async _createEscrow(task, agent, goal) {
    if (!this.escrowManager) return null;

    // Skip checkout escrow for the validator — it shares the researcher's
    // wallet, so Locus can't create a separate checkout session for it.
    // Payment is handled via the shared wallet's existing balance.
    if (agent.walletAddress === this.workers.get('researcher')?.walletAddress && agent.role === 'validator') {
      this.log('escrow_skipped_shared_wallet', {
        type: 'escrow',
        agent: agent.name,
        reasoning: `Skipping escrow for ${agent.name} — shares wallet with researcher. Validation cost covered by shared wallet balance.`,
      });
      return { sessionId: null, skipPayment: true };
    }

    try {
      // Worker creates the checkout session (merchant/seller).
      // Orchestrator pays after work is delivered (buyer).
      // Sessions track on the worker's Locus merchant dashboard.
      const session = await this.escrowManager.createEscrow(agent.locus, {
        amount: task.payment,
        description: task.description,
        buyerAgent: this.name,
        sellerAgent: agent.name,
        metadata: { goal, taskType: task.type },
      });

      // Orchestrator verifies the escrow is valid via preflight
      if (session?.sessionId) {
        await this.escrowManager.preflight(this.locus, session.sessionId);
      }
      return session;
    } catch (err) {
      this.log('escrow_fallback', {
        type: 'escrow',
        error: err.message,
        task: task.description,
        reasoning: `Checkout escrow failed: ${err.message}. Falling back to direct wallet payment after work completes.`,
      });
      return null;
    }
  }

  /**
   * Execute the actual work (research or synthesis).
   * Returns true if work completed, false if it failed.
   */
  async _executeWork(task, agent, results, researchFindings) {
    try {
      if (task.type === 'research') {
        const findings = await agent.research(task.query);
        if (!findings.scrapedData && !findings.searchResults && !findings.supplementaryResults) {
          this.log('research_empty', {
            query: task.query,
            reasoning: 'All research providers returned empty results. Report quality may be degraded.',
          });
        }
        researchFindings.push(findings);
      } else if (task.type === 'validate') {
        const validation = await agent.validate(researchFindings);
        results.validation = validation;
        this.log('validation_result', {
          validated: validation.validated,
          provider: validation.provider,
          reasoning: `Fact-check ${validation.validated ? 'completed' : 'skipped'} via ${validation.provider}. ${validation.sourcesChecked} sources checked.`,
        });
      } else if (task.type === 'write') {
        results.report = await agent.synthesize(researchFindings);
      }
      return true;
    } catch (err) {
      this.log('task_failed', { error: err.message, task: task.description });
      task.status = 'execution_failed';
      task.error = err.message;
      return false;
    }
  }

  /**
   * Release payment to the worker agent.
   * Tries in order: checkout escrow release → direct wallet → email escrow.
   * Marks task status based on outcome.
   */
  async _releasePayment(task, agent, escrowSession) {
    // Shared wallet — validation cost is covered, skip payment
    if (escrowSession?.skipPayment) {
      this.log('payment_skipped_shared_wallet', {
        task: task.description,
        amount: task.payment,
        reasoning: `Payment skipped — ${agent.name} shares wallet with researcher. Validation billed through shared balance.`,
      });
      this.budget.spent += task.payment;
      task.status = 'completed';
      return;
    }

    // 1. Try checkout escrow release
    if (escrowSession?.sessionId) {
      try {
        // Orchestrator (buyer) pays the worker's checkout session — worker (merchant) polls status
        await this.escrowManager.releasePayment(this.locus, escrowSession.sessionId, agent.locus);
        this.budget.spent += task.payment;
        task.status = 'completed';
        return;
      } catch (err) {
        this.log('escrow_pay_failed', {
          error: err.message,
          task: task.description,
          reasoning: `Checkout pay failed: ${err.message}. Falling back to direct wallet payment.`,
        });
      }
    }

    // 2. Fall back to direct wallet payment (with one retry)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.payAgent(agent.walletAddress, task.payment, task.description);
        this.budget.spent += task.payment;
        task.status = 'completed';
        return;
      } catch (err) {
        if (attempt === 1) {
          this.log('payment_retry', {
            error: err.message,
            task: task.description,
            reasoning: `Direct wallet payment failed (attempt 1): ${err.message}. Retrying in 2s.`,
          });
          await new Promise(r => setTimeout(r, 2000));
        } else {
          this.log('direct_pay_failed', {
            error: err.message,
            task: task.description,
            reasoning: `Direct wallet payment failed after retry: ${err.message}. Trying email escrow.`,
          });
        }
      }
    }

    // 3. Fall back to email escrow
    if (agent.agentEmail) {
      try {
        await this.payAgentViaEmail(agent.agentEmail, task.payment, task.description);
        this.budget.spent += task.payment;
        task.status = 'completed_via_email';
        return;
      } catch (emailErr) {
        this.log('payment_failed', {
          error: emailErr.message,
          task: task.description,
          reasoning: 'All payment methods exhausted: checkout escrow, direct wallet, and email escrow all failed.',
        });
        task.status = 'work_done_unpaid';
        task.error = emailErr.message;
        return;
      }
    }

    this.log('payment_failed', { task: task.description, reasoning: 'Checkout and direct wallet failed. No email configured for email escrow fallback.' });
    task.status = 'work_done_unpaid';
  }

  // ── Private: Agent discovery and planning ──────────────────────

  /**
   * Find the best agent for a task type.
   * Checks the service registry first (cheapest provider), falls back
   * to the direct worker map.
   * @param {string} taskType - 'research' or 'write'
   * @returns {BaseAgent|undefined}
   */
  _findAgent(taskType) {
    if (this.registry) {
      const capability = CAPABILITY_MAP[taskType] || taskType;
      const services = this.registry.findByCapability(capability);
      if (services.length > 0) {
        // Rank by price first, then reputation as tiebreaker
        const service = services.sort((a, b) => {
          if (a.price !== b.price) return a.price - b.price;
          const repA = this.registry.getReputation(a.agentName).score;
          const repB = this.registry.getReputation(b.agentName).score;
          return repB - repA; // Higher reputation wins ties
        })[0];
        // Match by name first, then wallet — avoids returning researcher
        // for validate tasks when validator shares the same wallet.
        let matched = null;
        for (const [, agent] of this.workers) {
          if (agent.name === service.agentName) { matched = agent; break; }
          if (!matched && agent.walletAddress === service.walletAddress) matched = agent;
        }
        if (matched) {
          this.log('agent_discovered', {
            type: 'registry',
            agent: service.agentName,
            service: service.serviceName,
            price: service.price,
            reasoning: `Selected ${service.agentName} from registry — cheapest provider for "${capability}" at $${service.price} USDC/task.`,
          });
          return matched;
        }
      }
    }

    return this.workers.get(ROLE_MAP[taskType]);
  }

  /**
   * Plan subtasks for a goal. Currently generates a research task
   * followed by a synthesis task. Prices come from the registry.
   * @param {string} goal - User's objective
   * @returns {Array<object>} Subtask definitions
   */
  _planSubtasks(goal) {
    const researchPrice = this._getServicePrice('research') || Math.min(this.budget.perTask, DEFAULT_MAX_PRICE);
    const validatePrice = this._getServicePrice('validation') || Math.min(this.budget.perTask * 0.5, 0.03);
    const writePrice = this._getServicePrice('writing') || Math.min(this.budget.perTask, DEFAULT_MAX_PRICE);

    // Dynamic planning: complex goals with multiple facets get additional research passes
    const researchQueries = this._decomposeResearchQueries(goal);
    const tasks = [];

    for (const query of researchQueries) {
      tasks.push({ type: 'research', description: `Research: ${query}`, query, payment: researchPrice, status: 'pending' });
    }
    tasks.push({ type: 'validate', description: `Fact-check: ${goal}`, payment: validatePrice, status: 'pending' });
    tasks.push({ type: 'write', description: `Synthesize report: ${goal}`, payment: writePrice, status: 'pending' });

    return tasks;
  }

  /**
   * Decompose a goal into research queries. Simple goals get one query;
   * complex goals with conjunctions or multiple facets get parallel queries.
   * Caps at 3 queries to stay within budget.
   * @param {string} goal - User's objective
   * @returns {string[]} Research queries
   */
  _decomposeResearchQueries(goal) {
    // Split on common conjunctions that indicate multiple research angles
    const separators = /\b(?:and|vs\.?|versus|compared to|comparing)\b/i;
    const parts = goal.split(separators).map(s => s.trim()).filter(s => s.length > 5);

    if (parts.length >= 2 && parts.length <= 3) {
      // Budget check: can we afford multiple research passes?
      const researchPrice = this._getServicePrice('research') || Math.min(this.budget.perTask, DEFAULT_MAX_PRICE);
      const totalResearchCost = parts.length * researchPrice;
      if (totalResearchCost <= this.budget.total * 0.6) {
        this.log('dynamic_planning', {
          reasoning: `Goal contains ${parts.length} distinct facets. Splitting into parallel research queries for comprehensive coverage.`,
          queries: parts,
        });
        return parts;
      }
    }
    return [goal];
  }

  /**
   * Look up the current price for a capability from the registry.
   * @param {string} capability - Registry capability to price
   * @returns {number|null} Price in USDC or null if not found
   */
  _getServicePrice(capability) {
    if (!this.registry) return null;
    const services = this.registry.findByCapability(capability);
    return services.length > 0 ? services[0].price : null;
  }

  // ── Private: Audit ─────────────────────────────────────────────

  /** Generate a complete audit report for this goal execution. */
  _generateAudit() {
    const workerAudits = {};
    for (const [role, agent] of this.workers) {
      workerAudits[role] = agent.getAuditTrail();
    }

    return {
      orchestrator: this.getAuditTrail(),
      workers: workerAudits,
      budget: { ...this.budget },
      tasks: this.tasks,
      summary: {
        totalTasks: this.tasks.length,
        completed: this.tasks.filter(t => t.status === 'completed').length,
        failed: this.tasks.filter(t => t.status.includes('failed') || t.status === 'work_done_unpaid').length,
        totalSpent: this.budget.spent,
        remainingBudget: this.budget.total - this.budget.spent,
      },
    };
  }
}

module.exports = OrchestratorAgent;
