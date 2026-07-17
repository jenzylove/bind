// Payability probe — for each cheap A2MCP agent, actually attempt the x402 flow and
// record whether it SETTLES a payment (or serves data free). Produces a tested allowlist
// the planner biases toward, so plans favor agents that really pay out, not ones that
// return 402 on a valid payment. Cost is real but tiny (only agents that settle charge).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const DATA_DIR = process.env.BIND_DATA_DIR ?? "data";
const PAYABLE_FILE = DATA_DIR + "/payable-agents.json";
const SPEND_CAP = 0.12;          // wallet is low pre-refund — hard stop once cumulative settled fees exceed this
const FEE_CEILING = 0.02;        // don't probe services pricier than this
let spent = 0;

// Skip agents we've already probed (successfully or not) — don't re-spend confirming a
// known reject, and don't waste calls re-verifying a known-payable agent.
let alreadyProbed = new Set();
try {
  const prev = JSON.parse(readFileSync(PAYABLE_FILE, "utf8"));
  alreadyProbed = new Set((prev.all || []).map((a) => a.id));
} catch {}

function catalog() {
  const queries = [
    "ai","crypto","trading","market","data","security","audit","news","social",
    "sentiment","nft","defi","yield","swap","token","price","onchain","wallet",
    "analytics","signal","research","meme","derivatives","funding","liquidation",
    "twitter","kol","content","art","game","sports","prediction","health","legal",
    "credit","payment","bridge","stake","dex","rpc","chart","alert","monitor",
    "scan","risk","brief","quant","arbitrage","options","stocks","macro","whale",
    "airdrop","launch","mint","A2MCP",
  ];
  const seen = new Map();
  for (const q of queries) {
    try {
      const p = JSON.parse(execFileSync(BIN,["agent","search","--query",q,"--status","online","--page-size","30"],{encoding:"utf8",timeout:15000}));
      for (const a of (p.data?.list||[])) {
        const svcs = (a.services||[]).filter(s=>s.serviceType==="A2MCP"&&s.endpoint);
        if (!svcs.length || seen.has(String(a.agentId))) continue;
        const cheapest = svcs.reduce((x,y)=>parseFloat(x.feeAmount)<=parseFloat(y.feeAmount)?x:y);
        seen.set(String(a.agentId),{
          id:String(a.agentId), name:a.name||"?", fee:parseFloat(cheapest.feeAmount)||0,
          endpoint:cheapest.endpoint, service:cheapest.serviceName,
          desc:(cheapest.serviceDescription||a.profileDescription||"").slice(0,140), svcCount:svcs.length,
        });
      }
    } catch {}
  }
  return [...seen.values()].filter(a=>a.fee<=FEE_CEILING).sort((a,b)=>a.fee-b.fee);
}

async function post(url, body, headers={}) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), 15000);
  try {
    const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:c.signal});
    return { status:r.status, headers:r.headers, text: await r.text() };
  } catch(e){ return { status:0, headers:new Headers(), text:String(e.message) }; }
  finally { clearTimeout(t); }
}

function settled(headers) {
  const pr = headers.get("payment-response");
  if (!pr) return null;
  try { const d = JSON.parse(Buffer.from(pr,"base64").toString()); return { ok:d?.success===true, tx:d?.transaction }; }
  catch { return null; }
}

// Loose "did we get real data" check.
function looksLikeData(text) {
  if (!text) return false;
  try { const j = JSON.parse(text);
    if (j?.error || j?.success===false) return false;
    return Object.keys(j).length>0;
  } catch { return text.length>20; }
}

