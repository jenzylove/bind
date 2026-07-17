// Bind — Express routes: /bind/plan, /bind/execute, /bind/status, /bind/search
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { PlanRequest } from "./types.js";
import { createPlan } from "./planner.js";
import { executePlan, InsufficientBalanceError } from "./executor.js";
import { savePlan, loadPlan, saveExecution, loadExecution } from "./store.js";
import { findMatchingAgents } from "./marketplace.js";
import { verifyPayment, commitPayment, releasePayment } from "./pay-verify.js";
import { allReputation, ledgerDetail, historyFor } from "./reputation.js";
import { requireX402 } from "./x402-gate.js";
import { config } from "../config.js";

// When set, /bind/execute runs without an on-chain payment (used for internal testing and
// sponsored demos). Default OFF: real users must pay the quote to Bind's wallet first,
// which the server verifies. This is what makes Bind a real economic loop and stops the
// agentic wallet from being drained by anonymous free calls.
const ALLOW_FREE = process.env.BIND_ALLOW_FREE === "1";

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

const executeHandler = async (req: any, res: any) => {
  // The verified payment tx, claimed but not burned. Burned only after the mission runs;
  // released if execution never starts, so the buyer can retry with the same payment.
  let claimedTx: string | undefined;
  try {
    const body = req.body as { planId?: string } | undefined;
    if (!body?.planId) {
      res.status(400).json({ error: "bad_request", message: "Provide a 'planId' from a previous /bind/plan call." });
      return;
    }

    const plan = plans.get(body.planId) ?? loadPlan(body.planId);
    if (!plan) {
      res.status(404).json({ error: "not_found", message: `No plan found for id '${body.planId}'.` });
      return;
    }

    // Verify the user paid the quote on-chain before we spend anything. Free plans (total
    // 0) and the internal sponsored-demo flag skip this.
    let payer: string | undefined;
    if (!ALLOW_FREE && plan.totalPriceUsdt > 0) {
      const paymentTxHash = (body as { paymentTxHash?: string }).paymentTxHash;
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


