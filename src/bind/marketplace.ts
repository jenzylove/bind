// Bind marketplace search — live agent discovery via OKX marketplace API
// No hardcoded catalog. Every plan searches the marketplace in real time.

import { execSync } from "node:child_process";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

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
}

function searchMarketplace(query: string): MarketplaceAgent[] {
  try {
    const result = execSync(
      `${ONCHAINOS_PATH} agent search --query "${query}" --service "A2MCP" --page-size 20`,
      { timeout: 15000, encoding: "utf8" }
    );
    const parsed = JSON.parse(result);
    if (!parsed.ok || !parsed.data?.list) return [];

    return parsed.data.list
      .filter((a: any) => {
        const services = a.services || [];
        return services.some((s: any) => s.serviceType === "A2MCP" && s.endpoint);
      })
      .map((a: any): MarketplaceAgent => {
        const services = (a.services || []).filter(
          (s: any) => s.serviceType === "A2MCP" && s.endpoint
        );
        return {
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
        };
      });
  } catch {
    return [];
  }
}

const CATEGORY_SIGNALS: Record<string, string[]> = {
  security: ["security", "scan", "audit", "risk", "verify", "honeypot", "safe", "token scan", "misttrack", "certik"],
  sentiment: ["sentiment", "social", "news", "trend", "twitter", "x api", "kol", "newsliquid"],
  market_data: ["market", "price", "data", "api", "derivatives", "funding", "defi", "trading", "coinank", "clawby"],
  onchain: ["onchain", "explorer", "wallet", "blockchain", "token", "address", "scope"],
  content: ["content", "image", "art", "video", "thumbnail", "bubble", "triptych"],
  defi: ["swap", "bridge", "yield", "stake", "deFi", "otto", "barker", "alpha"],
};

function scoreAgentRelevance(agent: MarketplaceAgent, goal: string): number {
  const goalLower = goal.toLowerCase();
  let score = 0;

  // Match against category signals
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const signal of signals) {
      if (goalLower.includes(signal)) {
        score += 10;
      }
    }
  }

  // Match against agent name and description
  const nameAndDesc = `${agent.name} ${agent.description}`.toLowerCase();
  const goalWords = goalLower.split(/\s+/);
  for (const word of goalWords) {
    if (word.length > 2 && nameAndDesc.includes(word)) {
      score += 5;
    }
  }

  // Boost by reputation signals
  score += Math.min(agent.rating / 10, 5);     // up to 5 for rating
  score += Math.min(agent.soldCount / 100, 3); // up to 3 for proven sales

  return score;
}

export async function findMatchingAgents(goal: string): Promise<MarketplaceAgent[]> {
  // Extract key terms from the goal to build search queries
  const goalLower = goal.toLowerCase();
  const searchQueries: string[] = [];

  // Build search queries based on goal content
  for (const signals of Object.values(CATEGORY_SIGNALS)) {
    for (const signal of signals) {
      if (goalLower.includes(signal)) {
        searchQueries.push(signal);
        break;
      }
    }
  }

  // Always search the goal itself
  searchQueries.push(goal);
  // Always search broadly for A2MCP agents
  searchQueries.push("A2MCP");

  // Deduplicate queries
  const uniqueQueries = [...new Set(searchQueries)].slice(0, 5);

  // Search marketplace with each query
  const seenIds = new Set<string>();
  const allAgents: MarketplaceAgent[] = [];

  for (const query of uniqueQueries) {
    const agents = searchMarketplace(query);
    for (const agent of agents) {
      if (!seenIds.has(agent.agentId)) {
        seenIds.add(agent.agentId);
        allAgents.push(agent);
      }
    }
  }

  // Score and sort by relevance
  const scored = allAgents.map((agent) => ({
    agent,
    score: scoreAgentRelevance(agent, goal),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Return top 10 most relevant
  return scored.slice(0, 10).map((s) => s.agent);
}