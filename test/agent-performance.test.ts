import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAttempt, AgentOperationEvent, BindExecution } from "../src/bind/types.js";
import {
  aggregateAgentPerformance,
  buildAgentOperationEvents,
  summarizeAgentPerformance,
} from "../src/bind/agent-performance.js";

// TEST-ONLY fixture factory. These records are never written outside a temporary test directory.
function testOnlyExecution(attempts: AgentAttempt[], executionId = "11111111-1111-4111-8111-111111111111"): BindExecution {
  return {
    executionId,
    planId: "22222222-2222-4222-8222-222222222222",
    goal: "TEST ONLY performance evidence fixture",
    status: "completed",
    stepResults: [{
      step: 1,
      agentId: attempts.at(-1)?.agentId,
      agentName: attempts.at(-1)?.agentName ?? "TEST ONLY agent",
      status: attempts.at(-1)?.status === "passed" ? "passed" : attempts.at(-1)?.status === "failed" ? "failed" : "errored",
      attempts,
      completedAt: "2026-08-04T12:00:00.000Z",
    }],
    totalPaid: 0,
    totalSteps: 1,
    completedSteps: attempts.some((attempt) => attempt.status === "passed") ? 1 : 0,
    createdAt: "2026-08-04T11:59:00.000Z",
    completedAt: "2026-08-04T12:00:00.000Z",
  };
}

function testOnlyAttempt(status: AgentAttempt["status"], overrides: Partial<AgentAttempt> = {}): AgentAttempt {
  return {
    agentId: "test-agent-1",
    agentName: "TEST ONLY Agent One",
    serviceName: "TEST ONLY service",
    endpoint: "https://test-only.invalid/run",
    paid: false,
    paymentState: "not_authorized",
    status,
    ...overrides,
  };
}

function testOnlyEvent(outcome: AgentOperationEvent["outcome"], ordinal: number): AgentOperationEvent {
  const verification = outcome === "verified_completed" ? "passed" : outcome === "verification_failed" ? "failed" : "not_run";
  return {
    schema: "bind.agent-operation.v1",
    eventId: `test-only-event-${ordinal}`,
    executionId: `test-only-execution-${ordinal}`,
    step: 1,
    attempt: 1,
    observedAt: `2026-08-04T12:00:0${ordinal}.000Z`,
    agentId: "test-agent-1",
    agentName: "TEST ONLY Agent One",
    serviceName: "TEST ONLY service",
    availability: outcome === "timed_out" ? "offline" : outcome === "no_result" ? "unknown" : "online",
    acceptance: verification === "not_run" ? "unknown" : "accepted",
    outcome,
    verification,
    payment: "not_authorized",
    evidenceSource: "bind_execution",
  };
}

test("execution attempts become durable events with one mutually exclusive outcome each", () => {
  const attempts = [
    testOnlyAttempt("passed", { output: { data: "ok" }, verificationDetail: "structured result" }),
    testOnlyAttempt("failed", { output: { error: "bad" }, verificationDetail: "error field present" }),
    testOnlyAttempt("errored", { error: "HTTP 0: This operation was aborted" }),
    testOnlyAttempt("errored", { error: "HTTP 503: unavailable" }),
  ];

  const events = buildAgentOperationEvents(testOnlyExecution(attempts));
  assert.deepEqual(events.map((event) => event.outcome), [
    "verified_completed",
    "verification_failed",
    "timed_out",
    "no_result",
  ]);
  assert.deepEqual(events.map((event) => event.verification), ["passed", "failed", "not_run", "not_run"]);
  assert.deepEqual(events.map((event) => event.availability), ["online", "online", "offline", "unknown"]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 4);
});

test("rating and routing exclusion use only operations where verification ran", () => {
  const events = [
    testOnlyEvent("verification_failed", 1),
    testOnlyEvent("timed_out", 2),
    testOnlyEvent("no_result", 3),
    testOnlyEvent("verification_failed", 4),
    testOnlyEvent("verification_failed", 5),
  ];

  const [performance] = aggregateAgentPerformance(events);
  assert.equal(performance.testedOperations, 5);
  assert.equal(performance.verifiedOperations, 3);
  assert.equal(performance.verifiedPassRate, 0);
  assert.equal(performance.timedOut, 1);
  assert.equal(performance.noResult, 1);
  assert.equal(performance.routingEligibility, "excluded");
  assert.match(performance.routingReason ?? "", /verified operations/i);
});

test("public metric summary counts agents by latest evidence without inventing unknown availability", () => {
  const agentOne = [testOnlyEvent("timed_out", 1), testOnlyEvent("verified_completed", 2)];
  const agentTwo = { ...testOnlyEvent("no_result", 3), agentId: "test-agent-2", agentName: "TEST ONLY Agent Two" };
  const summary = summarizeAgentPerformance([...agentOne, agentTwo]);

  assert.deepEqual(summary, {
    agentsTested: 2,
    online: 1,
    offline: 0,
    availabilityUnknown: 1,
    completed: 1,
    failedVerification: 0,
    timedOut: 1,
    noResult: 1,
    removedFromRouting: 0,
    verifiedOperations: 1,
  });
});

test("terminal execution persistence materializes evidence while running stubs do not", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-agent-performance-test-"));
  process.env.BIND_DATA_DIR = dataDir;
  try {
    const store = await import(`../src/bind/store.js?agent-performance=${Date.now()}`);
    const terminal = testOnlyExecution([
      testOnlyAttempt("passed", { output: { data: "ok" }, verificationDetail: "structured result" }),
    ]);
    store.saveExecution(terminal);
    const loaded = store.loadExecution(terminal.executionId);
    assert.equal(loaded?.agentOperationEvents?.length, 1);
    assert.equal(loaded?.agentOperationEvents?.[0].outcome, "verified_completed");

    const running = { ...testOnlyExecution([], "33333333-3333-4333-8333-333333333333"), status: "running" as const };
    store.saveExecution(running);
    assert.equal(store.loadExecution(running.executionId)?.agentOperationEvents, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
