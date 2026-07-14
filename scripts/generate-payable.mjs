// Build the expanded payable set from the settlement test, storing the EXACT working
// endpoint per agent (not "cheapest" — the working service is often pricier than a dead
// cheaper one). Two tiers: data-confirmed (returns data with generic params) and
// payment-capable (payment settles; params come from LLM inference in the executor).
import { readFileSync, writeFileSync } from "node:fs";

const settle = JSON.parse(readFileSync("data/settle-test.json", "utf8"));

// Off-topic agents to keep out of routing even though they pay (food, sports, fate, etc.)
const OFFTOPIC = new Set(["3345","4416","2161","5057","3538","3959","4489"]);

// The 5 originally confirmed (with their known-working endpoints).
const KNOWN = [
  { id:"2023", name:"Onchain Data Explorer", endpoint:"https://x402.6551.io/okx/get_token_info", fee:0.000015, service:"On-chain token data", tier:"data" },
  { id:"4413", name:"SignalDesk", endpoint:"https://api.mucvan.com/api/perp-positioning", fee:0.01, service:"Perp Positioning Signal", tier:"data" },
  { id:"3417", name:"AlgoVault Quant Signal", endpoint:"https://api.algovault.com/a2mcp/scan_funding_arb", fee:0.01, service:"Funding-Rate Spread Scan", tier:"data" },
  { id:"3887", name:"穿越牛熊简报", endpoint:"https://chuanyue-briefing-asp.vercel.app/api/sample-briefing", fee:0.01, service:"Daily market briefing", tier:"data" },
  { id:"5222", name:"DefiMacro", endpoint:"https://api.mucvan.com/api/defi-overview", fee:0.02, service:"DeFi Macro Overview", tier:"data" },
];

const map = new Map(KNOWN.map(k => [k.id, k]));
for (const r of settle.results) {
  if (OFFTOPIC.has(r.agentId) || map.has(r.agentId)) continue;
  const paidData = r.result === "PAID" && r.data;
  const paymentCapable = r.result === "PAID" || /^paid-\d/.test(r.result); // payment layer passed (4xx = bad params, fixable)
  if (!paidData && !paymentCapable) continue;
  map.set(r.agentId, {
    id: r.agentId, name: r.agentName, endpoint: r.endpoint, fee: r.fee, service: r.service,
    tier: paidData ? "data" : "capable",
  });
}

const all = [...map.values()];
const data = all.filter(a => a.tier === "data");
const capable = all.filter(a => a.tier === "capable");

writeFileSync("data/payable-agents.json", JSON.stringify({
  probedAt: "2026-07-13",
  note: "payableIds = data-confirmed + payment-capable. endpoints[] pins the WORKING service per agent (planner uses this, not cheapest).",
  dataConfirmed: data.length,
  paymentCapable: capable.length,
  payableIds: all.map(a => a.id),
  endpoints: Object.fromEntries(all.map(a => [a.id, { endpoint: a.endpoint, fee: a.fee, service: a.service, name: a.name, tier: a.tier }])),
  agents: all,
}, null, 2));

console.log(`data-confirmed: ${data.length} | payment-capable: ${capable.length} | total: ${all.length}`);
console.log("data:", data.map(a => `#${a.id} ${a.name}`).join(", "));
console.log("capable:", capable.map(a => `#${a.id} ${a.name}`).join(", "));
