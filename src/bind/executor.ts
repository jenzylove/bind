// Bind execution engine — direct agent calls with known-good params
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { BindExecution, BindPlan, ExecutionResult } from "./types.js";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

function login(): boolean {
  try {
    execSync(`${ONCHAINOS_PATH} wallet login`, { timeout: 10000, encoding: "utf8" });
    return true;
  } catch { return false; }
}

function httpCall(method: string, url: string, bodyStr: string | null, auth?: string, fmt?: "x402" | "payment"): { status: number; body: string; headers: Record<string, string> } {
  const header = auth ? (fmt === "x402" ? `-H 'Authorization: X402 ${auth}'` : `-H 'PAYMENT-SIGNATURE: ${auth}'`) : "";
  const bodyFlag = bodyStr ? `-d '${bodyStr.replace(/'/g, "'\\''")}'` : "";
  const result = execSync(
    `curl -sD - --max-time 15 -X ${method} '${url}' -H 'Content-Type: application/json' ${header} ${bodyFlag}`,
    { timeout: 20000, encoding: "utf8" }
  );
  const headerEnd = result.indexOf("\r\n\r\n");
  const h = result.slice(0, headerEnd).split("\r\n");
  const status = parseInt(h[0].split(" ")[1], 10);
  const headers: Record<string, string> = {};
  for (const l of h.slice(1)) { const c = l.indexOf(":"); if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); }
  return { status, body: result.slice(headerEnd + 4).trim(), headers };
}

function getParams(endpoint: string, goal: string): { body: Record<string, unknown>; method: "POST" | "GET" } {
  const e = endpoint;
  const hasAddr = goal.includes("0x");
  // Onchain Data Explorer (Agent 2023) — OKX Official
  if (e.includes("get_chain_info")) return { body: { chainIndex: "196" }, method: "POST" };
  if (e.includes("get_token_info")) return { body: { chainIndex: "196", tokenAddress: hasAddr ? goal : "0x779ded0c9e1022225f8e0630b35a9b54be713736" }, method: "POST" };
  if (e.includes("get_address_profile")) return { body: { chainIndex: "196", address: hasAddr ? goal : "0x22700698c503be7dfdeaaacc2e4e41c767c263b" }, method: "POST" };
  if (e.includes("get_token_price_history")) return { body: { chainIndex: "196", tokenAddress: hasAddr ? goal : "0x779ded0c9e1022225f8e0630b35a9b54be713736", granularity: "1D" }, method: "POST" };
  if (e.includes("get_block")) return { body: { chainIndex: "196", by: "height", value: "21000000" }, method: "POST" };
  if (e.includes("get_transaction")) return { body: { chainIndex: "196", txHash: hasAddr ? goal : "0x" }, method: "POST" };
  if (e.includes("get_contract_source")) return { body: { chainIndex: "196", address: hasAddr ? goal : "0x" }, method: "POST" };
  if (e.includes("get_token_holders")) return { body: { chainIndex: "196", tokenAddress: hasAddr ? goal : "0x", n: 5 }, method: "POST" };
  if (e.includes("get_address_transactions")) return { body: { chainIndex: "196", address: hasAddr ? goal : "0x22700698c503be7dfdeaaacc2e4e41c767c263b", limit: 3 }, method: "POST" };
  if (e.includes("get_token_price")) return { body: { chainIndex: "196", tokenAddresses: [hasAddr ? goal : "0x779ded0c9e1022225f8e0630b35a9b54be713736"] }, method: "POST" };
  if (e.includes("get_event_logs")) return { body: { chainIndex: "196", by: "tx", txHash: "0x" }, method: "POST" };
  if (e.includes("list_chains")) return { body: {}, method: "POST" };
  if (e.includes("universal_search")) return { body: { input: hasAddr ? goal : "0x" }, method: "POST" };
  // NewsLiquid (Agent 2135)
  if (e.includes("news_search") || e.includes("news_type")) return { body: { q: goal }, method: "POST" };
  if (e.includes("twitter_user_tweets")) return { body: { username: "Dollar782", maxResults: "3" }, method: "POST" };
  if (e.includes("twitter_user_info")) return { body: { username: "Dollar782" }, method: "POST" };
  if (e.includes("twitter_search")) return { body: { keywords: goal }, method: "POST" };
  // CoinAnk (Agent 2013) — Most are GET requests
  if (e.includes("coinank") || e.includes("getUsBtcEtf") || e.includes("getUsEthEtf") || e.includes("getLastPrice") || e.includes("getCoinMarketCap")) return { body: {}, method: "GET" };
  // Barker Yield (Agent 2012)
  if (e.includes("barker_defi_vaults") || e.includes("barker_market_overview") || e.includes("barker_market_trend")) return { body: {}, method: "POST" };
  if (e.includes("barker_yield_advisor")) return { body: { limit: 5 }, method: "POST" };
  // Generic fallback
  return { body: { q: goal }, method: "POST" };
}

