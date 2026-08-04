// Bind types — plan, execution, agent models
// Built on top of Vouch's existing report/verification types

export interface BindAgent {
  agentId: string;
  name: string;
  serviceId: string;
  serviceName: string;
  endpoint: string;
  feeAmount: number;         // USDT
  feeToken: string;
  category: "security" | "sentiment" | "market_data" | "content" | "analysis";
  /** The service description, so the executor can infer params for a fallback agent
   *  it has never called before (dynamic contractor: try any agent, not a fixed list). */
  serviceDescription?: string;
}

export interface BindStep {
  step: number;
  agent: BindAgent;
  agentServiceDescription?: string;
  // --- Dependency-graph fields (optional; absent = the classic independent step) ---
  /** Stable id for this node so downstream steps can reference its output. */
  nodeId?: string;
  /** Node ids whose VERIFIED output must exist before this step runs. A missing/failed
   *  dependency blocks this step instead of calling the agent with invented params. */
  dependsOn?: string[];
  /** Maps a request param -> a dotted path into an upstream node's output, e.g.
   *  { "tokenAddress": "resolve.data.0.tokenAddress" }. Resolved at execution time from
   *  the verified outputs of earlier nodes. This is what makes step 2 consume step 1. */
  inputMap?: Record<string, string>;
  inputTemplate: Record<string, string>;
  // Exact request body for a tested agent (from payable-agents.json). Values may contain
  // $TOKEN / $GOAL placeholders the executor substitutes at call time. When present, the
  // executor uses this verbatim instead of guessing params.
  boundParams?: Record<string, string>;
  /** Track record on past Bind missions, e.g. "94% verified over 17 missions". */
  track?: string;
  verificationType: "data" | "content" | "code";
  verificationCriteria?: string;
  fallbackAgent?: BindAgent;
  /** Service description for the stand-in, so param inference works for it too. */
  fallbackServiceDescription?: string;
  /** Ranked backup agents for this role — ANY eligible marketplace agent, not just the
   *  proven set. The executor tries them in order until one delivers verified output. */
  candidates?: BindAgent[];
  condition?: string;
}

export interface BindPlan {
  planId: string;
  goal: string;
  steps: BindStep[];
  totalPriceUsdt: number;
  agentCost?: number;
  platformFee?: number;
  priceBreakdown: { agentName: string; fee: number; }[];
  estimatedTime: string;
  createdAt: string;
  note?: string;
  inputs?: Record<string, unknown>;
  /** Canonical offered quote persisted at issuance. */
  quoteSnapshot?: QuoteSnapshot;
  /** True for the built-in dependency-graph flagship (step 2 consumes step 1's output). */
  flagship?: boolean;
}


export interface AgentAttempt {
  agentId?: string;
  agentName: string;
  serviceName?: string;
  endpoint?: string;
  feeUsdt?: number;
  feeBaseUnits?: string;
  paid: boolean;
  paymentState?: "not_authorized" | "authorized_ambiguous" | "settlement_confirmed" | "nonsettlement_confirmed";
  status: "passed" | "failed" | "errored";
  paymentTxHash?: string;
  paymentRecipient?: string;
  input?: unknown;
  output?: unknown;
  verificationDetail?: string;
  error?: string;
}

/**
 * One immutable observation of a marketplace agent call. The dimensions are deliberately
 * separate: a timeout is not a verification failure, a returned response is not proof of
 * settlement, and an internal routing exclusion is not a marketplace ban.
 */
export interface AgentOperationEvent {
  schema: "bind.agent-operation.v1";
  eventId: string;
  /** Private execution capability; aggregate/public projections must not expose it. */
  executionId: string;
  step: number;
  attempt: number;
  observedAt: string;
  agentId?: string;
  agentName: string;
  serviceName?: string;
  availability: "online" | "offline" | "unknown";
  acceptance: "accepted" | "not_accepted" | "unknown";
  /** Exactly one terminal operation outcome. */
  outcome: "verified_completed" | "verification_failed" | "timed_out" | "no_result";
  verification: "passed" | "failed" | "not_run";
  payment: "not_authorized" | "authorized_ambiguous" | "settlement_confirmed" | "nonsettlement_confirmed";
  evidenceSource: "bind_execution";
}

