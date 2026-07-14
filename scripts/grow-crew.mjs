// Grow the crew: the settlement errors told us each stuck agent's required field. Pay each
// with the correct hardcoded params and confirm it now returns DATA. Winners get promoted
// to data-confirmed + a param mapping the executor will use. Full error dumped for any that
// still miss, so we can iterate.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const GOAL = "Assess this token and the current crypto market for risk and signals";
const SPEND_CAP = 1.5; let spent = 0;

// Candidate params derived from the settlement error messages.
const CAND = {
  "2180": { target: TOKEN },                                   // MistEye — "missing body.target"
  "3808": { payload: TOKEN },                                  // Warden — "missing body.payload"
  "4759": { ids: "bitcoin,ethereum,solana" },                  // Keryx — "ids is required (comma separated)"
  "3824": { prompt: GOAL },                                    // 链上研究 — "missing body.prompt"
  "4159": { text: "Bitcoin positioning is balanced; no crowding risk right now." }, // AudioForge — "text 不能为空"
  "3884": { address: TOKEN },                                  // QTrade — Address Trust Check
  "2135": { username: "VitalikButerin" },                      // Newsliquid — "用户名不能为空"
  "2118": { mode: "watch" },                                   // Otto — "body.mode must be one of ..."
  "4502": { agent: "2023" },                                   // Factor Credit — "pass an okx.ai agentId"
  "3868": { agent: "2023" },
};

const payable = JSON.parse(readFileSync("data/payable-agents.json", "utf8"));
const needs = payable.needsParams || [];

async function post(url, body, headers={}) {
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),15000);
  try{ const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:c.signal});
    return {status:r.status,headers:r.headers,text:await r.text()}; }
  catch(e){ return {status:0,headers:new Headers(),text:String(e.message)}; } finally{ clearTimeout(t); }
}
function looksLikeData(t){ try{const j=JSON.parse(t); if(j.error||j.success===false||j.ok===false||j.detail) return false; return Object.keys(j).length>0;}catch{return t.length>25;} }

const out = [];
for (const a of needs) {
  const body = CAND[a.id] || {};
  if (spent + a.fee > SPEND_CAP) { out.push({ id:a.id, name:a.name, result:"skipped-cap" }); continue; }
  const first = await post(a.endpoint, body);
  if (first.status !== 402) {
    // no payment needed or hard error
    out.push({ id:a.id, name:a.name, params:Object.keys(body).join(",")||"none", result: first.status===200 ? (looksLikeData(first.text)?"DATA":"200-nodata") : `http-${first.status}`, body:first.text.slice(0,150) });
    console.error(pad(a.id,5), out[out.length-1].result.padEnd(11), a.name); continue;
  }
  const ch = first.headers.get("payment-required") || (()=>{try{const j=JSON.parse(first.text); if(j.accepts||j.x402Version) return Buffer.from(JSON.stringify(j)).toString("base64");}catch{} return null;})();
  if (!ch) { out.push({id:a.id,name:a.name,result:"no-challenge"}); continue; }
  let pay; try{ pay=JSON.parse((await ex(BIN,["payment","pay","--payload",ch],{timeout:30000})).stdout).data; }catch{ out.push({id:a.id,name:a.name,result:"sign-failed"}); continue; }
  if(!pay?.authorization_header){ out.push({id:a.id,name:a.name,result:"sign-noheader"}); continue; }
  const paid = await post(a.endpoint, body, { [pay.header_name||"PAYMENT-SIGNATURE"]: pay.authorization_header });
  const isData = paid.status===200 && looksLikeData(paid.text);
  if (paid.status===200 || paid.headers.get("payment-response")) spent += a.fee;
  out.push({ id:a.id, name:a.name, params:Object.keys(body).join(",")||"none", result: isData?"DATA":(paid.status===200?"200-nodata":`paid-${paid.status}`), body: paid.text.slice(0,170) });
  console.error(pad(a.id,5), out[out.length-1].result.padEnd(11), a.name, "|", paid.text.slice(0,90));
}
function pad(s,n){ return String(s).padEnd(n); }
const won = out.filter(r=>r.result==="DATA");
console.error(`\n=== spent $${spent.toFixed(4)} | NEW DATA agents: ${won.length} ===`);
console.error(won.map(r=>`#${r.id} ${r.name} (params: ${r.params})`).join("\n"));
console.error("\n--- still stuck (full body) ---");
out.filter(r=>r.result&&r.result!=="DATA"&&r.result!=="skipped-cap").forEach(r=>console.error(`#${r.id} ${r.name} [${r.result}]: ${r.body||""}`));
writeFileSync("data/grow-crew.json", JSON.stringify(out,null,2));
