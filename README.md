# Dispatch

Autonomous AI agents that discover, hire, and pay each other in USDC on Base.

Built for [The Synthesis](https://synthesis.md) hackathon. Powered by [Locus](https://paywithlocus.com) payment infrastructure.

---

## What is Dispatch?

Dispatch is an autonomous agent-to-agent payment marketplace. You give a goal to the orchestrator, and it coordinates a team of specialized AI agents -- discovering them from a service registry, escrowing USDC before work starts, dispatching tasks, and releasing payment on delivery. Every dollar is tracked on-chain.

No human touches the money after the goal is submitted. Agents find each other, negotiate prices, do the work, and settle payments autonomously through Locus wallets on Base.

## How It Works

```
User submits goal
        |
        v
  [Orchestrator]
   - Verifies wallet balance via Locus API
   - Queries service registry for capable agents
   - Selects cheapest provider per task (reputation breaks ties)
        |
        v
  [Worker Creates Escrow]
   - Worker agent creates a Locus checkout session (merchant/seller)
   - Orchestrator verifies escrow via preflight (buyer)
        |
        v
  [Researcher Agent]          [Validator Agent]          [Writer Agent]
   - Searches via Exa           - Fact-checks findings     - Synthesizes via Gemini
   - Scrapes via Firecrawl      - Rates confidence         - Falls back to Grok
   - All calls billed USDC      - Quality gate             - All calls billed USDC
        |                            |                          |
        v                            v                          v
  [Orchestrator Pays]          [Orchestrator Pays]        [Orchestrator Pays]
   - USDC on Base               - USDC on Base             - USDC on Base
        |
        v
  Report delivered with full audit trail
```

## Locus Integration

Dispatch uses Locus as its core payment layer. Remove Locus and the entire product stops working.

**Agent Wallets**: Four autonomous agent wallets on Base, each with its own Locus API key. Agents hold, send, and receive USDC independently.

**Checkout Session Escrow (Task-Scoped Fund Isolation)**: Each subtask gets its own Locus checkout session. Workers create sessions as merchants; the orchestrator pays as buyer after work is delivered. Funds are isolated per-task -- if one task fails, other escrowed funds remain safe. Sessions are verified via preflight before work begins and confirmed on-chain via polling.

**@withlocus/checkout-react SDK**: The dashboard integrates the official Locus Checkout React SDK with embedded mode, popup mode, and the `useLocusCheckout` hook for programmatic control. Paid sessions display the Locus checkout confirmation embed.

**Payment Router**: Checkout sessions route through the Locus Payment Router contract (`0x3418...7806`) on Base mainnet, enabling on-chain USDC settlement via the `CheckoutPayment` event.

**Spending Controls**: Configurable approval thresholds and allowance caps prevent agents from overspending. Payments exceeding the threshold return an approval URL for human review, surfaced directly in the dashboard.

**Pay-Per-Use Wrapped APIs**: Agents call external services (Exa, Firecrawl, Gemini, Grok) through Locus's wrapped API proxy. Each call is automatically billed in USDC to the calling agent's wallet -- no upstream API keys needed.

**Email Escrow Fallback**: If checkout escrow and direct wallet payment both fail, agents fall back to Locus email escrow. The recipient claims USDC via an email link -- a novel payment rail for agent-to-agent settlement.

**Checkout Webhooks**: HMAC-SHA256 verified webhooks from Locus on session paid/expired events drive real-time dashboard updates via SSE.

**Receipt Config**: Checkout sessions include structured receipts with line items, seller name, and support contact for full audit trail transparency.

**On-Chain Auditability**: Every payment between agents is a real USDC transfer on Base, verifiable on BaseScan. The dashboard displays transaction hashes with direct links. A dedicated reasoning log shows why each payment was made, not just the transaction data.

**Locus Feedback API**: After each goal completes, the orchestrator submits usage feedback to Locus with task counts and spend totals.

**Self-Registering Wallets**: Agents self-register via the Locus beta API. The setup script handles wallet deployment and credential management.

## Architecture

Dispatch is designed around four architectural principles:

1. **Every agent owns its wallet.** Each agent has its own Locus API key and wallet address. No shared credentials, no central treasury. Agents pay for their own API calls.
2. **Payments are escrow-first.** Workers create Locus checkout sessions as merchants. The orchestrator verifies via preflight and pays after delivery.
3. **Discovery is marketplace-driven.** The orchestrator doesn't hardcode which agent to use. It queries the service registry and picks the cheapest capable provider.
4. **Everything is auditable.** Every action emits a structured event with reasoning context. The full decision trail is available at `/api/reasoning`.

```
src/
  config.js          Centralized agent definitions, rate limits, budget caps
  server.js          Express server, API routes, SSE streaming, webhook handler
  locus.js           Locus API client (wallets, payments, checkout, wrapped APIs, feedback)
  escrow.js          Escrow manager wrapping Locus checkout sessions
  registry.js        Service marketplace for agent discovery and pricing
  event-bus.js       Global event emitter for real-time timeline
  agents/
    base-agent.js    Base class: wallet, payments, email escrow, API calls, audit trail
    orchestrator.js  Discovers agents, manages budget, escrows, dispatches work
    research-agent.js  Web search via Exa + Firecrawl (Locus wrapped APIs)
    validator-agent.js Fact-checks research via Grok + Gemini (Locus wrapped APIs)
    writer-agent.js  Report synthesis via Gemini + Grok (Locus wrapped APIs)
tests/
  orchestrator.test.js  45 unit tests (node --test)
app/
  page.tsx           Next.js / React dashboard with SSE, @withlocus/checkout-react, Tailwind
```

To add a new agent: define it in `config.js`, create its class extending `BaseAgent`, and register its service. The orchestrator will discover and hire it automatically.

## Agents

| Agent | Role | Wallet | What It Does |
|-------|------|--------|--------------|
| Orchestrator | Coordinator | Own Locus wallet | Discovers agents from registry, verifies escrow, dispatches tasks, pays workers |
| Researcher | Worker/Merchant | Own Locus wallet | Searches the web via Exa and Firecrawl, creates checkout sessions |
| Validator | Worker | Shared wallet | Fact-checks research findings for accuracy via Grok or Gemini |
| Writer | Worker/Merchant | Own Locus wallet | Synthesizes research into reports via Gemini or Grok, creates checkout sessions |

Each agent has its own Locus API key, wallet address, and USDC balance. Workers create checkout sessions as merchants; the orchestrator pays after delivery. Workers pay for their own wrapped API calls. All payments are real USDC on Base.

## Service Registry

Agents advertise their capabilities and prices in a marketplace registry. The orchestrator queries this registry to find the cheapest capable agent for each subtask. Reputation scores break ties.

```
Web Research       $0.05/task   [research, search, scrape, data-gathering]
Fact Checking      $0.03/task   [validation, fact-checking, quality-assurance]
Report Synthesis   $0.05/task   [writing, synthesis, report, summarization]
```

Any new agent can register a service via `POST /api/registry/register` with a price and capabilities. The orchestrator will discover and hire it if it's the cheapest option.

## Payment Flow

1. Orchestrator checks its Locus wallet balance
2. Worker agent creates a Locus checkout session (merchant/seller)
3. Orchestrator runs preflight to verify the escrow is valid (buyer)
4. Worker performs the task (research or synthesis)
5. Orchestrator pays the checkout session -- USDC moves on-chain to the worker
6. Worker's Locus client polls session status until PAID is confirmed
7. Transaction is confirmed on Base and logged in the audit trail

If checkout escrow fails, the system falls back to direct wallet payment (with retry), then email escrow. Three independent payment methods ensure no silent fund loss.

## Safety

- **Rate limiting**: 15-second cooldown between goals, max 10 per hour, per-IP tracking
- **CORS + API key auth**: Cross-origin protection and optional API key for write endpoints
- **Unit tests**: 45 tests covering orchestrator, validator, registry, config, and input validation (`npm test`)
- **Security headers**: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy
- **Input validation**: Budget and maxPerTask must be positive finite numbers; goal length capped
- **URL sanitization**: Markdown renderer rejects non-HTTP URLs to prevent XSS from LLM output
- **Error sanitization**: Internal errors return generic messages to clients; details logged server-side only
- **Dynamic task planning**: Complex multi-faceted goals automatically decomposed into parallel research queries
- **Budget caps**: Hardcoded max $1.00 per goal, $0.25 per task
- **Spending controls**: Locus approval thresholds and allowance caps. Payments exceeding the threshold return an approval URL for human review, surfaced directly in the dashboard
- **Balance verification**: Orchestrator checks its wallet before starting
- **Escrow**: Funds locked before work begins, released only on delivery
- **Payment retry**: Failed payments retried with 2s delay before falling back to email escrow
- **Circuit breaker**: Prevents cascading failures when the Locus API is down; only trips on 5xx errors

## Setup

### Prerequisites

- Node.js 18+
- Locus agent wallets funded with USDC on Base

### Install

```bash
npm install
npm run build
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

Open http://localhost:3001 in your browser.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System status, agent info, service count |
| `/api/goal` | POST | Submit a goal for autonomous execution |
| `/api/balances` | GET | USDC balances for all agent wallets |
| `/api/registry` | GET | All registered services in the marketplace |
| `/api/registry/discover?q=` | GET | Search services by keyword |
| `/api/registry/register` | POST | Register an external agent's service |
| `/api/escrows` | GET | All escrow sessions and their status |
| `/api/transactions` | GET | On-chain USDC transactions from all agents |
| `/api/approvals` | GET | Payments held by Locus spending controls |
| `/api/timeline` | GET | Full event timeline |
| `/api/events/stream` | GET | Server-Sent Events stream (real-time) |
| `/api/audit` | GET | Complete audit trail for all agents |
| `/api/reasoning` | GET | Agent decision-making log with reasoning |
| `/api/agents` | GET | Agent names, roles, and wallet addresses |
| `/api/reputation` | GET | Agent reputation scores |
| `/api/webhooks/checkout` | POST | Locus webhook receiver (HMAC-SHA256 verified) |

## Dashboard

The web dashboard shows the full agent economy in real time:

- **Agent Network** -- wallet balances and addresses with BaseScan links
- **Goal Input** -- submit goals with budget controls
- **Payment Flow** -- 9-step stepper tracking the full pipeline
- **Marketplace** -- registered services with prices and capabilities
- **Spending Controls** -- payments held by Locus approval thresholds with clickable approval URLs
- **Live Timeline** -- real-time SSE stream of every agent action
- **Escrow Sessions** -- checkout sessions with Locus SDK embeds showing payment confirmation
- **On-Chain Transactions** -- every USDC transfer with BaseScan tx links
- **Agent Reasoning** -- decision-making log with full reasoning context
- **Report Output** -- the final synthesized report with markdown rendering and download
- **Locus Integration** -- 12 integrated Locus features displayed with status

## Tech Stack

- **Runtime**: Node.js + Express
- **Payments**: Locus API (wallets, checkout escrow, wrapped APIs, spending controls, email escrow, webhooks, feedback)
- **Checkout SDK**: @withlocus/checkout-react (embedded, popup, programmatic)
- **Chain**: Base (Ethereum L2)
- **Currency**: USDC
- **Search**: Exa + Firecrawl via Locus wrapped APIs
- **LLMs**: Gemini + Grok via Locus wrapped APIs
- **Frontend**: Next.js / React with SSE, Framer Motion, Tailwind CSS

## License

MIT

---

Built by Matthew Sullivan for The Synthesis hackathon.
