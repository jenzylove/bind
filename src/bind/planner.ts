// Bind planner: goal decomposition into multi-agent plan
// Uses live marketplace search — no hardcoded agent catalog

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BindAgent, BindPlan, BindStep, PlanRequest } from "./types.js";
import { findMatchingAgentsScored, type MarketplaceAgent, type MarketplaceService } from "./marketplace.js";
import { selectAgents, type SelectCandidate } from "./select.js";
import { repSummary, isProvenBad } from "./reputation.js";
import { serviceReliabilityPenalty, serviceReliabilitySummary } from "./service-reliability.js";
import { isFlagshipGoal, buildFlagshipPlan } from "./flagship.js";
import { detectGoalDomain, domainMismatchReason, serviceMatchesGoalDomain } from "./routing-fit.js";

// Guardrails so an auto-plan is never surprising or nonsensical.
const PER_STEP_FEE_CEILING = 0.60;   // ceiling for tested-payable agents
const UNTESTED_FEE_CEILING = 0.12;   // reach genuinely useful unproven agents (travel, prediction ~$0.10) while capping the loss if one takes payment then fails; the dynamic fallback bounds this to one paid attempt per role
const MAX_TOTAL_USDT = 1.5;          // cap the whole quote

// Tested-payable-AND-data-usable agents. A live probe (scripts/probe-payability.mjs)
// signs a real x402 payment against each marketplace agent; most third-party sellers
// reject even a correctly-signed payment. Of those that settle, some still return no
// usable one-shot data (AlphaHunter #4215 is a non-standard MCP server; Clawby #3209 is
// a credit-topup, not a data call) — those are excluded. We bias hard to agents that
// both pay out AND return real data. Loaded from data/payable-agents.json (re-runnable).
const FALLBACK_PAYABLE = ["2023", "4413", "3417", "3887", "5222", "4759", "3808", "2080", "4380", "3650", "5221", "2567", "2131", "4848"];
// Settle-but-unusable agents: kept out even if a probe lists them.
const EXCLUDE_IDS = new Set(["4215", "3209", "5421", "6676"]); // AlphaHunter (MCP, no REST data), Clawby (topup), PixelBrief/Synesthesia (dead endpoints)

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
// Re-read the allowlist with a short TTL (instead of once at boot) so agents the nightly
// auto-probe admits become hireable without a redeploy.
let _payable = loadPayable();
let _payableAt = Date.now();
function payableNow() {
  if (Date.now() - _payableAt > 10 * 60_000) { _payable = loadPayable(); _payableAt = Date.now(); }
  return _payable;
}
const PAYABLE_AGENT_IDS = { has: (id: string) => payableNow().ids.has(id) };
const PAYABLE_ENDPOINTS = { get: (id: string) => payableNow().endpoints.get(id) };

