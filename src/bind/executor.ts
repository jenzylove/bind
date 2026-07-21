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
import type { BindExecution, BindPlan, BindStep, ExecutionResult } from "./types.js";
import { verifyStepOutput, checkRelevance } from "./verify.js";
import { anchorExecution } from "./receipt.js";
import { inferParams } from "./agent-infer.js";
import { synthesizeDeliverable, type AgentOutput } from "./synthesize.js";
import { refundUnspent } from "./refund.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const USDT_ADDRESS = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

// Thrown before any payment when the agentic wallet cannot cover the plan. The route
// turns this into a 402 with a "fund your wallet" message. This closes the bug where an
// empty wallet still "executed" the order: signing an x402 authorization does NOT check
// balance, so without this guard a broke wallet sails through and settlement silently fails.
export class InsufficientBalanceError extends Error {
  constructor(public have: number, public need: number) {
    super(`INSUFFICIENT_BALANCE: wallet holds ${have} USDT but this plan needs ${need} USDT`);
    this.name = "InsufficientBalanceError";
  }
}

// Reads the agentic wallet's USDT balance on X Layer. Returns null if it can't be read
// (in which case we do NOT block execution — we only block on a *confirmed* shortfall).
async function getUsdtBalance(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ONCHAINOS_PATH, ["wallet", "balance"], { timeout: 20000 });
    const parsed = JSON.parse(stdout);
    const details = parsed?.data?.details ?? [];
    for (const d of details) {
      for (const t of d.tokenAssets ?? []) {
        if (String(t.tokenAddress).toLowerCase() === USDT_ADDRESS) {
          const bal = parseFloat(t.balance);
          if (!Number.isNaN(bal)) return bal;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

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

// Sign an x402 payment authorization. `payment pay` routes through the OKX backend, which
// the server can intermittently fail to reach (datacenter-IP rate limiting) or against
// which the session can expire — so retry, re-authenticating once before a fresh attempt.
// A single blip here used to fail the whole agent call (and, in the flagship, block the
// entire downstream chain).
async function signPayment(challengeB64: string): Promise<string | null> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await execFileAsync(ONCHAINOS_PATH, ["payment", "pay", "--payload", challengeB64], { timeout: 30000 });
      const auth = JSON.parse(stdout).data?.authorization_header;
      if (auth) return auth;
      lastErr = "no authorization_header in response";
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 120);
    }
    // Re-authenticate before retrying: an expired TEE session is the most common cause.
    try { await execFileAsync(ONCHAINOS_PATH, ["wallet", "login"], { timeout: 15000 }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 900));
  }
  console.warn(`[bind] payment signing failed after retries: ${lastErr}`);
  return null;
}


// Hardcoded, proven parameter mappings for the four agents Bind has tested end-to-end.
// Returns null when the endpoint is unknown — the caller then asks inferParams to read
// the service description and build params for that agent (Option D: works with ANY agent).
function getParams(endpoint: string, goal: string): { body: Record<string, unknown>; method: "POST" | "GET" } | null {
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
  // Warden (Agent 3808) — payload security scan. Params learned from its 422 error.
  if (e.includes("warden") && e.includes("scan")) {
    const addr = goal.match(/0x[a-fA-F0-9]{40}/)?.[0];
    return { body: { payload: addr ?? goal }, method: "POST" };
  }
  // Keryx (Agent 4759) — crypto price feed; wants comma-separated ids.
  if (e.includes("keryx") || e.includes("crypto-price")) {
    const g = goal.toLowerCase();
    const ids = ["bitcoin", "ethereum", "solana", "bnb", "xrp", "dogecoin"].filter((c) => g.includes(c) || g.includes(c.slice(0, 3)));
    return { body: { ids: (ids.length ? ids : ["bitcoin", "ethereum", "solana"]).join(",") }, method: "POST" };
  }
  // Unknown endpoint — let inferParams read the service description instead.
  return null;
}

// Decodes the payment-response header into {settled, txHash}. A seller echoes
// {success, transaction} here after settling on-chain. We only count a step as truly
// paid when success === true; a 200 with success:false means the seller returned data
// but settlement did not actually happen (e.g. our authorization was worthless).
function readSettlement(headers: Headers): { settled: boolean; txHash?: string } | null {
  const pr = headers.get("payment-response");
  if (!pr) return null;
  try {
    const decoded = JSON.parse(Buffer.from(pr, "base64").toString());
    return { settled: decoded?.success === true, txHash: typeof decoded?.transaction === "string" ? decoded.transaction : undefined };
  } catch {
    return null;
  }
}

interface CallResult { output: unknown | null; paid: boolean; txHash?: string; error?: string; input: Record<string, unknown>; }

