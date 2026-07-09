// Bind execution engine — real agent calls with smart parameter inference
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { BindExecution, BindPlan, ExecutionResult } from "./types.js";
import { extractParamsFast, inferParams } from "./agent-infer.js";

const ONCHAINOS_PATH = process.env.HOME + "/.local/bin/onchainos";

function ensureLoggedIn(): boolean {
  try {
    execSync(`${ONCHAINOS_PATH} wallet login`, { timeout: 10000, encoding: "utf8" });
    return true;
  } catch { return false; }
}

function fetchServiceDescription(agentId: string, serviceId: string, serviceName?: string): string | null {
  try {
    const result = execSync(
      `${ONCHAINOS_PATH} agent service-list --agent-id ${agentId}`,
      { timeout: 10000, encoding: "utf8" }
    );
    const parsed = JSON.parse(result);
    if (!parsed.ok || !parsed.data?.[0]?.list) return null;
    for (const entry of parsed.data[0].list) {
      if (entry.serviceName === serviceName || String(entry.id) === serviceId) {
        return entry.serviceDescription || null;
      }
    }
    return parsed.data[0].list[0]?.serviceDescription || null;
  } catch { return null; }
}

function httpCall(method: string, url: string, body: string | null, authHeader?: string): { status: number; body: string; headers: Record<string, string> } {
  const authFlag = authHeader ? `-H 'PAYMENT-SIGNATURE: ${authHeader}'` : "";
  const bodyFlag = body ? `-d '${body.replace(/'/g, "'\\''")}'` : "";
  const result = execSync(
    `curl -sD - --max-time 15 -X ${method} '${url}' -H 'Content-Type: application/json' ${authFlag} ${bodyFlag}`,
    { timeout: 20000, encoding: "utf8" }
  );
  const headerEnd = result.indexOf("\r\n\r\n");
  const headerBlock = result.slice(0, headerEnd);
  const responseBody = result.slice(headerEnd + 4).trim();
  const statusLine = headerBlock.split("\r\n")[0];
  const status = parseInt(statusLine.split(" ")[1], 10);
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, body: responseBody, headers };
}

function parseChallenge(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body); } catch { return null; }
}

function signPayment(challenge: Record<string, unknown>): string | null {
  try {
    // Build the payload format onchainos payment pay expects
    const payload = Buffer.from(JSON.stringify(challenge)).toString("base64");
    const result = execSync(
      `${ONCHAINOS_PATH} payment pay --payload '${payload}'`,
      { timeout: 30000, encoding: "utf8" }
    );
    const parsed = JSON.parse(result);
    if (!parsed.ok) return null;
    return parsed.data.authorization_header || null;
  } catch { return null; }
}

export async function executePlan(plan: BindPlan): Promise<BindExecution> {
  ensureLoggedIn();
  const executionId = randomUUID();
  const stepResults: ExecutionResult[] = [];
  let allPassed = true;
  let totalPaid = 0;
  const outputs: string[] = [];
  let anchorTxHash: string | undefined;

  for (const step of plan.steps) {
    const result: ExecutionResult = {
      step: step.step,
      agentName: step.agent.name,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      // Fetch detailed service description if the profile description is generic
      let serviceDesc = step.agentServiceDescription || "";
      if (!serviceDesc.toLowerCase().includes("requires") && !serviceDesc.toLowerCase().includes("param")) {
        const detail = fetchServiceDescription(step.agent.agentId, step.agent.serviceId, step.agent.serviceName);
        if (detail) serviceDesc = detail;
      }

      // Step 1: Try to infer correct parameters from service description
      let inferredBody: Record<string, unknown> | null = null;
      let inferredMethod: "POST" | "GET" = "POST";

      if (serviceDesc) {
        const fast = extractParamsFast(serviceDesc);
        if (fast) {
          // Build body from extracted params — fill with goal where appropriate
          const body: Record<string, string> = {};
          for (const p of fast.required) {
            body[p] = plan.goal.includes("0x") ? plan.goal : plan.goal;
          }
          inferredBody = { ...body, ...fast.example };
        } else {
          // Fall back to LLM inference
          const inferred = await inferParams(
            step.agent.serviceName,
            serviceDesc,
            step.agent.endpoint,
            plan.goal
          );
          inferredMethod = inferred.method;
          inferredBody = inferred.body;
        }
      }

      // Build the list of formats to try — inferred first, then generics
      const inputFormats: Record<string, unknown>[] = [];

      if (inferredBody && Object.keys(inferredBody).length > 0) {
        inputFormats.push(inferredBody);
      }

      // Add generic formats as fallbacks
      const seen = new Set<string>();
      for (const body of [
        { q: plan.goal },
        { prompt: plan.goal },
        { query: plan.goal },
        { input: plan.goal },
        { text: plan.goal },
        {},
      ]) {
        const key = JSON.stringify(body);
        if (!seen.has(key)) {
          seen.add(key);
          inputFormats.push(body);
        }
      }
      
      // Deduplicate and try each format
      let lastError = "";
      let success = false;

      for (const fmt of inputFormats) {
        const body = JSON.stringify(fmt);
        result.input = fmt;
        let initial = httpCall("POST", step.agent.endpoint, body);

        // If POST fails with 405, try GET
        if (initial.status === 405) {
          initial = httpCall("GET", step.agent.endpoint, null);
        }

        if (initial.status === 200) {
          result.output = JSON.parse(initial.body || "{}");
          result.status = "passed";
          result.paymentTxHash = "no_payment_needed";
          success = true;
          break;
        }

        if (initial.status === 402) {
          // Parse x402 challenge from body or header
          let challenge = parseChallenge(initial.body);
          if (!challenge || !challenge.accepts) {
            const prHeader = initial.headers["payment-required"];
            if (prHeader) {
              try {
                const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString());
                challenge = decoded;
              } catch { /* skip */ }
            }
          }
          if (challenge && challenge.accepts) {
            const authHeader = signPayment(challenge);
            if (authHeader) {
              const paid = httpCall("POST", step.agent.endpoint, body, authHeader);
              if (paid.status === 200) {
                result.output = JSON.parse(paid.body || "{}");
                result.status = "passed";
                totalPaid += step.agent.feeAmount;
                result.paymentTxHash = "paid_via_x402";
                success = true;
                break;
              }
              lastError = `Paid call returned ${paid.status}`;
            } else {
              lastError = "Payment signing failed";
            }
          } else {
            lastError = "Could not parse x402 challenge";
          }
        } else {
          lastError = `HTTP ${initial.status}`;
        }
      }

      if (!success) {
        result.status = "errored";
        result.error = lastError || "All request formats failed";
        allPassed = false;
      }

      if (result.status === "passed" && result.output) {
        outputs.push(`[${step.agent.name}]\n${JSON.stringify(result.output, null, 2)}`);
      }

    } catch (e: any) {
      result.status = "errored";
      result.error = e.message || String(e);
      allPassed = false;
    }

    result.completedAt = new Date().toISOString();
    stepResults.push(result);
  }

  const completedSteps = stepResults.filter(r => r.status === "passed").length;
  const finalOutput = outputs.length > 0
    ? outputs.join("\n\n---\n\n")
    : "No agent outputs were successfully retrieved. Check the execution log for details.";

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
    anchorTxHash,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}