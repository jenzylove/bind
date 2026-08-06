import test from "node:test";
import assert from "node:assert/strict";
import type { BindExecution, BindPlan } from "../src/bind/types.js";
import {
  assertOfferedQuoteUnchanged,
  attachOfferedQuote,
  buildQuoteSnapshot,
  buildReceiptCore,
  buildReceiptProof,
  canonicalJson,
  hashCanonical,
} from "../src/bind/receipt.js";
import { renderMissionPage } from "../src/bind/mission-page.js";
import { renderAgentPage } from "../src/bind/agent-page.js";

function execution(): BindExecution {
  return {
    executionId: "11111111-1111-4111-8111-111111111111",
    planId: "22222222-2222-4222-8222-222222222222",
    goal: "Privately assess acquisition target Acme",
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
    quoteSnapshot: {
      schema: "bind.quote.v2",
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-07-30T09:59:00.000Z",
      expiresAt: "2026-07-30T10:29:00.000Z",
      buyerTotalBaseUnits: "50000",
      agentBudgetBaseUnits: "10000",
      platformFeeBaseUnits: "40000",
      buyerSettlement: {
        chain: "eip155:196",
        token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        recipient: "0x2222222222222222222222222222222222222222",
      },
      steps: [{
        step: 1,
        candidates: [{
          role: "primary",
          agentId: "4413",
          serviceId: "9001",
          serviceName: "Market intelligence",
          endpointSha256: "1".repeat(64),
          feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
          feeCapBaseUnits: "10000",
          chain: "eip155:196",
          recipient: null,
          authorization: "exact_reviewed_recipient_required",
        }],
      }],
    },
    status: "completed",
    stepResults: [
      {
        step: 1,
        agentId: "4413",
        agentName: "SignalDesk",
        serviceName: "Market intelligence",
        status: "passed",
        input: { company: "Acme", confidential: true },
        output: { verdict: "proceed", score: 82 },
        verificationType: "data",
        verificationCriteria: "Must include a supported verdict",
        verificationResult: { passed: true, detail: "Required fields present" },
        feeUsdt: 0.01,
        paymentTxHash: `0x${"a".repeat(64)}`,
        startedAt: "2026-07-30T10:00:00.000Z",
        completedAt: "2026-07-30T10:00:03.000Z",
      },
    ],
    finalOutput: "Proceed with enhanced diligence.",
    refundedUsdt: 0.02,
    refundTxHash: `0x${"b".repeat(64)}`,
    totalPaid: 0.01,
    totalSteps: 1,
    completedSteps: 1,
    createdAt: "2026-07-30T10:00:00.000Z",
    completedAt: "2026-07-30T10:00:04.000Z",
  };
}

test("canonicalJson is stable across object key order", () => {
  const a = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
  const b = { list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashCanonical(a), hashCanonical(b));
  assert.equal(canonicalJson([undefined, 1]), "[null,1]");
  assert.equal(canonicalJson({ omitted: undefined, kept: 1 }), '{"kept":1}');
});

