/**
 * Centralized configuration for Dispatch.
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
  validator: {
    name: 'MeshValidator',
    role: 'validator',
    locusApiKey: process.env.VALIDATOR_LOCUS_API_KEY || process.env.RESEARCHER_LOCUS_API_KEY,
    walletAddress: process.env.VALIDATOR_WALLET_ADDRESS || process.env.RESEARCHER_WALLET_ADDRESS,
    email: process.env.VALIDATOR_EMAIL || null,
    service: {
      name: 'Fact Checking',
      description: 'Validate research findings for accuracy using Grok or Gemini LLMs via Locus wrapped APIs',
      price: 0.03,
      capabilities: ['validation', 'fact-checking', 'quality-assurance'],
    },
  },
};

// ── Rate Limiting ────────────────────────────────────────────────

const RATE_LIMITS = {
  goalCooldownMs: 15000,        // 15 seconds between goals
  maxGoalsPerHour: 10,          // Maximum goals per rolling hour
  oneHourMs: 3600000,           // One hour in milliseconds
};

// ── Budget Caps ──────────────────────────────────────────────────

const BUDGET = {
  maxPerGoal: 1.0,              // Maximum USDC per goal
  maxPerTask: 0.25,             // Maximum USDC per individual task
  defaultTotal: 5.0,            // Default orchestrator budget
  defaultPerTask: 1.0,          // Default max per task
  minBalance: 0.01,             // Minimum USDC to start a goal
  defaultMaxPrice: 0.5,         // Default price cap when no registry price
};

// ── System ───────────────────────────────────────────────────────

const SYSTEM = {
  maxTimelineEvents: 500,       // Rolling event buffer size
  maxGoalLength: 500,           // Maximum goal input length
  port: process.env.PORT || 3001,
  deployedUrl: process.env.DEPLOYED_URL || null,
};

// ── Locus API ─────────────────────────────────────────────────

const LOCUS = {
  baseUrl: process.env.LOCUS_BASE_URL || 'https://api.paywithlocus.com/api',
  betaUrl: process.env.LOCUS_BETA_URL || 'https://beta-api.paywithlocus.com/api',
  checkoutUrl: 'https://checkout.paywithlocus.com',
  paymentRouter: '0x34184b7bCB4E6519C392467402DB8a853EF57806',  // Base mainnet
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // USDC on Base (6 decimals)
  statusPendingApproval: 202,
};

module.exports = { AGENTS, RATE_LIMITS, BUDGET, SYSTEM, LOCUS };
