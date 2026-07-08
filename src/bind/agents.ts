// Bind — orchestrator agent catalog
// Hardcoded for Phase 1 with real agents discovered on the marketplace
// In Phase 2, this becomes a live query against the OKX marketplace

import type { BindAgent } from "./types.js";

export const AGENT_CATALOG: BindAgent[] = [
  {
    agentId: "1965",
    name: "CertiK",
    serviceId: "2429",
    serviceName: "CertiK Security APIs",
    endpoint: "https://skills-for-okx.certik.com/api/services",
    feeAmount: 0.001,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "security",
  },
  {
    agentId: "3820",
    name: "Sentiment Oracle",
    serviceId: "23513",
    serviceName: "Token Sentiment Risk Analysis",
    endpoint: "https://okx.57tool.com/mcp/3820/token-risk",
    feeAmount: 0.1,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "sentiment",
  },
  {
    agentId: "3820",  // same agent, different service
    name: "Sentiment Oracle",
    serviceId: "23514",
    serviceName: "Smart Money Sentiment Tracker",
    endpoint: "https://okx.57tool.com/mcp/3820/smart-money",
    feeAmount: 0.5,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "market_data",
  },
  {
    agentId: "2143",
    name: "Predexon",
    serviceId: "16641",
    serviceName: "Predexon Market Search",
    endpoint: "https://a2mcp.predexon.com/v1/markets/search",
    feeAmount: 0.01,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "market_data",
  },
  {
    agentId: "2143",
    name: "Predexon",
    serviceId: "16644",
    serviceName: "Polymarket Leaderboard",
    endpoint: "https://a2mcp.predexon.com/v1/polymarket/leaderboard",
    feeAmount: 0.01,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "market_data",
  },
  {
    agentId: "2123",
    name: "Fan Token Intel",
    serviceId: "5464",
    serviceName: "Market Regime API",
    endpoint: "https://x402.brunopessoa.com/v1/market-regime",
    feeAmount: 0.02,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "market_data",
  },
  {
    agentId: "3887",
    name: "穿越牛熊简报",
    serviceId: "26447",
    serviceName: "Daily Market Briefing",
    endpoint: "https://chuanyue-briefing-asp.vercel.app/api/latest-briefing",
    feeAmount: 0.1,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    category: "analysis",
  },
];

export function findAgentById(agentId: string): BindAgent | undefined {
  return AGENT_CATALOG.find(a => a.agentId === agentId);
}

export function findAgentsByCategory(category: BindAgent["category"]): BindAgent[] {
  return AGENT_CATALOG.filter(a => a.category === category);
}

export function getCheapestByCategory(category: BindAgent["category"]): BindAgent | undefined {
  const agents = findAgentsByCategory(category);
  if (agents.length === 0) return undefined;
  return agents.reduce((cheapest, agent) =>
    agent.feeAmount < cheapest.feeAmount ? agent : cheapest
  );
}