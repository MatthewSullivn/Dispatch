const { v4: uuidv4 } = require('uuid');
const meshEvents = require('./event-bus');

class ServiceRegistry {
  constructor() {
    this.services = new Map();
  }

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

  discover(query) {
    const terms = query.toLowerCase().split(/\s+/);
    const results = [];

    for (const service of this.services.values()) {
      const searchable = [
        service.serviceName,
        service.description,
        ...service.capabilities,
      ].join(' ').toLowerCase();

      const score = terms.reduce((s, term) => s + (searchable.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        results.push({ ...service, score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  findByCapability(capability) {
    const cap = capability.toLowerCase();
    const results = [];
    for (const service of this.services.values()) {
      if (service.capabilities.some(c => c.toLowerCase().includes(cap))) {
        results.push(service);
      }
    }
    // Return cheapest first
    return results.sort((a, b) => a.price - b.price);
  }

  getAll() {
    // Strip sensitive fields before returning
    return Array.from(this.services.values()).map(({ locusApiKey, ...safe }) => safe);
  }

  getByAgent(agentName) {
    return Array.from(this.services.values())
      .filter(s => s.agentName === agentName)
      .map(({ locusApiKey, ...safe }) => safe);
  }
}

module.exports = ServiceRegistry;
