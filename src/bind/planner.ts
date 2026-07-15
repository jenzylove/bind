// Bind planner: goal decomposition into multi-agent plan
// Uses live marketplace search — no hardcoded agent catalog

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BindPlan, BindStep, PlanRequest } from "./types.js";
import { findMatchingAgentsScored, type MarketplaceAgent, type MarketplaceService } from "./marketplace.js";
import { selectAgents, type SelectCandidate } from "./select.js";
import { repSummary, isProvenBad } from "./reputation.js";

// Guardrails so an auto-plan is never surprising or nonsensical.
const PER_STEP_FEE_CEILING = 0.60;   // ceiling for tested-payable agents
const UNTESTED_FEE_CEILING = 0.05;   // never gamble much on an unproven agent (e.g. Messari lists $0.10, then 403s or overcharges)
const MAX_TOTAL_USDT = 1.5;          // cap the whole quote

// Tested-payable-AND-data-usable agents. A live probe (scripts/probe-payability.mjs)
// signs a real x402 payment against each marketplace agent; most third-party sellers
// reject even a correctly-signed payment. Of those that settle, some still return no
// usable one-shot data (AlphaHunter #4215 is a non-standard MCP server; Clawby #3209 is
// a credit-topup, not a data call) — those are excluded. We bias hard to agents that
// both pay out AND return real data. Loaded from data/payable-agents.json (re-runnable).
const FALLBACK_PAYABLE = ["2023", "4413", "3417", "3887", "5222", "4759", "3808", "2080", "4380", "3650", "5221", "2567", "2131", "4848"];
// Settle-but-unusable agents: kept out even if a probe lists them.
const EXCLUDE_IDS = new Set(["4215", "3209"]); // AlphaHunter (MCP, no REST data), Clawby (topup)