// Absolute hard ceiling per single agent call, regardless of the quote. Backstop against
// an agent whose 402 challenge demands far more than its listed marketplace fee.
const MAX_ABS_PER_CALL_USDT = 0.20;
const USDT_ASSET_LC = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

// Decodes a 402 challenge to the amount (in USDT) and asset it actually demands. An
// agent's live challenge can ask for MUCH more than the marketplace-listed fee — this is
// how a $0.11-listed agent drained $3/call. We check this BEFORE signing.
function readChallengeCost(challengeB64: string): { usdt: number; asset: string } | null {
  try {
    const dec = JSON.parse(Buffer.from(challengeB64, "base64").toString());
    const accept = (dec.accepts || dec.paymentRequirements || [])[0] || dec.accepted || {};
    const raw = accept.amount ?? accept.maxAmountRequired;
    if (raw == null) return null;
    // USDT on X Layer is 6 decimals.
    return { usdt: Number(raw) / 1e6, asset: String(accept.asset || "").toLowerCase() };
  } catch {
    return null;
  }
}

// Runs a single step: pick params (proven map, else infer from the service description),
// call the agent, pay if it returns 402, and verify the payment actually settled.
// Substitutes $TOKEN (a token address in the goal, else USDT) and $GOAL into a bound
// params template confirmed by the settlement test.
function fillBoundParams(tpl: Record<string, string>, goal: string): Record<string, unknown> {
  const addr = goal.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? USDT_ASSET_LC;
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tpl)) body[k] = v.replace(/\$TOKEN/g, addr).replace(/\$GOAL/g, goal);
  return body;
}

// Resolve one dotted reference ("nodeId.data.symbol") against a node's stored output.
// Transparently unwraps JSON-string layers: several OKX endpoints return {code,msg,data}
// where `data` is itself a JSON STRING, so "data.symbol" must parse `data` before indexing.
function resolveRef(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null) return undefined;
    if (typeof cur === "string") { try { cur = JSON.parse(cur); } catch { return undefined; } }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "string" && (cur[0] === "{" || cur[0] === "[")) { try { return JSON.parse(cur); } catch { /* leave as string */ } }
  return cur;
}

// Turn an inputMap into concrete params by reading verified upstream outputs. Only defined,
// non-null values are injected — a missing reference is left out so we never send junk.
function resolveInputMap(map: Record<string, string>, nodeOutputs: Map<string, unknown>): { params: Record<string, unknown>; unresolved: string[] } {
  const params: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const [param, ref] of Object.entries(map)) {
    const [nodeId, ...path] = ref.split(".");
    const val = resolveRef(nodeOutputs.get(nodeId), path);
    if (val !== undefined && val !== null && val !== "") params[param] = val;
    else unresolved.push(param);
  }
  return { params, unresolved };
}

async function callAgent(step: BindStep, goal: string, injected?: Record<string, unknown>): Promise<CallResult> {
  const endpoint = step.agent.endpoint;
  // Prefer the exact, tested params for this agent; then the proven hardcoded map; then infer.
  let { body, method } = step.boundParams
    ? { body: fillBoundParams(step.boundParams, goal), method: "POST" as const }
    : getParams(endpoint, goal) ?? await inferParams(step.agent.serviceName, step.agentServiceDescription ?? "", endpoint, goal);

  // Dependency-graph inputs override the guessed params: an upstream node's verified output
  // (a resolved token address, a selected symbol) is authoritative for this step.
  if (injected && body && typeof body === "object") body = { ...body, ...injected };

  let res = await httpCall(method, endpoint, body);
  if (res.status === 405 && method === "POST") res = await httpCall("GET", endpoint, null);

  if (res.status === 200) {
    return { output: safeJson(res.body), paid: false, input: body };
  }
  if (res.status !== 402) {
    return { output: null, paid: false, error: `HTTP ${res.status}: ${res.body.slice(0, 80)}`, input: body };
  }

  // 402 — sign and replay. Prefer the raw PAYMENT-REQUIRED header value (already the
  // exact base64 the signer expects); fall back to base64 of the challenge body.
  const challengeB64 = res.headers.get("payment-required") ?? Buffer.from(res.body).toString("base64");

  // Overcharge guard: never sign a payment bigger than what the plan quoted (with a
  // small tolerance) or the absolute per-call ceiling. This is the fix for the real leak
  // where an agent listed at ~$0.11 demanded $3 in its live challenge.
  const cost = readChallengeCost(challengeB64);
  if (cost) {
    const quoted = step.agent.feeAmount || 0;
    const allowed = Math.max(quoted * 1.5, 0.002); // tolerance for unit rounding on sub-cent quotes
    if (cost.usdt > allowed || cost.usdt > MAX_ABS_PER_CALL_USDT) {
      return { output: null, paid: false, error: `overcharge blocked: agent demands $${cost.usdt} (quoted $${quoted}, cap $${Math.min(allowed, MAX_ABS_PER_CALL_USDT)})`, input: body };
    }
    if (cost.asset && cost.asset !== USDT_ASSET_LC) {
      return { output: null, paid: false, error: `payment asset mismatch: challenge wants ${cost.asset}, not USDT`, input: body };
    }
  }

  const auth = await signPayment(challengeB64);
  if (!auth) return { output: null, paid: false, error: "payment signing failed", input: body };

  let paid = await httpCall("POST", endpoint, body, { "PAYMENT-SIGNATURE": auth });
  if (paid.status !== 200) paid = await httpCall("POST", endpoint, body, { "Authorization": `X402 ${auth}` });

  if (paid.status !== 200) {
    return { output: null, paid: false, error: `paid call returned ${paid.status}: ${paid.body.slice(0, 80)}`, input: body };
  }

  // Got data. Confirm the payment settled on-chain before calling it "paid".
  const settlement = readSettlement(paid.headers);
  if (settlement && !settlement.settled) {
    return { output: null, paid: false, error: "payment did not settle on-chain (success=false)", input: body };
  }
  return { output: safeJson(paid.body), paid: true, txHash: settlement?.txHash, input: body };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text || "{}"); } catch { return text; }
}

