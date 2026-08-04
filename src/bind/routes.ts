// Bind — Express routes: /bind/plan, /bind/execute, /bind/status, /bind/search
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { BindExecution, BuyerPaymentEvidence, PlanRequest } from "./types.js";
import { createPlan } from "./planner.js";
import { executePlan, InsufficientBalanceError } from "./executor.js";
import { savePlan, loadPlan, saveExecution, loadExecution } from "./store.js";
import { findMatchingAgents } from "./marketplace.js";
import { commitPayment, releasePayment, startPaymentExecution } from "./pay-verify.js";
import { assertOfferedQuoteUnchanged, attachOfferedQuote, buildReceiptProof } from "./receipt.js";
import { showcaseExecution } from "./showcase.js";
import { settleAuthorization } from "./x402-settle.js";
import { refundExactBaseUnits, refundUnspent, reconcileRefundEvidence, finalizeRefundAttestationClaim, type RefundResult } from "./refund.js";
import { allReputation, ledgerDetail } from "./reputation.js";
import { serviceReliability } from "./service-reliability.js";
import { aggregateAgentPerformance, readDurableAgentOperationEvents, summarizeAgentPerformance } from "./agent-performance.js";
import { requireX402 } from "./x402-gate.js";
import { paymentIntentNonce } from "./payment-intent.js";
import { config } from "../config.js";

// When set, /bind/execute runs without an on-chain payment (used for internal testing and
// sponsored demos). Default OFF: real users must pay the quote to Bind's wallet first,
// which the server verifies. This is what makes Bind a real economic loop and stops the
// agentic wallet from being drained by anonymous free calls.
const ALLOW_FREE = process.env.BIND_ALLOW_FREE === "1";
// A quote is only executable for a short window — after that, marketplace prices and agent
// availability may have moved, so the buyer must re-plan (audit H6).
const QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

type X402Settlement = {
  settled: boolean;
  txHash?: string;
  payer?: string;
  paidUsdt: number;
  amountBaseUnits: string;
  chain: "eip155:196";
  token: string;
  recipient: string;
  source: "eip3009";
};

function buyerEvidenceFromX402(payment: X402Settlement): BuyerPaymentEvidence {
  return {
    amountUsdt: payment.paidUsdt,
    amountBaseUnits: payment.amountBaseUnits,
    chain: payment.chain,
    token: payment.token,
    recipient: payment.recipient,
    source: payment.source,
    state: payment.txHash && /^0x[0-9a-fA-F]{64}$/.test(payment.txHash) ? "confirmed" : "unconfirmed",
    txHash: payment.txHash,
  };
}

function collectInputs(body: any): Record<string, unknown> | undefined {
  const inputs: Record<string, unknown> = body?.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
    ? { ...body.inputs }
    : {};
  for (const key of ["targetRole", "jobDescription", "resume", "name"]) {
    if (typeof body?.[key] === "string" && body[key].trim()) inputs[key] = body[key];
  }
  if (typeof body?.resumeFileBase64 === "string" && body.resumeFileBase64.trim()) {
    inputs.resumeFile = {
      kind: typeof body.resumeFileKind === "string" ? body.resumeFileKind : "pdf",
      base64: body.resumeFileBase64,
      mediaType: typeof body.resumeFileMediaType === "string" ? body.resumeFileMediaType : "application/pdf",
    };
  }
  return Object.keys(inputs).length > 0 ? inputs : undefined;
}

export const bindRouter = Router();

function setPrivateCapabilityHeaders(res: Response): void {
  res.set("Cache-Control", "private, no-store").set("Referrer-Policy", "no-referrer");
}

// In-memory cache in front of the file store. Fast path; disk is the durable fallback.
const plans = new Map<string, Awaited<ReturnType<typeof createPlan>>>();
const executions = new Map<string, Awaited<ReturnType<typeof executePlan>>>();

bindRouter.get("/health", (_req, res) => {
  res.json({
    service: "Bind",
    version: "0.1.0",
    description: "The orchestrator for the agent economy",
    status: "live",
  });
});

