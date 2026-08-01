import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPaymentClaim, refundClaimKey } from "../src/bind/payment-claims.js";

process.env.USDT_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
process.env.PAY_TO_ADDRESS = "0x2222222222222222222222222222222222222222";
const { confirmRefundTransfer, refundExactBaseUnits, refundTxHashFromResponse, refundUnspent, reconcileRefundEvidence } = await import("../src/bind/refund.js");
const { buildReceiptCore, buildReceiptProof, hashCanonical } = await import("../src/bind/receipt.js");

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const txHash = `0x${"a".repeat(64)}`;
const payer = "0x1111111111111111111111111111111111111111";
const token = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const sender = "0x2222222222222222222222222222222222222222";
const topic = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const receipt = (overrides: Record<string, unknown> = {}) => ({
  transactionHash: txHash,
  status: "0x1",
  logs: [{
    address: token,
    topics: [TRANSFER_TOPIC, topic(sender), topic(payer)],
    data: `0x${(50_000n).toString(16).padStart(64, "0")}`,
  }],
  ...overrides,
});

test("refund evidence accepts only a successful response with an explicit transaction hash", () => {
  const txHash = `0x${"a".repeat(64)}`;
  assert.equal(refundTxHashFromResponse({ ok: true, data: { txHash } }), txHash);
  assert.equal(refundTxHashFromResponse({ ok: false, data: { txHash } }), undefined);
  assert.equal(refundTxHashFromResponse({ data: { txHash } }), undefined);
  assert.equal(refundTxHashFromResponse({ ok: true, data: { orderId: "order-123" } }), undefined);
  assert.equal(refundTxHashFromResponse({ ok: true, data: { hash: txHash } }), undefined);
  assert.equal(refundTxHashFromResponse({ ok: true, data: { txHash: "not-a-hash" } }), undefined);
});

test("a failed refund preserves the amount still owed", async () => {
  const result = await refundUnspent(0.05, 0, undefined);
  assert.equal(result.amountDue, 0.05);
  assert.equal(result.amountSubmitted, 0);
  assert.equal(result.amountConfirmed, 0);
  assert.equal(result.state, "failed");
  assert.match(result.reason ?? "", /payer address/i);
});

test("refund reservation exists before wallet submission and ambiguity blocks every retry", async (t) => {
  const claimsDir = await mkdtemp(join(tmpdir(), "bind-refund-claim-test-"));
  t.after(() => rm(claimsDir, { recursive: true, force: true }));
  const liabilityId = "99999999-9999-4999-8999-999999999999";
  const key = refundClaimKey(liabilityId, token, payer, "50000");
  let submissions = 0;
  const submit = async () => {
    submissions += 1;
    assert.equal(loadPaymentClaim(key, claimsDir)?.state, "refund_pending");
    return { ok: true, data: {} };
  };

  const first = await refundUnspent(0.05, 0, payer, liabilityId, { claimsDir, submit });
  assert.equal(first.state, "reconciliation_required");
  assert.equal(loadPaymentClaim(key, claimsDir)?.state, "reconciliation_required");

  const second = await refundUnspent(0.05, 0, payer, liabilityId, { claimsDir, submit });
  assert.equal(second.state, "reconciliation_required");
  assert.equal(submissions, 1);
});

test("a submitted refund is idempotently returned without a second wallet call", async (t) => {
  const claimsDir = await mkdtemp(join(tmpdir(), "bind-refund-submit-test-"));
  t.after(() => rm(claimsDir, { recursive: true, force: true }));
  const liabilityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let submissions = 0;
  const first = await refundUnspent(0.05, 0, payer, liabilityId, {
    claimsDir,
    submit: async () => { submissions += 1; return { ok: true, data: { txHash } }; },
    confirm: async () => "pending",
  });
  assert.equal(first.state, "submitted");

  const second = await refundUnspent(0.05, 0, payer, liabilityId, {
    claimsDir,
    submit: async () => { submissions += 1; return { ok: true, data: { txHash } }; },
  });
  assert.equal(second.state, "submitted");
  assert.equal(second.txHash, txHash);
  assert.equal(submissions, 1);
});

