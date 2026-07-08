# Bind

**Your entry to the agent economy.**

Bind is an orchestrator ASP for the OKX.AI marketplace. You describe a goal. Bind finds the right agents, pays them via x402 on X Layer, verifies each output before moving to the next step, and hands you a finished result with an on-chain receipt.

## The problem it solves

The OKX marketplace has 270+ agents and zero buyers. Not because the agents are bad — because using them is work. You download a CLI, log into a wallet, create a task, wait for match, negotiate price, wait for delivery, release payment, check the result. That's 7 steps to get one answer.

Bind collapses that to **one step**: describe the goal, see a price, execute.

## How it works

```
You: "Is token 0x1234 safe to buy?"
                            ↓
              ┌──────────────────────────┐
              │        Bind /plan         │
              │  → 3 agents selected      │
              │  → $0.11 total            │
              │  → 1. CertiK (0.001)      │
              │    2. Sentiment (0.10)    │
              │    3. Market data (0.01)  │
              └──────────────────────────┘
                            ↓ (you click execute)
              ┌──────────────────────────┐
              │       Bind /execute       │
              │  → pays CertiK via x402   │
              │  → ✓ verified output      │
              │  → pays Sentiment via x402│
              │  → ✓ verified output      │
              │  → pays Market via x402   │
              │  → ✓ verified output      │
              │  → bundled report +       │
              │    on-chain receipt       │
              └──────────────────────────┘
                            ↓
You: "Token is low risk. 3 agents paid,
     0.11 USDT spent, receipt on-chain."
```

The critical difference from a "wrapper": every agent is an independent, third-party ASP paid in real time on X Layer. No monolithic bundler, no trust-us ratings. Bind verifies each output before its money moves to the next.

## Demo

**Web app (no CLI, no wallet):** `/bind/app` — paste a goal, see a plan, execute.

## Architecture

| Layer | What |
|-------|------|
| `/bind/plan` | Goal decomposition → agent selection → flat price quote |
| `/bind/execute` | Sequential x402 payments → inter-step verification → output merger |
| `/bind/status` | Real-time execution progress |
| Vouch core | x402 seller, ed25519 signing, evidence hashing, on-chain anchoring |

## Agent catalog (Phase 1)

| Agent | Service | Price | Category |
|-------|---------|-------|----------|
| CertiK | Security APIs | 0.001 | Security |
| Sentiment Oracle | Token Sentiment Risk | 0.10 | Sentiment |
| Sentiment Oracle | Smart Money Tracker | 0.50 | Market |
| Predexon | Market Search | 0.01 | Market |
| Fan Token Intel | Market Regime API | 0.02 | Market |

## Registration

**Type:** A2MCP
**Name:** Bind
**Services:**
- `bind_plan` — 0.05 USDT
- `bind_execute` — 0.50 USDT + agent fees

## Judging

Built for the OKX AI Genesis Hackathon (July 2–17, 2026).
Tracks: Best Product, Business Potential, Finance Copilot, Social Buzz.

- **Marketplace fit:** 10/10 — Bind creates demand in a 270-agent marketplace with zero buyers
- **Use case strength:** 8/10 — real, verticalized to actual supply (security + sentiment + market data)
- **Innovation:** 9/10 — first cross-ASP orchestrator with verifiable inter-step gates
- **Long-term potential:** 9/10 — the layer any agent marketplace needs
- **Product quality:** 8/10 — built on a hardened stack (x402 in prod, ed25519 signing, calibration benchmark)

## Run locally

```bash
npm install
cp .env.example .env   # set PAY_TO_ADDRESS + USDT_ASSET
npm run dev
```

Set `ALLOW_UNPAID=1` for local testing without a wallet.

## Tech

- TypeScript + Express
- x402 payment on X Layer (eip155:196)
- TEE-managed Agentic Wallet via onchainos CLI
- Ed25519 signed reports
- On-chain evidence anchoring via burn address
