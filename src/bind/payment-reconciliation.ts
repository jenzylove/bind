import {
  listPaymentClaims,
  transitionPaymentClaim,
  type PaymentClaim,
} from "./payment-claims.js";

export interface ReconciliationSummary {
  inspected: number;
  completedFromDurableExecution: number;
  refundedOrphanCustody: number;
  refundSubmittedOrphanCustody: number;
  blockedForReconciliation: number;
  alreadyTerminal: number;
}

export type OrphanRefundOutcome = {
  state: "confirmed" | "submitted" | "failed";
  txHash?: string;
  reason?: string;
};

/**
 * Resolve crash-left payment states before the server accepts new work. A confirmed buyer
 * payment with no execution attachment is refunded from its exact durable claim. Claims
 * attached to interrupted executions stay blocked because downstream exposure may exist.
 */
export async function reconcilePaymentClaimsOnStartup(
  resolveExecution: (executionId: string) => { status?: string } | null,
  dir?: string,
  refundOrphan?: (claim: PaymentClaim) => Promise<OrphanRefundOutcome>,
): Promise<ReconciliationSummary> {
  const claims = listPaymentClaims(dir);
  const summary: ReconciliationSummary = {
    inspected: claims.length,
    completedFromDurableExecution: 0,
    refundedOrphanCustody: 0,
    refundSubmittedOrphanCustody: 0,
    blockedForReconciliation: 0,
    alreadyTerminal: 0,
  };

  for (const original of claims) {
    let claim = original;
    if (claim.source === "downstream_x402" && claim.state === "settled") {
      summary.alreadyTerminal += 1;
      continue;
    }
    if (["completed", "refund_confirmed", "refund_submitted", "reconciliation_required"].includes(claim.state)) {
      summary.alreadyTerminal += 1;
      continue;
    }
    if (claim.state === "execution_started" && claim.executionId) {
      const execution = resolveExecution(claim.executionId);
      if (execution?.status === "completed" || execution?.status === "failed") {
        transitionPaymentClaim(claim.key, ["execution_started"], "completed", {
          detail: "startup matched a durable final execution record",
        }, dir);
        summary.completedFromDurableExecution += 1;
        continue;
      }
    }

    const orphanBuyerCustody =
      ["incoming_x402", "eip3009", "direct_transfer"].includes(claim.source)
      && !claim.executionId
      && ["settled", "refund_pending"].includes(claim.state)
      && claim.payer
      && claim.amountBaseUnits;
    if (orphanBuyerCustody && refundOrphan) {
      if (claim.state === "settled") {
        claim = transitionPaymentClaim(claim.key, ["settled"], "refund_pending", {
          detail: "startup reserved exact orphan-custody refund",
        }, dir);
      }
      const outcome = await refundOrphan(claim);
      if (outcome.state === "confirmed") {
        transitionPaymentClaim(claim.key, ["refund_pending"], "refund_confirmed", {
          refundTxHash: outcome.txHash?.toLowerCase(),
          detail: "startup confirmed exact orphan-custody refund",
        }, dir);
        summary.refundedOrphanCustody += 1;
      } else if (outcome.state === "submitted" && outcome.txHash) {
        transitionPaymentClaim(claim.key, ["refund_pending"], "refund_submitted", {
          refundTxHash: outcome.txHash.toLowerCase(),
          detail: "startup submitted exact orphan-custody refund; confirmation pending",
        }, dir);
        summary.refundSubmittedOrphanCustody += 1;
      } else {
        transitionPaymentClaim(claim.key, ["refund_pending"], "reconciliation_required", {
          detail: `startup orphan-custody refund failed: ${outcome.reason ?? "unknown outcome"}`.slice(0, 500),
        }, dir);
        summary.blockedForReconciliation += 1;
      }
      continue;
    }

    if (["submitting", "settled", "execution_started", "refund_pending"].includes(claim.state)) {
      transitionPaymentClaim(claim.key, [claim.state], "reconciliation_required", {
        detail: "startup found an interrupted payment lifecycle without authoritative final evidence",
      }, dir);
      summary.blockedForReconciliation += 1;
      continue;
    }
    summary.alreadyTerminal += 1;
  }
  return summary;
}

export function claimNeedsAttention(claim: PaymentClaim): boolean {
  return claim.state === "reconciliation_required"
    || claim.state === "submitting"
    || claim.state === "refund_pending"
    || claim.state === "refund_submitted";
}