test("receipt commits to private data without exposing it", () => {
  const receipt = buildReceiptCore(execution());
  const serialized = canonicalJson(receipt);

  assert.equal(receipt.schema, "bind.execution-receipt.v2");
  assert.match(receipt.goalSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.steps[0].inputSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.steps[0].outputSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.deliverableSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.buyerPayment.amountBaseUnits, "50000");
  assert.equal(receipt.buyerPayment.state, "confirmed");
  assert.equal(receipt.buyerPayment.txHash, `0x${"d".repeat(64)}`);
  assert.match(receipt.buyerPayment.recipientSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.steps[0].verificationType, "data");
  assert.match(receipt.steps[0].verificationCriteriaSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(serialized, /Acme/);
  assert.doesNotMatch(serialized, /proceed/);
  assert.doesNotMatch(serialized, /enhanced diligence/i);
  assert.doesNotMatch(serialized, /0x1111111111111111111111111111111111111111/);
});

test("receipt buyer economics come only from immutable stored evidence", () => {
  const exec = execution();
  exec.buyerPayment = {
    ...exec.buyerPayment!,
    amountUsdt: 0.05,
    amountBaseUnits: "50001",
    token: "0x3333333333333333333333333333333333333333",
    recipient: "0x4444444444444444444444444444444444444444",
    source: "eip3009",
  };
  const buyer = buildReceiptCore(exec).buyerPayment as any;
  assert.equal(buyer.amountBaseUnits, "50001");
  assert.equal(buyer.chain, "eip155:196");
  assert.equal(buyer.source, "eip3009");
  assert.equal(buyer.tokenSha256, `sha256:${hashCanonical(exec.buyerPayment.token.toLowerCase())}`);
  assert.equal(buyer.recipientSha256, `sha256:${hashCanonical(exec.buyerPayment.recipient.toLowerCase())}`);
});

test("receipt never labels a non-chain buyer or refund reference as a transaction hash", () => {
  const exec = execution();
  exec.buyerPayment = { ...exec.buyerPayment!, state: "submitted", txHash: "order_123" };
  exec.refundTxHash = "refund_order_123";
  exec.refundedUsdt = 0.01;
  exec.refundAmountDueUsdt = 0.01;
  exec.refundState = "submitted";
  const receipt = buildReceiptCore(exec);
  assert.equal(receipt.buyerPayment.state, "unconfirmed");
  assert.equal(receipt.buyerPayment.txHash, undefined);
  assert.equal(receipt.refund.state, "unconfirmed");
  assert.equal(receipt.refund.amountDueBaseUnits, "10000");
  assert.equal(receipt.refund.amountSubmittedBaseUnits, "0");
  assert.equal(receipt.refund.txHash, undefined);
  assert.doesNotMatch(canonicalJson(receipt), /order_123|refund_order_123/);
});

test("tampering with output, verification verdict, or a fallback attempt changes the receipt hash", () => {
  const original = execution();
  original.stepResults[0].attempts = [{
    agentId: "4413",
    agentName: "SignalDesk",
    serviceName: "Market intelligence",
    endpoint: "https://seller.example/execute",
    feeUsdt: 0.01,
    paid: true,
    paymentState: "settlement_confirmed",
    status: "passed",
    paymentTxHash: `0x${"a".repeat(64)}`,
    paymentRecipient: "0x2222222222222222222222222222222222222222",
    input: { company: "Acme" },
    output: { verdict: "proceed" },
    verificationDetail: "Required fields present",
  }];
  const changedOutput = structuredClone(original);
  changedOutput.stepResults[0].output = { verdict: "reject", score: 12 };
  const changedVerdict = structuredClone(original);
  changedVerdict.stepResults[0].verificationResult = { passed: false, detail: "Required fields missing" };
  const changedAttempt = structuredClone(original);
  changedAttempt.stepResults[0].attempts![0].feeUsdt = 0.02;
  const changedPaymentState = structuredClone(original);
  changedPaymentState.stepResults[0].attempts![0].paymentState = "authorized_ambiguous";
  const changedDependency = structuredClone(original);
  changedDependency.stepResults[0].blockedBy = "step 7";
  const changedError = structuredClone(original);
  changedError.stepResults[0].error = "seller timeout after authorization";
  const changedPolicy = structuredClone(original);
  changedPolicy.stepResults[0].verificationCriteria = "Must cite two independent sources";
  const changedRecipient = structuredClone(original);
  changedRecipient.stepResults[0].attempts![0].paymentRecipient = "0x3333333333333333333333333333333333333333";
  const changedExecutionError = structuredClone(original);
  changedExecutionError.error = "workflow persistence failed";

  const receipt = buildReceiptCore(original);
  assert.equal(receipt.steps[0].attempts.length, 1);
  assert.equal(receipt.steps[0].attempts[0].feeBaseUnits, "10000");
  assert.match(receipt.steps[0].attempts[0].paymentRecipientSha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(canonicalJson(receipt), /seller\.example|Required fields present|Acme/);
  const originalHash = hashCanonical(receipt);
  assert.notEqual(hashCanonical(buildReceiptCore(changedOutput)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedVerdict)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedAttempt)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedPaymentState)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedDependency)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedError)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedPolicy)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedRecipient)), originalHash);
  assert.notEqual(hashCanonical(buildReceiptCore(changedExecutionError)), originalHash);
});

