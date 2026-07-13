import { execFileSync } from "node:child_process";
const BIN = process.env.HOME + "/.local/bin/onchainos";

function search(q) {
  try { return JSON.parse(execFileSync(BIN,["agent","search","--query",q,"--status","online","--page-size","50"],{encoding:"utf8",timeout:15000})).data?.list || []; }
  catch { return []; }
}

// Broad, diverse keyword sweep to estimate how much of the 200+ marketplace we can reach.
const kw = ["ai","crypto","trading","market","data","security","audit","news","social","sentiment","nft",
  "defi","yield","swap","token","price","onchain","wallet","analytics","signal","research","meme","derivatives",
  "funding","liquidation","twitter","kol","image","video","content","art","game","sports","prediction","health",
  "food","legal","credit","payment","bridge","stake","dex","rpc","chart","alert","monitor","scan","risk","brief",
  "quant","arbitrage","options","stocks","forex","macro","earnings","insider","whale","airdrop","launch","mint"];

const agents = new Map();
for (const q of kw) {
  for (const a of search(q)) {
    const svcs = (a.services||[]).filter(s=>s.serviceType==="A2MCP"&&s.endpoint);
    if (!svcs.length) continue;
    if (!agents.has(String(a.agentId))) agents.set(String(a.agentId), {id:String(a.agentId),name:a.name,cat:(a.categoryCode||[])[0],svc:svcs.length});
  }
}
console.log("KEYWORDS:", kw.length, "| UNIQUE A2MCP AGENTS REACHED:", agents.size);
const cats = {};
for (const a of agents.values()) cats[a.cat||"?"] = (cats[a.cat||"?"]||0)+1;
console.log("by category:", JSON.stringify(cats));

// Clawby real services
const clawby = search("Clawby").find(x=>String(x.agentId)==="3209");
if (clawby) {
  console.log("\nClawby services ("+clawby.services.length+"):");
  for (const s of clawby.services.slice(0,15)) {
    console.log("  $"+s.feeAmount, "|", s.serviceName, "|", (s.endpoint||"").replace("https://",""));
    if (s.serviceDescription) console.log("      desc:", s.serviceDescription.slice(0,90));
  }
}
