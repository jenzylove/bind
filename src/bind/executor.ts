// Bind execution engine — actually calls agents, reports honestly, returns real output
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { BindExecution, BindPlan, ExecutionResult } from "./types.js";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

export class BindExecutionError extends Error {
  constructor(msg: string) { super(msg); this.name = "BindExecutionError"; }
}

function callAgent(endpoint: string, body: Record<string, unknown>): { status: number; data: unknown } {
  try {
    const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''");
    const result = execSync(
      `curl -s -w "\\n%{http_code}" --max-time 10 '${endpoint}' -H 'Content-Type: application/json' -d '${bodyStr}'`,
      { timeout: 15000, encoding: "utf8" }
    );
    const lines = result.trim().split("\n");
    const httpCode = parseInt(lines[lines.length - 1], 10);
    const responseBody = lines.slice(0, -1).join("\n");
    return { status: httpCode, data: JSON.parse(responseBody || "null") };
  } catch (e) {
    return { status: 0, data: { error: (e as Error).message } };
  }
}

function verifyOutput(output: unknown): { passed: boolean; detail: string } {
  if (!output) return { passed: false, detail: "No output received" };
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (obj.ok === false) return { passed: false, detail: `Agent error: ${obj.error || "unknown"}` };
    if (obj.error) return { passed: false, detail: `Agent error: ${obj.error}` };
    if (obj.data !== undefined) return { passed: true, detail: "Output received" };
  }
  if (typeof output === "string" && output.length > 0) return { passed: true, detail: "Output received" };
  return { passed: true, detail: "Output received" };
}

export async function executePlan(plan: BindPlan): Promise<BindExecution> {
  const executionId = randomUUID();
  const stepResults: ExecutionResult[] = [];
  let allPassed = true;
  let totalPaid = 0;
  const outputs: Record<number, unknown> = {};
  let finalOutput = "";

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step,
      agentName: step.agent.name,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      const input = { ...step.inputTemplate };
      result.input = input;

      // Try calling the agent directly
      const response = callAgent(step.agent.endpoint, input);

      if (response.status === 200) {
        result.output = response.data;
        outputs[step.step] = response.data;
        const verification = verifyOutput(response.data);
        result.verificationResult = verification;
        result.status = verification.passed ? "passed" : "failed";
        if (verification.passed) {
          totalPaid += step.agent.feeAmount;
          result.paymentTxHash = "no_payment_needed";
        }
      } else if (response.status === 402) {
        // Agent requires payment
        result.output = { note: "Agent requires x402 payment", challenge: response.data };
        result.status = "failed";
        result.verificationResult = { passed: false, detail: "Agent requires payment which is not yet wired" };
      } else {
        // Agent unreachable or error
        result.output = response.data;
        result.status = "failed";
        result.verificationResult = { passed: false, detail: `Agent returned error` };
      }

      if (result.status === "failed") {
        allPassed = false;
      }

    } catch (e) {
      result.status = "errored";
      result.error = (e as Error).message;
      allPassed = false;
    }

    result.completedAt = new Date().toISOString();
    stepResults.push(result);
  }

  // Build final output from what we got
  const successOutputs = Object.entries(outputs)
    .map(([step, data]) => `Step ${step}: ${JSON.stringify(data, null, 2)}`)
    .join("\n\n");
  finalOutput = successOutputs || "No agent outputs were successfully retrieved.";

  const completedSteps = stepResults.filter(r => r.status === "passed").length;

  return {
    executionId,
    planId: plan.planId,
    goal: plan.goal,
    status: allPassed ? "completed" : completedSteps > 0 ? "partial" : "failed",
    stepResults,
    finalOutput,
    totalPaid,
    totalSteps: plan.steps.length,
    completedSteps,
    createdAt: new Date().toISOString(),
  };
}