// An analytical goal ("is this safe", "research X", "sentiment on Y") must never
// select an agent whose job is to take an action (launch/mint/swap/deploy).
function goalIsAnalytical(goal: string): boolean {
  return /\b(safe|risk|research|analy|audit|check|is |are |should|vs\b|due diligence|sentiment|news|price|review|verify|scan|report|brief|explain|find|look up|holders?)\b/i.test(goal);
}
function isActionAgent(agent: MarketplaceAgent): boolean {
  const t = `${agent.name} ${agent.description}`.toLowerCase();
  return /(launch|mint|deploy|create token|token creation|swap|\bbuy\b|\bsell\b|bridge|stake|airdrop a)/.test(t);
}
function goalIsClearlyNonCrypto(goal: string): boolean {
  return /\b(cv|resume|curriculum vitae|cover letter|job application|jobs?|hiring|career|portfolio|linkedin|interview|personal statement)\b/i.test(goal);
}
function isFinancialMarketService(agent: MarketplaceAgent, service: MarketplaceService): boolean {
  const text = `${agent.name} ${agent.description} ${agent.category} ${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
  return /\b(crypto|token|onchain|on-chain|blockchain|wallet|defi|dex|swap|bridge|x layer|xlayer|trading|trade|traders|market|markets|market cap|price|price feed|chart|charts|tradingview|rsi|macd|ohlcv|perp|futures|funding|liquidity|holders|honeypot|rug|kol sentiment|whale|polymarket|prediction market)\b/.test(text);
}
function supportsCareerDocumentGoal(agent: MarketplaceAgent, service: MarketplaceService): boolean {
  const text = `${agent.name} ${agent.description} ${agent.category} ${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
  return /\b(cv|resume|curriculum vitae|cover letter|job application|career|linkedin|portfolio|document|docx|pdf|writing|writer|copy|content|plain-language request|summaries|web search|research assistant|chat completion|managed agent task|task execution)\b/.test(text);
}
function cheapestService(agent: MarketplaceAgent): MarketplaceService {
  return agent.services.reduce((a, b) => (a.feeAmount <= b.feeAmount ? a : b));
}
const TOKEN_SYMBOL_STOPWORDS = new Set([
  "AI", "API", "APIS", "CV", "DOC", "DOCX", "PDF", "PPT", "PPTX", "UI", "UX",
  "CEO", "CTO", "CFO", "COO", "HR", "JD", "KPI", "OKX", "MCP", "A2MCP",
]);
const COMMON_CRYPTO_SYMBOLS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "HYPE", "OKB", "USDT", "USDC"]);
function goalHasSpecificToken(goal: string): boolean {
  if (/\$[A-Za-z][A-Za-z0-9]{1,11}\b/.test(goal)) return true;
  const bare = goal.match(/\b[A-Z][A-Z0-9]{1,11}\b/g) ?? [];
  return bare.some((sym) =>
    !TOKEN_SYMBOL_STOPWORDS.has(sym) && (COMMON_CRYPTO_SYMBOLS.has(sym) || sym.length >= 3)
  );
}
function goalHasContractAddress(goal: string): boolean {
  return /0x[a-fA-F0-9]{40}/.test(goal);
}
function isStockOrEquityService(service: MarketplaceService): boolean {
  const text = `${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
  return /(?:stock|stocks|equity|equities|share price|tokenized share|company headlines|analyst research)/.test(text);
}
function serviceSupportsSpecificToken(service: MarketplaceService, goal = ""): boolean {
  const text = `${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
  const symbolAware = /(?:token symbol|symbol or contract|symbol, name|symbol name|coin parameter|coingecko id|market symbol|ticker|asset as|chain and asset|optional token|optional topic|any token|single token|crypto price|token fundamentals)/.test(text);
  const contractOnly = /(?:token contract address|contract address)/.test(text) && !symbolAware;
  if (goal && goalHasSpecificToken(goal) && !goalHasContractAddress(goal) && contractOnly) return false;
  return symbolAware || /(?:token contract|contract address)/.test(text);
}
function serviceRelevanceScore(service: MarketplaceService, goal: string, agentId?: string): number {
  const goalLower = goal.toLowerCase();
  const text = `${service.serviceName} ${service.description ?? ""} ${service.endpoint}`.toLowerCase();
  let score = 0;

  for (const word of goalLower.split(/[^a-z0-9$]+/)) {
    const normalized = word.replace(/^\$/, "");
    if (normalized.length > 2 && text.includes(normalized)) score += 4;
  }

  if (goalHasSpecificToken(goal)) {
    for (const signal of [
      "token", "symbol", "asset", "price", "market", "chart", "technical",
      "sentiment", "social", "news", "kol", "alpha", "funding", "hyperliquid",
      "contract", "futures",
    ]) {
      if (text.includes(signal)) score += 8;
    }
    if (isStockOrEquityService(service)) score -= 60;
    if (!goalHasContractAddress(goal) && /(?:token contract address|contract address)/.test(text) && !/(?:token symbol|symbol, name|coin parameter|market symbol|ticker|asset as|chain and asset)/.test(text)) {
      score -= 30;
    }
    for (const generic of [
      "defi macro", "macro overview", "valuation multiples", "supported chains",
      "yield", "top pools", "bridge", "swap", "portfolio",
    ]) {
      if (text.includes(generic)) score -= 10;
    }
  }

  score -= serviceReliabilityPenalty(agentId, service.serviceName, service.endpoint);
  return score;
}
// The service Bind will actually call. For a tested-payable agent we pin the exact
// endpoint the settlement test confirmed works, unless the goal clearly matches a
// different service on the same agent. This prevents token briefs from routing to a
// generic sibling service just because it was the last probed endpoint.
function chosenService(agent: MarketplaceAgent, goal?: string): MarketplaceService {
  if (goal && agent.services.length > 1) {
    const domain = detectGoalDomain(goal);
    const domainServices = agent.services.filter((service) => serviceMatchesGoalDomain(goal, agent, service));
    const baseServices = domainServices.length > 0 ? domainServices : agent.services;
    const services = goalHasSpecificToken(goal)
      ? baseServices.filter((service) => serviceSupportsSpecificToken(service, goal))
      : baseServices;
    if (services.length > 0) {
      const best = services.reduce((a, b) =>
        serviceRelevanceScore(a, goal, agent.agentId) >= serviceRelevanceScore(b, goal, agent.agentId) ? a : b
      );
      if (domain !== "general" && domainServices.length > 0) return best;
      if (serviceRelevanceScore(best, goal, agent.agentId) >= 16) return best;
    }
  }

  const o = PAYABLE_ENDPOINTS.get(agent.agentId);
  if (o) {
    const live = agent.services.find((s) => s.endpoint === o.endpoint);
    if (live) return live;
    return { serviceId: "", serviceName: o.service, serviceType: "A2MCP", feeAmount: o.fee, endpoint: o.endpoint, description: "" };
  }
  return cheapestService(agent);
}

function determineAgentRole(agent: MarketplaceAgent, goal: string): string {
  const svc = chosenService(agent, goal);
  const desc = `${agent.name} ${agent.description} ${agent.category} ${svc.serviceName} ${svc.description ?? ""}`.toLowerCase();
  const goalLower = goal.toLowerCase();

  // Non-crypto domains first, so a football or travel agent isn't misfiled as "market_data"
  // just because its description happens to mention a price.
  if (/predict|odds|forecast|polymarket|betting|upset|world.?cup|match outcome|who will win/.test(desc)) {
    return "prediction";
  }
  if (/travel|trip|flight|itinerary|hotel|destination|things to do|tourism/.test(desc)) {
    return "travel";
  }
  if (/image|logo|brand|\bart\b|design|music|song|avatar|sticker|generat/.test(desc)) {
    return "creative";
  }
  if (/health|diet|fitness|nutrition|calorie|workout|wellness|medical/.test(desc)) {
    return "health";
  }
  if (goalIsClearlyNonCrypto(goal) && supportsCareerDocumentGoal(agent, svc)) {
    return "content";
  }
  const safetyGoal = /\b(safe|safety|risk|audit|verify|scan|honeypot|rug|security)\b/.test(goalLower);
  if (!safetyGoal && (desc.includes("sentiment") || desc.includes("social") || desc.includes("news") || desc.includes("twitter") || desc.includes("kol"))) {
    return "sentiment";
  }
  if (!safetyGoal && (desc.includes("market") || desc.includes("data") || desc.includes("price") || desc.includes("trading") || desc.includes("derivatives") || desc.includes("technical") || desc.includes("tape") || desc.includes("flow") || desc.includes("whale"))) {
    return "market_data";
  }
  if (desc.includes("security") || desc.includes("scan") || desc.includes("risk") || desc.includes("audit") || desc.includes("verify")) {
    return "security";
  }
  if (desc.includes("sentiment") || desc.includes("social") || desc.includes("news") || desc.includes("twitter") || desc.includes("kol")) {
    return "sentiment";
  }
  if (desc.includes("market") || desc.includes("data") || desc.includes("price") || desc.includes("trading") || desc.includes("derivatives") || desc.includes("technical") || desc.includes("tape") || desc.includes("flow") || desc.includes("whale")) {
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
  // Token-vetting goals that name a contract address run the real dependency graph:
  // resolve the token (gate) -> holders + sentiment keyed on the resolved symbol.
  if (isFlagshipGoal(req.goal)) return buildFlagshipPlan(req.goal);

  const analytical = goalIsAnalytical(req.goal);
  const nonCryptoGoal = goalIsClearlyNonCrypto(req.goal);
  const scored = await findMatchingAgentsScored(req.goal);

  // Hard guardrails: must have a callable service, must be affordable, and must not
  // be an action agent when the goal is analytical. These prevent the "surprise
  // $3.30 meme-launcher on a safety question" failure mode.
  const eligible = scored.filter(({ agent }) => {
    if (agent.services.length === 0) return false;
    if (EXCLUDE_IDS.has(agent.agentId)) return false; // settle-but-unusable (MCP/topup) — never route to these
    // Fired by its own record: repeatedly hired, never delivered verified work.
    if (isProvenBad(agent.agentId, agent.name)) return false;
    const svc = chosenService(agent, req.goal);
    if (!serviceMatchesGoalDomain(req.goal, agent, svc)) return false;
    if (nonCryptoGoal && isFinancialMarketService(agent, svc)) return false;
    if (nonCryptoGoal && !supportsCareerDocumentGoal(agent, svc)) return false;
    if (goalHasSpecificToken(req.goal) && isStockOrEquityService(svc)) return false;
    if (goalHasSpecificToken(req.goal) && !serviceSupportsSpecificToken(svc, req.goal)) return false;
    const fee = svc.feeAmount;
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
    const aSvc = chosenService(a.agent, req.goal);
    const bSvc = chosenService(b.agent, req.goal);
    const rel = serviceReliabilityPenalty(a.agent.agentId, aSvc.serviceName, aSvc.endpoint) - serviceReliabilityPenalty(b.agent.agentId, bSvc.serviceName, bSvc.endpoint);
    if (rel !== 0) return rel;
    return b.score - a.score;
  });

  const selectedAgents: MarketplaceAgent[] = [];
  let runningTotal = 0;

  // Smart routing: let Claude pick from the whole eligible catalog (semantic fit +
  // payability + complementarity). This is what scales Bind to any goal across the
  // full marketplace without a hand-tuned agent list.
  const byId = new Map(eligible.map((e) => [e.agent.agentId, e.agent]));
  const candidates: SelectCandidate[] = eligible.map(({ agent }) => {
    const svc = chosenService(agent, req.goal);
    return {
      agentId: agent.agentId,
      name: agent.name,
      category: determineAgentRole(agent, req.goal),
      // Prefer the service's own description; the vendor profile is the weaker signal.
      description: svc.description || agent.description,
      service: svc.serviceName,
      cheapestFee: svc.feeAmount,
      payable: PAYABLE_AGENT_IDS.has(agent.agentId),
      track: [repSummary(agent.agentId, agent.name), serviceReliabilitySummary(agent.agentId, svc.serviceName, svc.endpoint)].filter(Boolean).join(" | ") || null,
    };
  });
  // Cap the crew at 3. The router used to pad to 4, which hired near-duplicate agents
  // (three "market data" specialists on one brief). Every extra hire is another charge to
  // the buyer and another chance to fail, so a smaller, distinct crew is strictly better.
  const selection = await selectAgents(req.goal, candidates, 3);

  // The router genuinely has no agent for this goal. Decline honestly instead of hiring
  // keyword-matched agents that would return irrelevant data and charge the buyer. This is
  // the fix for "web-app security audit" pulling three crypto agents.
  if (selection && selection.picks.length === 0 && selection.declineReason && eligible.length === 0) {
    return {
      planId: randomUUID(),
      goal: req.goal,
      steps: [],
      totalPriceUsdt: 0,
      priceBreakdown: [],
      estimatedTime: "N/A",
      createdAt: new Date().toISOString(),
      note: selection.declineReason,
    };
  }

  if (selection && selection.picks.length > 0) {
    for (const p of selection.picks) {
      const agent = byId.get(p.agentId);
      if (!agent) continue;
      const fee = chosenService(agent, req.goal).feeAmount;
      if (runningTotal + fee > MAX_TOTAL_USDT) continue;
      selectedAgents.push(agent);
      runningTotal += fee;
    }
  }

  // Website/brand missions need at least two independent routes when available: a brand/design
  // specialist plus a managed executor. The AI selector can be conservative and pick only one;
  // top up from the eligible marketplace list so one flaky agent settlement does not sink the mission.
  const desiredMinimum = detectGoalDomain(req.goal) === "website_brand" ? Math.min(2, eligible.length) : 0;
  if (selectedAgents.length < desiredMinimum) {
    const selectedIds = new Set(selectedAgents.map((agent) => agent.agentId));
    const usedRoles = new Set(selectedAgents.map((agent) => determineAgentRole(agent, req.goal)));
    for (const { agent } of eligible) {
      if (selectedAgents.length >= desiredMinimum) break;
      if (selectedIds.has(agent.agentId)) continue;
      const fee = chosenService(agent, req.goal).feeAmount;
      if (runningTotal + fee > MAX_TOTAL_USDT) continue;
      const role = determineAgentRole(agent, req.goal);
      if (usedRoles.has(role) && eligible.some((e) => !selectedIds.has(e.agent.agentId) && determineAgentRole(e.agent, req.goal) !== role)) continue;
      selectedAgents.push(agent);
      selectedIds.add(agent.agentId);
      usedRoles.add(role);
      runningTotal += fee;
    }
  }
  // Heuristic fallback (no AI key, or AI returned nothing): payable-first, role-diverse.
  if (selectedAgents.length === 0) {
    const usedRoles = new Set<string>();
    for (const { agent } of eligible) {
      if (selectedAgents.length >= 3) break;
      const fee = chosenService(agent, req.goal).feeAmount;
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
      note: domainMismatchReason(req.goal),
    };
  }

  // Ranked backups for each hire — the heart of the general-contractor behaviour. NOT
  // restricted to the proven set: any eligible marketplace agent covering the same role is
  // a candidate. `eligible` is already sorted proven-first then by fit, so slicing it gives
  // "try the agents we trust, then the untested ones" for free. The executor works down this
  // list until one delivers verified output — so a dead or useless agent no longer sinks the
  // whole mission (this is the fix for a single agent's HTTP 530 killing a one-agent brief).
  const selectedIds = new Set(selectedAgents.map((a) => a.agentId));
  function candidatesFor(agent: MarketplaceAgent, max = 3): MarketplaceAgent[] {
    const role = determineAgentRole(agent, req.goal);
    const feeCap = Math.max(chosenService(agent, req.goal).feeAmount + 0.02, UNTESTED_FEE_CEILING);
    return eligible
      .map((e) => e.agent)
      .filter((cand) =>
        !selectedIds.has(cand.agentId) &&
        cand.agentId !== agent.agentId &&
        determineAgentRole(cand, req.goal) === role &&
        chosenService(cand, req.goal).feeAmount <= feeCap)
      .slice(0, max);
  }
  function toBindAgent(cand: MarketplaceAgent): BindAgent {
    const cs = chosenService(cand, req.goal);
    return {
      agentId: cand.agentId, name: cand.name, serviceId: cs.serviceId, serviceName: cs.serviceName,
      endpoint: cs.endpoint, feeAmount: cs.feeAmount, feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      category: determineAgentRole(cand, req.goal) as any,
      serviceDescription: cs.description || cand.description,
    };
  }

  const steps: BindStep[] = selectedAgents.map((agent, i) => {
    const svc = chosenService(agent, req.goal);
    // Store the full service description for param inference
    const agentServiceDescription = svc.description || agent.description;
    const candidates = candidatesFor(agent).map(toBindAgent);
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
      boundParams: PAYABLE_ENDPOINTS.get(agent.agentId)?.endpoint === svc.endpoint
        ? PAYABLE_ENDPOINTS.get(agent.agentId)?.params ?? undefined
        : undefined,
      // Shown to the buyer so the crew is justified by evidence, not vibes.
      track: repSummary(agent.agentId, agent.name) ?? undefined,
      // Ranked backups (proven first, then untested) the executor works down on failure.
      candidates,
      fallbackAgent: candidates[0],
      fallbackServiceDescription: candidates[0]?.serviceDescription,
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