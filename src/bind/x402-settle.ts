// Seller-side settlement of an incoming x402 payment.
//
// A buyer agent answers our 402 challenge with a PAYMENT-SIGNATURE header carrying a
// signed EIP-3009 authorization (scheme "exact"). Before this module existed, Bind only
// checked that the header was present — any junk string got the service free and no
// revenue was ever collected. Now the credential is decoded, validated against our own
// challenge terms, and settled on-chain: Bind submits transferWithAuthorization on the
// USDT contract from its agentic wallet, moving the buyer's money to payTo. The result is
// echoed back in the standard payment-response header ({success, transaction}) — the same
// envelope Bind's own executor reads when it is the buyer.
//
// Interop guard: credentials without a verifiable EIP-3009 authorization fail closed.
// Supporting another OKX credential scheme requires a real settlement adapter, not a
// structured-JSON passthrough.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import {
  authorizationClaimKey,
  directPaymentClaimKey,
  reservePaymentClaim,
  transitionPaymentClaim,
} from "./payment-claims.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const DATA_DIR = process.env.BIND_DATA_DIR ?? "data";
const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// transferWithAuthorization overloads on EIP-3009 tokens.
const SEL_VRS = "0xe3ee160e";   // (...,bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
const SEL_BYTES = "0xcf092995"; // (...,bytes32 nonce, bytes signature)

export interface SettleVerdict {
  /** Serve the request? */
  ok: boolean;
  /** Settled on-chain (vs passed through as an unrecognized-but-plausible credential). */
  settled: boolean;
  txHash?: string;
  payer?: string;
  valueBaseUnits?: string;
  reason?: string;
}

export interface Eip3009Auth {
  from: string; to: string; value: string;
  validAfter: string | number; validBefore: string | number; nonce: string;
}

function topicAddress(topic: string): string { return `0x${topic.slice(-40)}`.toLowerCase(); }

async function rpc(method: string, params: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const payload = await response.json();
    return payload?.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function confirmsExpectedTransfer(txHash: string, auth: Eip3009Auth): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt) {
      if (receipt.status !== "0x1") return false;
      for (const log of receipt.logs ?? []) {
        const topics: string[] = log.topics ?? [];
        if (String(log.address).toLowerCase() !== config.usdtAsset.toLowerCase()) continue;
        if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
        if (topicAddress(topics[1]) !== auth.from.toLowerCase()) continue;
        if (topicAddress(topics[2]) !== auth.to.toLowerCase()) continue;
        try { if (BigInt(log.data) === BigInt(auth.value)) return true; } catch { /* unreadable log */ }
      }
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Settle a signed EIP-3009 authorization on-chain from Bind's wallet (Bind pays gas).
 * Used by the website's gasless buyer flow AND by seller-side x402 settlement — the
 * contract enforces the signature and the one-time nonce, so a bad or replayed
 * authorization simply fails. Returns the settlement tx hash, or null.
 */
export async function settleAuthorization(
  auth: Eip3009Auth,
  signature: string,
  source: "eip3009" | "incoming_x402" = "eip3009",
  route?: string,
  requestIntent?: string,
): Promise<string | null> {
  if (requestIntent && auth.nonce.toLowerCase() !== requestIntent.toLowerCase()) return null;
  const token = config.usdtAsset.toLowerCase();
  const authKey = authorizationClaimKey(token, auth.from, auth.nonce);
  const reserved = reservePaymentClaim({
    key: authKey,
    source,
    chain: "eip155:196",
    token,
    payer: auth.from.toLowerCase(),
    sender: config.payToAddress.toLowerCase(),
    nonce: auth.nonce.toLowerCase(),
    amountBaseUnits: String(auth.value),
    route,
    requestIntent,
  });
  if (!reserved) return null;
  transitionPaymentClaim(authKey, ["reserved"], "submitting");
  const result = await submitTransferWithAuthorization(auth, signature);
  if (!result.txHash || !result.confirmed) {
    transitionPaymentClaim(authKey, ["submitting"], "reconciliation_required", {
      txHash: result.txHash,
      detail: result.reason ?? "authorization submission outcome is ambiguous",
    });
    return null;
  }

  transitionPaymentClaim(authKey, ["submitting"], "settled", { txHash: result.txHash });
  const txKey = directPaymentClaimKey(token, result.txHash);
  const linked = reservePaymentClaim({
    key: txKey,
    source,
    chain: "eip155:196",
    token,
    payer: auth.from.toLowerCase(),
    sender: config.payToAddress.toLowerCase(),
    nonce: auth.nonce.toLowerCase(),
    txHash: result.txHash,
    amountBaseUnits: String(auth.value),
    route,
    requestIntent,
  });
  if (!linked) {
    transitionPaymentClaim(authKey, ["settled"], "reconciliation_required", {
      detail: "settled authorization could not reserve its transaction claim",
    });
    return null;
  }
  transitionPaymentClaim(txKey, ["reserved"], "settled");
  transitionPaymentClaim(authKey, ["settled"], "completed", {
    detail: `linked transaction claim ${txKey}`,
  });
  return result.txHash;
}

function word(hex: string): string { return hex.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
function numWord(v: string | number | bigint): string { return BigInt(v).toString(16).padStart(64, "0"); }

function decodeHeader(raw: string): any | null {
  // The header may arrive as "X402 <b64>" (Authorization form) or bare base64.
  const b64 = raw.replace(/^x402\s+/i, "").trim();
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); } catch { /* fall through */ }
  try { return JSON.parse(b64); } catch { return null; }
}

