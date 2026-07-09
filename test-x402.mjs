// Direct test: Onchain Data Explorer x402 flow
// Bypasses the executor to test if the flow actually works from Railway

import { execSync } from "node:child_process";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

// Step 1: Login
try { execSync(`${ONCHAINOS_PATH} wallet login`, { timeout: 10000 }); } catch {}

// Step 2: Call the endpoint
console.log("=== Step 1: Call Chain Info endpoint ===");
const resp = execSync(
  `curl -s --max-time 10 "https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info" -H "Content-Type: application/json" -d '{"chainIndex":"196"}'`,
  { timeout: 15000, encoding: "utf8" }
);
console.log("Response:", resp.slice(0, 200));

// Step 3: Parse and sign the challenge
const challenge = JSON.parse(resp);
console.log("\n=== Step 2: Sign payment ===");
const payload = Buffer.from(resp).toString("base64");
const signed = execSync(
  `${ONCHAINOS_PATH} payment pay --payload '${payload}'`,
  { timeout: 30000, encoding: "utf8" }
);
const authHeader = JSON.parse(signed).data.authorization_header;
console.log("Auth header:", authHeader.slice(0, 40) + "...");

// Step 4: Replay with Authorization: X402
console.log("\n=== Step 3: Replay with Authorization: X402 ===");
const paid = execSync(
  `curl -s --max-time 10 "https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info" -H "Content-Type: application/json" -H "Authorization: X402 ${authHeader}" -d '{"chainIndex":"196"}'`,
  { timeout: 15000, encoding: "utf8" }
);
console.log("Result:", paid.slice(0, 300));

// Step 5: Also try PAYMENT-SIGNATURE header
console.log("\n=== Step 4: Retry with PAYMENT-SIGNATURE ===");
const paid2 = execSync(
  `curl -s --max-time 10 "https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info" -H "Content-Type: application/json" -H "PAYMENT-SIGNATURE: ${authHeader}" -d '{"chainIndex":"196"}'`,
  { timeout: 15000, encoding: "utf8" }
);
console.log("Result:", paid2.slice(0, 300));