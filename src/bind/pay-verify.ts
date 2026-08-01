// On-chain payment verification for the buyer-pays flow.
//
// The user pays the plan's quoted total in USDT to Bind's wallet on X Layer, then passes
// the transaction hash to /bind/execute. The server verifies that transaction on-chain
// BEFORE spending anything: it must be a USDT transfer, to Bind's wallet, for at least the
// quote, confirmed successful, and not already spent on another execution. This is what
// makes Bind a real economic loop (users pay, not the founder) and closes the drain hole
// where anyone could hit /bind/execute for free and empty the agentic wallet.
import { config } from "../config.js";
import {
  directPaymentClaimKey,
  loadPaymentClaim,
  reservePaymentClaim,
  transitionPaymentClaim,
} from "./payment-claims.js";

const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const USDT = (process.env.USDT_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736").toLowerCase();
const BIND_WALLET = (config.payToAddress || "").toLowerCase();
const ERC20_TRANSFER = "0xa9059cbb"; // transfer(address,uint256)

export interface PaymentVerdict {
  ok: boolean;
  reason?: string;
  amount?: number;
  amountBaseUnits?: string;
  chain?: "eip155:196";
  token?: string;
  recipient?: string;
  source?: "direct_transfer";
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

export function paymentAlreadyUsed(hash: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) return true;
  return loadPaymentClaim(directPaymentClaimKey(USDT, hash)) !== undefined;
}

/** Mark that a mission is about to perform external work with this payment. */
export function startPaymentExecution(hash: string, executionId: string): void {
  const key = directPaymentClaimKey(USDT, hash);
  transitionPaymentClaim(key, ["settled"], "execution_started", { executionId });
}

/** Permanently complete the claim after the mission record is durable. */
export function commitPayment(hash: string): void {
  const key = directPaymentClaimKey(USDT, hash);
  transitionPaymentClaim(key, ["settled", "execution_started"], "completed");
}

/** A confirmed payment is never reusable. Failure leaves an explicit reconciliation record. */
export function releasePayment(hash: string): void {
  const key = directPaymentClaimKey(USDT, hash);
  const current = loadPaymentClaim(key);
  if (!current || current.state === "completed" || current.state === "reconciliation_required") return;
  transitionPaymentClaim(key, [current.state], "reconciliation_required", {
    detail: "execution did not complete after payment reservation",
  });
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function topicToAddress(t: string): string { return "0x" + t.slice(-40); }

export function summarizeBuyerPaymentReceipt(
  receipt: any,
  expectedTxHash: string,
  tokenAddress: string,
  recipientAddress: string,
): { payer: string; amountBaseUnits: bigint } | { reason: string } {
  if (String(receipt?.transactionHash ?? "").toLowerCase() !== expectedTxHash.toLowerCase()) {
    return { reason: "receipt transaction hash does not match the requested payment" };
  }
  const totals = new Map<string, bigint>();
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== tokenAddress.toLowerCase()) continue;
    const topics: string[] = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    if (topicToAddress(topics[2]).toLowerCase() !== recipientAddress.toLowerCase()) continue;
    const payer = topicToAddress(topics[1]).toLowerCase();
    try { totals.set(payer, (totals.get(payer) ?? 0n) + BigInt(log.data)); } catch {
      return { reason: "payment receipt contains an unreadable transfer amount" };
    }
  }
  if (totals.size === 0) return { reason: "no USDT transfer to Bind's wallet in this transaction" };
  if (totals.size !== 1) return { reason: "payment transaction contains transfers from multiple payers" };
  const [[payer, amountBaseUnits]] = [...totals.entries()];
  if (amountBaseUnits <= 0n) return { reason: "payment transfer amount is zero" };
  return { payer, amountBaseUnits };
}

// minUsdt: the plan's quoted total. amountUsdt is derived from 6-decimal USDT base units.
export async function verifyPayment(txHash: string, minUsdt: number): Promise<PaymentVerdict> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return { ok: false, reason: "invalid transaction hash" };
  if (!BIND_WALLET) return { ok: false, reason: "server misconfigured: no pay-to address" };
  const h = txHash.toLowerCase();

  const receipt = await rpc("eth_getTransactionReceipt", [h]);
  if (!receipt) return { ok: false, reason: "payment not yet confirmed — wait a few seconds and retry" };
  if (receipt.status !== "0x1") return { ok: false, reason: "payment transaction failed on-chain" };

  const summary = summarizeBuyerPaymentReceipt(receipt, h, USDT, BIND_WALLET);
  if ("reason" in summary) return { ok: false, reason: summary.reason };
  const { payer, amountBaseUnits: total } = summary;
  const minimumBaseUnits = BigInt(Math.round(minUsdt * 1e6));
  const amount = Number(total) / 1e6;
  if (total < minimumBaseUnits) return { ok: false, reason: `underpaid: sent $${amount} but mission costs $${minUsdt}` };

  const key = directPaymentClaimKey(USDT, h);
  const reserved = reservePaymentClaim({
    key,
    source: "direct_transfer",
    chain: "eip155:196",
    token: USDT,
    txHash: h,
    payer,
    amountBaseUnits: total.toString(),
  });
  if (!reserved) return { ok: false, reason: "this payment is already reserved for another mission or reconciliation" };
  try {
    transitionPaymentClaim(key, ["reserved"], "settled");
  } catch {
    return { ok: false, reason: "payment was reserved but its durable claim needs reconciliation" };
  }
  return {
    ok: true,
    amount,
    amountBaseUnits: total.toString(),
    chain: "eip155:196",
    token: USDT,
    recipient: BIND_WALLET,
    source: "direct_transfer",
    payer,
  };
}