// Public payment config the browser needs to build the buyer's on-chain payment.
bindRouter.get("/config", (_req, res) => {
  res.json({
    payTo: config.payToAddress,
    usdtAsset: config.usdtAsset,
    usdtDecimals: config.usdtDecimals,
    // EIP-712 domain of the payment token, for the gasless signature flow. Must match the
    // token contract exactly (proven by a successful on-chain settlement, 2026-07-16).
    usdtName: "USD₮0",
    usdtVersion: "1",
    chainId: 196,
    chainIdHex: "0xc4",
    requiresPayment: !ALLOW_FREE,
    paymentConfigured: config.payToAddress !== "" && config.usdtAsset !== "",
  });
});

const planHandler = async (req: Parameters<typeof bindRouter.post>[1] extends any ? any : never, res: any) => {
  setPrivateCapabilityHeaders(res);
  const x402 = res.locals?.x402 as X402Settlement | undefined;
  const paidTx = x402?.settled ? x402.txHash : undefined;
  try {
    const body = req.body as PlanRequest | undefined;
    if (!body?.goal || typeof body.goal !== "string" || body.goal.trim().length === 0) {
      if (x402?.settled) throw new Error("paid planning request did not contain a goal");
      res.status(400).json({ error: "bad_request", message: "Provide a non-empty 'goal' string." });
      return;
    }

    const plan = await createPlan({
      goal: body.goal.trim(),
      tokenAddress: body.tokenAddress,
      template: body.template,
      inputs: collectInputs(body),
    });

    attachOfferedQuote(plan, QUOTE_TTL_MS);
    savePlan(plan);
    plans.set(plan.planId, plan);
    if (paidTx) commitPayment(paidTx);

    res.json({
      plan,
      summary: {
        agents: plan.steps.length,
        totalPriceUsdt: plan.totalPriceUsdt,
        estimatedTime: plan.estimatedTime,
      },
    });
  } catch (e) {
    if (x402?.settled) {
      const refund: RefundResult = x402.payer
        ? await refundExactBaseUnits(x402.amountBaseUnits, x402.payer, paidTx)
        : failedRefundEvidence(x402.amountBaseUnits, "settled payment did not include a payer address");
      const executionId = persistFailedExecution({
        goal: typeof req.body?.goal === "string" ? req.body.goal : undefined,
        payer: x402.payer,
        buyerPayment: buyerEvidenceFromX402(x402),
        error: (e as Error).message,
        refund,
      });
      if (paidTx) commitPayment(paidTx);
      res.status(422).json({
        error: "plan_failed",
        message: (e as Error).message,
        executionId,
        refund: { amountDueUsdt: refund.amountDue, amountSubmittedUsdt: refund.amountSubmitted, state: refund.state, txHash: refund.txHash, reason: refund.reason },
      });
      return;
    }
    res.status(422).json({ error: "plan_failed", message: (e as Error).message });
  }
};

// /bind/plan is the REGISTERED x402 ASP endpoint: an unpaid call gets a 402 challenge, a
// paid call gets the plan. /bind/quote is the same logic, free, for the human website.
const PLAN_DESC = "Bind: plan a multi-agent workflow for a goal";
bindRouter.post("/plan", requireX402(config.prices.bind_plan, PLAN_DESC), planHandler);
// Validators (x402-validate) probe with GET and expect the 402 challenge there too.
bindRouter.get("/plan", requireX402(config.prices.bind_plan, PLAN_DESC), (_req, res) => res.status(405).json({ error: "method_not_allowed", message: "POST a goal to run this service." }));
bindRouter.post("/quote", planHandler);

// Shrink a plan to fit what an x402 buyer actually paid: drop steps (cheapest-first
// victims are the tail — the router ranks best-first) until agentCost + fee fits, and set
// agentCost so the refund math returns every unspent cent of the payment to the buyer.
function trimPlanToBudget(plan: NonNullable<ReturnType<typeof loadPlan>>, paidUsdt: number): void {
  const fee = () => Math.round((plan.steps.reduce((s, x) => s + x.agent.feeAmount, 0) * 0.02 + 0.03) * 1e6) / 1e6;
  while (plan.steps.length && plan.steps.reduce((s, x) => s + x.agent.feeAmount, 0) + fee() > paidUsdt) {
    plan.steps.pop();
  }
  plan.steps.forEach((s, i) => { s.step = i + 1; });
  plan.platformFee = fee();
  // The whole payment minus the earned fee is the buyer's agent budget: anything the
  // mission does not spend on verified work flows back to them via refundUnspent.
  plan.agentCost = Math.max(Math.round((paidUsdt - plan.platformFee) * 1e6) / 1e6, 0);
  plan.totalPriceUsdt = paidUsdt;
  plan.priceBreakdown = plan.steps.map((s) => ({ agentName: s.agent.name, fee: s.agent.feeAmount }));
}

