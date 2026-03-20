# AGENTS.md — Dispatch

## What is this?

Dispatch is an autonomous agent-to-agent service network where specialized AI agents hire and pay each other through Locus payment infrastructure on Base. Every payment flows in USDC, governed by spending controls, with a full audit trail.

## Architecture

```
User Goal
    ↓
┌─────────────────────────┐
│   Orchestrator Agent    │  ← receives goal, plans subtasks, manages budget
│   Locus Wallet + Policy │
└────┬──────────┬─────────┘
     │          │
     ↓          ↓
┌─────────┐ ┌─────────┐
│Research │ │ Writer  │
│ Agent   │ │ Agent   │
│ Wallet  │ │ Wallet  │
└─────────┘ └─────────┘
```

## Agents

### MeshOrchestrator
- **Role**: Coordinator — breaks goals into subtasks, dispatches to workers, manages budget, pays on completion
- **Locus features used**: Wallet, spending controls, USDC payments, transaction audit trail
- **Capabilities**: Task planning, budget enforcement, worker coordination, audit generation

### MeshResearcher
- **Role**: Data gatherer — scrapes websites and searches the web
- **Locus features used**: Wallet (receives payment), Wrapped APIs (Firecrawl, Exa)
- **Capabilities**: Web scraping, search, data extraction

### MeshWriter
- **Role**: Content synthesizer — turns research into structured reports
- **Locus features used**: Wallet (receives payment), Wrapped APIs (OpenAI)
- **Capabilities**: Report generation, content synthesis

## Locus Integration

- **Wallets**: Each agent has its own Locus wallet on Base
- **Payments**: Orchestrator pays workers in USDC for completed tasks
- **Spending Controls**: Budget limits enforced per-agent and per-task
- **Wrapped APIs**: Agents use Locus pay-per-use APIs (Firecrawl, Exa, OpenAI) — costs deducted from their wallets
- **Audit Trail**: Every action and payment is logged for full transparency

## How to interact

- **POST /api/goal** — Submit a goal with optional budget parameters
- **GET /api/balances** — View all agent wallet balances
- **GET /api/audit** — Full audit trail of all agent actions and payments
- **GET /api/agents** — List all agents and their wallets
- **GET /api/health** — System status

## Tech Stack

- Node.js + Express
- Locus Payment API (direct REST calls)
- Base chain (USDC)
- Claude Code (agent harness)
