// On-chain execution receipt. Hashes a canonical summary of the whole execution —
// which agents were called, how much each was actually paid, each real settlement tx,
// pass/fail per step — and anchors that hash on X Layer. The returned txHash is a real
// on-chain transaction (the anchor), so the receipt is verifiable, not decorative.
import { canonicalize, sha256Hex } from "../report.js";
import { anchorHash } from "../anchor.js";
import { config } from "../config.js";
import type { BindExecution } from "./types.js";

export interface ExecutionReceipt {
  txHash: string;    // real on-chain anchor tx
  reportUrl: string; // where the full, itemized execution lives
  receiptSha256: string;
}

function buildReceiptCore(execution: BindExecution) {
  return {
    kind: "bind-execution-receipt-v1",
    executionId: execution.executionId,
    planId: execution.planId,
    goal: execution.goal,
    status: execution.status,
    totalPaidUsdt: execution.totalPaid,
    createdAt: execution.createdAt,
    steps: execution.stepResults.map((s) => ({
      step: s.step,
      agent: s.agentName,
      status: s.status,
      settlementTx: s.paymentTxHash ?? null,
      verified: s.verificationResult?.passed ?? null,
    })),
  };
}

export async function anchorExecution(execution: BindExecution): Promise<ExecutionReceipt | null> {
  const receiptSha256 = sha256Hex(canonicalize(buildReceiptCore(execution)));
  const reportUrl = `${config.publicBaseUrl}/bind/status/${execution.executionId}`;

  try {
    const anchor = await anchorHash(receiptSha256, config.payToAddress);
    return { txHash: anchor.txHash, reportUrl, receiptSha256 };
  } catch {
    // Anchoring is best-effort: if the wallet/CLI isn't available (e.g. local dev),
    // the execution still completes; it just carries no on-chain anchor.
    return null;
  }
}
