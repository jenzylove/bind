// Bind planner: goal decomposition into multi-agent plan
// Uses live marketplace search — no hardcoded agent catalog

import { randomUUID } from "node:crypto";
import type { BindPlan, BindStep, PlanRequest } from "./types.js";
import { findMatchingAgentsScored, type MarketplaceAgent, type MarketplaceService } from "./marketplace.js";

// Guardrails so an auto-plan is never surprising or nonsensical.
const PER_STEP_FEE_CEILING = 0.60; // never silently add a pricey agent (e.g. a $3.30 token launcher)
const MAX_TOTAL_USDT = 1.5;        // cap the whole quote
// Agents the executor has verified parameter mappings for — strongly preferred so
// plans actually execute rather than erroring on wrong params.
const EXECUTABLE_AGENT_IDS = new Set(["2023", "2135", "2013", "2012"]);

// An analytical goal ("is this safe", "research X", "sentiment on Y") must never
// select an agent whose job is to take an action (launch/mint/swap/deploy).
function goalIsAnalytical(goal: string): boolean {
  return /\b(safe|risk|research|analy|audit|check|is |are |should|vs\b|due diligence|sentiment|news|price|review|verify|scan|report|brief|explain|find|look up|holders?)\b/i.test(goal);
}
function isActionAgent(agent: MarketplaceAgent): boolean {
  const t = `${agent.name} ${agent.description}`.toLowerCase();
  return /(launch|mint|deploy|create token|token creation|swap|\bbuy\b|\bsell\b|bridge|stake|airdrop a)/.test(t);
}
function cheapestService(agent: MarketplaceAgent): MarketplaceService {
  return agent.services.reduce((a, b) => (a.feeAmount <= b.feeAmount ? a : b));
}

function determineAgentRole(agent: MarketplaceAgent, goal: string): string {
  const desc = `${agent.name} ${agent.description}`.toLowerCase();
  const goalLower = goal.toLowerCase();

  if (desc.includes("security") || desc.includes("scan") || desc.includes("risk") || desc.includes("audit") || desc.includes("verify")) {
    return "security";
  }
  if (desc.includes("sentiment") || desc.includes("social") || desc.includes("news") || desc.includes("twitter") || desc.includes("kol")) {
    return "sentiment";
  }
  if (desc.includes("market") || desc.includes("data") || desc.includes("price") || desc.includes("trading") || desc.includes("derivatives")) {
    return "market_data";
  }
  if (desc.includes("onchain") || desc.includes("explorer") || desc.includes("wallet") || desc.includes("blockchain")) {
    return "onchain";
  }
  if (desc.includes("content") || desc.includes("image") || desc.includes("art") || desc.includes("video")) {
    return "content";
  }
  if (desc.includes("swap") || desc.includes("yield") || desc.includes("stake") || desc.includes("defi")) {
    return "defi";
  }

  return "general";
}

export async function createPlan(req: PlanRequest): Promise<BindPlan> {
  const analytical = goalIsAnalytical(req.goal);
  const scored = await findMatchingAgentsScored(req.goal);

  // Hard guardrails: must have a callable service, must be affordable, and must not
  // be an action agent when the goal is analytical. These prevent the "surprise
  // $3.30 meme-launcher on a safety question" failure mode.
  const eligible = scored.filter(({ agent }) => {
    if (agent.services.length === 0) return false;
    if (cheapestService(agent).feeAmount > PER_STEP_FEE_CEILING) return false;
    if (analytical && isActionAgent(agent)) return false;
    return true;
  });

  // Rank: agents the executor can call correctly first, then by relevance score.
  eligible.sort((a, b) => {
    const aExec = EXECUTABLE_AGENT_IDS.has(a.agent.agentId) ? 1 : 0;
    const bExec = EXECUTABLE_AGENT_IDS.has(b.agent.agentId) ? 1 : 0;
    if (aExec !== bExec) return bExec - aExec;
    return b.score - a.score;
  });

  // Select up to 4, preferring role diversity, and never exceeding the total cap.
  const selectedAgents: MarketplaceAgent[] = [];
  const usedRoles = new Set<string>();
  let runningTotal = 0;

  for (const { agent } of eligible) {
    if (selectedAgents.length >= 4) break;
    const fee = cheapestService(agent).feeAmount;
    if (runningTotal + fee > MAX_TOTAL_USDT) continue;
    const role = determineAgentRole(agent, req.goal);
    // Prefer new roles for diversity; still allow same-role until we have 2 steps.
    if (usedRoles.has(role) && selectedAgents.length >= 2) continue;
    selectedAgents.push(agent);
    usedRoles.add(role);
    runningTotal += fee;
  }

  // If no agents qualify, return empty plan
  if (selectedAgents.length === 0) {
    return {
      planId: randomUUID(),
      goal: req.goal,
      steps: [],
      totalPriceUsdt: 0,
      priceBreakdown: [],
      estimatedTime: "N/A",
      createdAt: new Date().toISOString(),
      note: "No compatible agents found on the marketplace for this goal. Try a different description.",
    };
  }

  const steps: BindStep[] = selectedAgents.map((agent, i) => {
    const svc = cheapestService(agent);
    // Store the full service description for param inference
    const agentServiceDescription = svc.description || agent.description;
    return {
      step: i + 1,
      agent: {
        agentId: agent.agentId,
        name: agent.name,
        serviceId: svc.serviceId,
        serviceName: svc.serviceName,
        endpoint: svc.endpoint,
        feeAmount: svc.feeAmount,
        feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        category: determineAgentRole(agent, req.goal) as any,
      },
      agentServiceDescription,
      inputTemplate: { q: req.goal },
      verificationType: "data",
      verificationCriteria: "Agent returned structured output",
    };
  });

  const priceBreakdown = steps.map((s) => ({
    agentName: s.agent.name,
    fee: s.agent.feeAmount,
  }));
  const totalPriceUsdt = steps.reduce((sum, s) => sum + s.agent.feeAmount, 0);

  return {
    planId: randomUUID(),
    goal: req.goal,
    steps,
    totalPriceUsdt,
    priceBreakdown,
    estimatedTime: `~${steps.length * 15} seconds`,
    createdAt: new Date().toISOString(),
  };
}