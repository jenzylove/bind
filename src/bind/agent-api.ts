// Agent API parameter mappings — allows executor to call each agent with correct params
// Each entry maps agentId or serviceId to the correct HTTP method, params, and endpoint selection

type HttpMethod = "POST" | "GET";

export interface AgentApiDef {
  serviceName?: string[];         // match by service name keywords
  method: HttpMethod;
  params: Record<string, string>; // param template with {goal} placeholder
  endpoint?: string;              // override endpoint
  transform?: (goal: string) => Record<string, unknown>; // custom function
}

// Match agents by their service names/keywords
export const AGENT_API_MAP: AgentApiDef[] = [
  // === Onchain Data Explorer (Agent 2023) — OKX Official, most reliable ===
  { serviceName: ["verified contract source"], method: "POST", params: { chainIndex: "196", address: "{goal}" } },
  { serviceName: ["chain info"], method: "POST", params: { chainIndex: "196", include: "fee,stats" } },
  { serviceName: ["block lookup"], method: "POST", params: { chainIndex: "196", by: "height", value: "21000000" } },
  { serviceName: ["transaction details"], method: "POST", params: { chainIndex: "196", txHash: "{goal}" } },
  { serviceName: ["address transaction", "address tx history"], method: "POST", params: { chainIndex: "196", address: "{goal}", limit: "5" } },
  { serviceName: ["address profile"], method: "POST", params: { chainIndex: "196", address: "{goal}" } },
  { serviceName: ["token metadata", "token info"], method: "POST", params: { chainIndex: "196", tokenAddress: "{goal}" } },
  { serviceName: ["historical token price"], method: "POST", params: { chainIndex: "196", tokenAddress: "{goal}", granularity: "1D" } },
  { serviceName: ["top token holders"], method: "POST", params: { chainIndex: "196", tokenAddress: "{goal}", n: "10" } },
  { serviceName: ["event logs"], method: "POST", params: { chainIndex: "196", by: "tx", txHash: "{goal}" } },

  // === NewsLiquid (Agent 2135) — News & Social ===
  { serviceName: ["news search", "news type"], method: "POST", params: { q: "{goal}" } },
  { serviceName: ["twitter user info"], method: "POST", params: { username: "{goal}" } },
  { serviceName: ["twitter user tweets"], method: "POST", params: { username: "{goal}", maxResults: "5" } },
  { serviceName: ["twitter search"], method: "POST", params: { keywords: "{goal}" } },

  // === CoinAnk (Agent 2013) — Market Data (no params needed) ===
  { serviceName: ["btc etf", "us btc etf"], method: "GET", params: {} },
  { serviceName: ["eth etf", "us eth etf"], method: "GET", params: {} },
  { serviceName: ["etf inflow"], method: "GET", params: {} },

  // === Barker Yield (Agent 2012) — DeFi Yields ===
  { serviceName: ["yield radar", "stablecoin yield"], method: "POST", params: { chain: "xlayer" } },
  { serviceName: ["market overview", "market trend"], method: "POST", params: {} },
  { serviceName: ["yield advisor"], method: "POST", params: { limit: "5" } },
  { serviceName: ["pool search"], method: "POST", params: { q: "{goal}" } },
  { serviceName: ["pool detail"], method: "POST", params: { poolUid: "{goal}" } },
];

export function getApiDef(serviceName: string): AgentApiDef | null {
  const nameLower = serviceName.toLowerCase();
  for (const def of AGENT_API_MAP) {
    for (const keyword of def.serviceName || []) {
      if (nameLower.includes(keyword)) return def;
    }
  }
  return null;
}

export function buildParams(def: AgentApiDef, goal: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(def.params)) {
    result[key] = val.replace("{goal}", goal);
  }
  return result;
}