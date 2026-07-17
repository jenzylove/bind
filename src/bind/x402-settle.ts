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

interface Eip3009Auth {
  from: string; to: string; value: string;
  validAfter: string | number; validBefore: string | number; nonce: string;
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

async function submitTransferWithAuthorization(auth: Eip3009Auth, signature: string): Promise<string | null> {
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

  for (const data of attempts) {
    try {
      const { stdout } = await execFileAsync(
        ONCHAINOS_PATH,
        ["wallet", "contract-call", "--to", config.usdtAsset, "--chain", "196", "--input-data", data],
        { timeout: 45000 },
      );
      const parsed = JSON.parse(stdout);
      const txHash = parsed?.data?.txHash ?? parsed?.data?.hash ?? parsed?.data?.orderId;
      if (typeof txHash === "string" && txHash.length > 0) return txHash;
    } catch { /* try the other overload */ }
  }
  return null;
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
    // Structured JSON but no EIP-3009 authorization we recognize — likely an OKX TEE /
    // deferred credential. Serve it (interop over revenue) but keep the evidence.
    settlementLog({ kind: "passthrough_unrecognized", keys: Object.keys(decoded), scheme: decoded.scheme ?? null });
    console.warn("[x402-settle] unrecognized credential format — served without settlement");
    return { ok: true, settled: false, reason: "unrecognized credential format (passthrough)" };
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
  const txHash = await submitTransferWithAuthorization(auth, signature);
  if (!txHash) {
    settlementLog({ kind: "settle_failed", payer: auth.from, value: String(value) });
    return { ok: false, settled: false, reason: "settlement transaction failed (invalid or replayed authorization)" };
  }

  settlementLog({ kind: "settled", payer: auth.from, value: String(value), txHash });
  console.log(`[x402-settle] settled ${Number(value) / 1e6} USDT from ${auth.from}: ${txHash}`);
  return { ok: true, settled: true, txHash, payer: auth.from };
}
