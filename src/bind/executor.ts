// Bind execution engine — pays marketplace agents via x402, verifies each output,
// anchors an on-chain receipt.
//
// Security: all HTTP is done with fetch and all CLI calls with execFile + an argument
// array. Nothing from the marketplace (endpoint URLs) or the user (goal) is ever
// interpolated into a shell string — there is no shell. This closes the command-
// injection surface that existed when calls were built as `execSync(\`curl '${url}'\`)`.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BindExecution, BindPlan, ExecutionResult } from "./types.js";
import { verifyStepOutput } from "./verify.js";
import { anchorExecution } from "./receipt.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";

interface HttpResult { status: number; body: string; headers: Headers; }

async function httpCall(method: "GET" | "POST", url: string, body: Record<string, unknown> | null, headers: Record<string, string> = {}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (e) {
    return { status: 0, body: (e as Error).message, headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

async function walletLogin(): Promise<void> {
  // Best-effort: a live session may already exist, in which case a re-login errors
  // harmlessly. Real auth failures surface later as a failed payment sign.
  try { await execFileAsync(ONCHAINOS_PATH, ["wallet", "login"], { timeout: 20000 }); } catch { /* ignore */ }
}

async function signPayment(challengeB64: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(ONCHAINOS_PATH, ["payment", "pay", "--payload", challengeB64], { timeout: 30000 });
    return JSON.parse(stdout).data?.authorization_header ?? null;
  } catch {
    return null;
  }
}

// The paid response carries a base64 `payment-response` header: {success, transaction}.
// Extract the real on-chain settlement tx hash so the receipt tells the truth.
function extractSettlementTx(headers: Headers): string | undefined {
  const pr = headers.get("payment-response");
  if (!pr) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(pr, "base64").toString());
    return typeof decoded?.transaction === "string" ? decoded.transaction : undefined;
  } catch {
    return undefined;
  }
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
  if (e.includes("twitter_kol_followers")) return { body: { username: "Dollar782" }, method: "POST" };
  if (e.includes("twitter_tweet_by_id") || e.includes("twitter_article_by_id")) return { body: { id: goal.includes(".") ? "" : goal }, method: "POST" };
  // CoinAnk (Agent 2013) — Most are GET requests
  if (e.includes("coinank") || e.includes("etf")) return { body: {}, method: "GET" };
  if (e.includes("getLastPrice") || e.includes("getCoinMarketCap")) return { body: { symbol: "BTC" }, method: "GET" };
  if (e.includes("liq") || e.includes("funding") || e.includes("longshort") || e.includes("position")) return { body: { symbol: "BTCUSDT" }, method: "GET" };
  if (e.includes("tickers") || e.includes("instruments")) return { body: {}, method: "GET" };
  if (e.includes("kline") || e.includes("agg")) return { body: { symbol: "BTCUSDT", interval: "1h" }, method: "GET" };
  if (e.includes("news_list") || e.includes("getNewsList")) return { body: { limit: 5 }, method: "GET" };
  // Barker Yield (Agent 2012)
  if (e.includes("barker_defi_vaults") || e.includes("barker_market_overview") || e.includes("barker_market_trend")) return { body: {}, method: "POST" };
  if (e.includes("barker_yield_advisor")) return { body: { limit: 5 }, method: "POST" };
  if (e.includes("barker_pool_search")) return { body: { q: goal }, method: "POST" };
  if (e.includes("barker_pool_detail") || e.includes("barker_pool_history")) return { body: { poolUid: "" }, method: "POST" };
  // Generic fallback
  return { body: { q: goal }, method: "POST" };
}

// Runs a single step: call the agent, pay if it returns 402, capture the real
// settlement tx hash. Returns the raw output (or null) plus payment metadata.
async function callAgent(endpoint: string, goal: string): Promise<{ output: unknown | null; paid: boolean; txHash?: string; error?: string }> {
  const { body, method } = getParams(endpoint, goal);

  let res = await httpCall(method, endpoint, body);
  if (res.status === 405 && method === "POST") res = await httpCall("GET", endpoint, null);

  if (res.status === 200) {
    return { output: safeJson(res.body), paid: false };
  }
  if (res.status !== 402) {
    return { output: null, paid: false, error: `HTTP ${res.status}: ${res.body.slice(0, 80)}` };
  }

  // 402 — sign and replay. Prefer the raw PAYMENT-REQUIRED header value (already the
  // exact base64 the signer expects); fall back to base64 of the challenge body.
  const challengeB64 = res.headers.get("payment-required") ?? Buffer.from(res.body).toString("base64");
  const auth = await signPayment(challengeB64);
  if (!auth) return { output: null, paid: false, error: "payment signing failed" };

  let paid = await httpCall("POST", endpoint, body, { "PAYMENT-SIGNATURE": auth });
  if (paid.status !== 200) paid = await httpCall("POST", endpoint, body, { "Authorization": `X402 ${auth}` });

  if (paid.status === 200) {
    return { output: safeJson(paid.body), paid: true, txHash: extractSettlementTx(paid.headers) };
  }
  return { output: null, paid: false, error: `paid call returned ${paid.status}: ${paid.body.slice(0, 80)}` };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text || "{}"); } catch { return text; }
}

export async function executePlan(plan: BindPlan): Promise<BindExecution> {
  await walletLogin();
  const executionId = randomUUID();
  const stepResults: ExecutionResult[] = [];
  const outputs: string[] = [];
  let totalPaid = 0;

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step, agentName: step.agent.name, status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      const call = await callAgent(step.agent.endpoint, plan.goal);
      result.input = getParams(step.agent.endpoint, plan.goal).body;

      if (call.output === null) {
        result.status = "errored";
        result.error = call.error ?? "no output";
      } else {
        result.output = call.output;
        if (call.paid) {
          result.paymentTxHash = call.txHash ?? "settled";
          totalPaid += step.agent.feeAmount;
        } else {
          result.paymentTxHash = "no_payment_needed";
        }

        // Verify the output before it counts toward the deliverable. A failing
        // step does not get merged and (Sev #2/#4) can fall back to another agent.
        const verdict = verifyStepOutput(step, call.output);
        result.verificationResult = { passed: verdict.passed, detail: verdict.detail };
        result.status = verdict.passed ? "passed" : "failed";

        if (verdict.passed) {
          outputs.push(`[${step.agent.name}]\n${JSON.stringify(call.output, null, 2)}`);
        }
      }
    } catch (e) {
      result.status = "errored";
      result.error = (e as Error).message;
    }

    result.completedAt = new Date().toISOString();
    stepResults.push(result);
  }

  const completed = stepResults.filter((r) => r.status === "passed").length;
  const finalOutput = outputs.join("\n\n---\n\n") || "No agent outputs passed verification.";

  const execution: BindExecution = {
    executionId, planId: plan.planId, goal: plan.goal,
    status: completed === stepResults.length ? "completed" : completed > 0 ? "partial" : "failed",
    stepResults, finalOutput,
    totalPaid, totalSteps: stepResults.length, completedSteps: completed,
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };

  // Anchor a signed receipt of the whole execution on X Layer (real tx).
  const anchor = await anchorExecution(execution);
  if (anchor) {
    execution.anchorTxHash = anchor.txHash;
    execution.finalReportUrl = anchor.reportUrl;
  }

  return execution;
}
