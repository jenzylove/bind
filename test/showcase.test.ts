import test from "node:test";
import assert from "node:assert/strict";
import { showcaseExecution } from "../src/bind/showcase.js";
import type { BindExecution } from "../src/bind/types.js";

const execution = {
  executionId: "11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  goal: "SECRET BUYER GOAL",
  payer: "0x1111111111111111111111111111111111111111",
  status: "completed",
  stepResults: [{
    step: 1,
    agentId: "4735",
    agentName: "Research service",
    serviceEndpoint: "https://secret-agent.example/private",
    status: "passed",
    feeUsdt: 0.05,
    paymentTxHash: `0x${"a".repeat(64)}`,
    input: { secretPrompt: "SECRET REQUEST BODY" },
    output: { secretResearch: "SECRET INTERMEDIATE OUTPUT" },
    attempts: [{
      agentId: "9999",
      agentName: "Fallback",
      serviceEndpoint: "https://fallback-secret.example",
      input: { nested: "SECRET ATTEMPT INPUT" },
      output: { nested: "SECRET ATTEMPT OUTPUT" },
      status: "failed",
      error: "SECRET RAW SELLER ERROR",
    }],
    verificationResult: { passed: true, detail: "SECRET VERIFICATION DETAIL" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  }],
  finalOutput: "Buyer-safe bundled deliverable",
  totalPaid: 0.05,
  totalSteps: 1,
  completedSteps: 1,
  refundAmountDueUsdt: 0.01,
  refundAmountSubmittedUsdt: 0.01,
  refundAmountConfirmedUsdt: 0,
  refundState: "submitted",
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
} as unknown as BindExecution;

test("showcase projection keeps the deliverable while excluding execution internals", () => {
  const projection = showcaseExecution(execution);
  const encoded = JSON.stringify(projection);
  assert.match(encoded, /Buyer-safe bundled deliverable/);
  assert.match(encoded, /Research service/);
  assert.match(encoded, /verificationPassed/);
  for (const secret of [
    "SECRET BUYER GOAL",
    "0x1111111111111111111111111111111111111111",
    "secret-agent.example",
    "fallback-secret.example",
    "SECRET REQUEST BODY",
    "SECRET INTERMEDIATE OUTPUT",
    "SECRET ATTEMPT INPUT",
    "SECRET ATTEMPT OUTPUT",
    "SECRET RAW SELLER ERROR",
    "SECRET VERIFICATION DETAIL",
    "4735",
    "9999",
  ]) assert.doesNotMatch(encoded, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
