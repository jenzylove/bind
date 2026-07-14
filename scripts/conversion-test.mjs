// Conversion test: for each payment-capable agent (settles, but returned a param error to
// our generic body), call it with LLM-inferred params (the same inferParams the executor
// uses) and see if it now returns DATA. Promotes "pays" agents to "delivers" agents.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";

const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const SPEND_CAP = 2.0;
let spent = 0;

// Load the Anthropic key so the compiled inferParams works.
const env = readFileSync("C:/Users/LENOVO/attestor/.env", "utf8");
process.env.ANTHROPIC_API_KEY = (env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1] || "").trim().replace(/^["']|["']$/g, "");
const { inferParams } = await import("../dist/bind/agent-infer.js");

const payable = JSON.parse(readFileSync("data/payable-agents.json", "utf8"));
const capable = payable.agents.filter((a) => a.tier === "capable");

// Build a description map (endpoint -> full serviceDescription) via a catalog scan.
function descMap() {
  const queries = ["security","audit","risk","scan","verify","trust","market","data","defi","onchain","token","price","signal","news","content","audio","launch","credit","whale","research","ai","crypto"];
  const map = new Map();
  for (const q of queries) {
    try {
      const p = JSON.parse(execFileSync(BIN,["agent","search","--query",q,"--status","online","--page-size","40"],{encoding:"utf8",timeout:15000}));
      for (const a of (p.data?.list||[])) for (const s of (a.services||[])) {
        if (s.endpoint && !map.has(s.endpoint)) map.set(s.endpoint, { name:s.serviceName||"", desc:s.serviceDescription||a.profileDescription||"" });
      }
    } catch {}
  }
  return map;
}

async function post(url, body, headers={}) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), 15000);
  try { const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:c.signal});
    return { status:r.status, headers:r.headers, text: await r.text() }; }
  catch(e){ return { status:0, headers:new Headers(), text:String(e.message).slice(0,40) }; }
  finally { clearTimeout(t); }
}
function looksLikeData(t){ try{ const j=JSON.parse(t); if(j.error||j.success===false) return false; return Object.keys(j).length>0; }catch{ return t.length>25; } }

const GOAL = "Assess token 0x779ded0c9e1022225f8e0630b35a9b54be713736 and the current Bitcoin market for risk, safety and signals";
const descs = descMap();

const out = [];
for (const agent of capable) {
  if (spent + agent.fee > SPEND_CAP) { out.push({ ...agent, result:"skipped-cap" }); continue; }
  const meta = descs.get(agent.endpoint) || { name: agent.service, desc: "" };
  const { method, body } = await inferParams(meta.name, meta.desc, agent.endpoint, GOAL);
  const first = await post(agent.endpoint, body, {}, );
  if (first.status === 200) { out.push({ ...agent, result: looksLikeData(first.text)?"DATA(free)":"200-nodata" }); continue; }
  if (first.status !== 402) { out.push({ ...agent, result:`http-${first.status}`, sample:first.text.slice(0,50) }); continue; }
  const challenge = first.headers.get("payment-required") || (()=>{ try{ const j=JSON.parse(first.text); if(j.accepts||j.x402Version) return Buffer.from(JSON.stringify(j)).toString("base64"); }catch{} return null; })();
  if (!challenge) { out.push({ ...agent, result:"no-challenge" }); continue; }
  let pay; try { pay = JSON.parse((await ex(BIN,["payment","pay","--payload",challenge],{timeout:30000})).stdout).data; } catch { out.push({ ...agent, result:"sign-failed" }); continue; }
  if (!pay?.authorization_header) { out.push({ ...agent, result:"sign-noheader" }); continue; }
  const paid = await post(agent.endpoint, body, { [pay.header_name||"PAYMENT-SIGNATURE"]: pay.authorization_header });
  if (paid.status === 200 || paid.headers.get("payment-response")) {
    spent += agent.fee;
    out.push({ ...agent, result: looksLikeData(paid.text) ? "DATA" : "paid-nodata", sample: paid.text.slice(0,90) });
  } else {
    out.push({ ...agent, result:`paid-${paid.status}`, sample: paid.text.slice(0,60) });
  }
  console.error(`  #${agent.id.padEnd(4)} ${out[out.length-1].result.padEnd(12)} ${agent.name}`);
}

const nowData = out.filter(r=>r.result==="DATA"||r.result==="DATA(free)");
writeFileSync("data/conversion-test.json", JSON.stringify({ spent, tested:out.length, converted:nowData.length, results:out }, null, 2));
console.error(`\n=== DONE. spent $${spent.toFixed(4)} | converted to DATA: ${nowData.length}/${capable.length} ===`);
console.error("NEW data agents:", nowData.map(r=>`#${r.id} ${r.name}`).join(", "));
