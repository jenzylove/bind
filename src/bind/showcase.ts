import type { BindExecution } from "./types.js";

function settlementClass(
  reference: string | undefined,
  paymentState: BindExecution["stepResults"][number]["paymentState"],
): "confirmed" | "reference_only" | "unconfirmed" | "none" {
  if (paymentState === "settlement_confirmed" && reference && /^0x[0-9a-fA-F]{64}$/.test(reference)) return "confirmed";
  if (paymentState === "authorized_ambiguous" || reference === "settlement_unconfirmed") return "unconfirmed";
  if (reference && reference !== "no_payment_needed") return "reference_only";
  return "none";
}

/** Capability-safe mission view. Raw goals, payer data, requests, endpoints and intermediate outputs stay private. */
export function showcaseExecution(execution: BindExecution) {
  return {
    executionId: execution.executionId,
    status: execution.status,
    progress: {
      completedSteps: execution.completedSteps,
      totalSteps: execution.totalSteps,
    },
    services: execution.stepResults.map((result, index) => ({
      step: index + 1,
      service: result.agentName,
      status: result.status,
      verificationPassed: result.verificationResult?.passed ?? false,
      feeUsdt: result.feeUsdt ?? 0,
      settlementEvidence: settlementClass(result.paymentTxHash, result.paymentState),
      settlementTxHash: result.paymentState === "settlement_confirmed" && /^0x[0-9a-fA-F]{64}$/.test(result.paymentTxHash ?? "")
        ? result.paymentTxHash
        : undefined,
    })),
    totalAgentFeesUsdt: execution.totalPaid,
    refund: {
      amountDueUsdt: execution.refundAmountDueUsdt ?? 0,
      amountSubmittedUsdt: execution.refundAmountSubmittedUsdt ?? execution.refundedUsdt ?? 0,
      amountConfirmedUsdt: execution.refundAmountConfirmedUsdt ?? 0,
      state: execution.refundState ?? "none",
      txHash: execution.refundTxHash,
      reason: execution.refundReason,
    },
    receipt: {
      available: true,
      url: `/bind/receipt/${execution.executionId}`,
      anchorTxHash: execution.anchorTxHash,
    },
    deliverable: execution.finalOutput,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt,
    error: execution.status === "failed" ? "mission_failed" : undefined,
  };
}