interface PayableEndpoint { endpoint: string; fee: number; service: string; name: string; tier: string; params?: Record<string, string> | null; }
function loadPayable(): { ids: Set<string>; endpoints: Map<string, PayableEndpoint> } {
  const endpoints = new Map<string, PayableEndpoint>();
  try {
    const dir = process.env.BIND_DATA_DIR ?? "data";
    const raw = JSON.parse(readFileSync(join(dir, "payable-agents.json"), "utf8"));
    const ids = Array.isArray(raw.payableIds) ? raw.payableIds.map(String) : [];
    for (const [id, ep] of Object.entries(raw.endpoints ?? {})) endpoints.set(String(id), ep as PayableEndpoint);
    const set = new Set<string>([...ids, ...FALLBACK_PAYABLE].filter((id) => !EXCLUDE_IDS.has(id)));
    return { ids: set, endpoints };
  } catch {
    return { ids: new Set<string>(FALLBACK_PAYABLE), endpoints };
  }
}
const { ids: PAYABLE_AGENT_IDS, endpoints: PAYABLE_ENDPOINTS } = loadPayable();

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
// The service Bind will actually call. For a tested-payable agent we pin the exact
// endpoint the settlement test confirmed works (often NOT the cheapest — a cheaper sibling
// service is frequently a dead 404). Everyone else falls back to the cheapest service.
function chosenService(agent: MarketplaceAgent): MarketplaceService {
  const o = PAYABLE_ENDPOINTS.get(agent.agentId);
  if (o) {
    const live = agent.services.find((s) => s.endpoint === o.endpoint);
    if (live) return live;
    return { serviceId: "", serviceName: o.service, serviceType: "A2MCP", feeAmount: o.fee, endpoint: o.endpoint, description: "" };
  }
  return cheapestService(agent);
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
    if (EXCLUDE_IDS.has(agent.agentId)) return false; // settle-but-unusable (MCP/topup) — never route to these
    // Fired by its own record: repeatedly hired, never delivered verified work.
    if (isProvenBad(agent.agentId, agent.name)) return false;
    const fee = chosenService(agent).feeAmount;
    const payable = PAYABLE_AGENT_IDS.has(agent.agentId);
    // Tested-payable agents get the full ceiling; unproven agents are capped low so a
    // pricey gamble (that usually 403s or overcharges) never bloats the quote.
    if (fee > (payable ? PER_STEP_FEE_CEILING : UNTESTED_FEE_CEILING)) return false;
    if (analytical && isActionAgent(agent)) return false;
    return true;
  });

  // Pre-rank payable-first (used both as the AI candidate order and the heuristic fallback).
  eligible.sort((a, b) => {
    const aPay = PAYABLE_AGENT_IDS.has(a.agent.agentId) ? 1 : 0;
    const bPay = PAYABLE_AGENT_IDS.has(b.agent.agentId) ? 1 : 0;
    if (aPay !== bPay) return bPay - aPay;
    return b.score - a.score;
  });

  const selectedAgents: MarketplaceAgent[] = [];
  let runningTotal = 0;

  // Smart routing: let Claude pick from the whole eligible catalog (semantic fit +
  // payability + complementarity). This is what scales Bind to any goal across the
  // full marketplace without a hand-tuned agent list.
  const byId = new Map(eligible.map((e) => [e.agent.agentId, e.agent]));
  const candidates: SelectCandidate[] = eligible.map(({ agent }) => {
    const svc = chosenService(agent);
    return {
      agentId: agent.agentId,
      name: agent.name,
      category: determineAgentRole(agent, req.goal),
      // Prefer the service's own description; the vendor profile is the weaker signal.
      description: svc.description || agent.description,
      service: svc.serviceName,
      cheapestFee: svc.feeAmount,
      payable: PAYABLE_AGENT_IDS.has(agent.agentId),
      track: repSummary(agent.agentId, agent.name),
    };
  });
  // Cap the crew at 3. The router used to pad to 4, which hired near-duplicate agents
  // (three "market data" specialists on one brief). Every extra hire is another charge to
  // the buyer and another chance to fail, so a smaller, distinct crew is strictly better.
  const picks = await selectAgents(req.goal, candidates, 3);
  if (picks) {
    for (const p of picks) {
      const agent = byId.get(p.agentId);
      if (!agent) continue;
      const fee = chosenService(agent).feeAmount;
      if (runningTotal + fee > MAX_TOTAL_USDT) continue;
      selectedAgents.push(agent);
      runningTotal += fee;
    }
  }

  // Heuristic fallback (no AI key, or AI returned nothing): payable-first, role-diverse.
  if (selectedAgents.length === 0) {
    const usedRoles = new Set<string>();
    for (const { agent } of eligible) {
      if (selectedAgents.length >= 3) break;
      const fee = chosenService(agent).feeAmount;
      if (runningTotal + fee > MAX_TOTAL_USDT) continue;
      const role = determineAgentRole(agent, req.goal);
      const payable = PAYABLE_AGENT_IDS.has(agent.agentId);
      if (!payable && usedRoles.has(role) && selectedAgents.length >= 2) continue;
      selectedAgents.push(agent);
      usedRoles.add(role);
      runningTotal += fee;
    }
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

  // Nominate a stand-in for each hire: a tested-payable agent covering the same role that
  // wasn't already hired. If the primary flakes without taking payment, the executor can
  // hire the stand-in inside the same budget instead of shipping a thinner brief.
  const selectedIds = new Set(selectedAgents.map((a) => a.agentId));
  function standInFor(agent: MarketplaceAgent): MarketplaceAgent | undefined {
    const role = determineAgentRole(agent, req.goal);
    return eligible
      .map((e) => e.agent)
      .find((cand) =>
        !selectedIds.has(cand.agentId) &&
        PAYABLE_AGENT_IDS.has(cand.agentId) &&
        determineAgentRole(cand, req.goal) === role &&
        chosenService(cand).feeAmount <= chosenService(agent).feeAmount + 0.02);
  }

  const steps: BindStep[] = selectedAgents.map((agent, i) => {
    const svc = chosenService(agent);
    // Store the full service description for param inference
    const agentServiceDescription = svc.description || agent.description;
    const backup = standInFor(agent);
    const backupSvc = backup ? chosenService(backup) : undefined;
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
      boundParams: PAYABLE_ENDPOINTS.get(agent.agentId)?.params ?? undefined,
      // Shown to the buyer so the crew is justified by evidence, not vibes.
      track: repSummary(agent.agentId, agent.name) ?? undefined,
      fallbackAgent: backup && backupSvc ? {
        agentId: backup.agentId,
        name: backup.name,
        serviceId: backupSvc.serviceId,
        serviceName: backupSvc.serviceName,
        endpoint: backupSvc.endpoint,
        feeAmount: backupSvc.feeAmount,
        feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        category: determineAgentRole(backup, req.goal) as any,
      } : undefined,
      fallbackServiceDescription: backupSvc ? (backupSvc.description || backup!.description) : undefined,
      inputTemplate: { q: req.goal },
      verificationType: "data",
      verificationCriteria: "Agent returned structured output",
    };
  });

  const priceBreakdown = steps.map((s) => ({
    agentName: s.agent.name,
    fee: s.agent.feeAmount,
  }));
  // Bind's revenue: a small platform fee on top of what the agents charge — 2% + a $0.03
  // flat commission (a pure % of cent-sized jobs would round to nothing). The buyer pays
  // agentCost + platformFee to Bind; Bind pays the agents and keeps the fee.
  const agentCost = round6(steps.reduce((sum, s) => sum + s.agent.feeAmount, 0));
  const platformFee = round6(agentCost * 0.02 + 0.03);
  const totalPriceUsdt = round6(agentCost + platformFee);

  return {
    planId: randomUUID(),
    goal: req.goal,
    steps,
    agentCost,
    platformFee,
    totalPriceUsdt,
    priceBreakdown,
    estimatedTime: `~${steps.length * 15} seconds`,
    createdAt: new Date().toISOString(),
  };
}

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }