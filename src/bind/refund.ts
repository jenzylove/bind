// Refund the buyer amount a mission did not earn.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { BindExecution, RefundAttestation } from "./types.js";
import { hashCanonical } from "./receipt.js";
import {
  loadPaymentClaim,
  refundClaimKey,
  reservePaymentClaim,
  transitionPaymentClaim,
} from "./payment-claims.js";

const execFileAsync = promisify(execFile);
const ONCHAINOS_PATH = (process.env.HOME || process.env.USERPROFILE || "") + "/.local/bin/onchainos";
const RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const MIN_REFUND_USDT = 0.004;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface RefundResult {
  amountDue: number;
  amountSubmitted: number;
  amountConfirmed: number;
  amountDueBaseUnits: string;
  amountSubmittedBaseUnits: string;
  amountConfirmedBaseUnits: string;
  /** @deprecated migration alias for amountSubmitted. */
  refunded: number;
  state: "not_due" | "below_threshold" | "submitted" | "confirmed" | "failed" | "confirmation_failed" | "reconciliation_required";
  txHash?: string;
  reason?: string;
}

export function refundTxHashFromResponse(value: unknown): string | undefined {
  const response = value as { ok?: unknown; data?: { txHash?: unknown } };
  if (response?.ok !== true) return undefined;
  const txHash = response.data?.txHash;
  return typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : undefined;
}

function transferCalldata(to: string, amountBaseUnits: bigint): string {
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amountBaseUnits.toString(16).padStart(64, "0");
  return "0xa9059cbb" + addr + amt;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
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

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export type RefundConfirmation = "pending" | "confirmed" | "failed";

/** Independently verify the exact canonical-USDT refund transfer on X Layer. */
export async function confirmRefundTransfer(
  txHash: string,
  payer: string,
  amountBaseUnits: string,
  readReceipt: (method: string, params: unknown[]) => Promise<any> = rpc,
  attempts = 1,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tokenAddress = config.usdtAsset,
  senderAddress = config.payToAddress,
): Promise<RefundConfirmation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return "failed";
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress) || !/^0x[0-9a-fA-F]{40}$/.test(senderAddress)) return "failed";
  if (!/^(0|[1-9][0-9]*)$/.test(amountBaseUnits)) return "failed";
  const expected = BigInt(amountBaseUnits);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const receipt = await readReceipt("eth_getTransactionReceipt", [txHash.toLowerCase()]);
    if (!receipt) {
      if (attempt + 1 < attempts) await wait(1000);
      continue;
    }
    if (String(receipt.transactionHash ?? "").toLowerCase() !== txHash.toLowerCase()) return "failed";
    if (receipt.status !== "0x1") return "failed";
    let transferred = 0n;
    for (const log of receipt.logs ?? []) {
      const topics: string[] = log.topics ?? [];
      if (String(log.address).toLowerCase() !== tokenAddress.toLowerCase()) continue;
      if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
      if (topicAddress(topics[1]) !== senderAddress.toLowerCase()) continue;
      if (topicAddress(topics[2]) !== payer.toLowerCase()) continue;
      try { transferred += BigInt(log.data); } catch { return "failed"; }
    }
    return transferred === expected ? "confirmed" : "failed";
  }
  return "pending";
}

export interface RefundDependencies {
  claimsDir?: string;
  tokenAddress?: string;
  senderAddress?: string;
  submit?: (payer: string, amountBaseUnits: bigint, calldata: string) => Promise<unknown>;
  confirm?: (txHash: string, payer: string, amountBaseUnits: string, token: string, sender: string) => Promise<RefundConfirmation>;
}

async function submitRefund(tokenAddress: string, payer: string, amountBaseUnits: bigint, calldata: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    ONCHAINOS_PATH,
    ["wallet", "contract-call", "--to", tokenAddress, "--chain", "196", "--input-data", calldata],
    { timeout: 45000 },
  );
  return JSON.parse(stdout);
}

export async function refundExactBaseUnits(
  amountDueBaseUnits: string,
  payer?: string,
  liabilityId?: string,
  dependencies: RefundDependencies = {},
): Promise<RefundResult> {
  const canonicalAmount = /^(0|[1-9][0-9]*)$/.test(amountDueBaseUnits) ? amountDueBaseUnits : "0";
  const amountBaseUnits = BigInt(canonicalAmount);
  const amountDue = Number(amountBaseUnits) / 1e6;
  const tokenAddress = (dependencies.tokenAddress ?? config.usdtAsset).toLowerCase();
  const senderAddress = (dependencies.senderAddress ?? config.payToAddress).toLowerCase();
  const result = (
    state: RefundResult["state"],
    submittedBaseUnits = "0",
    confirmedBaseUnits = "0",
    reason?: string,
    txHash?: string,
  ): RefundResult => ({
    amountDue,
    amountSubmitted: Number(BigInt(submittedBaseUnits)) / 1e6,
    amountConfirmed: Number(BigInt(confirmedBaseUnits)) / 1e6,
    amountDueBaseUnits: canonicalAmount,
    amountSubmittedBaseUnits: submittedBaseUnits,
    amountConfirmedBaseUnits: confirmedBaseUnits,
    refunded: Number(BigInt(submittedBaseUnits)) / 1e6,
    state,
    reason,
    txHash,
  });
  if (!/^(0|[1-9][0-9]*)$/.test(amountDueBaseUnits)) return result("failed", "0", "0", "refund amount is not a canonical base-unit integer");
  if (amountBaseUnits === 0n) return result("not_due", "0", "0", "full budget was spent or withheld for reconciliation");
  if (amountBaseUnits < 4_000n) return result("below_threshold", "0", "0", "below refund threshold");
  if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return result("failed", "0", "0", "no payer address on record");
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress) || !/^0x[0-9a-f]{40}$/.test(senderAddress)) {
    return result("failed", "0", "0", "server misconfigured: invalid token or sender address");
  }
  if (!liabilityId) return result("failed", "0", "0", "no durable liability id for idempotent refund");

  const normalizedPayer = payer.toLowerCase();
  const key = refundClaimKey(liabilityId, tokenAddress, normalizedPayer, canonicalAmount);
  const reserved = reservePaymentClaim({
    key,
    source: "refund",
    chain: "eip155:196",
    token: tokenAddress,
    sender: senderAddress,
    payer: normalizedPayer,
    amountBaseUnits: canonicalAmount,
    executionId: liabilityId,
    route: `refund:${liabilityId}`,
  }, dependencies.claimsDir);
  if (!reserved) {
    const existing = loadPaymentClaim(key, dependencies.claimsDir);
    if (!existing || existing.token !== tokenAddress || existing.sender !== senderAddress || existing.payer !== normalizedPayer || existing.amountBaseUnits !== canonicalAmount) {
      return result("reconciliation_required", "0", "0", "existing refund evidence does not match the immutable liability terms");
    }
    if (existing.state === "refund_confirmed" && existing.txHash) {
      return result("confirmed", canonicalAmount, canonicalAmount, undefined, existing.txHash);
    }
    if (existing.state === "refund_submitted" && existing.txHash) {
      return result("submitted", canonicalAmount, "0", "existing refund submission awaits reconciliation", existing.txHash);
    }
    return result("reconciliation_required", "0", "0", "an existing refund reservation blocks automatic retry");
  }

  transitionPaymentClaim(key, ["reserved"], "refund_pending", {}, dependencies.claimsDir);
  const submit = dependencies.submit ?? ((recipient, amount, calldata) => submitRefund(tokenAddress, recipient, amount, calldata));
  const confirm = dependencies.confirm ?? ((hash, recipient, amount, token, sender) => confirmRefundTransfer(hash, recipient, amount, rpc, 10, undefined, token, sender));
  try {
    const response = await submit(normalizedPayer, amountBaseUnits, transferCalldata(normalizedPayer, amountBaseUnits));
    const txHash = refundTxHashFromResponse(response)?.toLowerCase();
    if (!txHash) {
      transitionPaymentClaim(key, ["refund_pending"], "reconciliation_required", {
        detail: "refund submission returned no durable transaction identity",
      }, dependencies.claimsDir);
      return result("reconciliation_required", "0", "0", "refund submission outcome is ambiguous and automatic retry is blocked");
    }
    transitionPaymentClaim(key, ["refund_pending"], "refund_submitted", { txHash }, dependencies.claimsDir);
    const confirmation = await confirm(txHash, normalizedPayer, canonicalAmount, tokenAddress, senderAddress);
    if (confirmation === "confirmed") {
      transitionPaymentClaim(key, ["refund_submitted"], "refund_confirmed", {}, dependencies.claimsDir);
      return result("confirmed", canonicalAmount, canonicalAmount, undefined, txHash);
    }
    if (confirmation === "failed") {
      transitionPaymentClaim(key, ["refund_submitted"], "reconciliation_required", {
        detail: "submitted refund did not confirm as the exact expected USDT transfer",
      }, dependencies.claimsDir);
      return result("confirmation_failed", canonicalAmount, "0", "submitted refund did not confirm as the exact expected USDT transfer", txHash);
    }
    return result("submitted", canonicalAmount, "0", "refund submitted and awaiting on-chain confirmation", txHash);
  } catch (error) {
    try {
      const current = loadPaymentClaim(key, dependencies.claimsDir);
      if (current && ["refund_pending", "refund_submitted"].includes(current.state)) {
        transitionPaymentClaim(key, [current.state], "reconciliation_required", {
          detail: `refund operation threw after reservation: ${(error as Error).message}`.slice(0, 500),
        }, dependencies.claimsDir);
      }
    } catch { /* the durable reservation itself still blocks retry */ }
    return result("reconciliation_required", "0", "0", "refund submission failed after durable reservation; automatic retry is blocked");
  }
}

export async function refundUnspent(
  quotedAgentCost: number,
  spentCost: number,
  payer?: string,
  liabilityId?: string,
  dependencies: RefundDependencies = {},
): Promise<RefundResult> {
  const amountBaseUnits = BigInt(Math.max(Math.round((quotedAgentCost - spentCost) * 1e6), 0));
  return refundExactBaseUnits(amountBaseUnits.toString(), payer, liabilityId, dependencies);
}

/** Reconcile a submitted refund by appending a hash-chained follow-up attestation. */
export async function reconcileRefundEvidence(
  execution: BindExecution,
  confirm: (txHash: string, payer: string, amountBaseUnits: string, token: string, sender: string) => Promise<RefundConfirmation> =
    (hash, payer, amount, token, sender) => confirmRefundTransfer(hash, payer, amount, rpc, 1, undefined, token, sender),
): Promise<boolean> {
  if (execution.refundState !== "submitted" || !execution.refundTxHash || !execution.payer || !execution.receiptSha256) return false;
  if (execution.refundAttestations?.some((item) => item.txHash.toLowerCase() === execution.refundTxHash!.toLowerCase())) return false;
  const amountBaseUnits = execution.refundAmountSubmittedBaseUnits;
  const token = execution.refundToken ?? execution.buyerPayment?.token;
  const sender = execution.refundSender ?? execution.buyerPayment?.recipient;
  if (!amountBaseUnits || !/^(0|[1-9][0-9]*)$/.test(amountBaseUnits) || !token || !sender) return false;
  const state = await confirm(execution.refundTxHash, execution.payer, amountBaseUnits, token, sender);
  if (state === "pending") return false;
  const prior = execution.refundAttestations?.at(-1);
  const core: Omit<RefundAttestation, "sha256"> = {
    schema: "bind.refund-attestation.v1",
    version: (prior?.version ?? 0) + 1,
    executionId: execution.executionId,
    priorReceiptSha256: execution.receiptSha256,
    previousAttestationSha256: prior?.sha256,
    txHash: execution.refundTxHash.toLowerCase(),
    token: token.toLowerCase(),
    sender: sender.toLowerCase(),
    recipient: execution.payer.toLowerCase(),
    amountBaseUnits,
    state: state === "confirmed" ? "confirmed" : "confirmation_failed",
    verifiedAt: new Date().toISOString(),
  };
  const attestation: RefundAttestation = { ...core, sha256: hashCanonical(core) };
  execution.refundAttestations = [...(execution.refundAttestations ?? []), attestation];
  return true;
}

/** Advance the durable refund claim only after its attestation was atomically persisted. */
export function finalizeRefundAttestationClaim(execution: BindExecution): void {
  const attestation = execution.refundAttestations?.at(-1);
  if (!attestation || !execution.payer) return;
  const key = refundClaimKey(execution.executionId, attestation.token, execution.payer, attestation.amountBaseUnits);
  const claim = loadPaymentClaim(key);
  if (claim?.state !== "refund_submitted") return;
  transitionPaymentClaim(
    key,
    ["refund_submitted"],
    attestation.state === "confirmed" ? "refund_confirmed" : "reconciliation_required",
    { detail: `refund attestation ${attestation.sha256}` },
  );
}
