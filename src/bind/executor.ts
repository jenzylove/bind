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
import type { AgentAttempt, BindAgent, BindExecution, BindPlan, BindStep, ExecutionResult } from "./types.js";
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
interface RequestParams {
  body: Record<string, unknown>;
  method: "POST" | "GET";
  unavailableReason?: string;
}

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

function extractGoalSymbol(goal: string): string | null {
  const dollar = goal.match(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/);
  if (dollar) return dollar[1].toUpperCase();

  const stop = new Set(["USDT", "USDC", "USD", "BTC", "ETH", "SOL", "BNB", "OKX", "DEX", "A2MCP", "API"]);
  const bare = goal.match(/\b[A-Z][A-Z0-9]{2,11}\b/g) ?? [];
  return bare.find((x) => !stop.has(x)) ?? null;
}

function extractGoalAddress(goal: string): string | null {
  return goal.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? null;
}

function applyRequestParams(
  endpoint: string,
  body: Record<string, unknown>,
  method: "GET" | "POST",
): { url: string; body: Record<string, unknown> | null } {
  let url = endpoint;
  const remaining: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(body)) {
    const token = `{${key}}`;
    if (url.includes(token)) {
      url = url.replaceAll(token, encodeURIComponent(String(value)));
      delete remaining[key];
    }
  }
  if (method === "GET" && Object.keys(remaining).length > 0) {
    const u = new URL(url);
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null && value !== "") u.searchParams.set(key, String(value));
    }
    url = u.toString();
    return { url, body: null };
  }
  return { url, body: remaining };
}

function goalFieldValue(name: string, goal: string): unknown {
  const n = name.toLowerCase();
  const creativeName = extractCreativeName(goal);
  if (["brief", "description", "business", "company", "projectdescription", "prompt", "query", "q", "text", "topic", "mood"].includes(n)) return goal;
  if (["style", "preferences", "stylepreferences"].includes(n)) return goal.toLowerCase().includes("pink") ? "pink, skincare, soft premium" : "clean, polished, professional";
  if (["track", "category"].includes(n)) return /\b(crypto|web3|token|defi|wallet|onchain|on-chain)\b/i.test(goal) ? "web3" : "traditional";
  if (["name", "brand", "brandname", "brand_name", "title", "channel", "channelname", "channel_name"].includes(n)) return creativeName ?? (goal.toLowerCase().includes("skincare") ? "Pink Skincare Brand" : goal.slice(0, 60));
  if (["kind", "type"].includes(n)) return /\b(token|coin)\b/i.test(goal) ? "token" : /\b(agent)\b/i.test(goal) ? "agent" : "company";
  if (["format", "deliverable", "output"].includes(n)) return /\blogo\b/i.test(goal) ? "logo" : "brand kit";
  return undefined;
}

