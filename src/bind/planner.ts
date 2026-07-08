// Bind planner: goal decomposition into multi-agent plan with flat price
import { randomUUID } from "node:crypto";
import type { BindPlan, BindStep, PlanRequest, PlanTemplate } from "./types.js";
import { getCheapestByCategory, AGENT_CATALOG } from "./agents.js";

const TEMPLATES: Record<PlanTemplate, { goalPattern: RegExp; description: string }> = {
  due_diligence: {
    goalPattern: /(safe|risk|audit|scan|check|token|contract|honeypot|rug)/i,
    description: "Token due diligence, security scan, sentiment, market check",
  },
  market_brief: {
    goalPattern: /(market|brief|overview|trend|analysis|research)/i,
    description: "Market brief with data, sentiment, and analysis",
  },
  custom: {
    goalPattern: /.*/,
    description: "Custom goal analyzed against available agents",
  },
};

function detectTemplate(goal: string): PlanTemplate {
  for (const [template, config] of Object.entries(TEMPLATES)) {
    if (template === "custom") continue;
    if (config.goalPattern.test(goal)) {
      return template as PlanTemplate;
    }
  }
  return "custom";
}

function buildSteps(template: PlanTemplate, goal: string, params: PlanRequest): BindStep[] {
  switch (template) {

    case "due_diligence": {
      const security = getCheapestByCategory("security");
      const sentiment = getCheapestByCategory("sentiment");
      const market = getCheapestByCategory("market_data");
      const steps: BindStep[] = [];

      if (security) {
        steps.push({
          step: 1,
          agent: security,
          inputTemplate: { prompt: `Scan token ${params.tokenAddress || "this token"} for security risks` },
          verificationType: "data",
          verificationCriteria: "Security scan returned structured results with no critical errors",
        });
      }
      if (sentiment) {
        steps.push({
          step: 2,
          agent: sentiment,
          inputTemplate: { tokenAddress: params.tokenAddress || "" },
          verificationType: "data",
          verificationCriteria: "Sentiment analysis returned risk metrics",
          condition: "previous step passed",
        });
      }
      if (market) {
        steps.push({
          step: 3,
          agent: market,
          inputTemplate: { q: params.tokenAddress ? `token ${params.tokenAddress}` : goal },
          verificationType: "content",
          verificationCriteria: "Market data returned with price and volume information",
          condition: "previous step passed",
        });
      }
      return steps;
    }

    case "market_brief": {
      const market = getCheapestByCategory("market_data");
      const analysis = AGENT_CATALOG.find(a => a.category === "analysis" && a.name === "穿越牛熊简报");
      const steps: BindStep[] = [];
      if (market) {
        steps.push({
          step: 1,
          agent: market,
          inputTemplate: { q: goal },
          verificationType: "data",
          verificationCriteria: "Market data returned",
        });
      }
      if (analysis) {
        steps.push({
          step: 2,
          agent: analysis,
          inputTemplate: {},
          verificationType: "content",
          verificationCriteria: "Briefing content returned",
          condition: "always",
        });
      }
      return steps;
    }

    default: {
      const market = getCheapestByCategory("market_data");
      return market ? [
        {
          step: 1,
          agent: market,
          inputTemplate: { q: goal },
          verificationType: "content",
          verificationCriteria: "Response contains relevant information",
        },
      ] : [];
    }
  }
}

export function createPlan(req: PlanRequest): BindPlan {
  const template = req.template || detectTemplate(req.goal);
  const steps = buildSteps(template, req.goal, req);

  const priceBreakdown = steps.map(s => ({
    agentName: s.agent.name,
    fee: s.agent.feeAmount,
  }));
  const totalPriceUsdt = steps.reduce((sum, s) => sum + s.agent.feeAmount, 0);

  return {
    planId: randomUUID(),
    goal: req.goal,
    steps,
    totalPriceUsdt,
    priceBreakdown,
    estimatedTime: `~${steps.length * 15} seconds`,
    createdAt: new Date().toISOString(),
  };
}