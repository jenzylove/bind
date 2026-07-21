// Bind marketplace search — cached agent discovery via OKX marketplace API
// Caches results for 5 minutes so searches are fast
// Refreshes automatically to pick up new agents

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SEARCH_CONCURRENCY = 8;       // parallel marketplace searches
// Last good catalog, persisted to the volume. If the OKX search API is unreachable at
// boot (it happens), Bind serves this instead of quoting "no compatible agents" for every
// goal — a marketplace blip must not zero the product.
const CATALOG_FILE = join(process.env.BIND_DATA_DIR ?? "data", "catalog-cache.json");
// A real catalog snapshot committed to the repo. It is the floor: even if the volume is
// empty AND the OKX search API is unreachable from the server, Bind still has ~200 real
// agents to route to. Refreshed live in the background whenever the sweep succeeds.
const SEED_CANDIDATES = [
  join(process.cwd(), "catalog-seed.json"),
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "catalog-seed.json"),
];

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

function loadPersistedCatalog(): void {
  if (catalogCache) return;
  try {
    const saved = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as CachedCatalog;
    if (Array.isArray(saved.agents) && saved.agents.length > 0) {
      // Mark it stale so a live refresh still kicks off, but serve it immediately.
      catalogCache = { timestamp: 0, agents: saved.agents };
      console.log(`[bind] catalog restored from disk: ${saved.agents.length} agents (stale, refreshing)`);
    }
  } catch { /* no persisted catalog yet */ }
}

function loadSeedCatalog(): void {
  if (catalogCache) return; // volume cache or a live sweep already won
  for (const p of SEED_CANDIDATES) {
    try {
      const agents = JSON.parse(readFileSync(p, "utf8")) as MarketplaceAgent[];
      if (Array.isArray(agents) && agents.length > 0) {
        catalogCache = { timestamp: 0, agents }; // stale, so a live refresh still runs
        console.log(`[bind] catalog seeded from repo: ${agents.length} agents (refreshing live)`);
        return;
      }
    } catch { /* try next candidate */ }
  }
}

function persistCatalog(agents: MarketplaceAgent[]): void {
  try {
    mkdirSync(process.env.BIND_DATA_DIR ?? "data", { recursive: true });
    writeFileSync(CATALOG_FILE, JSON.stringify({ timestamp: Date.now(), agents }));
  } catch { /* best-effort */ }
}

function startRefresh(): Promise<MarketplaceAgent[]> {
  if (refreshing) return refreshing;              // share one sweep across callers
  refreshing = fetchAllA2McpAgents()
    .then((agents) => {
      // Never clobber a good cache with an empty sweep (e.g. a transient login failure).
      if (agents.length > 0) {
        catalogCache = { timestamp: Date.now(), agents };
        persistCatalog(agents);
      }
      return catalogCache?.agents ?? agents;
    })
    .catch(() => catalogCache?.agents ?? [])
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Stale-while-revalidate: a warm cache answers instantly; an expired one is still served
// immediately while a refresh runs in the background. Only a completely cold start waits.
async function getCatalog(): Promise<MarketplaceAgent[]> {
  loadPersistedCatalog();  // volume: last good live sweep
  loadSeedCatalog();       // repo floor: ~200 real agents, always available
  const now = Date.now();
  if (catalogCache && now - catalogCache.timestamp < CACHE_TTL_MS) return catalogCache.agents;
  if (catalogCache) { void startRefresh(); return catalogCache.agents; }
  return startRefresh();
}

// Called at boot so the first real user never pays the cold-start cost. If the sweep comes
// back empty (OKX API unreachable), keep retrying in the background until it succeeds —
// an empty catalog means every quote fails, which is an outage, not a degradation.
export async function warmCatalog(): Promise<number> {
  const agents = await getCatalog();
  if (agents.length === 0) {
    const retry = setInterval(() => {
      void startRefresh().then((a) => {
        if (a.length > 0) {
          console.log(`[bind] catalog recovered: ${a.length} agents`);
          clearInterval(retry);
        }
      });
    }, 2 * 60 * 1000);
  }
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

  // Domain-based scoring. Bind is a general contractor, so this spans well beyond crypto:
  // a goal's domain signals boost agents that serve that domain, whether it's a token audit,
  // a football prediction, a trip plan, or a logo.
  const catSigs: Record<string, string[]> = {
    SECURITY: ["security", "scan", "audit", "risk", "verify", "honeypot", "safe", "certik", "rug"],
    MARKET_DATA: ["market", "price", "data", "trading", "funding", "chart", "candle"],
    SENTIMENT: ["sentiment", "social", "news", "twitter", "kol", "mood", "buzz"],
    DEFI: ["swap", "yield", "stake", "defi", "otto", "barker", "liquidity", "pool"],
    CONTENT: ["content", "image", "art", "video", "create", "logo", "brand", "design", "music", "song", "generate", "meme", "avatar", "sticker"],
    ONCHAIN: ["onchain", "blockchain", "explorer", "wallet", "holder", "contract"],
    PREDICTION: ["prediction", "predict", "odds", "forecast", "who will", "who is gonna", "gonna win", "betting", "polymarket", "upset", "chances"],
    SPORTS: ["sports", "football", "soccer", "match", "team", "league", "cup", "world cup", "fixture", "score"],
    TRAVEL: ["travel", "trip", "flight", "itinerary", "hotel", "visit", "tour", "destination", "things to do", "what to do in"],
    HEALTH: ["health", "diet", "fitness", "nutrition", "food", "calorie", "workout", "medical", "bmi", "wellness"],
    LIFE: ["fortune", "astrology", "destiny", "horoscope", "recipe", "game", "rpg", "space", "weather"],
  };

  for (const [, signals] of Object.entries(catSigs)) {
    for (const signal of signals) {
      if (goalLower.includes(signal)) {
        score += 10;
        if (nameAndDesc.includes(signal)) score += 8;
      }
    }
  }

  // Marketplace-category alignment: if the agent's own listed category words appear in the
  // goal (e.g. a WORLD_CUP agent for a World Cup goal, an ART_CREATION agent for a logo).
  const catWords = (agent.category || "").toLowerCase().replace(/_/g, " ").split(" ");
  for (const w of catWords) if (w.length > 3 && goalLower.includes(w)) score += 8;

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