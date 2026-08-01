// Canonical integrity receipts for Bind executions.
//
// A receipt commits to the goal, every agent input/output, verification verdict, final
// deliverable, settlement references and refund record without embedding raw payloads.
// SHA-256 commitments prove integrity when a holder discloses a candidate payload. They are
// not encryption and must not be presented as confidentiality for guessable values.
// The canonical receipt hash is written as calldata in a zero-value X Layer transaction.
import { createHash } from "node:crypto";
import { anchorHash } from "../anchor.js";
import { config } from "../config.js";
import { reviewedPayeeForEndpoint } from "./reviewed-downstream.js";
import type { AgentAttempt, BindExecution, BindPlan, BuyerPaymentEvidence, ExecutionResult, QuoteSnapshot } from "./types.js";

const EXPLORER = "https://www.oklink.com/xlayer/tx/";
const X_LAYER_USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
export const RECEIPT_VERSION = "bind.execution-receipt.v2" as const;

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item) ?? null);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = canonicalValue((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return String(value);
}

/** Stable JSON for independent receipt reproduction. Object keys are sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** A lowercase SHA-256 digest without a prefix. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function commitment(value: unknown): string | undefined {
  return value === undefined ? undefined : `sha256:${hashCanonical(value)}`;
}

function usdtBaseUnits(value: number | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "0";
  return BigInt(Math.round(value * 1e6)).toString();
}

/** Capture the offered quote without exposing raw seller endpoints in public proofs. */
export function buildQuoteSnapshot(plan: BindPlan, ttlMs = 30 * 60 * 1000): QuoteSnapshot {
  const createdMs = new Date(plan.createdAt).getTime();
  const expiresAt = new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + ttlMs).toISOString();
  return {
    schema: "bind.quote.v2",
    planId: plan.planId,
    createdAt: plan.createdAt,
    expiresAt,
    buyerTotalBaseUnits: usdtBaseUnits(plan.totalPriceUsdt),
    agentBudgetBaseUnits: usdtBaseUnits(plan.agentCost),
    platformFeeBaseUnits: usdtBaseUnits(plan.platformFee),
    buyerSettlement: {
      chain: "eip155:196",
      token: config.usdtAsset.toLowerCase() || X_LAYER_USDT,
      recipient: config.payToAddress.toLowerCase(),
    },
    steps: plan.steps.map((step) => {
      const fallbacks = step.candidates?.length
        ? step.candidates
        : step.fallbackAgent
          ? [step.fallbackAgent]
          : [];
      const candidates = [
        { role: "primary" as const, agent: step.agent },
        ...fallbacks.map((agent) => ({ role: "fallback" as const, agent })),
      ];
      return {
        step: step.step,
        candidates: candidates.map(({ role, agent }) => ({
          role,
          agentId: agent.agentId,
          serviceId: agent.serviceId,
          serviceName: agent.serviceName,
          endpointSha256: hashCanonical(agent.endpoint),
          feeToken: config.usdtAsset.toLowerCase() || X_LAYER_USDT,
          feeCapBaseUnits: usdtBaseUnits(agent.feeAmount),
          chain: "eip155:196" as const,
          recipient: reviewedPayeeForEndpoint(agent.endpoint)?.toLowerCase() ?? null,
          authorization: "exact_reviewed_recipient_required" as const,
        })),
      };
    }),
  };
}

/** Attach the canonical offered quote exactly once, before the plan is persisted. */
export function attachOfferedQuote(plan: BindPlan, ttlMs = 30 * 60 * 1000): QuoteSnapshot {
  if (plan.quoteSnapshot) throw new Error("offered quote snapshot already attached");
  const snapshot = buildQuoteSnapshot(plan, ttlMs);
  plan.quoteSnapshot = snapshot;
  return snapshot;
}

/** Fail closed if executable plan data drifted after the offered quote was issued. */
export function assertOfferedQuoteUnchanged(plan: BindPlan): void {
  const offered = plan.quoteSnapshot;
  if (!offered || offered.schema !== "bind.quote.v2") {
    throw new Error("offered quote snapshot is missing or unsupported");
  }
  const createdMs = new Date(offered.createdAt).getTime();
  const expiresMs = new Date(offered.expiresAt).getTime();
  const ttlMs = expiresMs - createdMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("offered quote expiry is invalid");
  if (hashCanonical(buildQuoteSnapshot(plan, ttlMs)) !== hashCanonical(offered)) {
    throw new Error("offered quote executable terms changed after issuance");
  }
}

