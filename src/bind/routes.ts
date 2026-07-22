// Bind — Express routes: /bind/plan, /bind/execute, /bind/status, /bind/search
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { PlanRequest } from "./types.js";
import { createPlan } from "./planner.js";
import { executePlan, InsufficientBalanceError } from "./executor.js";
import { savePlan, loadPlan, saveExecution, loadExecution } from "./store.js";
import { findMatchingAgents } from "./marketplace.js";
import { verifyPayment, commitPayment, releasePayment } from "./pay-verify.js";
import { settleAuthorization } from "./x402-settle.js";
import { refundUnspent } from "./refund.js";
import { allReputation, ledgerDetail, historyFor } from "./reputation.js";
import { requireX402 } from "./x402-gate.js";
import { config } from "../config.js";

// When set, /bind/execute runs without an on-chain payment (used for internal testing and
// sponsored demos). Default OFF: real users must pay the quote to Bind's wallet first,
// which the server verifies. This is what makes Bind a real economic loop and stops the
// agentic wallet from being drained by anonymous free calls.
const ALLOW_FREE = process.env.BIND_ALLOW_FREE === "1";
// A quote is only executable for a short window — after that, marketplace prices and agent
// availability may have moved, so the buyer must re-plan (audit H6).
const QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export const bindRouter = Router();

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
  try {
    const body = req.body as PlanRequest | undefined;
    if (!body?.goal || typeof body.goal !== "string" || body.goal.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "Provide a non-empty 'goal' string." });
      return;
    }

    const plan = await createPlan({
      goal: body.goal.trim(),
      tokenAddress: body.tokenAddress,
      template: body.template,
    });

    plans.set(plan.planId, plan);
    savePlan(plan);

    res.json({
      plan,
      summary: {
        agents: plan.steps.length,
        totalPriceUsdt: plan.totalPriceUsdt,
        estimatedTime: plan.estimatedTime,
      },
    });
  } catch (e) {
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

const executeHandler = async (req: any, res: any) => {
  // The verified payment tx, claimed but not burned. Burned only after the mission runs;
  // released if execution never starts, so the buyer can retry with the same payment.
  let claimedTx: string | undefined;
  // Set when Bind itself settled the buyer's gasless authorization: that money has
  // already moved, so if the mission then never runs, the agent budget goes straight back.
  let refundOnFail: { payer: string; amount: number } | null = null;
  try {
    const body = req.body as { planId?: string; goal?: string } | undefined;
    // Settlement handed over by the x402 gate: this buyer already paid on-chain.
    const x402 = res.locals?.x402 as { settled: boolean; txHash?: string; payer?: string; paidUsdt: number } | undefined;

    let plan = body?.planId ? (plans.get(body.planId) ?? loadPlan(body.planId)) : undefined;
    if (!plan && typeof body?.goal === "string" && body.goal.trim()) {
      // Single-call service: a marketplace buyer pays once and sends a goal — Bind plans
      // AND executes inside that one paid call, sized to what they paid.
      plan = await createPlan({ goal: body.goal.trim() });
      if (x402?.settled) trimPlanToBudget(plan, x402.paidUsdt);
      if (plan.steps.length === 0) {
        // Nothing hireable for this goal (or budget) — the buyer already paid, so give it back.
        if (x402?.settled && x402.payer) void refundUnspent(x402.paidUsdt, 0, x402.payer);
        res.status(422).json({ error: "no_crew", message: (plan.note ?? "No agent on the marketplace can genuinely deliver this goal.") + " Your payment has been refunded on-chain.", refunded: x402?.settled ? x402.paidUsdt : 0 });
        return;
      }
      plans.set(plan.planId, plan);
      savePlan(plan);
    }
    if (body?.planId && !plan) {
      res.status(404).json({ error: "not_found", message: `No plan found for id '${body.planId}'.` });
      return;
    }
    if (!plan) {
      res.status(400).json({ error: "bad_request", message: "Provide a 'goal' to run a mission in one call, or a 'planId' from a previous /bind/plan call." });
      return;
    }

    // Quote expiry (audit H6): a saved plan quotes marketplace prices/endpoints that go
    // stale. Reject execution of an old quote so a buyer can't pay against prices that no
    // longer hold — they must re-plan. (Single-call goal plans are made fresh above, so
    // this only rejects a genuinely stale planId.)
    const ageMs = Date.now() - new Date(plan.createdAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > QUOTE_TTL_MS) {
      res.status(409).json({ error: "quote_expired", message: "This quote has expired. Request a fresh plan before paying — prices and available agents may have changed. You were not charged." });
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
      if (x402.payer) refundOnFail = { payer: x402.payer, amount: plan.agentCost ?? plan.totalPriceUsdt };
    } else if (!ALLOW_FREE && plan.totalPriceUsdt > 0) {
      const pa = (body as { paymentAuth?: { authorization?: any; signature?: string } }).paymentAuth;
      const paymentTxHash = (body as { paymentTxHash?: string }).paymentTxHash;

      if (pa?.authorization && typeof pa.signature === "string") {
        // Gasless buyer flow: the buyer signed an EIP-3009 transfer authorization; Bind
        // settles it on-chain and pays the gas. The token contract enforces signature,
        // amount, expiry, and one-time nonce — a bad or replayed authorization just fails.
        const auth = pa.authorization;
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
        const settleTx = await settleAuthorization(auth, pa.signature);
        if (!settleTx) {
          res.status(402).json({ error: "payment_invalid", message: "The signed authorization could not be settled on-chain (invalid, expired, or already used). You were not charged." });
          return;
        }
        payer = auth.from;
        claimedTx = settleTx;
        refundOnFail = { payer: auth.from, amount: plan.agentCost ?? plan.totalPriceUsdt };
      } else {
        if (!paymentTxHash) {
          res.status(402).json({
            error: "payment_required",
            message: `Connect your wallet and pay $${plan.totalPriceUsdt.toFixed(3)} USDT to Bind on X Layer to run this mission.`,
            payTo: "pay-to-bind",
            amountUsdt: plan.totalPriceUsdt,
          });
          return;
        }
        const verdict = await verifyPayment(paymentTxHash, plan.totalPriceUsdt);
        if (!verdict.ok) {
          res.status(402).json({ error: "payment_invalid", message: `Payment could not be verified: ${verdict.reason}` });
          return;
        }
        payer = verdict.payer; // so unspent agent budget can go back to whoever paid
        claimedTx = paymentTxHash;
      }
    }

    // Async mode (the website uses this): answer with a running stub immediately and let
    // the crew work in the background — long missions no longer die at proxy timeouts.
    // The registered agent endpoint stays synchronous: agent buyers expect the
    // deliverable in the response they paid for.
    if ((body as { async?: boolean }).async === true) {
      const executionId = randomUUID();
      const stub: Awaited<ReturnType<typeof executePlan>> = {
        executionId, planId: plan.planId, goal: plan.goal, status: "running",
        stepResults: [], totalPaid: 0, totalSteps: plan.steps.length, completedSteps: 0,
        createdAt: new Date().toISOString(),
      };
      executions.set(executionId, stub);
      saveExecution(stub);
      const spentTx = claimedTx;
      void executePlan(plan, payer, executionId)
        .then((execution) => {
          if (spentTx) commitPayment(spentTx);
          executions.set(executionId, execution);
          saveExecution(execution);
        })
        .catch((e) => {
          if (spentTx) releasePayment(spentTx);
          // A gasless payment was already settled; the mission never ran, so the buyer's
          // agent budget goes back (best-effort, on-chain).
          if (refundOnFail) void refundUnspent(refundOnFail.amount, 0, refundOnFail.payer);
          const failed = { ...stub, status: "failed" as const, finalOutput: undefined, completedAt: new Date().toISOString(), error: (e as Error).message } as any;
          executions.set(executionId, failed);
          saveExecution(failed);
        });
      res.status(202).json({ executionId, status: "running", statusUrl: `/bind/status/${executionId}` });
      return;
    }

    const execution = await executePlan(plan, payer);
    // The mission ran — only now is the payment spent (refund logic inside executePlan
    // already handled any under-delivery fairly).
    if (claimedTx) commitPayment(claimedTx);
    executions.set(execution.executionId, execution);
    saveExecution(execution);

    res.json(execution);
  } catch (e) {
    // Execution never happened — give the buyer their payment back to retry with.
    if (claimedTx) releasePayment(claimedTx);
    if (refundOnFail) void refundUnspent(refundOnFail.amount, 0, refundOnFail.payer);
    // The wallet can't cover the plan — decline BEFORE any payment, with a clear reason.
    if (e instanceof InsufficientBalanceError) {
      res.status(402).json({
        error: "insufficient_balance",
        message: `Your agentic wallet holds ${e.have} USDT but this plan costs ${e.need} USDT. Fund the wallet on X Layer and try again.`,
        have: e.have,
        need: e.need,
      });
      return;
    }
    res.status(422).json({ error: "execution_failed", message: (e as Error).message });
  }
};

// /bind/execute is the REGISTERED x402 ASP endpoint (unpaid → 402, paid → runs the
// mission). /bind/mission is the human website's path: it verifies a wallet payment tx.
const EXEC_DESC = "Bind: execute a planned multi-agent mission";
bindRouter.post("/execute", requireX402(config.prices.bind_execute, EXEC_DESC), executeHandler);
bindRouter.get("/execute", requireX402(config.prices.bind_execute, EXEC_DESC), (_req, res) => res.status(405).json({ error: "method_not_allowed", message: "POST a planId to run this service." }));
bindRouter.post("/mission", executeHandler);

bindRouter.get("/status/:executionId", (req, res) => {
  const execution = executions.get(req.params.executionId) ?? loadExecution(req.params.executionId);
  if (!execution) {
    res.status(404).json({ error: "not_found", message: `No execution found for id '${req.params.executionId}'.` });
    return;
  }
  res.json(execution);
});

// Agent reputation earned on real missions. This is Bind's own data: which marketplace
// agents actually take payment and deliver verified work. Public so it can be audited.
bindRouter.get("/agents", (_req, res) => {
  const reps = allReputation();
  res.json({
    note: "Track record earned on real Bind missions. passRate = verified outputs / times hired.",
    agents: reps.length,
    missions: reps.reduce((n, r) => n + r.missions, 0),
    leaderboard: reps.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      missions: r.missions,
      verified: r.passed,
      failed: r.failed,
      passRate: Math.round(r.passRate * 100) / 100,
      paidUsdt: Math.round(r.paidUsdt * 1e6) / 1e6,
      trackRecordUrl: `${config.publicBaseUrl}/a/${r.agentId}`,
    })),
  });
});

// Mission history for a buyer wallet: what they commissioned, what it cost, what came
// back. Wallet addresses are already public on-chain (every payment is a visible USDT
// transfer to Bind), so this exposes no more than the chain does — with better labels.
bindRouter.get("/history/:address", (req, res) => {
  const missions = historyFor(req.params.address);
  res.json({
    address: req.params.address,
    missions: missions.map((m) => ({ ...m, missionUrl: `${config.publicBaseUrl}/m/${m.executionId}` })),
    note: missions.length === 0 ? "No missions recorded for this wallet (history began 2026-07-16)." : undefined,
  });
});

// The reputation ledger sold as data (trust as a service): the free /agents endpoint is
// the summary; this returns the full hire-by-hire evidence — per-agent outcomes with
// settlement tx hashes — behind an x402 paywall. Only Bind has this data; it was earned
// by paying real money on real missions.
const REP_DESC = "Bind: full agent reputation ledger with hire-by-hire evidence";
const repHandler = (_req: any, res: any) => {
  res.json({
    note: "Evidence earned on real Bind missions: every hire, what it was paid, whether the output verified.",
    ...ledgerDetail(),
  });
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


