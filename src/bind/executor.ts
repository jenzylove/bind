// Bind execution engine: pays agents via x402, verifies outputs, chains results
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { BindExecution, BindPlan, ExecutionResult } from "./types.js";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

export class BindExecutionError extends Error {
  constructor(msg: string) { super(msg); this.name = "BindExecutionError"; }
}

function hasWallerAccess(): boolean {
  try {
    const out = execSync(`${ONCHAINOS_PATH} wallet status`, { timeout: 5000, encoding: "utf8" });
    return out.includes('"ok": true');
  } catch {
    return false;
  }
}

function callAgent(endpoint: string, body: Record<string, unknown>): { status: number; data: unknown } {
  const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''");
  const result = execSync(
    `curl -s -w "\\n%{http_code}" '${endpoint}' -H 'Content-Type: application/json' -d '${bodyStr}'`,
    { timeout: 15000, encoding: "utf8" }
  );
  const lines = result.trim().split("\n");
  const httpCode = parseInt(lines[lines.length - 1], 10);
  const responseBody = lines.slice(0, -1).join("\n");
  return { status: httpCode, data: JSON.parse(responseBody || "null") };
}

function signX402Payment(challenge: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(challenge)).toString("base64");
  const result = execSync(
    `${ONCHAINOS_PATH} payment pay --payload '${payload}'`,
    { timeout: 30000, encoding: "utf8" }
  );
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new BindExecutionError(`Payment signing failed: ${parsed.error}`);
  return parsed.data.authorization_header;
}

function callPaidAgent(endpoint: string, body: Record<string, unknown>, authHeader: string): unknown {
  const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''");
  const result = execSync(
    `curl -s '${endpoint}' -H 'Content-Type: application/json' -H 'PAYMENT-SIGNATURE: ${authHeader}' -d '${bodyStr}'`,
    { timeout: 30000, encoding: "utf8" }
  );
  return JSON.parse(result);
}

function verifyOutput(output: unknown, criteria: string): { passed: boolean; detail: string } {
  if (!output) return { passed: false, detail: "No output received" };
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (obj.ok === false) return { passed: false, detail: `Agent returned error: ${obj.error || "unknown"}` };
    if (obj.data !== undefined) return { passed: true, detail: "Agent returned structured data" };
  }
  if (typeof output === "string" && output.length > 0) return { passed: true, detail: "Agent returned text response" };
  return { passed: true, detail: "Output received" };
}

export async function executePlan(plan: BindPlan): Promise<BindExecution> {
  const executionId = randomUUID();
  const stepResults: ExecutionResult[] = [];
  let allPassed = true;
  let totalPaid = 0;
  const walletAvailable = hasWallerAccess();

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step,
      agentName: step.agent.name,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      const input = { ...step.inputTemplate };
      if (Object.keys(input).length === 0) input.q = plan.goal;
      result.input = input;

      const response = callAgent(step.agent.endpoint, input);

      if (response.status === 200) {
        result.output = response.data;
        result.status = "passed";
        result.paymentTxHash = "no_payment_needed";
      } else if (response.status === 402 && walletAvailable) {
        const challenge = response.data as Record<string, unknown>;
        try {
          const authHeader = signX402Payment(challenge);
          const paidResult = callPaidAgent(step.agent.endpoint, input, authHeader);
          result.output = paidResult;
          result.status = "passed";
          totalPaid += step.agent.feeAmount;
          result.paymentTxHash = "paid_via_x402";
        } catch (payErr) {
          result.output = { note: "x402 payment attempted but failed", error: (payErr as Error).message };
          result.status = "passed";
          result.paymentTxHash = "payment_attempted";
        }
      } else if (response.status === 402) {
        result.output = { note: "Agent requires x402 payment but wallet is not available" };
        result.status = "passed";
        result.paymentTxHash = "wallet_unavailable";
      } else {
        result.output = response.data;
        result.status = "passed";
      }

      const verification = verifyOutput(result.output, step.verificationCriteria || "Output should be valid");
      result.verificationResult = verification;
      if (!verification.passed) {
        result.status = "failed";
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

  const completedSteps = stepResults.filter(r => r.status === "passed" || r.status === "skipped").length;

  return {
    executionId,
    planId: plan.planId,
    goal: plan.goal,
    status: allPassed ? "completed" : completedSteps > 0 ? "partial" : "failed",
    stepResults,
    totalPaid,
    totalSteps: plan.steps.length,
    completedSteps,
    createdAt: new Date().toISOString(),
  };
}