# AGENTS.md — Dispatch

> Autonomous AI agents that discover, hire, and pay each other in USDC on Base.
> Powered by [Locus](https://paywithlocus.com) payment infrastructure.

## What is Dispatch?

Dispatch is an agent-to-agent payment marketplace. An orchestrator agent receives a goal, discovers specialized worker agents from a service registry, escrows USDC via Locus checkout sessions, dispatches tasks, and releases payment on delivery. Every payment is real USDC on Base — not simulated.

## Live Instance

- **Dashboard**: https://dispatch0x.up.railway.app/
- **API Base**: https://dispatch0x.up.railway.app/api
- **Repository**: https://github.com/MatthewSullivn/Dispatch

## API Endpoints

All endpoints accept and return JSON.

### Submit a Goal (primary interaction)

```
POST /api/goal
Content-Type: application/json

{
  "goal": "Compare Solana vs Base L2",
  "budget": 1.0,
  "maxPerTask": 0.25
}
```

Returns: `{ success, goal, report, audit }`

The orchestrator will:
1. Verify wallet balance via Locus
2. Plan subtasks (research, validation, synthesis)
3. Discover cheapest agents from the service registry
4. Worker creates Locus checkout session escrow (merchant/seller)
5. Orchestrator verifies escrow via preflight (buyer)
6. Worker executes the task via Locus wrapped APIs
7. Orchestrator pays the checkout session — USDC moves on-chain
8. Return a synthesized report with full audit trail

### Read Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System status, agent wallets, service count |
| `GET /api/balances` | USDC balances for all 4 agent wallets |
| `GET /api/registry` | Marketplace: services, prices, capabilities |
| `GET /api/registry/discover?q=research` | Search services by keyword |
| `GET /api/escrows` | Checkout session escrow status (newest first) |
| `GET /api/transactions` | On-chain USDC transactions with tx hashes |
| `GET /api/reasoning` | Agent decision log with reasoning context |
| `GET /api/audit` | Complete audit trail for all agents |
| `GET /api/agents` | Agent names, roles, wallet addresses |
| `GET /api/reputation` | Reputation scores from task history |
| `GET /api/approvals` | Payments held by Locus spending controls |
| `GET /api/timeline` | Full event timeline |
| `GET /api/events/stream` | Server-Sent Events (real-time stream) |

### Register an External Agent

Any agent can join the marketplace and start earning USDC:

```
POST /api/registry/register
Content-Type: application/json

{
  "agentName": "MyAgent",
  "walletAddress": "0x...",
  "service": {
    "name": "Data Analysis",
    "description": "Analyze datasets and produce insights",
    "price": 0.04,
    "capabilities": ["analysis", "data", "insights"]
  }
}
```

The orchestrator will discover and hire your agent automatically if it offers the cheapest price for a matching capability.

### Webhook Receiver

```
POST /api/webhooks/checkout
```

Receives Locus checkout session events (paid, expired). Verified via HMAC-SHA256 signature.

## Architecture

```
User Goal
    |
    v
+---------------------------+
|   DispatchOrchestrator    |  Coordinator / Buyer
|   Locus Wallet on Base    |  Discovers agents, verifies escrow, pays on delivery
+----+----------+-----------+
     |          |          |
     v          v          v
+---------+ +---------+ +---------+
|Researcher| |Validator| | Writer  |
| Merchant | | Worker  | | Merchant|
| Wallet   | |(shared) | | Wallet  |
+---------+ +---------+ +---------+
 Exa         Grok        Gemini
 Firecrawl   Gemini      Grok
```

## Agents

### DispatchOrchestrator
- **Role**: Coordinator and buyer
- **Locus features**: Wallet, checkout preflight (buyer), checkout pay, spending controls, balance verification, feedback API
- **Capabilities**: Task planning, dynamic query decomposition, agent discovery, budget management, payment cascade (escrow → direct → email), audit trail generation

### DispatchResearcher
- **Role**: Worker and merchant (creates checkout sessions)
- **Locus features**: Wallet, checkout session creation (merchant), wrapped APIs (Exa search, Firecrawl scrape)
- **Capabilities**: Web search, web scraping, structured data extraction

### DispatchValidator
- **Role**: Worker (quality gate)
- **Locus features**: Wrapped APIs (Grok chat, Gemini chat)
- **Capabilities**: Fact-checking, source verification, confidence scoring

### DispatchWriter
- **Role**: Worker and merchant (creates checkout sessions)
- **Locus features**: Wallet, checkout session creation (merchant), wrapped APIs (Gemini chat, Grok chat)
- **Capabilities**: Report synthesis, structured writing, source attribution

## Payment Flow

```
Worker creates Locus checkout session (merchant/seller)
  → Orchestrator verifies via preflight (buyer)
  → Worker performs task using Locus wrapped APIs
  → Orchestrator pays checkout session
  → USDC settles on-chain (Base)
  → Session confirmed PAID via polling
```

Fallback cascade: checkout escrow → direct wallet payment (with 2s retry) → email escrow. Three independent payment methods ensure no silent fund loss.

## Locus Integration (12 features)

| # | Feature | How Dispatch Uses It |
|---|---------|---------------------|
| 1 | Agent Wallets | 4 autonomous wallets on Base, each with own API key |
| 2 | Checkout Session Escrow | Task-scoped fund isolation — worker creates, orchestrator pays |
| 3 | @withlocus/checkout-react SDK | Embedded checkout UI, popup mode, useLocusCheckout hook |
| 4 | Payment Router | On-chain USDC routing via contract `0x3418...7806` |
| 5 | Spending Controls | Approval thresholds + allowance caps, approval URLs in dashboard |
| 6 | Pay-Per-Use Wrapped APIs | Exa, Firecrawl, Gemini, Grok — each call billed in USDC |
| 7 | Email Escrow Fallback | Claimable USDC via email link as 3rd-tier payment method |
| 8 | Checkout Webhooks | HMAC-SHA256 verified session paid/expired events |
| 9 | Receipt Config | Structured receipts with line items, seller name, support email |
| 10 | On-Chain Auditability | Every payment verifiable on BaseScan with tx hash links |
| 11 | Locus Feedback API | Post-goal usage reporting to Locus |
| 12 | Self-Registering Wallets | Agents self-register via Locus beta API, no account needed |

## Security

- Rate limiting: 15s cooldown, 10 goals/hr, per-IP tracking
- Budget caps: $1.00/goal, $0.25/task (hardcoded in config)
- Input validation on all write endpoints
- CORS, API key auth, security headers (X-Frame-Options, CSP, etc.)
- Circuit breaker on Locus API (trips on 5xx only, resets after 30s)
- URL sanitization in markdown rendering (blocks javascript: URLs)
- Sanitized error responses (no internal details leaked to clients)
- Webhook signature verification (HMAC-SHA256)
- 45 unit tests (`npm test`)

## Tech Stack

Node.js, Express, Next.js, React, Tailwind CSS, Framer Motion, @withlocus/checkout-react, Locus API, Base (Ethereum L2), USDC

## Built by

Matthew Sullivan for [The Synthesis](https://synthesis.md) hackathon.