function extractCreativeName(goal: string): string | null {
  const patterns = [
    /\b(?:titled|called|named|name is|title is)\s+["']?([a-z0-9][a-z0-9 ._-]{1,40})["']?/i,
    /\bfor\s+(?:my\s+)?(?:brand|channel|project|company)\s+["']?([a-z0-9][a-z0-9 ._-]{1,40})["']?/i,
  ];
  for (const re of patterns) {
    const match = goal.match(re)?.[1]?.trim();
    if (match) return match.replace(/\s+(?:logo|brand|channel|youtube|music).*$/i, "").trim();
  }
  return null;
}

function creativeStyle(goal: string): string {
  const tags = ["clean", "memorable", "scalable", "music-channel-ready"];
  if (/\bpink\b/i.test(goal)) tags.push("pink");
  if (/\b(skincare|beauty)\b/i.test(goal)) tags.push("soft premium beauty");
  if (/\b(music|song|youtube|yt)\b/i.test(goal)) tags.push("modern audio/music identity");
  if (/\b(luxury|premium)\b/i.test(goal)) tags.push("premium");
  if (/\b(minimal|minimalist)\b/i.test(goal)) tags.push("minimalist");
  return tags.join(", ");
}

function creativeRequestBody(goal: string): Record<string, unknown> {
  const name = extractCreativeName(goal) ?? "Untitled Brand";
  return {
    q: goal,
    prompt: goal,
    brief: goal,
    description: goal,
    name,
    brand: name,
    brandName: name,
    brand_name: name,
    title: name,
    channelName: name,
    kind: /\b(token|coin)\b/i.test(goal) ? "token" : /\b(agent)\b/i.test(goal) ? "agent" : "company",
    style: creativeStyle(goal),
    visualStyle: creativeStyle(goal),
    format: /\blogo\b/i.test(goal) ? "logo" : "brand kit",
    deliverable: /\blogo\b/i.test(goal) ? "logo" : "brand identity",
    targetAudience: /\b(youtube|yt|music)\b/i.test(goal) ? "YouTube music listeners" : "general audience",
  };
}

function hasProvidedImageInput(inputs?: Record<string, unknown>): boolean {
  if (!inputs) return false;
  return ["asset_base64", "assetBase64", "image_base64", "imageBase64", "image", "imageUrl", "assetUrl"]
    .some((key) => typeof inputs[key] === "string" && String(inputs[key]).trim().length > 0);
}

function requiresExistingImage(text: string): boolean {
  return /\b(asset_base64|image_base64|mask|watermark|compositor|edit-image|image compositor|remove watermark|existing image|source image|original image)\b/i.test(text);
}

function repairParamsFromInputError(current: Record<string, unknown>, errorBody: string, goal: string): Record<string, unknown> | null {
  let parsed: any;
  try { parsed = JSON.parse(errorBody); } catch { return null; }
  const names = new Set<string>();
  for (const name of parsed?.requiredAnyOf ?? []) if (typeof name === "string") names.add(name);
  for (const field of parsed?.fields ?? []) {
    if (field?.required && typeof field.name === "string") names.add(field.name);
  }
  for (const item of parsed?.detail ?? []) {
    const loc = Array.isArray(item?.loc) ? item.loc : [];
    const name = loc[0] === "body" ? loc[loc.length - 1] : undefined;
    if (typeof name === "string") names.add(name);
  }
  if (names.size === 0) return null;

  const repaired: Record<string, unknown> = { ...current };
  let changed = false;
  for (const name of names) {
    if (repaired[name] !== undefined && repaired[name] !== null && repaired[name] !== "") continue;
    const value = goalFieldValue(name, goal);
    if (value === undefined) continue;
    repaired[name] = value;
    changed = true;
  }
  return changed ? repaired : null;
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
      // onchainos prints its real error (HPKE, revert, etc.) to stdout even on a non-zero
      // exit — capture that, not just the generic "Command failed" message.
      const err = e as { stdout?: string; stderr?: string; message?: string };
      lastErr = String(err.stdout || err.stderr || err.message || "").replace(/\s+/g, " ").slice(0, 220);
    }
    // Re-authenticate before retrying: an expired TEE session is the most common cause.
    try { await execFileAsync(ONCHAINOS_PATH, ["wallet", "login"], { timeout: 15000 }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 900));
  }
  console.warn(`[bind] payment signing failed after retries: ${lastErr}`);
  return null;
}


function paramArgs(body: Record<string, unknown>): string[] | null {
  const args: string[] = [];
  let bytes = 0;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === "") continue;
    const rendered = `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`;
    bytes += Buffer.byteLength(rendered);
    // Do not pass large files/base64 through process argv. The direct HTTP replay path
    // already carries the JSON body; CLI fallback is only for small seller params.
    if (bytes > 24_000) return null;
    args.push("--param", rendered);
  }
  return args;
}

