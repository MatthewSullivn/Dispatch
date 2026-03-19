/**
 * Centralized configuration for Agent Mesh.
 *
 * All environment variables, agent definitions, and system constants
 * are defined here. This makes it easy to add new agents, adjust
 * pricing, or change rate limits without touching business logic.
 */

// ── Agent Definitions ────────────────────────────────────────────
// Each agent has its own Locus wallet, API key, and service definition.
// To add a new agent: define it here, create its class in src/agents/,
// and it will be auto-registered on startup.

const AGENTS = {
  orchestrator: {
    name: 'MeshOrchestrator',
    role: 'orchestrator',
    locusApiKey: process.env.ORCHESTRATOR_LOCUS_API_KEY,
    walletAddress: process.env.ORCHESTRATOR_WALLET_ADDRESS,
    email: process.env.ORCHESTRATOR_EMAIL || null,
  },
  researcher: {
    name: 'MeshResearcher',
    role: 'researcher',
    locusApiKey: process.env.RESEARCHER_LOCUS_API_KEY,
    walletAddress: process.env.RESEARCHER_WALLET_ADDRESS,
    email: process.env.RESEARCHER_EMAIL || null,
    service: {
      name: 'Web Research',
      description: 'Search the web, scrape websites, and gather data using Exa, Firecrawl, and Grok via Locus wrapped APIs',
      price: 0.05,
      capabilities: ['research', 'search', 'scrape', 'data-gathering'],
    },
  },
  writer: {
    name: 'MeshWriter',
    role: 'writer',
    locusApiKey: process.env.WRITER_LOCUS_API_KEY,
    walletAddress: process.env.WRITER_WALLET_ADDRESS,
    email: process.env.WRITER_EMAIL || null,
    service: {
      name: 'Report Synthesis',
      description: 'Synthesize research findings into professional reports using Gemini or Grok LLMs via Locus wrapped APIs',
      price: 0.05,
      capabilities: ['writing', 'synthesis', 'report', 'summarization'],
    },
  },
};

// ── Rate Limiting ────────────────────────────────────────────────

const RATE_LIMITS = {
  goalCooldownMs: 30000,        // 30 seconds between goals
  maxGoalsPerHour: 10,          // Maximum goals per rolling hour
  oneHourMs: 3600000,           // One hour in milliseconds
};

// ── Budget Caps ──────────────────────────────────────────────────

const BUDGET = {
  maxPerGoal: 1.0,              // Maximum USDC per goal
  maxPerTask: 0.25,             // Maximum USDC per individual task
  defaultTotal: 5.0,            // Default orchestrator budget
  defaultPerTask: 1.0,          // Default max per task
};

// ── System ───────────────────────────────────────────────────────

const SYSTEM = {
  maxTimelineEvents: 500,       // Rolling event buffer size
  maxGoalLength: 500,           // Maximum goal input length
  port: process.env.PORT || 3000,
  deployedUrl: process.env.DEPLOYED_URL || null,
};

module.exports = { AGENTS, RATE_LIMITS, BUDGET, SYSTEM };