export async function executePlan(plan: BindPlan): Promise<BindExecution> {
  login();
  const executionId = randomUUID();
  const stepResults: ExecutionResult[] = [];
  const outputs: string[] = [];

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step, agentName: step.agent.name, status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      const { body, method } = getParams(step.agent.endpoint, plan.goal);
      const bodyStr = method === "POST" ? JSON.stringify(body) : null;
      result.input = body;

      let initial = httpCall(method, step.agent.endpoint, bodyStr);
      if (initial.status === 405 && method === "POST") {
        initial = httpCall("GET", step.agent.endpoint, null);
      }

      if (initial.status === 200) {
        result.output = JSON.parse(initial.body || "{}");
        result.status = "passed";
        result.paymentTxHash = "no_payment_needed";
      } else if (initial.status === 402) {
        let challenge = JSON.parse(initial.body || "{}");
        if (!challenge.accepts) {
          const pr = initial.headers["payment-required"];
          if (pr) {
            try { challenge = JSON.parse(Buffer.from(pr, "base64").toString()); } catch {}
          }
        }
        if (challenge?.accepts?.[0]) {
          const payload = Buffer.from(JSON.stringify(challenge)).toString("base64");
          try {
            const signed = execSync(`${ONCHAINOS_PATH} payment pay --payload '${payload}'`, { timeout: 30000, encoding: "utf8" });
            const auth = JSON.parse(signed).data?.authorization_header;
            if (auth) {
              // Try PAYMENT-SIGNATURE first, then Authorization: X402
              let paid = httpCall("POST", step.agent.endpoint, bodyStr, auth, "payment");
              if (paid.status !== 200) paid = httpCall("POST", step.agent.endpoint, bodyStr, auth, "x402");
              if (paid.status === 200) {
                result.output = JSON.parse(paid.body || "{}");
                result.status = "passed";
                result.paymentTxHash = "paid_via_x402";
              } else {
                result.status = "errored";
                result.error = `Paid call returned ${paid.status}: ${paid.body.slice(0, 60)}`;
              }
            } else {
              result.status = "errored";
              result.error = "Payment signed but no auth header";
            }
          } catch (e: any) {
            result.status = "errored";
            result.error = `Payment signing failed: ${e.message}`;
          }
        } else {
          result.status = "errored";
          result.error = "Invalid x402 challenge";
        }
      } else {
        result.status = "errored";
        result.error = `HTTP ${initial.status}`;
      }

      if (result.status === "passed" && result.output) {
        outputs.push(`[${step.agent.name}]\n${JSON.stringify(result.output, null, 2)}`);
      }
    } catch (e: any) {
      result.status = "errored";
      result.error = e.message || String(e);
    }

    result.completedAt = new Date().toISOString();
    stepResults.push(result);
  }

  const completed = stepResults.filter(r => r.status === "passed").length;
  const totalPaid = stepResults.reduce((s, r) => s + (r.status === "passed" && r.paymentTxHash === "paid_via_x402" ? 1 : 0), 0) * 0.001;

  return {
    executionId, planId: plan.planId, goal: plan.goal,
    status: completed === stepResults.length ? "completed" : completed > 0 ? "partial" : "failed",
    stepResults,
    finalOutput: outputs.join("\n\n---\n\n") || "No agent outputs retrieved.",
    totalPaid, totalSteps: stepResults.length, completedSteps: completed,
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };
}