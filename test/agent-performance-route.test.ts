import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { BindExecution } from "../src/bind/types.js";

test("GET /bind/performance publishes only evidence-backed aggregate counts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-performance-route-test-"));
  process.env.BIND_DATA_DIR = dataDir;
  process.env.BIND_ALLOW_FREE = "1";
  const [{ bindRouter }, { saveExecution }] = await Promise.all([
    import("../src/bind/routes.js"),
    import("../src/bind/store.js"),
  ]);

  // TEST-ONLY fixture stored exclusively in the temporary directory above.
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
        endpoint: "https://test-only.invalid/run",
        status: "passed",
        paid: false,
        paymentState: "not_authorized",
        output: { secret: "TEST ONLY private output" },
        verificationDetail: "TEST ONLY verified detail",
      }],
    }],
    totalPaid: 0,
    totalSteps: 1,
    completedSteps: 1,
    createdAt: "2026-08-04T11:59:00.000Z",
    completedAt: "2026-08-04T12:00:00.000Z",
  };
  saveExecution(execution);

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
    removedFromRouting: 0,
    verifiedOperations: 1,
  });
  assert.equal(body.agents[0].rating.verifiedOperations, 1);
  assert.equal(body.agents[0].rating.verifiedPassRate, 1);
  assert.equal(body.agents[0].routing.status, "eligible");
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /private goal|private output|verified detail|77777777/);
  assert.match(body.note, /legacy records are not inferred/i);
});
