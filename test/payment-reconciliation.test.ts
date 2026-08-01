import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directPaymentClaimKey,
  loadPaymentClaim,
  reservePaymentClaim,
  transitionPaymentClaim,
} from "../src/bind/payment-claims.js";
import { reconcilePaymentClaimsOnStartup } from "../src/bind/payment-reconciliation.js";

const token = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

async function withClaim(state: "settled" | "execution_started", executionId?: string) {
  const dir = await mkdtemp(join(tmpdir(), "bind-reconcile-test-"));
  const txHash = `0x${Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64)}`;
  const key = directPaymentClaimKey(token, txHash);
  reservePaymentClaim({ key, source: "incoming_x402", chain: "eip155:196", token, txHash, payer: "0x1111111111111111111111111111111111111111", amountBaseUnits: "50000" }, dir);
  transitionPaymentClaim(key, ["reserved"], "settled", {}, dir);
  if (state === "execution_started") transitionPaymentClaim(key, ["settled"], "execution_started", { executionId }, dir);
  return { dir, key };
}

test("startup refunds a settled buyer claim that crashed before execution attachment", async (t) => {
  const { dir, key } = await withClaim("settled");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const refunded: string[] = [];
  const summary = await reconcilePaymentClaimsOnStartup(
    () => null,
    dir,
    async (claim) => {
      refunded.push(claim.amountBaseUnits!);
      return { state: "confirmed", txHash: `0x${"f".repeat(64)}` };
    },
  );
  assert.deepEqual(refunded, ["50000"]);
  assert.equal(summary.refundedOrphanCustody, 1);
  assert.equal(loadPaymentClaim(key, dir)?.state, "refund_confirmed");
});

test("startup blocks an interrupted execution with no durable final record", async (t) => {
  const { dir, key } = await withClaim("execution_started", "77777777-7777-4777-8777-777777777777");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await reconcilePaymentClaimsOnStartup(() => ({ status: "running" }), dir);
  assert.equal(loadPaymentClaim(key, dir)?.state, "reconciliation_required");
});

test("startup completes a claim only when its final execution is durable", async (t) => {
  const { dir, key } = await withClaim("execution_started", "88888888-8888-4888-8888-888888888888");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = await reconcilePaymentClaimsOnStartup(() => ({ status: "completed" }), dir);
  assert.equal(summary.completedFromDurableExecution, 1);
  assert.equal(loadPaymentClaim(key, dir)?.state, "completed");
});
