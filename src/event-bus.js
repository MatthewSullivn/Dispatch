const EventEmitter = require('events');
const meshEvents = new EventEmitter();
meshEvents.setMaxListeners(50);
module.exports = meshEvents;
