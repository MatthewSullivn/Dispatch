/**
 * Orchestrator agent for Dispatch.
 *
 * Coordinates the full goal execution pipeline:
 *   1. Verify wallet balance via Locus
 *   2. Plan subtasks (research + synthesis)
 *   3. Discover the cheapest agent for each task from the registry
 *   4. Create escrow via Locus checkout session
 *   5. Worker preflight verifies escrow
 *   6. Worker executes the task
 *   7. Release payment (escrow, direct, or email escrow fallback)
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
const CAPABILITY_MAP = { research: 'research', write: 'writing' };

// Task type to worker role mapping
const ROLE_MAP = { research: 'researcher', write: 'writer' };

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
      task.status = 'skipped_budget';
      this.tasks.push(task);
      return;
    }

    // Discover the right agent
    const agent = this._findAgent(task.type);
    if (!agent) {
      this.log('no_agent_found', { type: task.type });
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
  }

  /**
   * Create escrow via Locus checkout session. Returns null if escrow
   * creation fails (payment falls back to direct wallet transfer).
   */
  async _createEscrow(task, agent, goal) {
    if (!this.escrowManager) return null;

    try {
      const session = await this.escrowManager.createEscrow(this.locus, {
        amount: task.payment,
        description: task.description,
        buyerAgent: this.name,
        sellerAgent: agent.name,
        metadata: { goal, taskType: task.type },
      });

      // Worker verifies the escrow is valid via preflight
      if (session?.sessionId) {
        await this.escrowManager.preflight(agent.locus, session.sessionId);
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
    const MAX_RETRIES = 1;
    const RETRY_DELAY = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (escrowSession?.sessionId) {
          await this.escrowManager.releasePayment(this.locus, escrowSession.sessionId);
        } else {
          await this.payAgent(agent.walletAddress, task.payment, task.description);
        }
        this.budget.spent += task.payment;
        task.status = 'completed';
        return;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          this.log('payment_retry', {
            attempt: attempt + 1,
            error: err.message,
            task: task.description,
            reasoning: `Payment attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY}ms...`,
          });
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }

        // Exhausted retries — try email escrow fallback
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
              reasoning: 'All payment methods exhausted after retry: checkout escrow, direct wallet, and email escrow all failed.',
            });
            task.status = 'work_done_unpaid';
            task.error = emailErr.message;
            return;
          }
        }
        this.log('payment_failed', { error: err.message, task: task.description });
        task.status = 'work_done_unpaid';
        task.error = err.message;
      }
    }
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
        const service = services[0]; // Sorted cheapest first
        for (const [, agent] of this.workers) {
          if (agent.walletAddress === service.walletAddress || agent.name === service.agentName) {
            this.log('agent_discovered', {
              type: 'registry',
              agent: service.agentName,
              service: service.serviceName,
              price: service.price,
              reasoning: `Selected ${service.agentName} from registry — cheapest provider for "${capability}" at $${service.price} USDC/task.`,
            });
            return agent;
          }
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
    const writePrice = this._getServicePrice('writing') || Math.min(this.budget.perTask, DEFAULT_MAX_PRICE);

    return [
      { type: 'research', description: `Research: ${goal}`, query: goal, payment: researchPrice, status: 'pending' },
      { type: 'write', description: `Synthesize report: ${goal}`, payment: writePrice, status: 'pending' },
    ];
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
