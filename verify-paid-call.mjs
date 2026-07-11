// One real paid x402 call, end-to-end, the SAFE way: Node fetch + execFile (no shell
// string interpolation). Proves the money path AND captures whether the paid response
// carries an on-chain tx hash (informs the receipt work). Max spend: a few micro-USDT.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const BIN = (process.env.HOME || process.env.USERPROFILE) + "/.local/bin/onchainos";

const TARGET = {
  url: "https://www.oklink.com/api/v5/explorer/mcp/x402/get_token_info",
  body: { chainIndex: "196", tokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736" },
};

function dumpHeaders(h) {
  const interesting = [];
  for (const [k, v] of h.entries()) {
    if (/payment|tx|hash|settle|receipt/i.test(k)) interesting.push(`${k}: ${v.slice(0, 80)}`);
  }
  return interesting.length ? interesting.join("\n    ") : "(no payment/tx headers)";
}

async function post(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

console.log("=== ensure logged in ===");
try { await execFileAsync(BIN, ["wallet", "login"], { timeout: 20000 }); console.log("login ok"); }
catch (e) { console.log("login failed:", e.message); }

console.log("\n=== 1. initial call ===");
const first = await post(TARGET.url, TARGET.body);
console.log("status:", first.status);

if (first.status === 200) {
  console.log("FREE endpoint — returned 200 with no payment. Data:", first.text.slice(0, 160));
  console.log("\n(Payment path not exercised — this agent is free. Try a paid agent to prove settlement.)");
  process.exit(0);
}

if (first.status !== 402) {
  console.log("Unexpected status. Body:", first.text.slice(0, 200));
  process.exit(1);
}

// Extract the challenge from the Payment-Required header (v2) or body (v1)
let challengeB64 = first.headers.get("payment-required");
if (!challengeB64) {
  challengeB64 = Buffer.from(first.text).toString("base64");
}
console.log("got 402 challenge, length:", challengeB64.length);

console.log("\n=== 2. sign via TEE wallet ===");
const t0 = Date.now();
const { stdout } = await execFileAsync(BIN, ["payment", "pay", "--payload", challengeB64], { timeout: 30000 });
const auth = JSON.parse(stdout).data?.authorization_header;
console.log("signed in", ((Date.now() - t0) / 1000).toFixed(1) + "s, header len:", auth?.length);

console.log("\n=== 3. replay with payment (fast) ===");
let paid = await post(TARGET.url, TARGET.body, { "PAYMENT-SIGNATURE": auth });
if (paid.status !== 200) {
  console.log("PAYMENT-SIGNATURE gave", paid.status, "— trying Authorization: X402");
  paid = await post(TARGET.url, TARGET.body, { "Authorization": `X402 ${auth}` });
}
console.log("PAID call status:", paid.status);
console.log("response payment/tx headers:\n    " + dumpHeaders(paid.headers));
console.log("data:", paid.text.slice(0, 220));
console.log(paid.status === 200 ? "\n✅ REAL PAID CALL SUCCEEDED" : "\n❌ paid replay failed");
process.exit(paid.status === 200 ? 0 : 1);