function baseUnitsToUsdtText(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function failedRefundEvidence(amountBaseUnits: string, reason: string): RefundResult {
  const canonical = /^(0|[1-9][0-9]*)$/.test(amountBaseUnits) ? amountBaseUnits : "0";
  return {
    amountDue: Number(BigInt(canonical)) / 1e6,
    amountSubmitted: 0,
    amountConfirmed: 0,
    amountDueBaseUnits: canonical,
    amountSubmittedBaseUnits: "0",
    amountConfirmedBaseUnits: "0",
    refunded: 0,
    state: "failed",
    reason,
  };
}

function applyRefundEvidence(execution: BindExecution, refund: RefundResult): void {
  execution.refundAmountDueBaseUnits = refund.amountDueBaseUnits;
  execution.refundAmountSubmittedBaseUnits = refund.amountSubmittedBaseUnits;
  execution.refundAmountConfirmedBaseUnits = refund.amountConfirmedBaseUnits;
  execution.refundToken = execution.buyerPayment?.token;
  execution.refundSender = execution.buyerPayment?.recipient;
  execution.refundAmountDueUsdt = refund.amountDue;
  execution.refundAmountSubmittedUsdt = refund.amountSubmitted;
  execution.refundAmountConfirmedUsdt = refund.amountConfirmed;
  execution.refundState = refund.state;
  execution.refundTxHash = refund.txHash;
  execution.refundReason = refund.reason;
}

function persistFailedExecution(args: {
  executionId?: string;
  planId?: string;
  goal?: string;
  payer?: string;
  buyerPayment?: BuyerPaymentEvidence;
  totalSteps?: number;
  error: string;
  refund?: RefundResult;
}): string {
  const executionId = args.executionId ?? randomUUID();
  const failed = {
    executionId,
    planId: args.planId ?? "unplanned",
    goal: args.goal ?? "",
    payer: args.payer,
    buyerPayment: args.buyerPayment,
    status: "failed" as const,
    stepResults: [],
    totalPaid: 0,
    totalSteps: args.totalSteps ?? 0,
    completedSteps: 0,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: args.error,
  } as BindExecution & { error: string };
  if (args.refund) applyRefundEvidence(failed, args.refund);
  saveExecution(failed);
  executions.set(executionId, failed);
  return executionId;
}

const executeHandler = async (req: any, res: any) => {
  setPrivateCapabilityHeaders(res);
  // Durable transaction claim for either a direct transfer or an x402/EIP-3009 settlement.
  // Claims never become reusable after verification. Failed persistence moves them to reconciliation.
  let claimedTx: string | undefined;
  // Set when Bind itself settled the buyer's gasless authorization: those funds have
  // already moved, so if the mission then never runs, the agent budget goes straight back.
  let refundOnFail: { payer: string; amount: number } | null = null;
  let buyerPayment: BuyerPaymentEvidence | undefined;
  let activeStub: BindExecution | undefined;
  let failureContext: { planId: string; goal: string; totalSteps: number; payer?: string } | undefined;
  try {
    const body = req.body as { planId?: string; goal?: string; inputs?: Record<string, unknown> } | undefined;
    // Settlement handed over by the x402 gate: this buyer already paid on-chain.
    const x402 = res.locals?.x402 as X402Settlement | undefined;
    if (x402?.settled && x402.txHash) claimedTx = x402.txHash;
    const x402BuyerPayment: BuyerPaymentEvidence | undefined = x402?.settled
      ? buyerEvidenceFromX402(x402)
      : undefined;

    let plan = body?.planId ? (plans.get(body.planId) ?? loadPlan(body.planId)) : undefined;
    if (!plan && typeof body?.goal === "string" && body.goal.trim()) {
      // Single-call service: a marketplace buyer pays once and sends a goal — Bind plans
      // AND executes inside that one paid call, sized to what they paid.
      plan = await createPlan({ goal: body.goal.trim(), inputs: collectInputs(body) });
      if (x402?.settled) trimPlanToBudget(plan, x402.paidUsdt);
      if (plan.steps.length === 0) {
        // Nothing hireable for this goal (or budget). If the gate already moved funds,
        // wait for refund submission evidence before telling the buyer what happened.
        const refund: RefundResult | undefined = x402?.settled
          ? x402.payer
            ? await refundExactBaseUnits(x402.amountBaseUnits, x402.payer, claimedTx)
            : failedRefundEvidence(x402.amountBaseUnits, "settled payment did not include a payer address")
          : undefined;
        const refundMessage = refund
          ? refund.txHash
            ? ` Refund submitted on X Layer: ${refund.txHash}.`
            : ` Refund of $${refund.amountDue.toFixed(3)} remains unsubmitted: ${refund.reason ?? "no successful transaction hash returned"}.`
          : " You were not charged.";
        const executionId = refund ? persistFailedExecution({
          planId: plan.planId,
          goal: plan.goal,
          payer: x402?.payer,
          buyerPayment: x402BuyerPayment,
          totalSteps: 0,
          error: "no marketplace crew could deliver this goal within the paid budget",
          refund,
        }) : undefined;
        if (claimedTx) commitPayment(claimedTx);
        res.status(422).json({
          error: "no_crew",
          executionId,
          message: (plan.note ?? "No agent on the marketplace can genuinely deliver this goal.") + refundMessage,
          refund: refund ? {
            amountDueUsdt: refund.amountDue,
            amountSubmittedUsdt: refund.amountSubmitted,
            state: refund.state,
            txHash: refund.txHash,
            reason: refund.reason,
          } : undefined,
        });
        return;
      }
      attachOfferedQuote(plan, QUOTE_TTL_MS);
      savePlan(plan);
      plans.set(plan.planId, plan);
    }
    if (plan && body?.planId && x402?.settled) {
      // A saved plan already has immutable offered terms. A smaller fixed-route payment may
      // not rewrite those terms after custody moves. Fail closed and refund through the
      // ordinary paid-error path instead of trimming the plan.
      failureContext = { planId: plan.planId, goal: plan.goal, totalSteps: plan.steps.length, payer: x402.payer };
      buyerPayment = x402BuyerPayment;
      if (x402.payer) refundOnFail = { payer: x402.payer, amount: x402.paidUsdt };
      if (x402.paidUsdt + 0.0000001 < plan.totalPriceUsdt) {
        throw new Error("confirmed payment underfunds the immutable offered quote");
      }
    }
    if (!plan) {
      const refund: RefundResult | undefined = x402?.settled
        ? x402.payer
          ? await refundExactBaseUnits(x402.amountBaseUnits, x402.payer, claimedTx)
          : failedRefundEvidence(x402.amountBaseUnits, "settled payment did not include a payer address")
        : undefined;
      const paymentMessage = refund
        ? refund.txHash
          ? ` Refund submitted on X Layer: ${refund.txHash}.`
          : ` Refund of $${refund.amountDue.toFixed(3)} remains unsubmitted: ${refund.reason ?? "no successful transaction hash returned"}.`
        : "";
      const executionId = refund ? persistFailedExecution({
        planId: body?.planId,
        goal: body?.goal,
        payer: x402?.payer,
        buyerPayment: x402BuyerPayment,
        error: "paid request did not contain a usable goal or plan",
        refund,
      }) : undefined;
      if (claimedTx) commitPayment(claimedTx);
      res.status(400).json({
        error: "bad_request",
        executionId,
        message: "Provide a 'goal' to run a mission in one call, or a 'planId' from a previous /bind/plan call." + paymentMessage,
        refund: refund ? {
          amountDueUsdt: refund.amountDue,
          amountSubmittedUsdt: refund.amountSubmitted,
          state: refund.state,
          txHash: refund.txHash,
          reason: refund.reason,
        } : undefined,
      });
      return;
    }

    assertOfferedQuoteUnchanged(plan);

    // Quote expiry (audit H6): a saved plan quotes marketplace prices/endpoints that go
    // stale. Reject execution of an old quote so a buyer can't pay against prices that no
    // longer hold — they must re-plan. (Single-call goal plans are made fresh above, so
    // this only rejects a genuinely stale planId.)
    const ageMs = Date.now() - new Date(plan.createdAt).getTime();
    failureContext = { planId: plan.planId, goal: plan.goal, totalSteps: plan.steps.length };
    if (Number.isFinite(ageMs) && ageMs > QUOTE_TTL_MS) {
      const refund: RefundResult | undefined = x402?.settled
        ? x402.payer
          ? await refundExactBaseUnits(x402.amountBaseUnits, x402.payer, claimedTx)
          : failedRefundEvidence(x402.amountBaseUnits, "settled payment did not include a payer address")
        : undefined;
      const paymentMessage = refund
        ? refund.txHash
          ? ` Refund submitted on X Layer: ${refund.txHash}.`
          : ` Refund of $${refund.amountDue.toFixed(3)} remains unsubmitted: ${refund.reason ?? "no successful transaction hash returned"}.`
        : " You were not charged.";
      const executionId = refund ? persistFailedExecution({
        planId: plan.planId,
        goal: plan.goal,
        payer: x402?.payer,
        buyerPayment: x402BuyerPayment,
        totalSteps: plan.steps.length,
        error: "paid quote expired before execution",
        refund,
      }) : undefined;
      if (claimedTx) commitPayment(claimedTx);
      res.status(409).json({
        error: "quote_expired",
        executionId,
        message: "This quote has expired. Request a fresh plan before paying because prices and available agents may have changed." + paymentMessage,
        refund: refund ? {
          amountDueUsdt: refund.amountDue,
          amountSubmittedUsdt: refund.amountSubmitted,
          state: refund.state,
          txHash: refund.txHash,
          reason: refund.reason,
        } : undefined,
      });
      return;
    }

    // Verify the user paid the quote on-chain before we spend anything. Free plans (total
    // 0) and the internal sponsored-demo flag skip this.
    let payer: string | undefined;
    if (!ALLOW_FREE && plan.totalPriceUsdt > 0 && x402?.settled) {
      // The x402 gate already settled this buyer's payment on-chain. That IS the payment —
      // never re-demand one. Wire the payer through so verification failures and unspent
      // budget refund to the right wallet.
      payer = x402.payer;
      if (failureContext) failureContext.payer = payer;
      buyerPayment = x402BuyerPayment;
      if (x402.payer) refundOnFail = { payer: x402.payer, amount: x402.paidUsdt };
    } else if (!ALLOW_FREE && plan.totalPriceUsdt > 0) {
      const pa = (body as { paymentAuth?: { authorization?: any; signature?: string } }).paymentAuth;

      if (pa?.authorization && typeof pa.signature === "string") {
        // Gasless buyer flow: the buyer signed an EIP-3009 transfer authorization; Bind
        // settles it on-chain and pays the gas. The token contract enforces signature,
        // amount, expiry, and one-time nonce — a bad or replayed authorization just fails.
        const auth = pa.authorization;
        const requestIntent = paymentIntentNonce(req.originalUrl, body ?? {});
        if (typeof auth.nonce !== "string" || auth.nonce.toLowerCase() !== requestIntent.toLowerCase()) {
          res.status(402).json({ error: "payment_invalid", message: "Authorization does not match this exact mission request." });
          return;
        }
        if ((auth.to || "").toLowerCase() !== config.payToAddress.toLowerCase()) {
          res.status(402).json({ error: "payment_invalid", message: "Authorization does not pay Bind." });
          return;
        }
        let value: bigint;
        try { value = BigInt(auth.value); } catch {
          res.status(402).json({ error: "payment_invalid", message: "Unreadable authorization amount." });
          return;
        }
        if (value < BigInt(Math.round(plan.totalPriceUsdt * 1e6))) {
          res.status(402).json({ error: "payment_invalid", message: `Underpaid: authorized $${Number(value) / 1e6} but the mission costs $${plan.totalPriceUsdt}.` });
          return;
        }
        const settleTx = await settleAuthorization(auth, pa.signature, "eip3009", req.originalUrl, requestIntent);
        if (!settleTx) {
          res.status(402).json({ error: "payment_invalid", message: "The signed authorization could not be settled on-chain (invalid, expired, or already used). You were not charged." });
          return;
        }
        payer = auth.from;
        if (failureContext) failureContext.payer = payer;
        claimedTx = settleTx;
        buyerPayment = {
          amountUsdt: Number(value) / 1e6,
          amountBaseUnits: value.toString(),
          chain: "eip155:196",
          token: config.usdtAsset.toLowerCase(),
          recipient: config.payToAddress.toLowerCase(),
          source: "eip3009",
          state: "confirmed",
          txHash: settleTx,
        };
        refundOnFail = { payer: auth.from, amount: Number(value) / 1e6 };
      } else {
        res.status(402).json({
          error: "payment_required",
          message: `Connect a compatible wallet and sign the exact $${plan.totalPriceUsdt.toFixed(3)} USDT mission authorization. No funds were moved.`,
          amountUsdt: plan.totalPriceUsdt,
        });
        return;
      }
    }

    // Persist the mission identity and approved economics before any downstream side effect.
    const executionId = randomUUID();
    const stub: BindExecution = {
      executionId,
      planId: plan.planId,
      goal: plan.goal,
      payer,
      buyerPayment,
      quoteSnapshot: plan.quoteSnapshot,
      status: "running",
      stepResults: [],
      totalPaid: 0,
      totalSteps: plan.steps.length,
      completedSteps: 0,
      createdAt: new Date().toISOString(),
    };
    activeStub = stub;
    saveExecution(stub);
    executions.set(executionId, stub);
    if (claimedTx) startPaymentExecution(claimedTx, executionId);

    // Async mode answers with the already-persisted id while the crew works. The registered
    // agent endpoint stays synchronous because agent buyers expect the paid deliverable.
    if ((body as { async?: boolean }).async === true) {
      const spentTx = claimedTx;
      void executePlan(plan, payer, executionId, buyerPayment)
        .then((execution) => {
          try {
            saveExecution(execution);
            executions.set(executionId, execution);
            if (spentTx) commitPayment(spentTx);
          } catch (persistError) {
            if (spentTx) releasePayment(spentTx);
            console.error("completed async mission requires reconciliation", persistError);
          }
        }, async (e) => {
          try {
            const failed = { ...stub, status: "failed" as const, completedAt: new Date().toISOString(), error: (e as Error).message } as BindExecution;
            if (refundOnFail) {
              const refund = await refundUnspent(refundOnFail.amount, 0, refundOnFail.payer, activeStub?.executionId ?? claimedTx);
              applyRefundEvidence(failed, refund);
            }
            saveExecution(failed);
            executions.set(executionId, failed);
            if (spentTx) commitPayment(spentTx);
          } catch (persistError) {
            if (spentTx) releasePayment(spentTx);
            console.error("paid async mission requires reconciliation", persistError);
          }
        });
      res.status(202).json({ executionId, status: "running", statusUrl: `/bind/status/${executionId}` });
      return;
    }

    const execution = await executePlan(plan, payer, executionId, buyerPayment);
    try {
      saveExecution(execution);
      executions.set(execution.executionId, execution);
      if (claimedTx) commitPayment(claimedTx);
    } catch (persistError) {
      if (claimedTx) releasePayment(claimedTx);
      console.error("completed mission requires reconciliation", persistError);
      res.status(500).json({
        error: "reconciliation_required",
        message: "The mission finished, but its final durable record could not be committed. Buyer funds and payment reuse are blocked for reconciliation.",
        executionId,
      });
      return;
    }

    res.set("Cache-Control", "private, no-store").set("Referrer-Policy", "no-referrer").json(showcaseExecution(execution));
  } catch (e) {
    const failedRefund = refundOnFail
      ? await refundUnspent(refundOnFail.amount, 0, refundOnFail.payer, activeStub?.executionId ?? claimedTx)
      : undefined;
    let executionId: string | undefined;
    try {
      if (activeStub) {
        const failed: BindExecution = {
          ...activeStub,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: (e as Error).message,
        };
        if (failedRefund) applyRefundEvidence(failed, failedRefund);
        saveExecution(failed);
        executions.set(failed.executionId, failed);
        executionId = failed.executionId;
      } else if (failedRefund && failureContext) {
        executionId = persistFailedExecution({
          ...failureContext,
          buyerPayment,
          error: (e as Error).message,
          refund: failedRefund,
        });
      }
      if (claimedTx) commitPayment(claimedTx);
    } catch (persistError) {
      if (claimedTx) releasePayment(claimedTx);
      console.error("paid mission failure requires reconciliation", persistError);
      res.status(500).json({
        error: "reconciliation_required",
        message: "Payment evidence was reserved, but the final mission liability record could not be persisted. Bind has blocked payment reuse for manual reconciliation.",
        executionId: activeStub?.executionId,
      });
      return;
    }
    const refundResponse = failedRefund ? {
      amountDueUsdt: failedRefund.amountDue,
      amountSubmittedUsdt: failedRefund.amountSubmitted,
      amountConfirmedUsdt: failedRefund.amountConfirmed,
      state: failedRefund.state,
      txHash: failedRefund.txHash,
      reason: failedRefund.reason,
      executionId,
    } : undefined;
    // The wallet can't cover the plan — decline before downstream agent payment.
    if (e instanceof InsufficientBalanceError) {
      res.status(402).json({
        error: "insufficient_balance",
        message: `Bind can prove ${baseUnitsToUsdtText(e.haveBaseUnits)} USDT is available, but ${baseUnitsToUsdtText(e.needBaseUnits)} USDT is required after reserving unresolved liabilities. Fund the wallet on X Layer or reconcile liabilities, then try again.`,
        haveBaseUnits: e.haveBaseUnits.toString(),
        needBaseUnits: e.needBaseUnits.toString(),
        reservedBaseUnits: e.reservedBaseUnits.toString(),
        refund: refundResponse,
      });
      return;
    }
    res.status(422).json({ error: "execution_failed", message: (e as Error).message, refund: refundResponse });
  }
};

// /bind/execute is the REGISTERED x402 ASP endpoint (unpaid → 402, paid → runs the
// mission). /bind/mission is the human website's path: it verifies a wallet payment tx.
const EXEC_DESC = "Bind: execute a planned multi-agent mission";
bindRouter.post("/execute", requireX402(config.prices.bind_execute, EXEC_DESC, "minimum"), executeHandler);
bindRouter.get("/execute", requireX402(config.prices.bind_execute, EXEC_DESC, "minimum"), (_req, res) => res.status(405).json({ error: "method_not_allowed", message: "POST a planId to run this service." }));
bindRouter.post("/mission", executeHandler);

async function loadCapabilityExecution(executionId: string): Promise<BindExecution | null> {
  const stored = executions.get(executionId) ?? loadExecution(executionId);
  if (!stored) return null;
  const candidate = structuredClone(stored) as BindExecution;
  if (await reconcileRefundEvidence(candidate)) {
    saveExecution(candidate);
    executions.set(executionId, candidate);
  }
  finalizeRefundAttestationClaim(candidate);
  return candidate;
}

bindRouter.get("/status/:executionId", async (req, res) => {
  setPrivateCapabilityHeaders(res);
  const execution = await loadCapabilityExecution(req.params.executionId);
  if (!execution) {
    res.status(404).json({ error: "not_found", message: `No execution found for id '${req.params.executionId}'.` });
    return;
  }
  res.set("Cache-Control", "private, no-store").set("Referrer-Policy", "no-referrer").json(showcaseExecution(execution));
});

// Canonical receipt proof. Raw goals, inputs and outputs stay out of this bundle. Its
// integrity commitments let a holder test a disclosed artifact, but do not encrypt or hide
// guessable values. The execution id acts as the same capability as /status/:executionId.
bindRouter.get("/receipt/:executionId", async (req, res) => {
  setPrivateCapabilityHeaders(res);
  const execution = await loadCapabilityExecution(req.params.executionId);
  if (!execution) {
    res.status(404).json({ error: "not_found", message: `No execution found for id '${req.params.executionId}'.` });
    return;
  }
  res.set("Cache-Control", "private, no-store").set("Referrer-Policy", "no-referrer").json(buildReceiptProof(execution));
});

// Agent reputation recorded from Bind missions. Public so attempts, verification rates and
// settlement references can be audited without exposing customer goals.
bindRouter.get("/agents", (_req, res) => {
  const reps = allReputation();
  res.json({
    note: "Track record from recorded Bind call attempts. passRate = verified outputs / recorded calls. Fee totals include only attempts with a seller-supplied transaction reference and are not independent chain confirmation.",
    agents: reps.length,
    missions: reps.reduce((n, r) => n + r.missions, 0),
    leaderboard: reps.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      missions: r.missions,
      verified: r.passed,
      failed: r.failed,
      passRate: Math.round(r.passRate * 100) / 100,
      feesWithSettlementReferenceUsdt: Math.round(r.feesWithSettlementReferenceUsdt * 1e6) / 1e6,
      trackRecordUrl: `${config.publicBaseUrl}/a/${r.agentId}`,
    })),
  });
});

