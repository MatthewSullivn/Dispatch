/**
 * Service registry for Dispatch.
 *
 * A marketplace where agents advertise their capabilities and prices.
 * The orchestrator queries this registry to discover the cheapest
 * capable agent for each subtask. Services are sorted by price
 * (cheapest first) so the orchestrator always gets the best deal.
 *
 * Any agent can register a service. New agents that join the mesh
 * are automatically discoverable.
 */
const { v4: uuidv4 } = require('uuid');
const meshEvents = require('./event-bus');

class ServiceRegistry {
  constructor() {
    /** @type {Map<string, object>} Registered services by ID */
    this.services = new Map();
    /** @type {Map<string, object>} Agent reputation scores by agent name */
    this.reputation = new Map();
  }

  /**
   * Register a new service in the marketplace.
   * @param {string} agentName - Name of the agent providing the service
   * @param {string} walletAddress - Agent's wallet address for payments
   * @param {string} locusApiKey - Agent's Locus API key (stored internally, never exposed)
   * @param {object} service - Service definition
   * @param {string} service.name - Service display name
   * @param {string} service.description - What the service does
   * @param {number} service.price - Price in USDC per task
   * @param {string[]} service.capabilities - Searchable capability tags
   * @returns {object} The registered service entry
   */
  register(agentName, walletAddress, locusApiKey, service) {
    const id = uuidv4();
    const entry = {
      id,
      agentName,
      walletAddress,
      locusApiKey,
      serviceName: service.name,
      description: service.description,
      price: service.price,
      capabilities: service.capabilities || [],
      registeredAt: new Date().toISOString(),
    };
    this.services.set(id, entry);
    meshEvents.emit('agent-event', {
      timestamp: entry.registeredAt,
      agent: agentName,
      action: 'service_registered',
      type: 'registry',
      serviceName: service.name,
      price: service.price,
    });
    return entry;
  }

  /**
   * Search for services by keyword query.
   * Scores services by how many query terms match their name,
   * description, and capabilities. Returns results sorted by relevance.
   * @param {string} query - Space-separated search terms
   * @returns {Array<object>} Matching services (API keys stripped)
   */
  discover(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];

    for (const service of this.services.values()) {
      const searchable = [
        service.serviceName,
        service.description,
        ...service.capabilities,
      ].join(' ').toLowerCase();

      const score = terms.reduce((s, term) => s + (searchable.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        results.push({ ...this._sanitize(service), score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Find services that match a specific capability.
   * Returns results sorted by price (cheapest first).
   * @param {string} capability - Capability to search for
   * @returns {Array<object>} Matching services sorted by price
   */
  findByCapability(capability) {
    const cap = capability.toLowerCase();
    const results = [];
    for (const service of this.services.values()) {
      if (service.capabilities.some(c => c.toLowerCase().includes(cap))) {
        results.push(service);
      }
    }
    return results.sort((a, b) => a.price - b.price);
  }

  /**
   * Get all registered services (API keys stripped for safety).
   * @returns {Array<object>} All services without sensitive fields
   */
  getAll() {
    return Array.from(this.services.values()).map(s => this._sanitize(s));
  }

  /**
   * Get all services registered by a specific agent.
   * @param {string} agentName - Agent name to filter by
   * @returns {Array<object>} Matching services (API keys stripped)
   */
  getByAgent(agentName) {
    return Array.from(this.services.values())
      .filter(s => s.agentName === agentName)
      .map(s => this._sanitize(s));
  }

  // ── Reputation System ─────────────────────────────────────────

  /**
   * Record a task completion outcome for an agent.
   * @param {string} agentName - Agent that performed the task
   * @param {boolean} success - Whether the task succeeded
   * @param {number} paymentAmount - USDC paid for the task
   */
  recordOutcome(agentName, success, paymentAmount = 0) {
    const rep = this.reputation.get(agentName) || {
      completed: 0, failed: 0, totalEarned: 0, score: 1.0,
    };
    if (success) {
      rep.completed++;
      rep.totalEarned += paymentAmount;
    } else {
      rep.failed++;
    }
    const total = rep.completed + rep.failed;
    rep.score = total > 0 ? rep.completed / total : 1.0;
    this.reputation.set(agentName, rep);
  }

  /**
   * Get reputation data for an agent.
   * @param {string} agentName - Agent to look up
   * @returns {object} Reputation with completed, failed, totalEarned, score
   */
  getReputation(agentName) {
    return this.reputation.get(agentName) || {
      completed: 0, failed: 0, totalEarned: 0, score: 1.0,
    };
  }

  /**
   * Get all agent reputations.
   * @returns {Array<object>} All reputation records
   */
  getAllReputations() {
    const reps = [];
    for (const [agent, rep] of this.reputation) {
      reps.push({ agent, ...rep });
    }
    return reps;
  }

  /**
   * Strip sensitive fields (API keys) before returning service data.
   * @private
   */
  _sanitize({ locusApiKey, ...safe }) {
    const rep = this.reputation.get(safe.agentName);
    if (rep) safe.reputation = rep.score;
    return safe;
  }
}

module.exports = ServiceRegistry;