export interface IncomingPaymentTerms {
  amountBaseUnits: string;
  amountPolicy: "exact" | "minimum";
  resource: string;
  intentNonce: string;
}

export function validateIncomingCredential(
  decoded: any,
  terms: IncomingPaymentTerms,
  nowSeconds = Math.floor(Date.now() / 1000),
): { auth: Eip3009Auth; signature: string; value: bigint } | { reason: string } {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded.x402Version !== 2) {
    return { reason: "credential must declare x402Version 2" };
  }
  if (decoded.accepts !== undefined || decoded.paymentRequirements !== undefined) {
    return { reason: "credential has ambiguous payment requirement representations" };
  }
  if (!decoded.resource || typeof decoded.resource !== "object" || Array.isArray(decoded.resource) || decoded.resource.url !== terms.resource) {
    return { reason: "credential resource does not match this exact route" };
  }
  const accepted = decoded.accepted;
  if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) return { reason: "credential has no single selected x402 terms object" };
  if (accepted.maxAmountRequired !== undefined) return { reason: "credential uses an ambiguous amount alias" };
  if (accepted.scheme !== "exact") return { reason: "credential scheme is not exact" };
  if (accepted.network !== "eip155:196") return { reason: "credential network is not X Layer" };
  if (String(accepted.asset ?? "").toLowerCase() !== config.usdtAsset.toLowerCase()) return { reason: "credential asset is not canonical X Layer USDT" };
  if (String(accepted.payTo ?? "").toLowerCase() !== config.payToAddress.toLowerCase()) return { reason: "credential payee does not match Bind" };

  const payload = decoded.payload;
  const auth = payload?.authorization as Eip3009Auth | undefined;
  const signature = payload?.signature;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !auth || typeof auth !== "object" || Array.isArray(auth)) {
    return { reason: "credential has no standard EIP-3009 payload" };
  }
  if (typeof auth.from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)
      || typeof auth.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(auth.to)) {
    return { reason: "authorization contains an invalid address" };
  }
  if (auth.to.toLowerCase() !== config.payToAddress.toLowerCase()) return { reason: "authorization pays a different address" };
  if (typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return { reason: "authorization nonce is invalid" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(terms.intentNonce) || auth.nonce.toLowerCase() !== terms.intentNonce.toLowerCase()) {
    return { reason: "authorization nonce does not match this request intent" };
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { reason: "authorization signature is invalid" };
  if (typeof auth.value !== "string" || !/^[1-9][0-9]*$/.test(auth.value)
      || typeof accepted.amount !== "string" || !/^[1-9][0-9]*$/.test(accepted.amount)
      || !/^[1-9][0-9]*$/.test(terms.amountBaseUnits)) {
    return { reason: "credential amount is not a canonical base-unit integer" };
  }
  if (typeof auth.validAfter !== "string" || !/^[0-9]+$/.test(auth.validAfter)
      || typeof auth.validBefore !== "string" || !/^[0-9]+$/.test(auth.validBefore)) {
    return { reason: "authorization validity window is invalid" };
  }
  if (BigInt(auth.validAfter) > BigInt(nowSeconds) || BigInt(auth.validBefore) <= BigInt(nowSeconds)) {
    return { reason: "authorization is not currently valid" };
  }

  const value = BigInt(auth.value);
  const selectedAmount = BigInt(accepted.amount);
  const expected = BigInt(terms.amountBaseUnits);
  if (value !== selectedAmount) return { reason: "authorization amount does not match selected x402 terms" };
  if (terms.amountPolicy === "exact" ? value !== expected : value < expected) {
    return { reason: terms.amountPolicy === "exact" ? "authorization amount must equal the fixed route price" : "authorization underpays the route minimum" };
  }
  return { auth, signature, value };
}

function settlementLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "asp-payments.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* audit log is best-effort */ }
}

