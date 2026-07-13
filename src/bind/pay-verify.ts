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

export interface PaymentVerdict { ok: boolean; reason?: string; amount?: number; }

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

// minUsdt: the plan's quoted total. amountUsdt is derived from 6-decimal USDT base units.
export async function verifyPayment(txHash: string, minUsdt: number): Promise<PaymentVerdict> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return { ok: false, reason: "invalid transaction hash" };
  if (!BIND_WALLET) return { ok: false, reason: "server misconfigured: no pay-to address" };
  const h = txHash.toLowerCase();
  if (loadUsed().has(h)) return { ok: false, reason: "this payment was already used for another mission" };

  const tx = await rpc("eth_getTransactionByHash", [h]);
  if (!tx) return { ok: false, reason: "transaction not found on X Layer" };
  if ((tx.to || "").toLowerCase() !== USDT) return { ok: false, reason: "not a USDT transfer" };

  const input = (tx.input || "").toLowerCase();
  if (!input.startsWith(ERC20_TRANSFER) || input.length < 138) return { ok: false, reason: "not an ERC-20 transfer" };
  const to = "0x" + input.slice(34, 74);          // transfer arg1: address (last 20 bytes of the 32-byte word)
  const amountHex = input.slice(74, 138);          // transfer arg2: uint256 amount
  if (to.toLowerCase() !== BIND_WALLET) return { ok: false, reason: "payment was not sent to Bind's wallet" };

  let amount: number;
  try { amount = Number(BigInt("0x" + amountHex)) / 1e6; } catch { return { ok: false, reason: "could not read payment amount" }; }
  if (amount + 1e-9 < minUsdt) return { ok: false, reason: `underpaid: sent $${amount} but mission costs $${minUsdt}` };

  const receipt = await rpc("eth_getTransactionReceipt", [h]);
  if (!receipt) return { ok: false, reason: "payment not yet confirmed — wait a few seconds and retry" };
  if (receipt.status !== "0x1") return { ok: false, reason: "payment transaction failed on-chain" };

  markUsed(h);
  return { ok: true, amount };
}
