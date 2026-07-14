// Deep payment-surface map: enumerate EVERY A2MCP service of EVERY reachable agent and
// categorize its payment surface — free, 402-with-findable-challenge (+scheme/asset), or
// dead (404/405/timeout). No payments made here; this is the free reconnaissance that
// tells us how many endpoints are actually payment-capable (vs the ~5 we've confirmed).
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const BIN = process.env.HOME + "/.local/bin/onchainos";
const CONCURRENCY = 10;

function catalog() {
  const queries = [
    "ai","crypto","trading","market","data","security","audit","news","social","sentiment",
    "nft","defi","yield","swap","token","price","onchain","wallet","analytics","signal",
    "research","meme","derivatives","funding","liquidation","twitter","kol","content","art",
    "game","sports","prediction","health","legal","credit","payment","bridge","stake","dex",
    "rpc","chart","alert","monitor","scan","risk","brief","quant","arbitrage","options",
    "stocks","macro","whale","airdrop","launch","mint","image","video","audio","music","code",
    "A2MCP","mcp","agent","okx","bitcoin","ethereum","solana","yield","staking","governance",
  ];
  const agents = new Map();
  for (const q of queries) {
    try {
      const p = JSON.parse(execFileSync(BIN,["agent","search","--query",q,"--status","online","--page-size","40"],{encoding:"utf8",timeout:15000}));
      for (const a of (p.data?.list||[])) {
        const svcs = (a.services||[]).filter(s=>s.serviceType==="A2MCP"&&s.endpoint);
        if (!svcs.length) continue;
        if (!agents.has(String(a.agentId))) agents.set(String(a.agentId), { id:String(a.agentId), name:a.name||"?", cat:(a.categoryCode||[])[0]||"?", services: [] });
        const rec = agents.get(String(a.agentId));
        for (const s of svcs) {
          if (rec.services.find(x=>x.endpoint===s.endpoint)) continue;
          rec.services.push({ serviceId:String(s.serviceId), name:s.serviceName||"?", endpoint:s.endpoint, fee:parseFloat(s.feeAmount)||0, desc:(s.serviceDescription||"").slice(0,80) });
        }
      }
    } catch {}
  }
  return [...agents.values()];
}

async function post(url, headers={}) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), 8000);
  const body = JSON.stringify({ q:"bitcoin", input:"bitcoin", query:"bitcoin", symbol:"BTC", chainIndex:"196" });
  try {
    const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body,signal:c.signal});
    return { status:r.status, headers:r.headers, text: await r.text() };
  } catch(e){ return { status:0, headers:new Headers(), text:String(e.message).slice(0,40) }; }
  finally { clearTimeout(t); }
}

function findChallenge(res) {
  // 1. standard header
  const hdr = res.headers.get("payment-required");
  if (hdr) { try { return { src:"header", obj: JSON.parse(Buffer.from(hdr,"base64").toString()) }; } catch {} }
  // 2. other candidate headers
  for (const h of ["www-authenticate","x-payment-required","accept-payment","x-402"]) {
    const v = res.headers.get(h);
    if (v) { try { return { src:h, obj: JSON.parse(Buffer.from(v,"base64").toString()) }; } catch {} }
  }
  // 3. body JSON carrying x402 fields
  try {
    const j = JSON.parse(res.text);
    if (j && (j.x402Version || j.accepts || j.paymentRequirements)) return { src:"body", obj:j };
  } catch {}
  return null;
}

async function probeEndpoint(agent, svc) {
  const res = await post(svc.endpoint);
  const base = { agentId:agent.id, agentName:agent.name, cat:agent.cat, service:svc.name, endpoint:svc.endpoint, fee:svc.fee };
  const isMcp = /\/mcp\/?$/.test(svc.endpoint);
  if (res.status === 200) {
    let data=false; try { const j=JSON.parse(res.text); data = !j.error && j.success!==false && Object.keys(j).length>0; } catch { data = res.text.length>20; }
    return { ...base, verdict: data ? "free-data" : "free-200", mcp:isMcp };
  }
  if (res.status !== 402) return { ...base, verdict:`http-${res.status}`, mcp:isMcp, note: res.text.slice(0,40) };
  const ch = findChallenge(res);
  if (!ch) return { ...base, verdict:"402-no-challenge", mcp:isMcp, note: res.text.slice(0,50) };
  const accepts = (ch.obj.accepts || ch.obj.paymentRequirements || (ch.obj.accepted?[ch.obj.accepted]:[])) || [];
  const a = accepts[0] || {};
  return { ...base, verdict:"402-payable", mcp:isMcp, challengeSrc:ch.src,
    scheme:a.scheme, network:a.network, asset:(a.asset||"").toLowerCase(), amount:a.amount??a.maxAmountRequired, schemes: accepts.map(x=>x.scheme) };
}

async function run() {
  const agents = catalog();
  const endpoints = [];
  for (const a of agents) for (const s of a.services) endpoints.push([a,s]);
  console.error(`agents: ${agents.length} | endpoints: ${endpoints.length} — probing (free)…`);

  const results = [];
  let i = 0;
  async function worker() {
    while (i < endpoints.length) {
      const idx = i++; const [a,s] = endpoints[idx];
      const r = await probeEndpoint(a,s);
      results.push(r);
      if (idx % 25 === 0) console.error(`  …${idx}/${endpoints.length}`);
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY}, worker));

  // Summary
  const by = {}; for (const r of results) by[r.verdict] = (by[r.verdict]||0)+1;
  const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  const payable = results.filter(r=>r.verdict==="402-payable");
  const signable = payable.filter(r=> r.network==="eip155:196" && r.asset===USDT && r.schemes.includes("exact"));
  const otherNet = payable.filter(r=> !(r.network==="eip155:196" && r.asset===USDT));

  mkdirSync("data",{recursive:true});
  writeFileSync("data/deep-probe.json", JSON.stringify({ agents:agents.length, endpoints:endpoints.length, summary:by, results }, null, 2));

  console.error("\n=== SUMMARY (endpoints) ===");
  console.error(JSON.stringify(by, null, 0));
  console.error(`\n402-payable total: ${payable.length}`);
  console.error(`  signable now (X Layer USDT + exact scheme): ${signable.length} endpoints across ${new Set(signable.map(r=>r.agentId)).size} agents`);
  console.error(`  payable but different network/asset/scheme: ${otherNet.length}`);
  console.error(`  free-data endpoints: ${(by["free-data"]||0)}`);
  console.error("\n=== SIGNABLE agents (unique) ===");
  const seen=new Set();
  for (const r of signable) { if(seen.has(r.agentId))continue; seen.add(r.agentId); console.error(`  #${r.agentId} ${r.agentName} — ${r.service} ($${r.fee})`); }
  console.error("\n=== FREE-DATA agents (no payment needed!) ===");
  const fseen=new Set();
  for (const r of results.filter(r=>r.verdict==="free-data")) { if(fseen.has(r.agentId))continue; fseen.add(r.agentId); console.error(`  #${r.agentId} ${r.agentName} — ${r.service}`); }
}
run();
