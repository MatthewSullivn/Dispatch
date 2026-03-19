const BaseAgent = require('./base-agent');

class OrchestratorAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'orchestrator' });
    this.workers = new Map();
    this.registry = config.registry || null;
    this.escrowManager = config.escrowManager || null;
    this.budget = { total: 0, spent: 0, perTask: 0 };
    this.tasks = [];
  }

  registerWorker(agent) {
    this.workers.set(agent.role, agent);
    this.log('worker_registered', {
      name: agent.name,
      role: agent.role,
      wallet: agent.walletAddress,
    });
  }

  setBudget(totalBudget, maxPerTask) {
    this.budget = {
      total: totalBudget,
      spent: 0,
      perTask: maxPerTask,
    };
    this.log('budget_set', { total: totalBudget, maxPerTask });
  }

  async executeGoal(goal) {
    // Reset per-run state
    this.tasks = [];
    this.taskLog = [];
    for (const [, agent] of this.workers) {
      agent.taskLog = [];
    }
    this.budget.spent = 0;

    this.log('goal_received', { goal });

    // Step 0: Verify wallet balance before starting
    try {
      const balResult = await this.getBalance();
      const balance = parseFloat(balResult.data?.data?.usdc_balance || balResult.data?.usdc_balance || '0');
      this.log('balance_verified', { balance, wallet: this.walletAddress });
      if (balance < 0.01) {
        throw new Error(`Orchestrator wallet balance too low ($${balance.toFixed(2)} USDC). Fund wallet before running goals.`);
      }
    } catch (err) {
      if (err.message.includes('too low')) throw err;
      // Balance check failed but don't block execution
    }

    // Step 1: Plan subtasks
    const subtasks = this._planSubtasks(goal);
    this.log('subtasks_planned', {
      count: subtasks.length,
      reasoning: `Decomposed goal into ${subtasks.length} subtasks: ${subtasks.map(t => t.type).join(', ')}. Total estimated cost: $${subtasks.reduce((s, t) => s + t.payment, 0).toFixed(2)} USDC.`,
    });

    const results = {};
    const researchFindings = [];

    // Step 2: Execute each subtask
    for (const task of subtasks) {
      // Check budget
      if (this.budget.spent + task.payment > this.budget.total) {
        this.log('budget_exceeded', { spent: this.budget.spent, taskCost: task.payment });
        task.status = 'skipped_budget';
        this.tasks.push(task);
        continue;
      }

      // Find the right agent (registry or fallback to workers map)
      const agent = this._findAgent(task.type);
      if (!agent) {
        this.log('no_agent_found', { type: task.type });
        task.status = 'no_agent';
        this.tasks.push(task);
        continue;
      }

      this.log('dispatching_task', {
        type: 'dispatch',
        task: task.description,
        to: agent.name,
        budget: task.payment,
        reasoning: `Dispatching "${task.type}" to ${agent.name}. Budget allocation: $${task.payment} of $${(this.budget.total - this.budget.spent).toFixed(2)} remaining.`,
      });

      // Step A: Create escrow (checkout session) before work starts
      let escrowSession = null;
      if (this.escrowManager) {
        try {
          escrowSession = await this.escrowManager.createEscrow(this.locus, {
            amount: task.payment,
            description: task.description,
            buyerAgent: this.name,
            sellerAgent: agent.name,
            metadata: { goal, taskType: task.type },
          });

          // Worker agent verifies the escrow via preflight
          if (escrowSession?.sessionId) {
            await this.escrowManager.preflight(agent.locus, escrowSession.sessionId);
          }
        } catch (err) {
          // Escrow creation/preflight failed, fall back to direct payment
          escrowSession = null;
        }
      }

      // Step B: Execute the task (work happens while funds are in escrow)
      let taskResult;
      try {
        if (task.type === 'research') {
          taskResult = await agent.research(task.query);
          researchFindings.push(taskResult);
        } else if (task.type === 'write') {
          taskResult = await agent.synthesize(researchFindings);
          results.report = taskResult;
        }
      } catch (err) {
        this.log('task_failed', { error: err.message, task: task.description });
        task.status = 'execution_failed';
        task.error = err.message;
        this.tasks.push(task);
        continue;
      }

      // Step C: Release payment — escrow release, direct payment, or email escrow fallback
      try {
        if (escrowSession?.sessionId) {
          await this.escrowManager.releasePayment(this.locus, escrowSession.sessionId);
        } else {
          await this.payAgent(agent.walletAddress, task.payment, task.description);
        }
        this.budget.spent += task.payment;
        task.status = 'completed';
      } catch (err) {
        // Fallback: try email escrow if agent has an email
        if (agent.agentEmail) {
          try {
            await this.payAgentViaEmail(agent.agentEmail, task.payment, task.description);
            this.budget.spent += task.payment;
            task.status = 'completed_via_email';
          } catch (emailErr) {
            this.log('payment_failed', { error: emailErr.message, task: task.description, reasoning: 'All payment methods exhausted: checkout escrow, direct wallet, and email escrow all failed.' });
            task.status = 'work_done_unpaid';
            task.error = emailErr.message;
          }
        } else {
          this.log('payment_failed', { error: err.message, task: task.description });
          task.status = 'work_done_unpaid';
          task.error = err.message;
        }
      }

      this.tasks.push(task);
    }

    results.research = researchFindings;

    // Generate audit
    const audit = this._generateAudit();
    results.audit = audit;

    this.log('goal_completed', {
      goal,
      totalSpent: this.budget.spent,
      tasksCompleted: this.tasks.filter(t => t.status === 'completed').length,
    });

    return results;
  }

  _findAgent(taskType) {
    // Try registry first
    if (this.registry) {
      const capability = taskType === 'research' ? 'research' : 'writing';
      const services = this.registry.findByCapability(capability);
      if (services.length > 0) {
        const service = services[0]; // Cheapest
        // Find the worker agent with this wallet
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

    // Fallback to direct worker map
    const roleMap = { research: 'researcher', write: 'writer' };
    return this.workers.get(roleMap[taskType]);
  }

  _planSubtasks(goal) {
    const researchPrice = this._getServicePrice('research') || Math.min(this.budget.perTask, 0.5);
    const writePrice = this._getServicePrice('writing') || Math.min(this.budget.perTask, 0.5);

    return [
      {
        type: 'research',
        description: `Research: ${goal}`,
        query: goal,
        payment: researchPrice,
        status: 'pending',
      },
      {
        type: 'write',
        description: `Synthesize report: ${goal}`,
        payment: writePrice,
        status: 'pending',
      },
    ];
  }

  _getServicePrice(capability) {
    if (!this.registry) return null;
    const services = this.registry.findByCapability(capability);
    if (services.length > 0) return services[0].price;
    return null;
  }

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
