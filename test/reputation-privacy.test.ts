import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindExecution } from "../src/bind/types.js";

test("public reputation exposes attempt evidence without customer mission or wallet data", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-reputation-test-"));
  process.env.BIND_DATA_DIR = dataDir;
  try {
    const [{ saveExecution }, reputation] = await Promise.all([
      import("../src/bind/store.js"),
      import("../src/bind/reputation.js"),
    ]);
    const exec: BindExecution = {
      executionId: "55555555-5555-4555-8555-555555555555",
      planId: "66666666-6666-4666-8666-666666666666",
      goal: "Confidentially investigate Acme before acquisition",
      payer: "0x1111111111111111111111111111111111111111",
      status: "completed",
      stepResults: [{
        step: 1,
        agentId: "4413",
        agentName: "SignalDesk",
        serviceName: "Market intelligence",
        status: "passed",
        verificationResult: { passed: true, detail: "Acme appears in the verified output" },
        attempts: [{
          agentId: "4413",
          agentName: "SignalDesk",
          serviceName: "Market intelligence",
          endpoint: "https://seller.internal/execute",
          paid: false,
          status: "passed",
          verificationDetail: "Acme appears in the verified output",
        }],
      }],
      totalPaid: 0,
      totalSteps: 1,
      completedSteps: 1,
      createdAt: "2026-07-30T10:00:00.000Z",
    };
    saveExecution(exec);

    const publicData = {
      agent: reputation.agentEvidence("4413"),
      ledger: reputation.ledgerDetail(),
    };
    const serialized = JSON.stringify(publicData);
    assert.doesNotMatch(serialized, /Acme/);
    assert.doesNotMatch(serialized, /investigate/);
    assert.doesNotMatch(serialized, /appears in the verified output/);
    assert.doesNotMatch(serialized, new RegExp(exec.executionId));
    assert.doesNotMatch(serialized, /0x1111111111111111111111111111111111111111/);
    assert.doesNotMatch(serialized, /seller\.internal/);
    assert.match(serialized, /evidenceId/);
    assert.match(serialized, /sha256:[0-9a-f]{64}/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
