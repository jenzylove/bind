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
}

export interface BindStep {
  step: number;
  agent: BindAgent;
  agentServiceDescription?: string;
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
  /** True when the primary hire flaked and the stand-in delivered instead. */
  usedFallback?: boolean;
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "errored";
  input?: unknown;
  output?: unknown;
  verificationResult?: {
    passed: boolean;
    reportUrl?: string;
    detail?: string;
  };
  paymentTxHash?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BindExecution {
  executionId: string;
  planId: string;
  goal: string;
  /** The buyer's wallet (from the payment's Transfer log) — keys per-wallet mission history. */
  payer?: string;
  /** Agent budget quoted but never spent, returned to the buyer on-chain. */
  refundedUsdt?: number;
  refundTxHash?: string;
  status: "running" | "completed" | "failed" | "partial";
  stepResults: ExecutionResult[];
  finalOutput?: string;
  finalReportUrl?: string;
  anchorTxHash?: string;
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
}