// Bind marketplace search — cached agent discovery via OKX marketplace API
// Caches results for 5 minutes so searches are fast
// Refreshes automatically to pick up new agents

import { execSync } from "node:child_process";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedCatalog {
  timestamp: number;
  agents: MarketplaceAgent[];
}

let catalogCache: CachedCatalog | null = null;

export interface MarketplaceAgent {
  agentId: string;
  name: string;
  description: string;
  category: string;
  rating: number;
  soldCount: number;
  priceMin: number;
  services: MarketplaceService[];
}

export interface MarketplaceService {
  serviceId: string;
  serviceName: string;
  serviceType: string;
  feeAmount: number;
  endpoint: string;
  description?: string;
}

function ensureLoggedIn(): boolean {
  try {
    execSync(`${ONCHAINOS_PATH} wallet login`, { timeout: 10000, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function fetchAllA2McpAgents(): MarketplaceAgent[] {
  ensureLoggedIn();
  const allAgents: MarketplaceAgent[] = [];
  const seenIds = new Set<string>();

  // Search multiple categories to cover the marketplace breadth
  const queries = ["A2MCP", "security", "market", "data", "defi", "social", "content", "onchain"];

  for (const query of queries) {
    try {
      const result = execSync(
        `${ONCHAINOS_PATH} agent search --query "${query}" --status online --page-size 20`,
        { timeout: 10000, encoding: "utf8" }
      );
      const parsed = JSON.parse(result);
      if (!parsed.ok || !parsed.data?.list) continue;

      for (const a of parsed.data.list) {
        if (seenIds.has(String(a.agentId))) continue;
        seenIds.add(String(a.agentId));

        const services = (a.services || []).filter(
          (s: any) => s.serviceType === "A2MCP" && s.endpoint
        );
        if (services.length === 0) continue;

        allAgents.push({
          agentId: String(a.agentId),
          name: a.name || "Unknown",
          description: (a.profileDescription || "").slice(0, 200),
          category: (a.categoryCode || ["GENERAL"])[0],
          rating: a.feedbackRate || a.securityRate || 0,
          soldCount: a.soldCount || 0,
          priceMin: a.serviceMinPrice || 0,
          services: services.map((s: any) => ({
            serviceId: String(s.serviceId),
            serviceName: s.serviceName || "Unnamed",
            serviceType: s.serviceType,
            feeAmount: parseFloat(s.feeAmount) || 0,
            endpoint: s.endpoint || "",
          })),
        });
      }
    } catch {
      // skip failed queries
    }
  }

  return allAgents;
}

function getCatalog(): MarketplaceAgent[] {
  const now = Date.now();
  if (catalogCache && now - catalogCache.timestamp < CACHE_TTL_MS) {
    return catalogCache.agents;
  }
  catalogCache = { timestamp: now, agents: fetchAllA2McpAgents() };
  return catalogCache.agents;
}

function scoreAgentRelevance(agent: MarketplaceAgent, goal: string): number {
  const goalLower = goal.toLowerCase();
  const nameAndDesc = `${agent.name} ${agent.description}`.toLowerCase();
  let score = 0;

  const goalWords = goalLower.split(/\s+/);
  for (const word of goalWords) {
    if (word.length > 2 && nameAndDesc.includes(word)) score += 5;
  }

  // Category-based scoring
  const catSigs: Record<string, string[]> = {
    SECURITY: ["security", "scan", "audit", "risk", "verify", "honeypot", "safe", "certik"],
    MARKET_DATA: ["market", "price", "data", "trading", "funding"],
    SENTIMENT: ["sentiment", "social", "news", "twitter", "kol"],
    DEFI: ["swap", "yield", "stake", "defi", "otto", "barker"],
    CONTENT: ["content", "image", "art", "video", "create"],
    ONCHAIN: ["onchain", "blockchain", "explorer", "wallet"],
  };

  for (const [, signals] of Object.entries(catSigs)) {
    for (const signal of signals) {
      if (goalLower.includes(signal)) {
        score += 10;
        if (nameAndDesc.includes(signal)) score += 8;
      }
    }
  }

  // Reputation bonus
  score += Math.min(agent.rating / 10, 5);
  score += Math.min(agent.soldCount / 100, 3);

  return score;
}

export async function findMatchingAgents(goal: string): Promise<MarketplaceAgent[]> {
  const catalog = getCatalog();
  const scored = catalog
    .map((agent) => ({ agent, score: scoreAgentRelevance(agent, goal) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s) => s.agent);

  return scored;
}

export function getAgentCount(): number {
  return getCatalog().length;
}