function settlementErrorReason(e: unknown): string {
  const err = e as { message?: string; stderr?: string; stdout?: string };
  const raw = err.stderr || err.stdout || err.message || String(e);
  return raw
    .replace(/--input-data\s+0x[a-fA-F0-9]+/g, "--input-data <redacted-calldata>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function submitTransferWithAuthorization(auth: Eip3009Auth, signature: string): Promise<{ txHash?: string; confirmed: boolean; reason?: string }> {
  const sig = signature.toLowerCase().replace(/^0x/, "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(auth.from) || !/^0x[0-9a-fA-F]{40}$/.test(auth.to)) {
    return { confirmed: false, reason: "authorization contains an invalid address" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) || !/^[0-9a-f]{130}$/.test(sig)) {
    return { confirmed: false, reason: "authorization contains an invalid nonce or signature" };
  }
  const common =
    word(auth.from) + word(auth.to) + numWord(auth.value) +
    numWord(auth.validAfter ?? 0) + numWord(auth.validBefore) + word(auth.nonce);
  const r = sig.slice(0, 64), s = sig.slice(64, 128);
  let v = BigInt("0x" + sig.slice(128, 130));
  if (v < 27n) v += 27n;
  const data = SEL_VRS + common + numWord(v) + r + s;

  try {
    const { stdout } = await execFileAsync(
      ONCHAINOS_PATH,
      ["wallet", "contract-call", "--to", config.usdtAsset, "--chain", "196", "--input-data", data],
      { timeout: 45000 },
    );
    const parsed = JSON.parse(stdout);
    const txHash = parsed?.data?.txHash ?? parsed?.data?.hash;
    if (typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      const normalized = txHash.toLowerCase();
      const confirmed = await confirmsExpectedTransfer(normalized, auth);
      return {
        txHash: normalized,
        confirmed,
        reason: confirmed ? undefined : "submitted transaction did not confirm the exact expected USDT transfer",
      };
    }
    return {
      confirmed: false,
      reason: parsed?.error || parsed?.data?.executeErrorMsg || parsed?.msg || "wallet returned no transaction hash",
    };
  } catch (error) {
    return { confirmed: false, reason: settlementErrorReason(error) };
  }
}

/** Validate the exact v2 envelope before reserving or submitting its authorization. */
export async function settleIncomingPayment(rawHeader: string, terms: IncomingPaymentTerms): Promise<SettleVerdict> {
  const decoded = decodeHeader(rawHeader);
  const validated = validateIncomingCredential(decoded, terms);
  if ("reason" in validated) {
    settlementLog({ kind: "rejected_terms", reason: validated.reason });
    return { ok: false, settled: false, reason: validated.reason };
  }

  const { auth, signature, value } = validated;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, settled: false, reason: "authorization amount exceeds supported accounting range" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    if (BigInt(auth.validBefore) <= BigInt(nowSec)) return { ok: false, settled: false, reason: "authorization expired" };
    if (auth.validAfter != null && BigInt(auth.validAfter) > BigInt(nowSec)) return { ok: false, settled: false, reason: "authorization not yet valid" };
  } catch {
    return { ok: false, settled: false, reason: "unreadable validity window" };
  }

  const txHash = await settleAuthorization(auth, signature, "incoming_x402", terms.resource, terms.intentNonce);
  if (!txHash) {
    settlementLog({ kind: "settle_failed_or_reconciliation", payer: auth.from, value: String(value), route: terms.resource });
    return { ok: false, settled: false, reason: "authorization is rejected, already reserved, or requires settlement reconciliation" };
  }

  settlementLog({ kind: "settled", payer: auth.from, value: String(value), txHash, route: terms.resource });
  console.log(`[x402-settle] settled ${Number(value) / 1e6} USDT from ${auth.from}: ${txHash}`);
  return { ok: true, settled: true, txHash, payer: auth.from, valueBaseUnits: String(value) };
}
