import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { BindExecution } from "../src/bind/types.js";
import { buildReceiptCore, hashCanonical, RECEIPT_VERSION } from "../src/bind/receipt.js";

test("GET /bind/performance publishes privacy-safe local receipt-bound reporting only", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-performance-route-test-"));
  process.env.BIND_DATA_DIR = dataDir;
  process.env.BIND_ALLOW_FREE = "1";
  const [{ bindRouter }, { saveExecution }] = await Promise.all([
    import("../src/bind/routes.js"),
    import("../src/bind/store.js"),
  ]);

  const execution: BindExecution = {
    executionId: "77777777-7777-4777-8777-777777777777",
    planId: "88888888-8888-4888-8888-888888888888",
    goal: "TEST ONLY private goal must not appear",
    status: "completed",
    stepResults: [{
      step: 1,
      agentId: "test-route-agent",
      agentName: "TEST ONLY Route Agent",
      serviceName: "TEST ONLY Route Service",
      status: "passed",
      completedAt: "2026-08-04T12:00:00.000Z",
      attempts: [{
        agentId: "test-route-agent",
        agentName: "TEST ONLY Route Agent",
        serviceName: "TEST ONLY Route Service",
        endpoint: "https://test-only.invalid/private-endpoint",
        status: "passed",
        paid: false,
        paymentState: "not_authorized",
        output: { secret: "TEST ONLY private output" },
        verificationDetail: "TEST ONLY private verified detail",
      }],
    }],
    totalPaid: 0,
    totalSteps: 1,
    completedSteps: 1,
    createdAt: "2026-08-04T11:59:00.000Z",
    completedAt: "2026-08-04T12:00:00.000Z",
  };
  execution.receiptVersion = RECEIPT_VERSION;
  execution.receiptSha256 = hashCanonical(buildReceiptCore(execution));
  saveExecution(execution);
  const persisted = JSON.parse(await readFile(join(dataDir, "executions", `${execution.executionId}.json`), "utf8"));
  assert.equal("agentOperationEvents" in persisted, false);

  const app = express();
  app.use("/bind", bindRouter);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/bind/performance`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.deepEqual(body.metrics, {
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
  assert.equal(body.agents[0].rating.verifiedOperations, 1);
  assert.equal("routing" in body.agents[0], false);
  assert.equal("removedFromRouting" in body.metrics, false);
  assert.match(body.note, /local receipt-hash binding/i);
  assert.match(body.note, /on-chain confirmation is not checked/i);
  assert.match(body.note, /name-only observations.*not merged/i);

  const serialized = JSON.stringify(body);
  for (const secret of [
    "private goal", "private output", "private verified detail", "private-endpoint",
    execution.executionId,
  ]) assert.doesNotMatch(serialized, new RegExp(secret, "i"));
});

test("planner has no performance import or performance-based exclusion", async () => {
  const planner = await readFile(new URL("../src/bind/planner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(planner, /agent-performance|durableAgentPerformance|performanceExcluded|removedFromRouting/);
});