function settlementFor(step: { paymentTxHash?: string }): {
  state: "none" | "free" | "submitted" | "unconfirmed";
  txHash?: string;
} {
  const ref = step.paymentTxHash;
  if (!ref) return { state: "none" };
  if (ref === "no_payment_needed") return { state: "free" };
  if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return { state: "submitted", txHash: ref.toLowerCase() };
  return { state: "unconfirmed" };
}

export interface ReceiptCoreV2 {
  schema: typeof RECEIPT_VERSION;
  chain: "eip155:196";
  executionId: string;
  planId: string;
  quote: QuoteSnapshot | { state: "legacy_unavailable"; planId: string };
  goalSha256: string;
  payerSha256?: string;
  buyerPayment: {
    amountBaseUnits: string;
    chain?: BuyerPaymentEvidence["chain"];
    source?: BuyerPaymentEvidence["source"];
    state: "none" | "confirmed" | "submitted" | "sponsored" | "unconfirmed";
    txHash?: string;
    tokenSha256?: string;
    recipientSha256?: string;
  };
  status: BindExecution["status"];
  executionErrorSha256?: string;
  steps: Array<{
    step: number;
    agentId?: string;
    agentName: string;
    serviceName?: string;
    status: ExecutionResult["status"];
    usedFallback: boolean;
    blockedBySha256?: string;
    errorSha256?: string;
    verificationType?: string;
    verificationCriteriaSha256?: string;
    feeBaseUnits?: string;
    inputSha256?: string;
    outputSha256?: string;
    verification: {
      passed?: boolean;
      detailSha256?: string;
    };
    settlement: ReturnType<typeof settlementFor>;
    paymentState?: ExecutionResult["paymentState"];
    attempts: Array<{
      agentId?: string;
      agentName: string;
      serviceName?: string;
      endpointSha256?: string;
      feeBaseUnits?: string;
      paid: boolean;
      paymentState?: AgentAttempt["paymentState"];
      status: AgentAttempt["status"];
      settlement: ReturnType<typeof settlementFor>;
      paymentRecipientSha256?: string;
      inputSha256?: string;
      outputSha256?: string;
      verificationDetailSha256?: string;
      errorSha256?: string;
    }>;
    startedAt?: string;
    completedAt?: string;
  }>;
  deliverableSha256?: string;
  totals: {
    agentFeesRecordedBaseUnits: string;
    unresolvedAuthorizationExposureBaseUnits: string;
    totalSteps: number;
    verifiedSteps: number;
  };
  refund: {
    amountDueBaseUnits: string;
    amountSubmittedBaseUnits: string;
    amountConfirmedBaseUnits: string;
    state: "none" | "not_due" | "below_threshold" | "submitted" | "confirmed" | "failed" | "confirmation_failed" | "unconfirmed" | "reconciliation_required";
    txHash?: string;
    reasonSha256?: string;
    recipientSha256?: string;
  };
  createdAt: string;
  completedAt?: string;
}

