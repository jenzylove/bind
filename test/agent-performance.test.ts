import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAttempt, AgentOperationEvent, BindExecution } from "../src/bind/types.js";
import { buildReceiptCore, hashCanonical, RECEIPT_VERSION } from "../src/bind/receipt.js";
import {
  aggregateAgentPerformance,
  buildAgentOperationEvents,
  readDurableAgentOperationEvents,
  summarizeAgentPerformance,
} from "../src/bind/agent-performance.js";

function attempt(status: AgentAttempt["status"], overrides: Partial<AgentAttempt> = {}): AgentAttempt {
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

function execution(attempts: AgentAttempt[], executionId = "11111111-1111-4111-8111-111111111111"): BindExecution {
  const value: BindExecution = {
    executionId,
    planId: "22222222-2222-4222-8222-222222222222",
    goal: "TEST ONLY private performance evidence fixture",
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
    completedSteps: attempts.some((item) => item.status === "passed") ? 1 : 0,
    createdAt: "2026-08-04T11:59:00.000Z",
    completedAt: "2026-08-04T12:00:00.000Z",
  };
  value.receiptVersion = RECEIPT_VERSION;
  value.receiptSha256 = hashCanonical(buildReceiptCore(value));
  return value;
}

function derivedEvent(status: AgentAttempt["status"] = "passed"): AgentOperationEvent {
  return buildAgentOperationEvents(execution([attempt(status)]))[0]!;
}

test("timeout is separate from offline availability without independent network evidence", () => {
  const events = buildAgentOperationEvents(execution([
    attempt("errored", { error: "AbortError: request timed out" }),
    attempt("errored", { error: "HTTP 503: unavailable" }),
  ]));
  assert.deepEqual(events.map((event) => event.outcome), ["timed_out", "no_result"]);
  assert.deepEqual(events.map((event) => event.availability), ["unknown", "online"]);
  assert.deepEqual(events.map((event) => event.verification), ["not_run", "not_run"]);
});

test("event IDs commit to content and exact duplicates are suppressed", () => {
  const event = derivedEvent();
  const changed = { ...event, outcome: "verification_failed" as const, verification: "failed" as const };
  assert.throws(() => aggregateAgentPerformance([event, changed]), /duplicate event id/i);
  const [record] = aggregateAgentPerformance([event, { ...event }]);
  assert.equal(record.testedOperations, 1);
  assert.match(event.eventId, /^sha256:[0-9a-f]{64}$/);
});

test("invalid event dimensions and non-content IDs are rejected", () => {
  const event = derivedEvent();
  assert.throws(
    () => aggregateAgentPerformance([{ ...event, availability: "offline" }]),
    /event id|dimension/i,
  );
  assert.throws(() => aggregateAgentPerformance([{ ...event, eventId: "position-1" }]), /event id/i);
});

test("timestamps are canonical, valid, and deterministically reproduce event IDs", () => {
  const value = execution([attempt("passed")]);
  const first = buildAgentOperationEvents(value);
  const second = buildAgentOperationEvents(structuredClone(value));
  assert.equal(first[0]?.observedAt, "2026-08-04T12:00:00.000Z");
  assert.equal(first[0]?.eventId, second[0]?.eventId);

  value.stepResults[0]!.completedAt = "not-a-date";
  value.receiptSha256 = hashCanonical(buildReceiptCore(value));
  assert.throws(() => buildAgentOperationEvents(value), /timestamp/i);
});

test("payment and verification remain orthogonal dimensions", () => {
  const events = buildAgentOperationEvents(execution([
    attempt("passed", { paid: false, paymentState: "not_authorized" }),
    attempt("failed", {
      paid: true,
      paymentState: "settlement_confirmed",
      paymentTxHash: `0x${"a".repeat(64)}`,
    }),
  ]));
  assert.deepEqual(events.map(({ outcome, verification, payment }) => ({ outcome, verification, payment })), [
    { outcome: "verified_completed", verification: "passed", payment: "not_authorized" },
    { outcome: "verification_failed", verification: "failed", payment: "settlement_confirmed" },
  ]);
});

test("impossible payment dimensions are rejected", () => {
  assert.throws(
    () => buildAgentOperationEvents(execution([attempt("passed", { paid: true, paymentState: "not_authorized" })])),
    /payment dimension/i,
  );
});

test("name-only observations are not unauthenticatedly merged", () => {
  const two = buildAgentOperationEvents(execution([
    attempt("passed", { agentId: undefined, agentName: "Shared Name" }),
    attempt("failed", { agentId: undefined, agentName: "Shared Name" }),
  ]));
  const records = aggregateAgentPerformance(two);
  assert.equal(records.filter((record) => record.agentName === "Shared Name").length, 2);
  assert.ok(records.every((record) => record.agentId || record.identityBasis === "name_only_uncorrelated"));
});

test("durable reader derives only strict locally receipt-hash-bound terminal attempts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-agent-performance-test-"));
  const executions = join(dataDir, "executions");
  await mkdir(executions);
  process.env.BIND_DATA_DIR = dataDir;
  try {
    const bound = execution([attempt("passed")]);
    await writeFile(join(executions, `${bound.executionId}.json`), JSON.stringify(bound));
    const legacy = execution([attempt("passed")], "33333333-3333-4333-8333-333333333333");
    delete legacy.receiptVersion;
    delete legacy.receiptSha256;
    await writeFile(join(executions, `${legacy.executionId}.json`), JSON.stringify(legacy));
    const running = { ...execution([], "44444444-4444-4444-8444-444444444444"), status: "running" as const };
    await writeFile(join(executions, `${running.executionId}.json`), JSON.stringify(running));

    const events = readDurableAgentOperationEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.agentName, "TEST ONLY Agent One");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("tampered or malformed claimed receipt evidence fails visibly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-agent-performance-tamper-"));
  const executions = join(dataDir, "executions");
  await mkdir(executions);
  process.env.BIND_DATA_DIR = dataDir;
  try {
    const tampered = execution([attempt("passed")]);
    tampered.goal = "tampered after receipt";
    await writeFile(join(executions, `${tampered.executionId}.json`), JSON.stringify(tampered));
    assert.throws(() => readDurableAgentOperationEvents(), /receipt hash/i);
    tampered.receiptSha256 = "not-a-hash";
    await writeFile(join(executions, `${tampered.executionId}.json`), JSON.stringify(tampered));
    assert.throws(() => readDurableAgentOperationEvents(), /receipt hash/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("corrupt storage fails visibly while a missing directory is an empty baseline", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-agent-performance-corrupt-"));
  process.env.BIND_DATA_DIR = dataDir;
  assert.deepEqual(readDurableAgentOperationEvents(), []);
  const executions = join(dataDir, "executions");
  await mkdir(executions);
  await writeFile(join(executions, "corrupt.json"), "{not json");
  assert.throws(() => readDurableAgentOperationEvents(), /could not read performance evidence/i);
  await rm(dataDir, { recursive: true, force: true });
});

test("summary contains reporting dimensions only", () => {
  const summary = summarizeAgentPerformance([derivedEvent()]);
  assert.deepEqual(summary, {
    agentsTested: 1,
    online: 1,
    offline: 0,
    availabilityUnknown: 0,
    completed: 1,
    failedVerification: 0,
    timedOut: 0,
    noResult: 0,
    verifiedOperations: 1,
  });
  assert.equal("removedFromRouting" in summary, false);
});
