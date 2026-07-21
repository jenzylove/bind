// Flagship mission: a REAL dependency graph, not a batch of parallel calls.
//
// When a buyer hands Bind a token address to vet, Bind runs a chain where each step
// consumes the VERIFIED output of the one before it:
//
//   1. resolve  — Onchain Data Explorer get_token_info(address) -> the token's real
//                 symbol, name, supply. This is the GATE: if the address is not a real
//                 token, this step fails and everything downstream is blocked (Bind
//                 declines honestly instead of inventing an audit).
//   2. holders  — Top Token Holders for that same, now-confirmed token -> concentration.
//                 dependsOn resolve, so it never runs on an unverified token.
//   3. sentiment— Newsliquid news_search keyed on the SYMBOL that step 1 extracted. The
//                 buyer only gave an address; step 3 searches by a symbol it could only
//                 get from step 1's output. This is the undeniable data-flow dependency.
//
// This is what separates an orchestrator from a chatbot: step 2 receives what step 1
// actually produced, and a failed dependency stops the chain.
import { randomUUID } from "node:crypto";
import type { BindPlan, BindStep } from "./types.js";

const USDT_TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const OKX = "https://www.oklink.com/api/v5/explorer/mcp/x402";

// A token-vetting goal that names a specific contract address.
export function isFlagshipGoal(goal: string): boolean {
  const hasAddress = /0x[a-fA-F0-9]{40}/.test(goal);
  const vetting = /\b(token|audit|coin|buy|ape|aping|rug|safe|invest|worth|due diligence|vet|legit|scam|holders?)\b/i.test(goal);
  return hasAddress && vetting;
}

function step(n: number, agentId: string, name: string, serviceName: string, endpoint: string, fee: number, category: string, extra: Partial<BindStep>): BindStep {
  return {
    step: n,
    agent: { agentId, name, serviceId: "", serviceName, endpoint, feeAmount: fee, feeToken: USDT_TOKEN, category: category as any },
    agentServiceDescription: serviceName,
    inputTemplate: {},
    verificationType: "data",
    ...extra,
  };
}

export function buildFlagshipPlan(goal: string): BindPlan {
  const addr = (goal.match(/0x[a-fA-F0-9]{40}/) ?? [USDT_TOKEN])[0];

  const steps: BindStep[] = [
    // 1. Resolve + gate. boundParams: $TOKEN is substituted with the address in the goal.
    step(1, "2023", "Onchain Data Explorer", "Token Metadata", `${OKX}/get_token_info`, 0.000015, "onchain", {
      nodeId: "resolve",
      boundParams: { chainIndex: "196", tokenAddress: "$TOKEN" },
    }),
    // 2. Concentration for the confirmed token. Blocked if resolve did not verify.
    step(2, "2023", "Onchain Data Explorer", "Top Token Holders", `${OKX}/get_token_holders_top_n`, 0.000075, "onchain", {
      nodeId: "holders",
      dependsOn: ["resolve"],
      boundParams: { chainIndex: "196", tokenAddress: "$TOKEN", limit: "10" },
    }),
    // 3. Sentiment keyed on the SYMBOL step 1 resolved from the address. The heart of the
    //    graph: this query exists only because resolve produced it.
    step(3, "2135", "Newsliquid", "OpenNews News Search", "https://x402.6551.io/okx/news_search", 0.002, "sentiment", {
      nodeId: "sentiment",
      dependsOn: ["resolve"],
      inputMap: { q: "resolve.data.symbol", keyword: "resolve.data.symbol", keywords: "resolve.data.symbol" },
    }),
  ];

  const agentCost = round6(steps.reduce((s, x) => s + x.agent.feeAmount, 0));
  const platformFee = round6(agentCost * 0.02 + 0.03);
  return {
    planId: randomUUID(),
    goal,
    steps,
    agentCost,
    platformFee,
    totalPriceUsdt: round6(agentCost + platformFee),
    priceBreakdown: steps.map((s) => ({ agentName: s.agent.name, fee: s.agent.feeAmount })),
    estimatedTime: "~45 seconds",
    createdAt: new Date().toISOString(),
    flagship: true,
  };
}

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }
