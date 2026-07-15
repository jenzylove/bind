// Bind marketplace search — cached agent discovery via OKX marketplace API
// Caches results for 5 minutes so searches are fast
// Refreshes automatically to pick up new agents

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SEARCH_CONCURRENCY = 8;       // parallel marketplace searches

interface CachedCatalog {
  timestamp: number;
  agents: MarketplaceAgent[];
}

let catalogCache: CachedCatalog | null = null;
// In-flight refresh, so concurrent callers share one sweep instead of stampeding.
let refreshing: Promise<MarketplaceAgent[]> | null = null;

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

async function ensureLoggedIn(): Promise<boolean> {
  try {
    await execFileAsync(ONCHAINOS_PATH, ["wallet", "login"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Broad semantic sweep to reach the whole marketplace. The backend search is a
// similarity ranker with no "list all", so we union the top matches across many
// diverse keywords — this reaches ~107 unique A2MCP agents (effectively the full
// callable marketplace).
const QUERIES = [
  "ai", "crypto", "trading", "market", "data", "security", "audit", "news", "social",
  "sentiment", "nft", "defi", "yield", "swap", "token", "price", "onchain", "wallet",
  "analytics", "signal", "research", "meme", "derivatives", "funding", "liquidation",
  "twitter", "kol", "content", "art", "game", "sports", "prediction", "health", "legal",
  "credit", "payment", "bridge", "stake", "dex", "rpc", "chart", "alert", "monitor",
  "scan", "risk", "brief", "quant", "arbitrage", "options", "stocks", "macro", "whale",
  "airdrop", "launch", "mint", "A2MCP",
];

async function searchOne(query: string): Promise<any[]> {
  try {
    const { stdout } = await execFileAsync(
      ONCHAINOS_PATH,
      ["agent", "search", "--query", query, "--status", "online", "--page-size", "20"],
      { timeout: 10000 },
    );
    const parsed = JSON.parse(stdout);
    return parsed.ok && parsed.data?.list ? parsed.data.list : [];
  } catch {
    return []; // skip failed queries
  }
}

// Runs the sweep with bounded concurrency. Previously this was 57 sequential
// execFileSync calls, which blocked the event loop for ~90s — the whole server (health
// checks included) froze during a cold plan, which is what aborted client requests.
async function fetchAllA2McpAgents(): Promise<MarketplaceAgent[]> {
  await ensureLoggedIn();
  const allAgents: MarketplaceAgent[] = [];
  const seenIds = new Set<string>();

  let i = 0;
  async function worker() {
    while (i < QUERIES.length) {
      const list = await searchOne(QUERIES[i++]);
      for (const a of list) {
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
            // The service description carries the input-requirements doc ("Input
            // requirements: ...") — the executor feeds this to inferParams so it can
            // call ANY agent correctly, not just the four it has hardcoded mappings for.
            description: s.serviceDescription || "",
          })),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));

  return allAgents;
}

function startRefresh(): Promise<MarketplaceAgent[]> {
  if (refreshing) return refreshing;              // share one sweep across callers
  refreshing = fetchAllA2McpAgents()
    .then((agents) => {
      // Never clobber a good cache with an empty sweep (e.g. a transient login failure).
      if (agents.length > 0) catalogCache = { timestamp: Date.now(), agents };
      return catalogCache?.agents ?? agents;
    })
    .catch(() => catalogCache?.agents ?? [])
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Stale-while-revalidate: a warm cache answers instantly; an expired one is still served
// immediately while a refresh runs in the background. Only a completely cold start waits.
async function getCatalog(): Promise<MarketplaceAgent[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.timestamp < CACHE_TTL_MS) return catalogCache.agents;
  if (catalogCache) { void startRefresh(); return catalogCache.agents; }
  return startRefresh();
}

// Called at boot so the first real user never pays the cold-start cost.
export async function warmCatalog(): Promise<number> {
  const agents = await getCatalog();
  return agents.length;
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

export async function findMatchingAgentsScored(goal: string): Promise<{ agent: MarketplaceAgent; score: number }[]> {
  const catalog = await getCatalog();
  return catalog
    .map((agent) => ({ agent, score: scoreAgentRelevance(agent, goal) }))
    .sort((a, b) => b.score - a.score);
}

export async function findMatchingAgents(goal: string): Promise<MarketplaceAgent[]> {
  return (await findMatchingAgentsScored(goal)).slice(0, 10).map((s) => s.agent);
}

export async function getAgentCount(): Promise<number> {
  return (await getCatalog()).length;
}