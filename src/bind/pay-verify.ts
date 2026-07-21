// On-chain payment verification for the buyer-pays flow.
//
// The user pays the plan's quoted total in USDT to Bind's wallet on X Layer, then passes
// the transaction hash to /bind/execute. The server verifies that transaction on-chain
// BEFORE spending anything: it must be a USDT transfer, to Bind's wallet, for at least the
// quote, confirmed successful, and not already spent on another execution. This is what
// makes Bind a real economic loop (users pay, not the founder) and closes the drain hole
// where anyone could hit /bind/execute for free and empty the agentic wallet.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const USDT = (process.env.USDT_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736").toLowerCase();
const BIND_WALLET = (config.payToAddress || "").toLowerCase();
const DIR = process.env.BIND_DATA_DIR ?? "data";
const USED_FILE = join(DIR, "used-payments.json");
const ERC20_TRANSFER = "0xa9059cbb"; // transfer(address,uint256)

export interface PaymentVerdict {
  ok: boolean;
  reason?: string;
  amount?: number;
  /** Who paid. Needed to refund any agent budget the mission never spends. */
  payer?: string;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const j = await r.json();
    return j?.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function loadUsed(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(USED_FILE, "utf8")) as string[]); } catch { return new Set(); }
}
function markUsed(hash: string): void {
  try {
    const s = loadUsed(); s.add(hash.toLowerCase());
    mkdirSync(DIR, { recursive: true });
    writeFileSync(USED_FILE, JSON.stringify([...s]));
  } catch { /* best-effort; the on-chain checks still gate spending */ }
}

export function paymentAlreadyUsed(hash: string): boolean {
  return loadUsed().has((hash || "").toLowerCase());
}

// Claimed by an in-flight execution but not yet burned. Two concurrent requests with the
// same tx hash must not both pass verification (the used-file write is not atomic), and a
// payment must only be burned once its mission actually ran — if execution throws before
// doing any work, the buyer keeps the right to retry with the same tx.
const inFlight = new Set<string>();

/** Burn the payment: its mission ran. Call after executePlan returns. */
export function commitPayment(hash: string): void {
  const h = (hash || "").toLowerCase();
  markUsed(h);
  inFlight.delete(h);
}

/** Release a claimed payment so the buyer can retry: its mission never ran. */
export function releasePayment(hash: string): void {
  inFlight.delete((hash || "").toLowerCase());
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function topicToAddress(t: string): string { return "0x" + t.slice(-40); }

/**
 * The real payer, read from the USDT Transfer log rather than tx.from. Payments on X Layer
 * are commonly relayed (the buyer signs, a relayer submits and pays gas), so tx.from is
 * the relayer. Refunding that address would send the buyer's money to a bundler.
 */
function payerFromReceipt(receipt: any): string | undefined {
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== USDT) continue;
    const topics: string[] = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    if (topicToAddress(topics[2]).toLowerCase() !== BIND_WALLET) continue; // the leg paying us
    return topicToAddress(topics[1]);
  }
  return undefined;
}

// minUsdt: the plan's quoted total. amountUsdt is derived from 6-decimal USDT base units.
export async function verifyPayment(txHash: string, minUsdt: number): Promise<PaymentVerdict> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return { ok: false, reason: "invalid transaction hash" };
  if (!BIND_WALLET) return { ok: false, reason: "server misconfigured: no pay-to address" };
  const h = txHash.toLowerCase();
  if (loadUsed().has(h)) return { ok: false, reason: "this payment was already used for another mission" };
  if (inFlight.has(h)) return { ok: false, reason: "this payment is already funding a mission that is running right now" };

  const receipt = await rpc("eth_getTransactionReceipt", [h]);
  if (!receipt) return { ok: false, reason: "payment not yet confirmed — wait a few seconds and retry" };
  if (receipt.status !== "0x1") return { ok: false, reason: "payment transaction failed on-chain" };

  // Verify by the USDT Transfer LOG, not by decoding tx.input. The log is the real proof
  // that value moved, and it is correct for EVERY payment method: a direct EOA transfer, a
  // relayed/sponsored tx, or an account-abstraction (smart-wallet) tx where tx.to is an
  // entrypoint, not the token. Decoding tx.input only worked for direct EOA transfers and
  // rejected every smart-wallet buyer as "not a USDT transfer".
  let total = 0n;
  let payer: string | undefined;
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== USDT) continue;
    const topics: string[] = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    if (topicToAddress(topics[2]).toLowerCase() !== BIND_WALLET) continue; // credited to us
    try { total += BigInt(log.data); } catch { /* skip unreadable log */ }
    payer = topicToAddress(topics[1]);
  }
  if (total === 0n) return { ok: false, reason: "no USDT transfer to Bind's wallet in this transaction" };
  const amount = Number(total) / 1e6;
  if (amount + 1e-9 < minUsdt) return { ok: false, reason: `underpaid: sent $${amount} but mission costs $${minUsdt}` };

  // Claim (don't burn) the payment. The route commits it only after the mission runs,
  // so a pre-execution failure leaves the buyer free to retry with the same tx.
  inFlight.add(h);
  return { ok: true, amount, payer };
}