async function probe(a) {
  const body = { q: "bitcoin", input: "bitcoin" };
  let r = await post(a.endpoint, body);
  if (r.status === 200) return { ...a, verdict: looksLikeData(r.text)?"free-data":"free-200", cost:0, sample:r.text.slice(0,80) };
  if (r.status !== 402) return { ...a, verdict:`http-${r.status}`, cost:0, sample:r.text.slice(0,80) };

  if (spent + a.fee > SPEND_CAP) return { ...a, verdict:"skipped-cap", cost:0 };
  const challenge = r.headers.get("payment-required");
  if (!challenge) return { ...a, verdict:"402-no-challenge", cost:0 };
  let auth;
  try { auth = JSON.parse((await ex(BIN,["payment","pay","--payload",challenge],{timeout:30000})).stdout).data?.authorization_header; } catch {}
  if (!auth) return { ...a, verdict:"sign-failed", cost:0 };

  // Standard x402 header first, then the variants some sellers use.
  for (const h of [{"X-PAYMENT":auth},{"PAYMENT-SIGNATURE":auth},{"Authorization":`X402 ${auth}`}]) {
    const paid = await post(a.endpoint, body, h);
    const s = settled(paid.headers);
    if (paid.status===200 || (s && s.ok)) {
      spent += a.fee;
      return { ...a, verdict:"PAID-SETTLED", cost:a.fee, tx:s?.tx, header:Object.keys(h)[0], data:looksLikeData(paid.text), sample:paid.text.slice(0,80) };
    }
  }
  return { ...a, verdict:"rejected-payment", cost:0 };
}

const fullCatalog = catalog();
const agents = fullCatalog.filter((a) => !alreadyProbed.has(a.id));
console.error(`catalog: ${fullCatalog.length} total, ${agents.length} new (skipping ${fullCatalog.length - agents.length} already-probed). spend cap $${SPEND_CAP}...`);
const results = [];
for (const a of agents) {
  const res = await probe(a);
  results.push(res);
  console.error(`  #${res.id} ${("$"+res.fee).padEnd(9)} ${res.verdict.padEnd(18)} ${res.name}`);
}
// Merge with previously-probed results so the output file stays a full historical record.
let previousAll = [];
try { previousAll = JSON.parse(readFileSync(PAYABLE_FILE, "utf8")).all || []; } catch {}
const mergedAll = [...previousAll, ...results];

// Data-usable = settled/free AND returned real data AND not an MCP/topup endpoint (those
// settle but yield no usable one-shot data). This auto-curation is what keeps us from
// hand-maintaining the allowlist as the marketplace changes.
function dataUsable(r) {
  if (!["PAID-SETTLED","free-data","free-200"].includes(r.verdict)) return false;
  if (r.data === false) return false;
  const ep = (r.endpoint||"").toLowerCase();
  if (ep.endsWith("/mcp") || ep.includes("/topup")) return false;
  return true;
}
// Carry forward previously-confirmed payable agents (they aren't re-probed this run) and
// merge in anything new this run found data-usable.
let previousPayable = [];
try { previousPayable = JSON.parse(readFileSync(PAYABLE_FILE, "utf8")).payable || []; } catch {}
const newUsable = results.filter(dataUsable);
const settledThisRun = results.filter(r=>["PAID-SETTLED","free-data","free-200"].includes(r.verdict));
const usableById = new Map(previousPayable.map(p=>[p.id,p]));
for (const p of newUsable) usableById.set(p.id, {id:p.id,name:p.name,fee:p.fee,verdict:p.verdict,endpoint:p.endpoint,service:p.service,desc:p.desc});
const usable = [...usableById.values()];

mkdirSync(DATA_DIR,{recursive:true});
writeFileSync(PAYABLE_FILE, JSON.stringify({
  probedAt:new Date().toISOString().slice(0,10), totalProbedThisRun:results.length, totalProbedAllTime:mergedAll.length, totalSpentThisRun:spent,
  payableIds: usable.map(p=>p.id),                       // routing set = data-usable, carried forward across runs
  settledButUnusable: settledThisRun.filter(r=>!dataUsable(r)).map(p=>({id:p.id,name:p.name,reason:(p.endpoint||"").endsWith("/mcp")?"mcp":(p.endpoint||"").includes("/topup")?"topup":"no-data"})),
  payable: usable,
  all: mergedAll,
}, null, 2));
console.error(`\nDONE. spent $${spent.toFixed(4)} this run. new-this-run: ${newUsable.length}, total data-usable: ${usable.length}, total probed all-time: ${mergedAll.length}`);
console.error("data-usable (all-time):", usable.map(p=>`#${p.id} ${p.name}`).join(", "));
