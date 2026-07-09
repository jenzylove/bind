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
  inputTemplate: Record<string, string>;   // param template, filled at exec time
  verificationType: "data" | "content" | "code";
  verificationCriteria?: string;           // what to verify (optional, can be LLM-generated)
  fallbackAgent?: BindAgent;               // if this step fails verification
  condition?: string;                      // when to skip this step
}

export interface BindPlan {
  planId: string;
  goal: string;
  steps: BindStep[];
  totalPriceUsdt: number;
  priceBreakdown: { agentName: string; fee: number; }[];
  estimatedTime: string;
  createdAt: string;
  note?: string;
}

export interface ExecutionResult {
  step: number;
  agentName: string;
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