// Evidence-backed operational reporting. This endpoint never influences planner routing.
bindRouter.get("/performance", (_req, res) => {
  const events = readDurableAgentOperationEvents();
  const agents = aggregateAgentPerformance(events);
  res.json({
    schema: "bind.agent-performance.v1",
    note: "Counts are derived from canonical terminal attempts only after strict validation and local receipt-hash binding to a bind.execution-receipt.v2 receipt. On-chain confirmation is not checked by this endpoint. Legacy and unbound records are excluded. Timeouts do not prove an agent offline. Name-only observations are kept distinct and not merged because seller identity is unauthenticated.",
    metrics: summarizeAgentPerformance(events),
    agents: agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.agentName,
      identityBasis: agent.identityBasis,
      testedOperations: agent.testedOperations,
      availability: {
        latest: agent.latestAvailability,
        onlineObservations: agent.onlineObservations,
        offlineObservations: agent.offlineObservations,
        unknownObservations: agent.availabilityUnknown,
      },
      outcomes: {
        completed: agent.verifiedCompleted,
        failedVerification: agent.verificationFailed,
        timedOut: agent.timedOut,
        noResult: agent.noResult,
      },
      rating: {
        verifiedOperations: agent.verifiedOperations,
        verifiedPassRate: agent.verifiedPassRate,
      },
    })),
  });
});

