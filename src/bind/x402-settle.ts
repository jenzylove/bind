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
// Interop guard: OKX's task system may present credential formats we can't parse (TEE
// deferred schemes). Those are structured JSON but carry no EIP-3009 authorization — they
// pass through with a log line rather than a rejection, so the listing keeps working.
// Unparseable garbage is rejected outright.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const DATA_DIR = process.env.BIND_DATA_DIR ?? "data";

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
  reason?: string;
}

export interface Eip3009Auth {
  from: string; to: string; value: string;
  validAfter: string | number; validBefore: string | number; nonce: string;
}

/**
 * Settle a signed EIP-3009 authorization on-chain from Bind's wallet (Bind pays gas).
 * Used by the website's gasless buyer flow AND by seller-side x402 settlement — the
 * contract enforces the signature and the one-time nonce, so a bad or replayed
 * authorization simply fails. Returns the settlement tx hash, or null.
 */
export async function settleAuthorization(auth: Eip3009Auth, signature: string): Promise<string | null> {
  return (await submitTransferWithAuthorization(auth, signature)).txHash ?? null;
}

function word(hex: string): string { return hex.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
function numWord(v: string | number | bigint): string { return BigInt(v).toString(16).padStart(64, "0"); }

function decodeHeader(raw: string): any | null {
  // The header may arrive as "X402 <b64>" (Authorization form) or bare base64.
  const b64 = raw.replace(/^x402\s+/i, "").trim();
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); } catch { /* fall through */ }
  try { return JSON.parse(b64); } catch { return null; }
}

function findAuthorization(decoded: any): { auth: Eip3009Auth; signature: string } | null {
  // Standard x402 exact shape: { payload: { authorization: {...}, signature } }; be
  // liberal about nesting — some signers put it a level up or down.
  const spots = [decoded?.payload, decoded, decoded?.payload?.payload];
  for (const s of spots) {
    const a = s?.authorization;
    const sig = s?.signature ?? decoded?.signature;
    if (a?.from && a?.to && a?.value != null && a?.nonce && typeof sig === "string") {
      return { auth: a as Eip3009Auth, signature: sig };
    }
  }
  return null;
}

function settlementLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "asp-payments.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* audit log is best-effort */ }
}

async function submitTransferWithAuthorization(auth: Eip3009Auth, signature: string): Promise<{ txHash?: string; reason?: string }> {
  const sig = signature.toLowerCase().replace(/^0x/, "");
  const common =
    word(auth.from) + word(auth.to) + numWord(auth.value) +
    numWord(auth.validAfter ?? 0) + numWord(auth.validBefore) + word(auth.nonce);

  const attempts: string[] = [];
  if (sig.length === 130) {
    // v,r,s overload first — cheapest calldata, most widely implemented.
    const r = sig.slice(0, 64), s = sig.slice(64, 128), v = BigInt("0x" + sig.slice(128, 130));
    attempts.push(SEL_VRS + common + numWord(v) + r + s);
  }
  // bytes-signature overload: offset (0x120 = 9 words in), length, padded bytes.
  const sigPadded = sig.padEnd(Math.ceil(sig.length / 64) * 64, "0");
  attempts.push(SEL_BYTES + common + numWord(0x120) + numWord(sig.length / 2) + sigPadded);

  // Capture the REAL reason each overload fails — the CLI's error string (revert reason,
  // out-of-gas, HPKE, invalid signature) — instead of swallowing it. Without this we could
  // only report a generic "settlement failed" and were flying blind (this is what OKX's
  // review flagged: inspect settler logs).
  let lastReason = "no settlement attempt ran";
  for (const data of attempts) {
    try {
      const { stdout } = await execFileAsync(
        ONCHAINOS_PATH,
        ["wallet", "contract-call", "--to", config.usdtAsset, "--chain", "196", "--input-data", data],
        { timeout: 45000 },
      );
      const parsed = JSON.parse(stdout);
      const txHash = parsed?.data?.txHash ?? parsed?.data?.hash ?? parsed?.data?.orderId;
      if (typeof txHash === "string" && txHash.length > 0) return { txHash };
      // ok:false or no hash — keep the CLI's own error/simulation message.
      lastReason = parsed?.error || parsed?.data?.executeErrorMsg || parsed?.msg || JSON.stringify(parsed).slice(0, 160);
    } catch (e) {
      lastReason = (e as Error).message.slice(0, 160);
    }
  }
  return { reason: lastReason };
}

/**
 * Validate and settle an incoming x402 credential against our challenge terms.
 * @param rawHeader   the PAYMENT-SIGNATURE / X-PAYMENT / Authorization header value
 * @param amountBaseUnits the price this route charges (USDT, 6 decimals)
 */
export async function settleIncomingPayment(rawHeader: string, amountBaseUnits: string): Promise<SettleVerdict> {
  const decoded = decodeHeader(rawHeader);
  if (!decoded || typeof decoded !== "object") {
    return { ok: false, settled: false, reason: "credential is not a decodable x402 payment" };
  }

  const found = findAuthorization(decoded);
  if (!found) {
    // FAIL CLOSED. A structured JSON blob without a verifiable EIP-3009 authorization is
    // not proof of payment — the old passthrough here served paid routes for free to any
    // `{"foo":"bar"}` (audit C1). Returning ok:false makes the gate answer 402, which is
    // also the correct x402 response for an unverifiable/unsupported credential.
    settlementLog({ kind: "rejected_unrecognized", keys: Object.keys(decoded), scheme: decoded.scheme ?? null });
    console.warn("[x402-settle] unrecognized/unverifiable credential — rejected (402)");
    return { ok: false, settled: false, reason: "unsupported or unverifiable payment credential (no settlement adapter)" };
  }

  const { auth, signature } = found;
  const payTo = (config.payToAddress || "").toLowerCase();
  if ((auth.to || "").toLowerCase() !== payTo) {
    return { ok: false, settled: false, reason: "authorization pays a different address" };
  }
  let value: bigint;
  try { value = BigInt(auth.value); } catch { return { ok: false, settled: false, reason: "unreadable amount" }; }
  if (value < BigInt(amountBaseUnits)) {
    return { ok: false, settled: false, reason: `underpaid: authorized ${value} of ${amountBaseUnits} base units` };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    if (BigInt(auth.validBefore) <= BigInt(nowSec)) return { ok: false, settled: false, reason: "authorization expired" };
    if (auth.validAfter != null && BigInt(auth.validAfter) > BigInt(nowSec)) return { ok: false, settled: false, reason: "authorization not yet valid" };
  } catch { return { ok: false, settled: false, reason: "unreadable validity window" }; }

  // The token contract enforces the signature and the nonce (replay protection) —
  // a bad credential reverts and we never serve it.
  const { txHash, reason } = await submitTransferWithAuthorization(auth, signature);
  if (!txHash) {
    settlementLog({ kind: "settle_failed", payer: auth.from, value: String(value), reason });
    console.warn(`[x402-settle] settlement did not land: ${reason}`);
    // Surface the actual on-chain reason instead of falsely blaming a "replayed" nonce.
    return { ok: false, settled: false, reason: `settlement did not confirm on X Layer: ${reason ?? "unknown"}` };
  }

  settlementLog({ kind: "settled", payer: auth.from, value: String(value), txHash });
  console.log(`[x402-settle] settled ${Number(value) / 1e6} USDT from ${auth.from}: ${txHash}`);
  return { ok: true, settled: true, txHash, payer: auth.from };
}
