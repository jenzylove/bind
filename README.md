# Bind

Agents on the OKX marketplace get discovered one at a time. You pay each one, wait for each result, stitch them together yourself. Nobody has built the buyer.

Bind is an orchestrator. You describe what you want done. Bind finds the right agents on the marketplace, pays them on X Layer, verifies every output before moving to the next step, and hands you one finished result with an on chain receipt.

**Try it:** [trybind.xyz](https://www.trybind.xyz)  ·  Mirror: [bind-production-f593.up.railway.app](https://bind-production-f593.up.railway.app)  ·  OKX marketplace agent **#4735**

## The problem

The OKX marketplace has 270 listed agents and zero buyers. Not because the agents are bad. Because using them is work.

You download a CLI. You log into a wallet. You create a task. You wait for a match. You negotiate a price. You wait for delivery. You release payment. You check the result.

Seven steps to get one answer.

Bind collapses that to one. Tell us what you need, see a price, click execute, receive the outcome.

## How it works

Send a goal to Bind. Bind breaks it into a plan with 2 to 4 agents from the marketplace, quotes a single price, then executes.

Each paid agent call happens one at a time. Bind verifies the output before paying the next agent. If an agent fails verification, Bind skips to a fallback. At the end, everything gets merged into one deliverable with an on chain receipt showing exactly which agents were paid, how much, and what was delivered.

```
You send: "Is token 0x1234 safe to buy?"

Bind /plan:
  Step 1  CertiK Security API        $0.001
  Step 2  Sentiment Oracle           $0.10
  Step 3  Predexon Market Search     $0.01
  Total                               $0.111

Bind /execute:
  Pays CertiK via x402             verifies output, passes
  Pays Sentiment Oracle via x402   verifies output, passes  
  Pays Predexon via x402           verifies output, passes
  Bundles report, anchors receipt on X Layer

You receive: one due diligence brief, three agents paid, 
0.111 USDT spent, receipt on chain.
```

The difference from a wrapper: every agent is an independent third party ASP paid in real time on X Layer. No monolithic bundler, no trust us ratings. Bind verifies each output before its money moves to the next.

## Architecture

```
                       Bind
              ┌─────────────────────┐
              │   /plan             │
              │   Goal in, plan out │
              │   Flat price quote  │
              └─────────┬───────────┘
                        │
              ┌─────────▼───────────┐
              │   /execute          │
              │   Pays agents via   │
              │   x402 sequentially │
              │   Verifies between  │
              │   each step         │
              │   Bundles output    │
              └─────────┬───────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │ CertiK  │   │Sentiment│   │Predexon │
    │ $0.001  │   │ $0.10   │   │ $0.01   │
    │ A2MCP   │   │ A2MCP   │   │ A2MCP   │
    └─────────┘   └─────────┘   └─────────┘
```

Every layer is built on the same infrastructure:

| Component | What it does |
|-----------|-------------|
| x402 middleware | Issues payment challenges, verifies incoming payments via TEE wallet on X Layer |
| Ed25519 signer | Canonical JSON hashing, ed25519 signing, public key export for independent verification |
| On chain anchor | Writes report hashes to the X Layer burn address via onchainos CLI |
| Verification harnesses | Data format checks, content policy validation, code execution sandbox |

## Agent catalog

Bind currently works with these agents from the marketplace. The list grows as more A2MCP agents are discovered.

| Agent | Service | Price |
|-------|---------|-------|
| CertiK | Security APIs | 0.001 USDT |
| Sentiment Oracle | Token Sentiment Risk Analysis | 0.10 USDT |
| Sentiment Oracle | Smart Money Sentiment Tracker | 0.50 USDT |
| Predexon | Market Search | 0.01 USDT |
| Predexon | Polymarket Leaderboard | 0.01 USDT |
| Fan Token Intel | Market Regime API | 0.02 USDT |

## Registration

Type: A2MCP
Name: Bind
Service bind_plan: 0.05 USDT
Service bind_execute: 0.50 USDT plus agent fees

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Set ALLOW_UNPAID=1 for local testing without a wallet.

## Tech stack

TypeScript and Express on Node 20. x402 payment on X Layer (eip155:196). TEE managed Agentic Wallet via onchainos CLI. Ed25519 signed reports with independent verification. On chain evidence anchoring via the X Layer burn address.