// Two-stage verification: cheap structural check first, then (only if it passes) an LLM
// relevance check. Off-topic-but-well-formed output fails, so Bind neither counts nor keeps
// paying for data that does not address the goal.
async function evaluateOutput(step: BindStep, goal: string, output: unknown): Promise<{ passed: boolean; detail: string }> {
  const structural = verifyStepOutput(step, output);
  if (!structural.passed) return structural;
  const rel = await checkRelevance(goal, step.agent.serviceName, step.agentServiceDescription ?? "", output);
  if (!rel.relevant) return { passed: false, detail: `off-topic — did not address the goal: ${rel.reason}` };
  return { passed: true, detail: structural.detail };
}

export async function executePlan(plan: BindPlan, payer?: string, presetExecutionId?: string): Promise<BindExecution> {
  await walletLogin();

  // Guard: never start paying agents unless the wallet can cover the whole plan. This
  // is what was missing before — an empty wallet used to "execute" and silently fail.
  const balance = await getUsdtBalance();
  if (balance !== null && balance < plan.totalPriceUsdt) {
    throw new InsufficientBalanceError(balance, plan.totalPriceUsdt);
  }

  // An async mission hands out its executionId before running, so /status can be
  // polled while the crew works; the finished record must land under the same id.
  const executionId = presetExecutionId ?? randomUUID();
  const stepResults: ExecutionResult[] = [];
  const passedOutputs: AgentOutput[] = [];
  // Verified output of each graph node, so a downstream step can consume it. Only outputs
  // that PASSED verification land here — a failed node cannot feed the next step.
  const nodeOutputs = new Map<string, unknown>();
  let totalPaid = 0;

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step, agentName: step.agent.name, serviceName: step.agent.serviceName,
      agentId: step.agent.agentId, status: "running",
      startedAt: new Date().toISOString(),
    };

    // Dependency gate: if an upstream node this step needs did not produce verified output,
    // block this step rather than call (and pay) an agent with invented parameters.
    const missingDep = (step.dependsOn ?? []).find((dep) => !nodeOutputs.has(dep));
    if (missingDep) {
      result.status = "blocked";
      result.blockedBy = missingDep;
      result.error = `blocked: upstream step "${missingDep}" did not deliver verified output`;
      result.completedAt = new Date().toISOString();
      stepResults.push(result);
      continue;
    }

    // Resolve this step's inputs from the verified outputs of earlier nodes (the heart of
    // graph execution: step 2 receives what step 1 actually produced).
    const injected = step.inputMap ? resolveInputMap(step.inputMap, nodeOutputs).params : undefined;

    try {
      let call = await callAgent(step, plan.goal, injected);
      let agent = step.agent;
      // Evaluate = structural check, then (only if it passes) an LLM relevance check. An
      // agent that returns well-formed but off-topic data (whale wallets for a football
      // question) FAILS here, exactly like an empty or errored response.
      let outcome = call.output === null
        ? { passed: false, detail: call.error ?? "no output" }
        : await evaluateOutput(step, plan.goal, call.output);

      // Dynamic fallback — the general-contractor behaviour. Work down the ranked backup
      // agents (any eligible marketplace agent, not a fixed list) until one delivers
      // RELEVANT verified output. We only try a backup while the current attempt failed AND
      // took no payment: a dead, useless, or off-topic-but-free agent is replaced for free,
      // but once money has actually moved we stop, so a buyer is never charged twice.
      const backups = step.candidates?.length ? step.candidates : (step.fallbackAgent ? [step.fallbackAgent] : []);
      for (const cand of backups) {
        if (call.paid || outcome.passed) break;
        const fbStep: BindStep = {
          ...step,
          agent: cand,
          agentServiceDescription: cand.serviceDescription ?? step.fallbackServiceDescription ?? step.agentServiceDescription,
          boundParams: undefined,
        };
        const fb = await callAgent(fbStep, plan.goal, injected);
        const fbOutcome = fb.output === null
          ? { passed: false, detail: fb.error ?? "no output" }
          : await evaluateOutput(fbStep, plan.goal, fb.output);
        if (fbOutcome.passed || fb.paid) {
          // Either this backup delivered relevant work, or it took payment (record it and
          // stop spending). It becomes the recorded attempt for this step.
          call = fb;
          agent = cand;
          outcome = fbOutcome;
          result.usedFallback = true;
          result.agentName = cand.name;
          result.serviceName = cand.serviceName;
          result.agentId = cand.agentId;
          break;
        }
        // Unpaid failure: leave `call` on the prior attempt and try the next candidate.
      }

      result.input = call.input;
      if (call.output === null) {
        result.status = "errored";
        result.error = outcome.detail;
      } else {
        result.output = call.output;
        if (call.paid) {
          result.paymentTxHash = call.txHash ?? "settled";
          result.feeUsdt = agent.feeAmount;
          totalPaid += agent.feeAmount;
        } else {
          result.paymentTxHash = "no_payment_needed";
        }

        // The step counts toward the deliverable only if it passed BOTH structure and
        // relevance. Off-topic paid output is marked failed, so the refund logic returns
        // its cost to the buyer and the synthesizer never sees it.
        result.verificationResult = { passed: outcome.passed, detail: outcome.detail };
        result.status = outcome.passed ? "passed" : "failed";

        if (outcome.passed) {
          // The deliverable must reference agents by the name the buyer saw hired (the
          // service), not the vendor name — "NewsSweep" in the text when the crew card
          // said "Latest Crypto Headlines" reads like a fabrication.
          passedOutputs.push({ agent: agent.serviceName || agent.name, role: agent.category, output: call.output });
          // Publish this node's verified output so downstream steps can consume it.
          if (step.nodeId) nodeOutputs.set(step.nodeId, call.output);
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
  // The deliverable: one readable answer synthesized from the verified agent outputs.
  const finalOutput = await synthesizeDeliverable(plan.goal, passedOutputs);

  const execution: BindExecution = {
    executionId, planId: plan.planId, goal: plan.goal, payer,
    status: completed === stepResults.length ? "completed" : completed > 0 ? "partial" : "failed",
    stepResults, finalOutput,
    totalPaid, totalSteps: stepResults.length, completedSteps: completed,
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  };

  // The buyer only pays for VERIFIED work. Refund the quoted cost of every agent that did
  // not deliver a passing output — whether it never took payment, or it took payment and
  // then failed inspection. In the second case Bind absorbs the loss to that agent; that is
  // the cost of being the trusted layer, and it makes "you never pay for work that fails
  // verification" actually true. Bind's platform fee is normally earned and stays — EXCEPT
  // when the mission delivered NOTHING verified: then Bind did not deliver, so the fee is
  // refunded too (you never pay for a non-answer). Best-effort: a refund failure never fails
  // the mission.
  const quotedAgentCost = plan.agentCost ?? plan.steps.reduce((s, x) => s + x.agent.feeAmount, 0);
  const deliveredCost = stepResults
    .filter((r) => r.status === "passed")
    .reduce((s, r) => s + (r.feeUsdt ?? 0), 0);
  const refundBase = completed === 0 ? quotedAgentCost + (plan.platformFee ?? 0) : quotedAgentCost;
  const refund = await refundUnspent(refundBase, deliveredCost, payer);
  if (refund.refunded > 0) {
    execution.refundedUsdt = refund.refunded;
    execution.refundTxHash = refund.txHash;
  }

  // Anchor a signed receipt of the whole execution on X Layer (real tx).
  const anchor = await anchorExecution(execution);
  if (anchor) {
    execution.anchorTxHash = anchor.txHash;
    execution.finalReportUrl = anchor.reportUrl;
  }

  return execution;
}
