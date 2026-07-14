// Settlement test (PAID): for each newly-discovered signable endpoint, sign with the TEE
// wallet and replay using the CORRECT header_name the CLI returns (not a guess), then
// record whether the payment actually SETTLES and whether we get data back. Cheapest-first,
// one service per agent for breadth, hard spend cap. Skips the 5 already confirmed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";

const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const KNOWN = new Set(["2023","4413","3417","3887","5222"]);
const FEE_CAP = 0.12;         // per-call: skip pricier services for this sweep
const SPEND_CAP = 3.0;        // total hard stop
let spent = 0;

const probe = JSON.parse(readFileSync("data/deep-probe.json","utf8"));
// signable endpoints, cheapest service per agent, excluding known + too-pricey
const byAgent = new Map();
for (const r of probe.results) {
  if (r.verdict !== "402-payable") continue;
  if (!(r.network === "eip155:196" && r.asset === USDT && (r.schemes||[]).includes("exact"))) continue;
  if (KNOWN.has(r.agentId)) continue;
  if (r.fee > FEE_CAP) continue;
  const cur = byAgent.get(r.agentId);
  if (!cur || r.fee < cur.fee) byAgent.set(r.agentId, r);
}
const targets = [...byAgent.values()].sort((a,b)=>a.fee-b.fee);

async function post(url, headers={}) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), 15000);
  const body = JSON.stringify({ q:"bitcoin", input:"bitcoin", query:"bitcoin", symbol:"BTC", chainIndex:"196" });
  try { const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body,signal:c.signal});
    return { status:r.status, headers:r.headers, text: await r.text() }; }
  catch(e){ return { status:0, headers:new Headers(), text:String(e.message).slice(0,40) }; }
  finally { clearTimeout(t); }
}
function looksLikeData(text){ try{ const j=JSON.parse(text); if(j.error||j.success===false) return false; return Object.keys(j).length>0; }catch{ return text.length>25; } }
function settled(h){ const pr=h.get("payment-response"); if(!pr) return null; try{ const d=JSON.parse(Buffer.from(pr,"base64").toString()); return {ok:d?.success===true,tx:d?.transaction}; }catch{ return null; } }

async function testOne(r) {
  if (spent + r.fee > SPEND_CAP) return { ...r, result:"skipped-cap" };
  // fresh challenge
  const res = await post(r.endpoint);
  if (res.status !== 402) return { ...r, result:`no-402(${res.status})` };
  const challenge = res.headers.get("payment-required") || (()=>{ try{ const j=JSON.parse(res.text); if(j.accepts||j.x402Version) return Buffer.from(JSON.stringify(j)).toString("base64"); }catch{} return null; })();
  if (!challenge) return { ...r, result:"no-challenge-refetch" };
  let pay;
  try { pay = JSON.parse((await ex(BIN,["payment","pay","--payload",challenge],{timeout:30000})).stdout).data; }
  catch(e){ return { ...r, result:"sign-failed" }; }
  if (!pay?.authorization_header) return { ...r, result:"sign-noheader" };
  const headerName = pay.header_name || "PAYMENT-SIGNATURE";
  // try correct header first, then fallbacks
  const variants = [ {[headerName]: pay.authorization_header}, {"X-PAYMENT": pay.authorization_header}, {"Authorization": `X402 ${pay.authorization_header}`} ];
  for (const h of variants) {
    const paid = await post(r.endpoint, h);
    const s = settled(paid.headers);
    if (paid.status === 200 || (s && s.ok)) {
      spent += r.fee;
      return { ...r, result:"PAID", header:Object.keys(h)[0], settledFlag: s?.ok||false, tx:s?.tx, data:looksLikeData(paid.text), sample: paid.text.slice(0,70) };
    }
    if (paid.status !== 402) return { ...r, result:`paid-${paid.status}`, sample: paid.text.slice(0,50) };
  }
  return { ...r, result:"rejected-402" };
}

console.error(`signable candidates (cheapest svc/agent, fee<=$${FEE_CAP}, excl known 5): ${targets.length} | spend cap $${SPEND_CAP}\n`);
const out = [];
for (const r of targets) {
  const res = await testOne(r);
  out.push(res);
  const tag = res.result==="PAID" ? (res.data?"PAID+DATA":"PAID(no-data)") : res.result;
  console.error(`  #${res.agentId.padEnd(4)} $${String(res.fee).padEnd(7)} ${tag.padEnd(16)} ${res.agentName} — ${res.service}`);
}
const paid = out.filter(r=>r.result==="PAID");
const paidData = paid.filter(r=>r.data);
writeFileSync("data/settle-test.json", JSON.stringify({ spent, tested:out.length, paid:paid.length, paidWithData:paidData.length, results:out }, null, 2));
console.error(`\n=== DONE. spent $${spent.toFixed(4)} | tested ${out.length} | PAID ${paid.length} | PAID+DATA ${paidData.length} ===`);
console.error("NEW payable+data agents:", paidData.map(r=>`#${r.agentId} ${r.agentName}`).join(", "));
console.error("Paid but no-data (params fixable):", paid.filter(r=>!r.data).map(r=>`#${r.agentId} ${r.agentName}`).join(", "));