test("receipt hash commits to the complete offered quote economics", () => {
  const original = execution();
  const originalHash = hashCanonical(buildReceiptCore(original));
  const mutations: Array<(value: BindExecution) => void> = [
    (value) => { value.quoteSnapshot!.buyerTotalBaseUnits = "51000"; },
    (value) => { value.quoteSnapshot!.agentBudgetBaseUnits = "11000"; },
    (value) => { value.quoteSnapshot!.platformFeeBaseUnits = "39000"; },
    (value) => { value.quoteSnapshot!.expiresAt = "2026-07-30T10:30:00.000Z"; },
    (value) => { value.quoteSnapshot!.buyerSettlement.recipient = "0x3333333333333333333333333333333333333333"; },
    (value) => { value.quoteSnapshot!.steps[0].candidates[0].feeCapBaseUnits = "11000"; },
    (value) => { value.quoteSnapshot!.steps[0].candidates[0].endpointSha256 = "2".repeat(64); },
    (value) => { value.quoteSnapshot!.steps[0].candidates[0].recipient = "0x5555555555555555555555555555555555555555"; },
    (value) => {
      const added = structuredClone(value.quoteSnapshot!.steps[0]);
      added.step = 2;
      added.candidates[0].agentId = "5222";
      value.quoteSnapshot!.steps.push(added);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(hashCanonical(buildReceiptCore(changed)), originalHash);
  }
  const ordered = structuredClone(original);
  const added = structuredClone(ordered.quoteSnapshot!.steps[0]);
  added.step = 2;
  added.candidates[0].agentId = "5222";
  ordered.quoteSnapshot!.steps.push(added);
  const reversed = structuredClone(ordered);
  reversed.quoteSnapshot!.steps.reverse();
  assert.notEqual(hashCanonical(buildReceiptCore(ordered)), hashCanonical(buildReceiptCore(reversed)));
  assert.deepEqual(buildReceiptCore({ ...original, quoteSnapshot: undefined }).quote, {
    state: "legacy_unavailable",
    planId: original.planId,
  });
});

test("offered quote commits every executable fallback and immutable settlement economics", () => {
  const primary = {
    agentId: "primary", name: "Primary", serviceId: "svc-primary", serviceName: "Primary service",
    endpoint: "https://primary.example/run", feeAmount: 0.01,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736", category: "analysis" as const,
  };
  const fallbackA = {
    ...primary, agentId: "fallback-a", name: "Fallback A", serviceId: "svc-a",
    endpoint: "https://fallback-a.example/run", feeAmount: 0.008,
  };
  const fallbackB = {
    ...primary, agentId: "fallback-b", name: "Fallback B", serviceId: "svc-b",
    endpoint: "https://fallback-b.example/run", feeAmount: 0.009,
  };
  const plan: BindPlan = {
    planId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    goal: "Compare fallback quote commitments",
    steps: [{
      step: 1, agent: primary, candidates: [fallbackA, fallbackB], inputTemplate: {}, verificationType: "data",
    }],
    totalPriceUsdt: 0.05, agentCost: 0.02, platformFee: 0.03,
    priceBreakdown: [{ agentName: primary.name, fee: primary.feeAmount }],
    estimatedTime: "1 minute", createdAt: "2026-07-30T09:59:00.000Z",
  };

  const offered = buildQuoteSnapshot(plan) as any;
  assert.equal(offered.schema, "bind.quote.v2");
  assert.deepEqual(offered.buyerSettlement, {
    chain: "eip155:196",
    token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    recipient: offered.buyerSettlement.recipient,
  });
  assert.deepEqual(offered.steps[0].candidates.map((candidate: any) => candidate.role), ["primary", "fallback", "fallback"]);
  assert.deepEqual(offered.steps[0].candidates.map((candidate: any) => candidate.agentId), ["primary", "fallback-a", "fallback-b"]);
  assert.equal(offered.steps[0].candidates[1].feeCapBaseUnits, "8000");
  assert.equal(offered.steps[0].candidates[1].recipient, null);
  assert.equal(offered.steps[0].candidates[1].authorization, "exact_reviewed_recipient_required");

  const originalHash = hashCanonical(offered);
  for (const mutate of [
    (value: BindPlan) => { value.steps[0].candidates![0].agentId = "different"; },
    (value: BindPlan) => { value.steps[0].candidates![0].endpoint = "https://different.example/run"; },
    (value: BindPlan) => { value.steps[0].candidates![0].feeAmount = 0.007; },
    (value: BindPlan) => { value.steps[0].candidates!.reverse(); },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.notEqual(hashCanonical(buildQuoteSnapshot(changed)), originalHash);
  }
});

test("issued offered quote rejects later plan mutation", () => {
  const agent = {
    agentId: "primary", name: "Primary", serviceId: "svc-primary", serviceName: "Primary service",
    endpoint: "https://primary.example/run", feeAmount: 0.01,
    feeToken: "0x779ded0c9e1022225f8e0630b35a9b54be713736", category: "analysis" as const,
  };
  const plan: BindPlan = {
    planId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", goal: "Freeze this offered quote",
    steps: [{ step: 1, agent, inputTemplate: {}, verificationType: "data" }],
    totalPriceUsdt: 0.05, agentCost: 0.01, platformFee: 0.04,
    priceBreakdown: [{ agentName: agent.name, fee: agent.feeAmount }],
    estimatedTime: "1 minute", createdAt: "2026-07-30T09:59:00.000Z",
  };
  attachOfferedQuote(plan);
  assert.equal(plan.quoteSnapshot?.schema, "bind.quote.v2");
  assert.doesNotThrow(() => assertOfferedQuoteUnchanged(plan));

  plan.steps[0].agent.endpoint = "https://tampered.example/run";
  assert.throws(() => assertOfferedQuoteUnchanged(plan), /offered quote.*changed/i);
});

test("proof bundle self-checks the stored hash and exposes expected anchor calldata", () => {
  const exec = execution();
  const hash = hashCanonical(buildReceiptCore(exec));
  exec.receiptVersion = "bind.execution-receipt.v2";
  exec.receiptSha256 = hash;
  exec.anchorTxHash = `0x${"c".repeat(64)}`;

  const proof = buildReceiptProof(exec);
  assert.equal(proof.receiptSha256, hash);
  assert.equal(proof.selfCheck.storedHashMatches, true);
  assert.equal(proof.anchor.expectedCalldata, `0x${hash}`);
  assert.equal(proof.anchor.binding, "local_hash_matches");
  assert.equal(proof.anchor.onchainConfirmation, "not_checked");
  assert.equal(proof.verification.hashAlgorithm, "sha256");
  assert.match(proof.verification.canonicalization, /recursively sorting/i);
  assert.equal(proof.anchor.txHash, exec.anchorTxHash);
  assert.equal(proof.anchor.chain, "eip155:196");
});

test("mission page links the exact machine-verifiable receipt", () => {
  const exec = execution();
  exec.receiptVersion = "bind.execution-receipt.v2";
  exec.receiptSha256 = hashCanonical(buildReceiptCore(exec));
  exec.anchorTxHash = `0x${"c".repeat(64)}`;

  const html = renderMissionPage(exec);
  assert.match(html, new RegExp(`/bind/receipt/${exec.executionId}`));
  assert.match(html, new RegExp(exec.receiptSha256));
  assert.match(html, /canonical JSON and local hash check/i);
  assert.match(html, /refund submitted/i);
  assert.doesNotMatch(html, /refunded to buyer/i);
  assert.match(html, /recorded \$0\.010/i);
  assert.doesNotMatch(html, /paid \$0\.010/i);
  assert.doesNotMatch(html, /Paid to agents/i);
  assert.doesNotMatch(html, /agent budget refunded/i);
});

test("mission and agent pages reject stored-data markup in numeric fields", () => {
  const exec = execution();
  exec.completedSteps = '<img src=x onerror=alert(1)>' as unknown as number;
  exec.totalSteps = '<svg onload=alert(1)>' as unknown as number;
  const missionHtml = renderMissionPage(exec);
  assert.doesNotMatch(missionHtml, /<img src=x|<svg onload/);
  assert.match(missionHtml, /Agents verified<\/span><span>0\/0/);

  const rep = {
    agentId: "4413", name: "SignalDesk",
    missions: '<img src=x onerror=alert(1)>' as unknown as number,
    passed: '<svg onload=alert(1)>' as unknown as number,
    failed: 0,
    feesWithSettlementReferenceUsdt: '<script>alert(1)<\/script>' as unknown as number,
    referencedMissions: 0, referencedPassed: 0, referencedPassRate: 0, passRate: 0,
  };
  const agentHtml = renderAgentPage("4413", rep, [], "https://trybind.xyz");
  assert.doesNotMatch(agentHtml, /<img src=x|<svg onload|<script>alert/);
  assert.match(agentHtml, /<b>0<\/b><span>recorded calls/);
});

test("agent page describes mixed attempt evidence honestly", () => {
  const rep = {
    agentId: "4413",
    name: "SignalDesk",
    missions: 2,
    passed: 1,
    failed: 1,
    feesWithSettlementReferenceUsdt: 0.01,
    referencedMissions: 1,
    referencedPassed: 1,
    referencedPassRate: 1,
    passRate: 0.5,
  };
  const html = renderAgentPage("4413", rep, [
    {
      at: "2026-07-30T10:00:00.000Z",
      evidenceId: `sha256:${"e".repeat(64)}`,
      serviceName: "Market intelligence",
      status: "errored",
    },
  ], "https://trybind.xyz");

  assert.doesNotMatch(html, /every data point has an on-chain receipt/i);
  assert.doesNotMatch(html, /it cannot be bought/i);
  assert.match(html, /settlement links appear when available/i);
});
