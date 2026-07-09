// Bind — Express routes: /bind/plan, /bind/execute, /bind/status
import { Router } from "express";
import type { PlanRequest } from "./types.js";
import { createPlan } from "./planner.js";
import { executePlan } from "./executor.js";

export const bindRouter = Router();

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

bindRouter.post("/plan", async (req, res) => {
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
});

bindRouter.post("/execute", async (req, res) => {
  try {
    const body = req.body as { planId?: string } | undefined;
    if (!body?.planId) {
      res.status(400).json({ error: "bad_request", message: "Provide a 'planId' from a previous /bind/plan call." });
      return;
    }

    const plan = plans.get(body.planId);
    if (!plan) {
      res.status(404).json({ error: "not_found", message: `No plan found for id '${body.planId}'.` });
      return;
    }

    const execution = await executePlan(plan);
    executions.set(execution.executionId, execution);

    res.json(execution);
  } catch (e) {
    res.status(422).json({ error: "execution_failed", message: (e as Error).message });
  }
});

bindRouter.get("/status/:executionId", (req, res) => {
  const execution = executions.get(req.params.executionId);
  if (!execution) {
    res.status(404).json({ error: "not_found", message: `No execution found for id '${req.params.executionId}'.` });
    return;
  }
  res.json(execution);
});

// Search the marketplace live
bindRouter.get("/search", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "A2MCP";
    const { findMatchingAgents } = await import("./marketplace.js");
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