export interface ExecutionResult {
  step: number;
  agentName: string;
  /** What the buyer saw hired (the service), shown on all buyer-facing surfaces. The
   * vendor agentName above stays untouched — reputation history is keyed on it. */
  serviceName?: string;
  /** Kept so reputation can be aggregated per agent across missions, not by display name. */
  agentId?: string;
  /** What this agent was actually paid, when a real settlement happened. */
  feeUsdt?: number;
  feeBaseUnits?: string;
  /** True when the primary hire flaked and the stand-in delivered instead. */
  usedFallback?: boolean;
  /** Every primary/fallback attempt made for this step, so Bind can learn service reliability. */
  attempts?: AgentAttempt[];
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "errored" | "blocked";
  /** For a blocked step: which upstream dependency failed to deliver. */
  blockedBy?: string;
  input?: unknown;
  output?: unknown;
  /** Verification policy captured at execution time for receipt reproducibility. */
  verificationType?: BindStep["verificationType"];
  verificationCriteria?: string;
  verificationResult?: {
    passed: boolean;
    reportUrl?: string;
    detail?: string;
  };
  paymentTxHash?: string;
  paymentState?: "not_authorized" | "authorized_ambiguous" | "settlement_confirmed" | "nonsettlement_confirmed";
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BuyerPaymentEvidence {
  amountUsdt: number;
  amountBaseUnits: string;
  chain: "eip155:196";
  token: string;
  recipient: string;
  source: "direct_transfer" | "eip3009" | "sponsored";
  state: "confirmed" | "submitted" | "sponsored" | "unconfirmed";
  txHash?: string;
}

/** Immutable economics Bind offered before downstream side effects. */
export interface QuoteSnapshot {
  schema: "bind.quote.v2";
  planId: string;
  createdAt: string;
  expiresAt: string;
  buyerTotalBaseUnits: string;
  agentBudgetBaseUnits: string;
  platformFeeBaseUnits: string;
  buyerSettlement: {
    chain: "eip155:196";
    token: string;
    recipient: string;
  };
  steps: Array<{
    step: number;
    candidates: Array<{
      role: "primary" | "fallback";
      agentId: string;
      serviceId: string;
      serviceName: string;
      endpointSha256: string;
      feeToken: string;
      feeCapBaseUnits: string;
      chain: "eip155:196";
      recipient: string | null;
      authorization: "exact_reviewed_recipient_required";
    }>;
  }>;
}

export interface RefundAttestation {
  schema: "bind.refund-attestation.v1";
  version: number;
  executionId: string;
  priorReceiptSha256: string;
  previousAttestationSha256?: string;
  txHash: string;
  token: string;
  sender: string;
  recipient: string;
  amountBaseUnits: string;
  state: "confirmed" | "confirmation_failed";
  verifiedAt: string;
  sha256: string;
}

export interface BindExecution {
  executionId: string;
  planId: string;
  goal: string;
  /** The buyer's wallet (from the payment's Transfer log) — keys per-wallet mission history. */
  payer?: string;
  /** Incoming one-payment evidence, kept separate from downstream agent settlements. */
  buyerPayment?: BuyerPaymentEvidence;
  /** Canonical quote captured before execution and committed into the receipt. */
  quoteSnapshot?: QuoteSnapshot;
  /** Amount withheld from immediate refund while downstream authorization settlement is unresolved. */
  unresolvedAuthorizationExposureUsdt?: number;
  /** Full refund liability, independent of submission or confirmation. */
  refundAmountDueBaseUnits?: string;
  refundAmountSubmittedBaseUnits?: string;
  refundAmountConfirmedBaseUnits?: string;
  refundToken?: string;
  refundSender?: string;
  refundAmountDueUsdt?: number;
  refundAmountSubmittedUsdt?: number;
  refundAmountConfirmedUsdt?: number;
  /** @deprecated legacy alias for refundAmountSubmittedUsdt. */
  refundedUsdt?: number;
  refundTxHash?: string;
  refundState?: "none" | "not_due" | "below_threshold" | "submitted" | "confirmed" | "failed" | "confirmation_failed" | "unconfirmed" | "reconciliation_required";
  refundReason?: string;
  /** Versioned post-anchor refund confirmations, each chained to the original receipt. */
  refundAttestations?: RefundAttestation[];
  status: "running" | "completed" | "failed" | "partial";
  error?: string;
  stepResults: ExecutionResult[];
  /** Durable operation evidence derived from terminal attempts; absent on running stubs. */
  agentOperationEvents?: AgentOperationEvent[];
  finalOutput?: string;
  anchorTxHash?: string;
  /** Canonical receipt schema and hash committed by the anchor transaction calldata. */
  receiptVersion?: "bind.execution-receipt.v2";
  receiptSha256?: string;
  totalPaid: number;
  totalSteps: number;
  completedSteps: number;
  createdAt: string;
  completedAt?: string;
}

export type PlanTemplate = "due_diligence" | "market_brief" | "custom";

export interface PlanRequest {
  goal: string;
  tokenAddress?: string;
  template?: PlanTemplate;
  inputs?: Record<string, unknown>;
}