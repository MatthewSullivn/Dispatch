# Agent Mesh

Autonomous AI agents that discover, hire, and pay each other in USDC on Base.

Built for [The Synthesis](https://synthesis.md) hackathon. Powered by [Locus](https://paywithlocus.com) payment infrastructure.

---

## What is Agent Mesh?

Agent Mesh is an autonomous agent-to-agent payment marketplace. You give a goal to the orchestrator, and it coordinates a team of specialized AI agents -- discovering them from a service registry, escrowing USDC before work starts, dispatching tasks, and releasing payment on delivery. Every dollar is tracked on-chain.

No human touches the money after the goal is submitted. Agents find each other, negotiate prices, do the work, and settle payments autonomously through Locus wallets on Base.

## How It Works

```
User submits goal
        |
        v
  [Orchestrator]
   - Verifies wallet balance via Locus API
   - Queries service registry for capable agents
   - Selects cheapest provider per task
        |
        v
  [Escrow Created]
   - Locus checkout session locks USDC before work starts
   - Worker agent verifies escrow via preflight check
        |
        v
  [Researcher Agent]                    [Writer Agent]
   - Searches via Exa (Locus wrapped)    - Synthesizes via Gemini (Locus wrapped)
   - Scrapes via Firecrawl (Locus wrapped) - Falls back to Grok (Locus wrapped)
   - All API calls billed in USDC          - All API calls billed in USDC
        |                                       |
        v                                       v
  [Escrow Released]                     [Escrow Released]
   - USDC payment confirmed on Base      - USDC payment confirmed on Base
   - Transaction verifiable on BaseScan  - Transaction verifiable on BaseScan
        |
        v
  Report delivered with full audit trail
```

## Locus Integration

Agent Mesh uses Locus as its core payment layer. Remove Locus and the entire product stops working.

**Wallets**: Three autonomous agent wallets on Base, each with its own Locus API key. Agents hold, send, and receive USDC independently.

**Spending Controls**: Configurable approval thresholds and allowance caps prevent agents from overspending. The orchestrator verifies its own balance before dispatching work.

**Checkout Session Escrow**: Before any work begins, the orchestrator creates a Locus checkout session that locks funds. The worker agent verifies the escrow via preflight. Payment is only released after work is delivered.

**Pay-Per-Use Wrapped APIs**: Agents call external services (Exa, Firecrawl, Gemini, Grok) through Locus's wrapped API proxy. Each call is automatically billed in USDC to the calling agent's wallet -- no upstream API keys needed.

**On-Chain Auditability**: Every payment between agents is a real USDC transfer on Base, verifiable on BaseScan. The dashboard displays transaction hashes with direct links.

## Architecture

```
src/
  server.js          Express server, API routes, SSE streaming
  locus.js           Locus API client (wallets, payments, checkout, wrapped APIs)
  escrow.js          Escrow manager wrapping Locus checkout sessions
  registry.js        Service marketplace for agent discovery
  event-bus.js       Global event emitter for real-time timeline
  agents/
    base-agent.js    Base class: wallet, payments, API calls, audit trail
    orchestrator.js  Discovers agents, manages budget, escrows, dispatches work
    research-agent.js  Web search via Exa + Firecrawl (Locus wrapped APIs)
    writer-agent.js  Report synthesis via Gemini + Grok (Locus wrapped APIs)
public/
  index.html         Dashboard: agent network, timeline, escrows, transactions
```

## Agents

| Agent | Role | Wallet | What It Does |
|-------|------|--------|--------------|
| Orchestrator | Coordinator | Own Locus wallet | Discovers agents from registry, creates escrow, dispatches tasks, releases payment |
| Researcher | Worker | Own Locus wallet | Searches the web via Exa and Firecrawl, returns structured findings |
| Writer | Worker | Own Locus wallet | Synthesizes research into reports via Gemini or Grok |

Each agent has its own Locus API key, wallet address, and USDC balance. The orchestrator pays workers; workers pay for their own API calls. All payments are real USDC on Base.

## Service Registry

Agents advertise their capabilities and prices in a marketplace registry. The orchestrator queries this registry to find the cheapest capable agent for each subtask.

```
Web Research       $0.05/task   [research, search, scrape, data-gathering]
Report Synthesis   $0.05/task   [writing, synthesis, report, summarization]
```

Any new agent can register a service with a price and capabilities. The orchestrator will discover and hire it if it's the cheapest option.

## Payment Flow

1. Orchestrator checks its Locus wallet balance
2. Creates a Locus checkout session (escrow) for the task amount
3. Worker agent runs preflight to verify the escrow is valid
4. Worker performs the task (research or synthesis)
5. Orchestrator releases the escrow -- USDC moves on-chain
6. Transaction is confirmed on Base and logged in the audit trail

If escrow is unavailable, the system falls back to direct Locus wallet-to-wallet payment.

## Safety

- **Rate limiting**: 30-second cooldown between goals, max 10 per hour
- **Budget caps**: Hardcoded max $1.00 per goal, $0.25 per task
- **Spending controls**: Locus approval threshold and allowance caps
- **Balance verification**: Orchestrator checks its wallet before starting
- **Escrow**: Funds are locked before work begins, released only on delivery

## Setup

### Prerequisites

- Node.js 18+
- Three Locus agent wallets funded with USDC on Base

### Install

```bash
npm install
```

### Configure

Create a `.env` file:

```
ORCHESTRATOR_LOCUS_API_KEY=your_key
ORCHESTRATOR_WALLET_ADDRESS=0x...
RESEARCHER_LOCUS_API_KEY=your_key
RESEARCHER_WALLET_ADDRESS=0x...
WRITER_LOCUS_API_KEY=your_key
WRITER_WALLET_ADDRESS=0x...
```

### Register wallets (first time only)

```bash
npm run setup
```

### Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System status, agent info, service count |
| `/api/goal` | POST | Submit a goal for the mesh to execute |
| `/api/balances` | GET | USDC balances for all agent wallets |
| `/api/registry` | GET | All registered services in the marketplace |
| `/api/registry/discover?q=` | GET | Search services by keyword |
| `/api/escrows` | GET | All escrow sessions and their status |
| `/api/transactions` | GET | On-chain USDC transactions from all agents |
| `/api/approvals` | GET | Payments held by Locus spending controls |
| `/api/timeline` | GET | Full event timeline |
| `/api/events/stream` | GET | Server-Sent Events stream (real-time) |
| `/api/audit` | GET | Complete audit trail for all agents |
| `/api/agents` | GET | Agent names, roles, and wallet addresses |

## Dashboard

The web dashboard shows the full agent economy in real time:

- **Agent Network** -- wallet balances and addresses with BaseScan links
- **Goal Input** -- submit goals with budget controls
- **Marketplace** -- registered services with prices and capabilities
- **Spending Controls** -- payments held by Locus approval thresholds
- **Live Timeline** -- real-time SSE stream of every agent action
- **Escrow Sessions** -- checkout sessions with create/verify/release status
- **On-Chain Transactions** -- every USDC transfer with BaseScan tx links
- **Report Output** -- the final synthesized report

## Tech Stack

- **Runtime**: Node.js + Express
- **Payments**: Locus API (wallets, checkout escrow, spending controls)
- **Chain**: Base (Ethereum L2)
- **Currency**: USDC
- **Search**: Exa + Firecrawl via Locus wrapped APIs
- **LLMs**: Gemini + Grok via Locus wrapped APIs
- **Frontend**: Vanilla HTML/CSS/JS with SSE

## License

MIT

---

Built by Matthew Sullivan for The Synthesis hackathon.