// Service-level aggregate reliability Bind uses to route and avoid repeating paid failures.
// The public response omits exact endpoints and failure details.
bindRouter.get("/reliability", (_req, res) => {
  const rows = [...serviceReliability().values()]
    .sort((a, b) => b.attempts - a.attempts || a.passRate - b.passRate)
    .slice(0, 200);
  res.json({
    note: "Service-level aggregate reliability learned from recorded Bind call attempts. Exact endpoints and failure details stay private.",
    services: rows.length,
    rows: rows.map((r) => {
      const [agentId, serviceName] = r.key.split("|");
      return {
        agentId: agentId || undefined,
        serviceName: serviceName || undefined,
        attempts: r.attempts,
        passed: r.passed,
        failed: r.failed,
        paymentAttemptFailures: r.paidFailed,
        passRate: Math.round(r.passRate * 100) / 100,
      };
    }),
  });
});

// Wallet history is intentionally not enumerable by address. A wallet address does not
// authorize disclosure of its off-chain Bind usage. Mission-specific capability URLs are
// the access boundary for status, receipts, and refund evidence.
bindRouter.get("/history/:address", (_req, res) => {
  setPrivateCapabilityHeaders(res);
  res.status(404).json({ error: "not_found", message: "Wallet history is private. Use a mission-specific capability URL." });
});