/** Build the exact canonical integrity object committed to the X Layer anchor. */
export function buildReceiptCore(exec: BindExecution): ReceiptCoreV2 {
  const refundHash = exec.refundTxHash;
  const refundSubmitted = typeof refundHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(refundHash);
  const legacySubmittedAmount = exec.refundedUsdt ?? 0;
  const recordedSubmittedAmount = exec.refundAmountSubmittedUsdt ?? legacySubmittedAmount;
  const refundSubmittedAmount = refundSubmitted ? recordedSubmittedAmount : 0;
  const refundConfirmedAmount = exec.refundState === "confirmed" && refundSubmitted
    ? (exec.refundAmountConfirmedUsdt ?? 0)
    : 0;
  const refundDue = exec.refundAmountDueUsdt ?? recordedSubmittedAmount;
  const inferredRefundState: ReceiptCoreV2["refund"]["state"] = refundDue === 0
    ? "none"
    : refundSubmitted
      ? "submitted"
      : "unconfirmed";
  const recordedRefundState: ReceiptCoreV2["refund"]["state"] | undefined = exec.refundState;
  const refundState: ReceiptCoreV2["refund"]["state"] = recordedRefundState === "confirmed" && (!refundSubmitted || refundConfirmedAmount <= 0)
    ? "unconfirmed"
    : recordedRefundState === "submitted" && !refundSubmitted
      ? "unconfirmed"
      : recordedRefundState ?? inferredRefundState;
  const buyerTxHash = exec.buyerPayment?.txHash;
  const validBuyerTx = typeof buyerTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(buyerTxHash);
  const buyerState = !exec.buyerPayment
    ? "none"
    : exec.buyerPayment.state === "submitted" && !validBuyerTx
      ? "unconfirmed"
      : buyerTxHash && !validBuyerTx
        ? "unconfirmed"
        : exec.buyerPayment.state;
  const storedBuyerBaseUnits = exec.buyerPayment?.amountBaseUnits;
  if (exec.buyerPayment && !/^(0|[1-9][0-9]*)$/.test(storedBuyerBaseUnits ?? "")) {
    throw new Error("buyer payment evidence has invalid base units");
  }

  return {
    schema: RECEIPT_VERSION,
    chain: "eip155:196",
    executionId: exec.executionId,
    planId: exec.planId,
    quote: exec.quoteSnapshot ?? { state: "legacy_unavailable", planId: exec.planId },
    goalSha256: commitment(exec.goal)!,
    payerSha256: exec.payer ? commitment(exec.payer.toLowerCase()) : undefined,
    buyerPayment: {
      amountBaseUnits: storedBuyerBaseUnits ?? "0",
      chain: exec.buyerPayment?.chain,
      source: exec.buyerPayment?.source,
      state: buyerState,
      txHash: validBuyerTx
        ? buyerTxHash!.toLowerCase()
        : undefined,
      tokenSha256: exec.buyerPayment ? commitment(exec.buyerPayment.token.toLowerCase()) : undefined,
      recipientSha256: exec.buyerPayment ? commitment(exec.buyerPayment.recipient.toLowerCase()) : undefined,
    },
    status: exec.status,
    executionErrorSha256: commitment(exec.error),
    steps: (exec.stepResults ?? []).map((step) => ({
      step: step.step,
      agentId: step.agentId,
      agentName: step.agentName,
      serviceName: step.serviceName,
      status: step.status,
      usedFallback: step.usedFallback === true,
      blockedBySha256: commitment(step.blockedBy),
      errorSha256: commitment(step.error),
      verificationType: step.verificationType,
      verificationCriteriaSha256: commitment(step.verificationCriteria),
      feeBaseUnits: step.feeUsdt == null ? undefined : usdtBaseUnits(step.feeUsdt),
      inputSha256: commitment(step.input),
      outputSha256: commitment(step.output),
      verification: {
        passed: step.verificationResult?.passed,
        detailSha256: commitment(step.verificationResult?.detail),
      },
      settlement: settlementFor(step),
      paymentState: step.paymentState,
      attempts: (step.attempts ?? []).map((attempt) => ({
        agentId: attempt.agentId,
        agentName: attempt.agentName,
        serviceName: attempt.serviceName,
        endpointSha256: commitment(attempt.endpoint),
        feeBaseUnits: attempt.feeUsdt == null ? undefined : usdtBaseUnits(attempt.feeUsdt),
        paid: attempt.paid,
        paymentState: attempt.paymentState,
        status: attempt.status,
        settlement: settlementFor(attempt),
        paymentRecipientSha256: commitment(attempt.paymentRecipient?.toLowerCase()),
        inputSha256: commitment(attempt.input),
        outputSha256: commitment(attempt.output),
        verificationDetailSha256: commitment(attempt.verificationDetail),
        errorSha256: commitment(attempt.error),
      })),
      startedAt: step.startedAt,
      completedAt: step.completedAt,
    })),
    deliverableSha256: commitment(exec.finalOutput),
    totals: {
      agentFeesRecordedBaseUnits: usdtBaseUnits(exec.totalPaid),
      unresolvedAuthorizationExposureBaseUnits: usdtBaseUnits(exec.unresolvedAuthorizationExposureUsdt),
      totalSteps: exec.totalSteps,
      verifiedSteps: exec.completedSteps,
    },
    refund: {
      amountDueBaseUnits: usdtBaseUnits(refundDue),
      amountSubmittedBaseUnits: usdtBaseUnits(refundSubmittedAmount),
      amountConfirmedBaseUnits: usdtBaseUnits(refundConfirmedAmount),
      state: refundState,
      txHash: refundSubmitted ? refundHash!.toLowerCase() : undefined,
      reasonSha256: commitment(exec.refundReason),
      recipientSha256: refundDue > 0 && exec.payer ? commitment(exec.payer.toLowerCase()) : undefined,
    },
    createdAt: exec.createdAt,
    completedAt: exec.completedAt,
  };
}

