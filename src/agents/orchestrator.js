const BaseAgent = require('./base-agent');
const ResearchAgent = require('./research-agent');
const WriterAgent = require('./writer-agent');

class OrchestratorAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'orchestrator' });
    this.workers = new Map();
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

    // Step 1: Break goal into subtasks
    const subtasks = this._planSubtasks(goal);
    this.log('subtasks_planned', { count: subtasks.length, subtasks });

    const results = {};

    // Step 2: Execute research subtasks
    const researcher = this.workers.get('researcher');
    if (!researcher) throw new Error('No research agent registered');

    const researchFindings = [];
    for (const task of subtasks.filter(t => t.type === 'research')) {
      this.log('dispatching_task', {
        task: task.description,
        to: researcher.name,
        budget: task.payment,
      });

      // Check budget
      if (this.budget.spent + task.payment > this.budget.total) {
        this.log('budget_exceeded', {
          spent: this.budget.spent,
          taskCost: task.payment,
          total: this.budget.total,
        });
        break;
      }

      // Execute research
      const findings = await researcher.research(task.query);
      researchFindings.push(findings);

      // Pay the research agent via Locus
      try {
        const payment = await this.payAgent(
          researcher.walletAddress,
          task.payment,
          task.description
        );
        this.budget.spent += task.payment;
        task.status = 'completed';
        task.paymentResult = payment;
      } catch (err) {
        this.log('payment_failed', { error: err.message, task: task.description });
        // Mark task as work_done even if payment fails (insufficient balance)
        task.status = findings.scrapedData || findings.searchResults ? 'work_done_unpaid' : 'payment_failed';
        task.error = err.message;
      }

      this.tasks.push(task);
    }

    results.research = researchFindings;

    // Step 3: Execute writing subtasks
    const writer = this.workers.get('writer');
    if (writer && researchFindings.length > 0) {
      const writeTask = subtasks.find(t => t.type === 'write');
      if (writeTask) {
        this.log('dispatching_task', {
          task: writeTask.description,
          to: writer.name,
          budget: writeTask.payment,
        });

        const report = await writer.synthesize(researchFindings);
        results.report = report;

        // Pay the writer agent
        try {
          const payment = await this.payAgent(
            writer.walletAddress,
            writeTask.payment,
            writeTask.description
          );
          this.budget.spent += writeTask.payment;
          writeTask.status = 'completed';
          writeTask.paymentResult = payment;
        } catch (err) {
          this.log('payment_failed', { error: err.message });
          writeTask.status = 'payment_failed';
          writeTask.error = err.message;
        }

        this.tasks.push(writeTask);
      }
    }

    // Step 4: Generate full audit trail
    const audit = this._generateAudit();
    results.audit = audit;

    this.log('goal_completed', {
      goal,
      totalSpent: this.budget.spent,
      tasksCompleted: this.tasks.filter(t => t.status === 'completed').length,
    });

    return results;
  }

  _planSubtasks(goal) {
    // Simple task decomposition — in production this would use an LLM
    const researchPayment = Math.min(this.budget.perTask, 1.0);
    const writePayment = Math.min(this.budget.perTask, 1.5);

    return [
      {
        type: 'research',
        description: `Research: ${goal}`,
        query: goal,
        payment: researchPayment,
        status: 'pending',
      },
      {
        type: 'write',
        description: `Write report: ${goal}`,
        payment: writePayment,
        status: 'pending',
      },
    ];
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
        failed: this.tasks.filter(t => t.status === 'payment_failed').length,
        totalSpent: this.budget.spent,
        remainingBudget: this.budget.total - this.budget.spent,
      },
    };
  }
}

module.exports = OrchestratorAgent;