// The reputation ledger sold as data: the free /agents endpoint is the summary; this returns
// hire-by-hire opaque IDs, verification outcomes, recorded fees and seller-supplied
// settlement transaction references when available.
const REP_DESC = "Bind: full agent reputation ledger with hire-by-hire evidence";
const repHandler = (_req: any, res: any) => {
  const payload = {
    note: "Bind execution evidence: opaque attempt IDs, recorded fee amounts, outcomes, and seller-supplied settlement references when available. References are not independent chain confirmation.",
    ...ledgerDetail(),
  };
  const txHash = res.locals?.x402?.txHash;
  if (typeof txHash === "string") commitPayment(txHash);
  res.json(payload);
};
bindRouter.get("/reputation", requireX402(config.prices.bind_reputation, REP_DESC), repHandler);
bindRouter.post("/reputation", requireX402(config.prices.bind_reputation, REP_DESC), repHandler);

// Search the marketplace live
bindRouter.get("/search", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "A2MCP";
    const agents = await findMatchingAgents(query);
    res.json({
      count: agents.length,
      agents: agents.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        category: a.category,
        priceMin: a.priceMin,
        rating: a.rating,
        soldCount: a.soldCount,
        services: a.services.length,
      })),
    });
  } catch (e) {
    res.status(422).json({ error: "search_failed", message: (e as Error).message });
  }
});