test("exact refund evidence preserves issuance token, sender, recipient, and base units", async (t) => {
  const claimsDir = await mkdtemp(join(tmpdir(), "bind-refund-exact-test-"));
  t.after(() => rm(claimsDir, { recursive: true, force: true }));
  const liabilityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const result = await refundExactBaseUnits("50001", payer, liabilityId, {
    claimsDir,
    tokenAddress: token,
    senderAddress: sender,
    submit: async (_payer, amount) => {
      assert.equal(amount, 50_001n);
      return { ok: true, data: { txHash } };
    },
    confirm: async (_hash, recipient, amountBaseUnits, originalToken, originalSender) => {
      assert.equal(recipient, payer);
      assert.equal(amountBaseUnits, "50001");
      assert.equal(originalToken, token);
      assert.equal(originalSender, sender);
      return "confirmed";
    },
  });
  assert.equal(result.amountDueBaseUnits, "50001");
  const claim = loadPaymentClaim(refundClaimKey(liabilityId, token, payer, "50001"), claimsDir);
  assert.equal(claim?.token, token);
  assert.equal(claim?.sender, sender);
  assert.equal(claim?.state, "refund_confirmed");
});

test("refund reconciliation appends a chained attestation without rewriting the anchored receipt", async () => {
  const execution: any = {
    executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    planId: "plan-1",
    goal: "private goal",
    payer,
    status: "failed",
    stepResults: [],
    totalPaid: 0,
    totalSteps: 0,
    completedSteps: 0,
    refundAmountDueBaseUnits: "50000",
    refundAmountSubmittedBaseUnits: "50000",
    refundAmountConfirmedBaseUnits: "0",
    refundToken: token,
    refundSender: sender,
    refundAmountDueUsdt: 0.05,
    refundAmountSubmittedUsdt: 0.05,
    refundAmountConfirmedUsdt: 0,
    refundState: "submitted",
    refundTxHash: txHash,
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:01:00.000Z",
    receiptVersion: "bind.execution-receipt.v2",
  };
  execution.receiptSha256 = hashCanonical(buildReceiptCore(execution));
  const originalHash = hashCanonical(buildReceiptCore(execution));

  assert.equal(await reconcileRefundEvidence(execution, async () => "confirmed"), true);
  assert.equal(hashCanonical(buildReceiptCore(execution)), originalHash);
  assert.equal(execution.refundState, "submitted");
  assert.equal(execution.refundAttestations.length, 1);
  const proof = buildReceiptProof(execution);
  assert.equal(proof.refundAttestations[0].hashMatches, true);
  assert.equal(proof.refundAttestations[0].chainMatches, true);
  assert.equal(proof.refundAttestations[0].attestation.priorReceiptSha256, originalHash);
});

test("refund confirmation requires the exact canonical transfer", async () => {
  const confirm = (read: (method: string, params: unknown[]) => Promise<unknown>) =>
    confirmRefundTransfer(txHash, payer, "50000", read, 1, async () => {}, token, sender);
  const read = async () => receipt();
  assert.equal(await confirm(read), "confirmed");
  assert.equal(await confirm(async () => null), "pending");
  assert.equal(await confirm(async () => receipt({ status: "0x0" })), "failed");

  const wrongToken = receipt();
  wrongToken.logs[0].address = "0x2222222222222222222222222222222222222222";
  assert.equal(await confirm(async () => wrongToken), "failed");

  const wrongSender = receipt();
  wrongSender.logs[0].topics[1] = topic("0x3333333333333333333333333333333333333333");
  assert.equal(await confirm(async () => wrongSender), "failed");

  const wrongRecipient = receipt();
  wrongRecipient.logs[0].topics[2] = topic("0x4444444444444444444444444444444444444444");
  assert.equal(await confirm(async () => wrongRecipient), "failed");

  const wrongAmount = receipt();
  wrongAmount.logs[0].data = `0x${(49_999n).toString(16).padStart(64, "0")}`;
  assert.equal(await confirm(async () => wrongAmount), "failed");
});