export interface ReceiptProofBundle {
  schema: "bind.receipt-proof.v1";
  receipt: ReceiptCoreV2;
  receiptSha256: string;
  storedReceiptSha256?: string;
  selfCheck: {
    storedHashMatches: boolean | null;
    note: string;
  };
  refundAttestations: Array<{
    attestation: import("./types.js").RefundAttestation;
    hashMatches: boolean;
    chainMatches: boolean;
  }>;
  verification: {
    hashAlgorithm: "sha256";
    canonicalization: string;
    commitmentFormat: string;
  };
  anchor: {
    chain: "eip155:196";
    txHash?: string;
    explorerUrl?: string;
    expectedCalldata?: string;
    binding: "local_hash_matches" | "legacy_unproven" | "not_anchored";
    onchainConfirmation: "not_checked";
  };
}

/** Public machine-verifiable bundle. Older v1 anchors are labelled as unproven. */
export function buildReceiptProof(exec: BindExecution): ReceiptProofBundle {
  const receipt = buildReceiptCore(exec);
  const receiptSha256 = hashCanonical(receipt);
  const hasStoredV2 = exec.receiptVersion === RECEIPT_VERSION && typeof exec.receiptSha256 === "string";
  const storedHashMatches = hasStoredV2 ? exec.receiptSha256 === receiptSha256 : null;
  const anchored = typeof exec.anchorTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(exec.anchorTxHash);
  const bound = hasStoredV2 && storedHashMatches === true;
  let previousAttestationSha256: string | undefined;
  const refundAttestations = (exec.refundAttestations ?? []).map((attestation) => {
    const { sha256, ...core } = attestation;
    const chainMatches = attestation.priorReceiptSha256 === exec.receiptSha256
      && attestation.previousAttestationSha256 === previousAttestationSha256;
    previousAttestationSha256 = attestation.sha256;
    return { attestation, hashMatches: hashCanonical(core) === sha256, chainMatches };
  });

  return {
    schema: "bind.receipt-proof.v1",
    receipt,
    receiptSha256,
    storedReceiptSha256: hasStoredV2 ? exec.receiptSha256 : undefined,
    selfCheck: {
      storedHashMatches,
      note: hasStoredV2
        ? storedHashMatches
          ? "The stored receipt hash matches the canonical receipt shown here."
          : "The stored receipt hash does not match the canonical receipt. Treat this proof as invalid."
        : "This execution predates v2 receipts, so its legacy anchor cannot be bound to this v2 receipt.",
    },
    refundAttestations,
    verification: {
      hashAlgorithm: "sha256",
      canonicalization: "UTF-8 JSON using ECMAScript JSON.stringify after recursively sorting object keys; undefined object fields omitted; undefined array values encoded as null; USDT values encoded as base-unit decimal strings.",
      commitmentFormat: "Integrity commitment sha256:<64 lowercase hexadecimal characters>. A commitment does not hide a guessable payload.",
    },
    anchor: {
      chain: "eip155:196",
      txHash: anchored ? exec.anchorTxHash!.toLowerCase() : undefined,
      explorerUrl: anchored ? `${EXPLORER}${exec.anchorTxHash}` : undefined,
      expectedCalldata: bound ? `0x${receiptSha256}` : undefined,
      binding: bound ? "local_hash_matches" : anchored ? "legacy_unproven" : "not_anchored",
      onchainConfirmation: "not_checked",
    },
  };
}

export interface AnchorReceipt {
  txHash: string;
  receiptSha256: string;
  receiptVersion: typeof RECEIPT_VERSION;
}

export async function anchorExecution(exec: BindExecution): Promise<AnchorReceipt | null> {
  try {
    const receipt = buildReceiptCore(exec);
    const receiptSha256 = hashCanonical(receipt);
    const anchor = await anchorHash(receiptSha256, config.payToAddress);

    return {
      txHash: anchor.txHash,
      receiptSha256,
      receiptVersion: RECEIPT_VERSION,
    };
  } catch (error) {
    console.warn("[bind] receipt anchor failed (non-fatal):", (error as Error).message);
    return null;
  }
}
