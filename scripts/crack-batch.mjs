// Batch cracker: throw EVERY parked agent at the wall at once, using the exact params each
// one's own error/schema demanded. Handles three shapes:
//   1. REST agents  -> post the known body
//   2. schema agents -> fetch their published docsUrl first, then post per the schema
//   3. MCP agents    -> JSON-RPC with the SSE-compatible Accept header, discover tools/list
// Any that return data get promoted; the rest print their full error so the next pass is
// informed rather than guesswork.
//
// Run: node scripts/crack-batch.mjs        (requires the onchainos CLI to be reachable)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";

const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const GOAL = "Assess this token and the current crypto market for risk and signals";
const SPEND_CAP = 2.0;
const CONCURRENCY = 4;
let spent = 0;

// Params taken verbatim from each agent's own error message or published schema.
const KNOWN = {
  "3884": { chain: "xlayer", address: TOKEN },                    // published schema
  "2118": { mode: "notify" },                                      // "must be auto or notify"
  "2180": { target: TOKEN, type: "address" },                      // demanded `type`
  "4153": { receipt_id: "test", payload: TOKEN },                  // "`receipt_id` is required"
  "2084": { serviceName: "bind", url: "https://www.trybind.xyz" }, // "missing body.serviceName"
  "3255": { model: "gpt-4o-mini", messages: [{ role: "user", content: GOAL }] },
  "4674": { target_agent: "4348" },                                // supportedTargets listed 4348
  "4490": { service: "agent_kol_studio", request: { goal: GOAL, url: "https://www.trybind.xyz" } },
  "4451": { service: "agent_output_verifier", request: { output: "BTC positioning is balanced.", goal: GOAL } },
  "4453": { service: "agent_trust_layer", request: { agentId: "2023", goal: GOAL } },
};
// Alternate bodies to try if the first shape is rejected.
const ALTS = {
  "2180": [{ target: TOKEN, type: "token" }, { target: TOKEN, type: "contract" }, { target: TOKEN, type: "wallet" }],
  "2118": [{ mode: "auto" }],
  "4451": [{ output: "BTC positioning is balanced.", goal: GOAL }, { requestId: "1", output: "x" }],
  "4453": [{ agentId: "2023" }, { agent: "2023" }],
  "4490": [{ goal: GOAL }, { url: "https://www.trybind.xyz" }],
};

const payable = JSON.parse(readFileSync("data/payable-agents.json", "utf8"));
const parked = payable.needsParams || [];

const isMcp = (u) => /\/mcp\/?$/.test(u) || /mcp/.test(new URL(u).pathname);
const MCP_HEADERS = { accept: "application/json, text/event-stream" };

async function post(url, body, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: c.signal });
    return { status: r.status, headers: r.headers, text: await r.text() };
  } catch (e) { return { status: 0, headers: new Headers(), text: String(e.message) }; }
  finally { clearTimeout(t); }
}
function looksLikeData(t) {
  try { const j = JSON.parse(t); if (j.error || j.success === false || j.ok === false || j.detail) return false; return Object.keys(j).length > 0; }
  catch { return t.length > 25; }
}
async function sign(challenge) {
  try { return JSON.parse((await ex(BIN, ["payment", "pay", "--payload", challenge], { timeout: 40000 })).stdout).data; }
  catch { return null; }
}
// Some agents publish their own schema; read it instead of guessing.
async function schemaBody(errText) {
  const m = errText.match(/https?:\/\/[^"\s]+schema[^"\s]*/);
  if (!m) return null;
  try {
    const r = await fetch(m[0], { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return j.exampleBody ?? null;
  } catch { return null; }
}

async function attempt(a, body, mcp) {
  const headers = mcp ? MCP_HEADERS : {};
  const first = await post(a.endpoint, body, headers);
  if (first.status !== 402) return { stage: "unpaid", res: first };
  const ch = first.headers.get("payment-required");
  if (!ch) return { stage: "no-challenge", res: first };
  if (spent + a.fee > SPEND_CAP) return { stage: "cap", res: first };
  const pay = await sign(ch);
  if (!pay?.authorization_header) return { stage: "sign-failed", res: first };
  const paid = await post(a.endpoint, body, { ...headers, [pay.header_name || "PAYMENT-SIGNATURE"]: pay.authorization_header });
  if (paid.status === 200 || paid.headers.get("payment-response")) spent += a.fee;
  return { stage: "paid", res: paid };
}

async function crack(a) {
  const mcp = isMcp(a.endpoint);
  const bodies = mcp
    ? [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]
    : [KNOWN[a.id] ?? { q: GOAL }, ...(ALTS[a.id] ?? [])];

  for (const body of bodies) {
    const { stage, res } = await attempt(a, body, mcp);
    if (stage === "sign-failed") return { id: a.id, name: a.name, result: "SIGNER-DOWN" };
    if (stage === "cap") return { id: a.id, name: a.name, result: "skipped-cap" };
    if (res.status === 200 && looksLikeData(res.text)) {
      return { id: a.id, name: a.name, result: "DATA", body: JSON.stringify(body), sample: res.text.slice(0, 120) };
    }
    // If it published a schema, try that before giving up on this agent.
    const sb = await schemaBody(res.text);
    if (sb) {
      const retry = await attempt(a, sb, mcp);
      if (retry.res.status === 200 && looksLikeData(retry.res.text)) {
        return { id: a.id, name: a.name, result: "DATA", body: JSON.stringify(sb), sample: retry.res.text.slice(0, 120) };
      }
    }
    var last = res;
  }
  return { id: a.id, name: a.name, result: `stuck-${last?.status}`, sample: (last?.text || "").replace(/\s+/g, " ").slice(0, 170) };
}

const out = [];
let i = 0;
async function worker() {
  while (i < parked.length) {
    const a = parked[i++];
    const r = await crack(a);
    out.push(r);
    console.error(`#${String(r.id).padEnd(5)} ${r.result.padEnd(13)} ${(r.name || "").padEnd(22)} ${r.sample ? r.sample.slice(0, 80) : ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const won = out.filter((r) => r.result === "DATA");
writeFileSync("data/crack-batch.json", JSON.stringify(out, null, 2));
console.error(`\n=== spent $${spent.toFixed(4)} | cracked ${won.length}/${parked.length} ===`);
won.forEach((w) => console.error(`  #${w.id} ${w.name}  params: ${w.body}`));
if (out.some((r) => r.result === "SIGNER-DOWN")) console.error("\n(the OKX signer was unreachable — rerun when it is back)");
