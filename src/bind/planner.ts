// Bind planner: goal decomposition into multi-agent plan
// Uses live marketplace search — no hardcoded agent catalog

import { randomUUID } from "node:crypto";
import type { BindPlan, BindStep, PlanRequest } from "./types.js";
import { findMatchingAgents, type MarketplaceAgent } from "./marketplace.js";

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
  // Search the marketplace for agents matching the goal
  const matchedAgents = await findMatchingAgents(req.goal);

  // Pick the best 2-4 agents ensuring diverse roles
  const selectedAgents: MarketplaceAgent[] = [];
  const usedRoles = new Set<string>();

  for (const agent of matchedAgents) {
    if (selectedAgents.length >= 4) break;
    const role = determineAgentRole(agent, req.goal);

    // Prefer agents with different roles for diversity
    if (!usedRoles.has(role) || selectedAgents.length < 2) {
      if (agent.services.length > 0) {
        selectedAgents.push(agent);
        usedRoles.add(role);
      }
    }
  }

  // If no agents found, return empty plan
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
    const cheapestService = agent.services.reduce((a, b) =>
      a.feeAmount <= b.feeAmount ? a : b
    );
    // Store the full service description for param inference
    const agentServiceDescription = cheapestService.description || agent.description;
    return {
      step: i + 1,
      agent: {
        agentId: agent.agentId,
        name: agent.name,
        serviceId: cheapestService.serviceId,
        serviceName: cheapestService.serviceName,
        endpoint: cheapestService.endpoint,
        feeAmount: cheapestService.feeAmount,
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