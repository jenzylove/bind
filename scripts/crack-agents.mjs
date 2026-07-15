// Crack the remaining parked agents using the exact params their own errors/schemas asked
// for. QTrade published a schema; Otto named its valid modes; MistEye named its missing field.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const ex = promisify(execFile);
const BIN = process.env.HOME + "/.local/bin/onchainos";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

const TARGETS = [
  // QTrade schema: {chain: one of ethereum|base|bnb|xlayer|polygon, address: EVM address}
  { id: "3884", name: "QTrade Guard", endpoint: "https://api.qtrade.top/okx/address-trust", body: { chain: "xlayer", address: TOKEN } },
  // Otto: body.mode must be "auto" (signed delegation) or "notify" (free observation)
  { id: "2118", name: "Otto AI", endpoint: "https://xlayer.ottoai.services/yield-watch", body: { mode: "notify" } },
  // MistEye: had {target}, error demanded a `type`
  { id: "2180", name: "MistEye", endpoint: "https://x402.misteye.io/okx/x402/detect", body: { target: TOKEN, type: "address" } },
];

async function post(url, body, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: c.signal });
    return { status: r.status, headers: r.headers, text: await r.text() };
  } catch (e) { return { status: 0, headers: new Headers(), text: String(e.message) }; }
  finally { clearTimeout(t); }
}
function looksLikeData(t) { try { const j = JSON.parse(t); if (j.error || j.success === false || j.ok === false || j.detail) return false; return Object.keys(j).length > 0; } catch { return t.length > 25; } }

for (const t of TARGETS) {
  const first = await post(t.endpoint, t.body);
  if (first.status !== 402) {
    console.log(`#${t.id} ${t.name}: no-402 (${first.status}) ${first.text.slice(0, 90)}`);
    continue;
  }
  const ch = first.headers.get("payment-required");
  if (!ch) { console.log(`#${t.id} ${t.name}: no challenge`); continue; }
  let pay;
  try { pay = JSON.parse((await ex(BIN, ["payment", "pay", "--payload", ch], { timeout: 30000 })).stdout).data; }
  catch { console.log(`#${t.id} ${t.name}: sign failed`); continue; }
  const paid = await post(t.endpoint, t.body, { [pay.header_name || "PAYMENT-SIGNATURE"]: pay.authorization_header });
  const ok = paid.status === 200 && looksLikeData(paid.text);
  console.log(`#${t.id} ${t.name}: ${ok ? "*** DATA ***" : "still-" + paid.status} :: ${paid.text.replace(/\s+/g, " ").slice(0, 150)}`);
}
