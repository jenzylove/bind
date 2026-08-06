import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { BindExecution } from "../src/bind/types.js";
import { buildReceiptCore, hashCanonical } from "../src/bind/receipt.js";

test("GET /bind/receipt/:id returns a private, self-checking proof bundle", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bind-receipt-test-"));
  process.env.BIND_DATA_DIR = dataDir;
  process.env.BIND_ALLOW_FREE = "1";

  const [{ bindRouter }, { saveExecution }] = await Promise.all([
    import("../src/bind/routes.js"),
    import("../src/bind/store.js"),
  ]);

  const exec: BindExecution = {
    executionId: "33333333-3333-4333-8333-333333333333",
    planId: "44444444-4444-4444-8444-444444444444",
    goal: "Confidential acquisition target Acme",
    payer: "0x1111111111111111111111111111111111111111",
    buyerPayment: {
      amountUsdt: 0.05,
      amountBaseUnits: "50000",
      chain: "eip155:196",
      token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      recipient: "0x2222222222222222222222222222222222222222",
      source: "direct_transfer",
      state: "confirmed",
      txHash: `0x${"d".repeat(64)}`,
    },
    status: "completed",
    stepResults: [{
      step: 1,
      agentId: "4413",
      agentName: "SignalDesk",
      status: "passed",
      input: { target: "Acme" },
      output: { verdict: "proceed" },
      verificationResult: { passed: true, detail: "Relevant output" },
      completedAt: "2026-07-30T10:00:03.000Z",
    }],
    finalOutput: "Proceed with the acquisition.",
    totalPaid: 0,
    totalSteps: 1,
    completedSteps: 1,
    createdAt: "2026-07-30T10:00:00.000Z",
    completedAt: "2026-07-30T10:00:04.000Z",
  };
  exec.receiptVersion = "bind.execution-receipt.v2";
  exec.receiptSha256 = hashCanonical(buildReceiptCore(exec));
  exec.anchorTxHash = `0x${"c".repeat(64)}`;
  saveExecution(exec);

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
  const response = await fetch(`http://127.0.0.1:${address.port}/bind/receipt/${exec.executionId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const body = await response.json() as Record<string, any>;
  assert.equal(body.receiptSha256, exec.receiptSha256);
  assert.equal(body.receipt.buyerPayment.amountBaseUnits, "50000");
  assert.equal(body.receipt.buyerPayment.state, "confirmed");
  assert.equal(body.selfCheck.storedHashMatches, true);
  assert.equal(body.anchor.expectedCalldata, `0x${exec.receiptSha256}`);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Acme/);
  assert.doesNotMatch(serialized, /Proceed with the acquisition/);
  assert.doesNotMatch(serialized, /0x1111111111111111111111111111111111111111/);

  const missingReceipt = await fetch(`http://127.0.0.1:${address.port}/bind/receipt/missing-capability`);
  assert.equal(missingReceipt.status, 404);
  assert.equal(missingReceipt.headers.get("cache-control"), "private, no-store");
  assert.equal(missingReceipt.headers.get("referrer-policy"), "no-referrer");

  const missingStatus = await fetch(`http://127.0.0.1:${address.port}/bind/status/missing-capability`);
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.headers.get("cache-control"), "private, no-store");
  assert.equal(missingStatus.headers.get("referrer-policy"), "no-referrer");

  for (const path of ["/bind/quote", "/bind/mission"]) {
    const earlyError = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.ok(earlyError.status >= 400);
    assert.equal(earlyError.headers.get("cache-control"), "private, no-store");
    assert.equal(earlyError.headers.get("referrer-policy"), "no-referrer");
  }

  const history = await fetch(`http://127.0.0.1:${address.port}/bind/history/${exec.payer}`);
  assert.equal(history.status, 404);
  assert.equal(history.headers.get("cache-control"), "private, no-store");
  assert.equal(history.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(await history.text(), new RegExp(exec.payer!, "i"));
});