async function payAgentWithCli(endpoint: string, method: "GET" | "POST", body: Record<string, unknown>, quoted: number): Promise<CallResult> {
  try {
    const params = paramArgs(body);
    if (!params) return { output: null, paid: false, error: "seller CLI fallback skipped: request body is too large for process arguments", input: body };
    const quote = await execFileAsync(ONCHAINOS_PATH, ["payment", "quote", endpoint, "--method", method, ...params], { timeout: 45000 });
    const q = JSON.parse(quote.stdout);
    const data = q?.data;
    const paymentId = data?.paymentId;
    const selected = data?.candidates?.find((c: any) => c.recommended) ?? data?.candidates?.[0];
    const selectedIndex = selected?.acceptsIndex ?? 0;
    const amount = Number(selected?.amount ?? data?.decodedChallenge?.amount ?? 0) / 1e6;
    const asset = String(data?.accepts?.[selectedIndex]?.asset ?? data?.decodedChallenge?.asset ?? USDT_ASSET_LC).toLowerCase();
    const allowed = Math.max(quoted * 1.5, 0.002);
    if (!paymentId) return { output: null, paid: false, error: "CLI quote did not return a payment id", input: body };
    if (amount > allowed || amount > MAX_ABS_PER_CALL_USDT) {
      return { output: null, paid: false, error: `overcharge blocked: agent demands $${amount} (quoted $${quoted}, cap $${Math.min(allowed, MAX_ABS_PER_CALL_USDT)})`, input: body };
    }
    if (asset && asset !== USDT_ASSET_LC) return { output: null, paid: false, error: `payment asset mismatch: challenge wants ${asset}, not USDT`, input: body };

    const paid = await execFileAsync(ONCHAINOS_PATH, ["payment", "pay", "--payment-id", paymentId, "--selected-index", String(selectedIndex), "--yes", ...params], { timeout: 120000 });
    const p = JSON.parse(paid.stdout);
    const receipt = p?.data?.decodedReceipt;
    const txHash = p?.data?.txHash ?? receipt?.transaction;
    if (p?.data?.ok === true || p?.data?.status === "success") {
      return { output: p.data.result ?? {}, paid: true, txHash, input: body };
    }
    return { output: null, paid: false, error: p?.data?.error ?? "CLI paid replay failed", input: body };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { output: null, paid: false, error: String(err.stdout || err.stderr || err.message || "CLI payment failed").replace(/\s+/g, " ").slice(0, 180), input: body };
  }
}
// Hardcoded, proven parameter mappings for the four agents Bind has tested end-to-end.
// Returns null when the endpoint is unknown — the caller then asks inferParams to read
// the service description and build params for that agent (Option D: works with ANY agent).
function getParams(step: BindStep, goal: string, missionInputs?: Record<string, unknown>): RequestParams | null {
  const endpoint = step.agent.endpoint;
  const e = endpoint;
  const serviceText = `${step.agent.name} ${step.agent.serviceName} ${step.agentServiceDescription ?? step.agent.serviceDescription ?? ""} ${endpoint}`;
  if (requiresExistingImage(serviceText) && !hasProvidedImageInput(missionInputs)) {
    return {
      body: {},
      method: "POST",
      unavailableReason: "agent requires an existing image/upload, but this goal asks for a new logo and no image asset was provided",
    };
  }
  if (e.includes("agent-reel-production.up.railway.app/v1/brandkit")) {
    return { body: { brand: `${extractCreativeName(goal) ?? "Aevri"}: ${goal}`, style: creativeStyle(goal) }, method: "POST" };
  }
  if (e.includes("agent-reel-production.up.railway.app/v1/asset")) {
    return { body: { scene: goal, title: extractCreativeName(goal) ?? "Aevri", subtitle: "YouTube music channel logo direction" }, method: "POST" };
  }  if (/\b(logo|brand kit|brandkit|palette|design token|visual identity|image generat|generate.*image|meme)\b/i.test(serviceText)) {
    return { body: creativeRequestBody(goal), method: "POST" };
  }
  const addr = extractGoalAddress(goal);
  const hasAddr = Boolean(addr);
  const symbol = extractGoalSymbol(goal);
  if (e.includes("pitchook.xyz/v1/x402/agent")) return { body: { prompt: goal }, method: "POST" };
  if (e.includes("brandforge-production-714f.up.railway.app/api/kit")) return { body: { brief: goal, style: goal.toLowerCase().includes("pink") ? "pink, skincare, soft premium" : undefined }, method: "POST" };
  if (e.includes("resumurai.xyz/x402/tailor")) {
    const inputs = missionInputs ?? {};
    const targetRole = String(inputs.targetRole ?? "Business Analyst");
    const jobDescription = String(inputs.jobDescription ?? `${targetRole} role requiring requirements gathering, stakeholder communication, process analysis, documentation, reporting, data interpretation, and business insight delivery.`);
    const body: Record<string, unknown> = { jobDescription, options: { includeCoverLetter: true } };
    if (inputs.resumeFile) body.resumeFile = inputs.resumeFile;
    else if (typeof inputs.resume === "string") body.resume = inputs.resume;
    else body.resume = goal;
    return { body, method: "POST" };
  }
  // Onchain Data Explorer (Agent 2023) — OKX Official
  if (e.includes("get_chain_info")) return { body: { chainIndex: "196" }, method: "POST" };
  if (e.includes("get_token_info")) return { body: { chainIndex: "196", tokenAddress: addr ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736" }, method: "POST" };
  if (e.includes("get_address_profile")) return { body: { chainIndex: "196", address: addr ?? "0x22700698c503be7dfdeaaacc2e4e41c767c263b" }, method: "POST" };
  if (e.includes("get_token_price_history")) return { body: { chainIndex: "196", tokenAddress: addr ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736", granularity: "1D" }, method: "POST" };
  if (e.includes("get_block")) return { body: { chainIndex: "196", by: "height", value: "21000000" }, method: "POST" };
  if (e.includes("get_transaction")) return { body: { chainIndex: "196", txHash: hasAddr ? goal : "0x" }, method: "POST" };
  if (e.includes("get_contract_source")) return { body: { chainIndex: "196", address: hasAddr ? goal : "0x" }, method: "POST" };
  if (e.includes("get_token_holders")) return { body: { chainIndex: "196", tokenAddress: hasAddr ? goal : "0x", n: 5 }, method: "POST" };
  if (e.includes("get_address_transactions")) return { body: { chainIndex: "196", address: hasAddr ? goal : "0x22700698c503be7dfdeaaacc2e4e41c767c263b", limit: 3 }, method: "POST" };
  if (e.includes("get_token_price")) return { body: { chainIndex: "196", tokenAddresses: [addr ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736"] }, method: "POST" };
  if (e.includes("get_event_logs")) return { body: { chainIndex: "196", by: "tx", txHash: "0x" }, method: "POST" };
  if (e.includes("list_chains")) return { body: {}, method: "POST" };
  if (e.includes("universal_search")) return { body: { input: addr ?? symbol ?? goal }, method: "POST" };
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
    return { body: { payload: addr ?? goal }, method: "POST" };
  }
  if (e.includes("token-fundamentals")) {
    return { body: { coin: symbol ?? "HYPE" }, method: "POST" };
  }
  if (e.includes("api.ethyai.app/paid/v1/xlayer/score")) {
    return { body: { chain: "hyperliquid", asset: symbol ?? "HYPE" }, method: "GET" };
  }
  // Keryx (Agent 4759) — generic crypto price feed; use exact aliases only.
  if (e.includes("crypto-price")) {
    const aliases: Record<string, string> = {
      BTC: "bitcoin",
      BITCOIN: "bitcoin",
      ETH: "ethereum",
      ETHEREUM: "ethereum",
      SOL: "solana",
      SOLANA: "solana",
      BNB: "bnb",
      XRP: "xrp",
      DOGE: "dogecoin",
      DOGECOIN: "dogecoin",
      HYPE: "hyperliquid",
      HYPERLIQUID: "hyperliquid",
    };
    const id = symbol ? aliases[symbol] : null;
    return { body: { ids: id ?? "bitcoin,ethereum,solana" }, method: "POST" };
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

function attemptFrom(
  agent: BindAgent,
  call: CallResult,
  outcome: { passed: boolean; detail: string },
): AgentAttempt {
  return {
    agentId: agent.agentId,
    agentName: agent.name,
    serviceName: agent.serviceName,
    endpoint: agent.endpoint,
    feeUsdt: call.paid ? agent.feeAmount : undefined,
    paid: call.paid,
    status: outcome.passed ? "passed" : call.output === null ? "errored" : "failed",
    paymentTxHash: call.txHash,
    input: call.input,
    verificationDetail: outcome.detail,
    error: call.error,
  };
}

// Absolute hard ceiling per single agent call, regardless of the quote. Backstop against
// an agent whose 402 challenge demands far more than its listed marketplace fee.
const MAX_ABS_PER_CALL_USDT = 0.20;
const MAX_PAID_ATTEMPTS_PER_STEP = 3;
const MAX_FAILED_FALLBACK_SPEND_USDT = 0.15;
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

// SSRF guard (audit H7): marketplace endpoints are seller-controlled. Only call public
// HTTPS URLs — never http, never localhost, private, link-local, or cloud-metadata hosts.
function isSafeEndpoint(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".internal")) return false;
  // Block IP-literal hosts in private / loopback / link-local / metadata ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
  }
  return true;
}

async function callAgent(step: BindStep, goal: string, injected?: Record<string, unknown>, missionInputs?: Record<string, unknown>): Promise<CallResult> {
  const endpoint = step.agent.endpoint;
  if (!isSafeEndpoint(endpoint)) {
    return { output: null, paid: false, error: `unsafe agent endpoint refused: ${endpoint.slice(0, 60)}`, input: {} };
  }
  // Prefer the exact, tested params for this agent; then the proven hardcoded map; then infer.
  const mapped = step.boundParams
    ? { body: fillBoundParams(step.boundParams, goal), method: "POST" as const }
    : getParams(step, goal, missionInputs) ?? await inferParams(step.agent.serviceName, step.agentServiceDescription ?? "", endpoint, goal);
  if ("unavailableReason" in mapped && typeof mapped.unavailableReason === "string" && mapped.unavailableReason) {
    return { output: null, paid: false, error: mapped.unavailableReason, input: mapped.body };
  }
  let { body, method } = mapped;

  // Dependency-graph inputs override the guessed params: an upstream node's verified output
  // (a resolved token address, a selected symbol) is authoritative for this step.
  if (injected && body && typeof body === "object") body = { ...body, ...injected };

  let replayMethod = method;
  let request = applyRequestParams(endpoint, body, replayMethod);
  let res = await httpCall(replayMethod, request.url, request.body);
  if (res.status === 405 && replayMethod === "POST") {
    replayMethod = "GET";
    request = applyRequestParams(endpoint, body, replayMethod);
    res = await httpCall(replayMethod, request.url, null);
  }

  if (res.status === 200) {
    return { output: safeJson(res.body), paid: false, input: body };
  }
  if (res.status !== 402) {
    const repaired = (res.status === 400 || res.status === 422) ? repairParamsFromInputError(body, res.body, goal) : null;
    if (repaired) {
      body = repaired;
      request = applyRequestParams(endpoint, body, replayMethod);
      res = await httpCall(replayMethod, request.url, request.body);
      if (res.status === 200) return { output: safeJson(res.body), paid: false, input: body };
    }
    if (res.status !== 402) {
      return { output: null, paid: false, error: `HTTP ${res.status}: ${res.body.slice(0, 80)}`, input: body };
    }
  }

  // 402 — sign and replay. Prefer the raw PAYMENT-REQUIRED header value (already the
  // exact base64 the signer expects); fall back to base64 of the challenge body.
  const challengeB64 = res.headers.get("payment-required") ?? Buffer.from(res.body).toString("base64");

  // Overcharge guard: never sign a payment bigger than what the plan quoted (with a
  // small tolerance) or the absolute per-call ceiling. This is the fix for the real leak
  // where an agent listed at ~$0.11 demanded $3 in its live challenge.
  const cost = readChallengeCost(challengeB64);
  // FAIL CLOSED on an unreadable challenge (audit H2): if we cannot parse the amount/asset
  // the seller is demanding, we must not sign it blind — the local signer's understanding
  // and the OKX signer's could differ, and an unknown amount could drain the wallet.
  if (!cost) {
    return { output: null, paid: false, error: "challenge could not be decoded — refusing to sign an unknown payment amount", input: body };
  }
  const quoted = step.agent.feeAmount || 0;
  const allowed = Math.max(quoted * 1.5, 0.002); // tolerance for unit rounding on sub-cent quotes
  if (cost.usdt > allowed || cost.usdt > MAX_ABS_PER_CALL_USDT) {
    return { output: null, paid: false, error: `overcharge blocked: agent demands $${cost.usdt} (quoted $${quoted}, cap $${Math.min(allowed, MAX_ABS_PER_CALL_USDT)})`, input: body };
  }
  if (cost.asset && cost.asset !== USDT_ASSET_LC) {
    return { output: null, paid: false, error: `payment asset mismatch: challenge wants ${cost.asset}, not USDT`, input: body };
  }

  const auth = await signPayment(challengeB64);
  if (!auth) return { output: null, paid: false, error: "payment signing failed", input: body };

  const paidRequest = applyRequestParams(endpoint, body, replayMethod);
  let paid = await httpCall(replayMethod, paidRequest.url, paidRequest.body, { "PAYMENT-SIGNATURE": auth });
  if (paid.status !== 200) paid = await httpCall(replayMethod, paidRequest.url, paidRequest.body, { "X-PAYMENT": auth });
  if (paid.status !== 200) paid = await httpCall(replayMethod, paidRequest.url, paidRequest.body, { "Authorization": `X402 ${auth}` });

  if (paid.status !== 200) {
    if (paid.status === 402) return payAgentWithCli(endpoint, replayMethod, body, quoted);
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
  // Skip the LLM relevance gate for PINNED, purpose-built calls (boundParams) — e.g. the
  // flagship's resolve/holders data-fetches. Those are configured to return one specific
  // data type; judging their output against the whole goal wrongly fails them (it rejected
  // valid token metadata as "insufficient for a full audit"). Relevance is meant to catch
  // DYNAMICALLY-selected agents returning off-topic data, not our own vetted data-fetches.
  if (step.boundParams) return { passed: true, detail: structural.detail };
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
      let call = await callAgent(step, plan.goal, injected, plan.inputs);
      let agent = step.agent;
      // Evaluate = structural check, then (only if it passes) an LLM relevance check. An
      // agent that returns well-formed but off-topic data (whale wallets for a football
      // question) FAILS here, exactly like an empty or errored response.
      let outcome = call.output === null
        ? { passed: false, detail: call.error ?? "no output" }
        : await evaluateOutput(step, plan.goal, call.output);
      const attempts: AgentAttempt[] = [attemptFrom(agent, call, outcome)];

      // Dynamic fallback — the general-contractor behaviour. Work down the ranked backup
      // agents (any eligible marketplace agent, not a fixed list) until one delivers
      // RELEVANT verified output. A paid-but-bad output is now allowed to fall through to
      // the next candidate, but only under a strict Bind-side risk cap. The buyer still
      // pays only for verified work; failed paid attempts are refunded/absorbed by Bind.
      const backups = step.candidates?.length ? step.candidates : (step.fallbackAgent ? [step.fallbackAgent] : []);
      let paidAttempts = call.paid ? 1 : 0;
      let failedPaidSpend = call.paid && !outcome.passed ? agent.feeAmount : 0;
      let paidAttemptCost = call.paid ? agent.feeAmount : 0;
      for (const cand of backups) {
        if (outcome.passed) break;
        if (paidAttempts >= MAX_PAID_ATTEMPTS_PER_STEP) break;
        if (failedPaidSpend >= MAX_FAILED_FALLBACK_SPEND_USDT) break;
        const fbStep: BindStep = {
          ...step,
          agent: cand,
          agentServiceDescription: cand.serviceDescription ?? step.fallbackServiceDescription ?? step.agentServiceDescription,
          boundParams: undefined,
        };
        const fb = await callAgent(fbStep, plan.goal, injected, plan.inputs);
        const fbOutcome = fb.output === null
          ? { passed: false, detail: fb.error ?? "no output" }
          : await evaluateOutput(fbStep, plan.goal, fb.output);
        attempts.push(attemptFrom(cand, fb, fbOutcome));
        if (fb.paid) {
          paidAttempts += 1;
          paidAttemptCost += cand.feeAmount;
          if (!fbOutcome.passed) failedPaidSpend += cand.feeAmount;
        }
        if (fbOutcome.passed || fb.paid) {
          // Keep the best/latest paid attempt on record. If it failed, continue while the
          // retry budget allows; if it passed, stop immediately with a deliverable.
          call = fb;
          agent = cand;
          outcome = fbOutcome;
          result.usedFallback = true;
          result.agentName = cand.name;
          result.serviceName = cand.serviceName;
          result.agentId = cand.agentId;
          if (fbOutcome.passed) break;
        }
        // Unpaid failure: leave `call` on the prior attempt and try the next candidate.
      }

      result.attempts = attempts;
      result.input = call.input;
      if (call.output === null) {
        result.status = "errored";
        result.error = outcome.detail;
      } else {
        result.output = call.output;
        if (call.paid) {
          // Only claim a verified settlement when we actually have the tx hash from the
          // agent's payment-response. Without it the money most likely moved (the agent
          // served paid data), but we must not present an unproven hash as "settled"
          // (audit C3) — label it honestly so receipts and reputation don't overstate.
          result.paymentTxHash = call.txHash ?? "settlement_unconfirmed";
          result.feeUsdt = agent.feeAmount;
          totalPaid += Math.max(paidAttemptCost, agent.feeAmount);
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
  const hasDeliverable = completed > 0 && !/^No agent outputs passed verification/i.test(finalOutput);

  const execution: BindExecution = {
    executionId, planId: plan.planId, goal: plan.goal, payer,
    // A planned route can be dropped by safety caps, merchant errors, or a better fallback.
    // If Bind still returns a verified synthesized answer, the buyer got the product.
    status: hasDeliverable ? "completed" : "failed",
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
