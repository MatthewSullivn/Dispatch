/**
 * Global event bus for Agent Mesh.
 *
 * All agent actions (payments, API calls, escrow events, task updates)
 * are emitted here as 'agent-event' events. The server captures these
 * for the SSE timeline stream and rolling event log.
 */
const EventEmitter = require('events');

const MAX_LISTENERS = 50;

const meshEvents = new EventEmitter();
meshEvents.setMaxListeners(MAX_LISTENERS);

module.exports = meshEvents;
