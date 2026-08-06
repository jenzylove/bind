import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDownstreamAuthorization,
  decodeSignedDownstreamCredential,
  downstreamExposureBaseUnits,
  mayAttemptFallback,
  readChallengeCost,
  remainingAgentBudget,
  unresolvedAuthorizationExposureUsdt,
} from "../src/bind/executor.js";
import type { BindPlan } from "../src/bind/types.js";

const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x3333333333333333333333333333333333333333";
const RESOURCE = "https://agent.example/x402/run";

function signedCredential(overrides: Record<string, unknown> = {}): string {
  const authorization = {
    from: PAYER,
    to: PAYEE,
    value: "15000",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: `0x${"b".repeat(64)}`,
    ...overrides,
  };
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: { scheme: "exact", network: "eip155:196", amount: "15000", asset: USDT, payTo: PAYEE },
    payload: { authorization, signature: `0x${"c".repeat(130)}` },
  })).toString("base64");
}

function challenge(requirement: Record<string, unknown> = {}, extraAccepts: unknown[] = [], topLevel: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [{
      scheme: "exact",
      network: "eip155:196",
      amount: "15000",
      asset: USDT,
      payTo: PAYEE,
      ...requirement,
    }, ...extraAccepts],
    ...topLevel,
  })).toString("base64");
}

test("x402 challenge parsing returns the one fully bound live amount Bind may sign", () => {
  assert.deepEqual(readChallengeCost(challenge(), RESOURCE, PAYEE), { usdt: 0.015, amountBaseUnits: "15000", asset: USDT, payTo: PAYEE });
});

test("x402 challenge parsing fails closed on malformed, ambiguous, or incompletely bound requirements", () => {
  for (const amount of ["", "0", "-1", "1.5", "1e3", "0x10", "NaN", "Infinity", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(readChallengeCost(challenge({ amount }), RESOURCE, PAYEE), null, `amount ${String(amount)} must fail`);
  }
  assert.equal(readChallengeCost(challenge({ asset: undefined }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ asset: "0x2222222222222222222222222222222222222222" }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ scheme: undefined }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ scheme: "permit" }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ network: undefined }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ network: "eip155:1" }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ payTo: undefined }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ payTo: "not-an-address" }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge(), RESOURCE, "0x2222222222222222222222222222222222222222"), null);
  assert.equal(
    readChallengeCost(challenge({}, [], { resource: { url: `${RESOURCE}?account=attacker` } }), `${RESOURCE}?account=victim`, PAYEE),
    null,
  );
  assert.equal(readChallengeCost(challenge({}, [{ scheme: "exact", network: "eip155:196", amount: "1", asset: USDT, payTo: PAYEE }]), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({}, [], { x402Version: 1 }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({}, [], { resource: { url: "https://evil.example/run" } }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({ maxAmountRequired: "16000" }), RESOURCE, PAYEE), null);
  assert.equal(readChallengeCost(challenge({}, [], { paymentRequirements: [{ scheme: "exact" }] }), RESOURCE, PAYEE), null);
});

test("signed downstream credential exposes a claimable payer and nonce only when all selected terms match", () => {
  const expected = { resource: RESOURCE, amountBaseUnits: "15000", asset: USDT, payTo: PAYEE, payer: PAYER };
  assert.deepEqual(decodeSignedDownstreamCredential(signedCredential(), expected), {
    from: PAYER,
    to: PAYEE,
    value: "15000",
    nonce: `0x${"b".repeat(64)}`,
  });
  assert.equal(decodeSignedDownstreamCredential(signedCredential({ to: "0x4444444444444444444444444444444444444444" }), expected), null);
  assert.equal(decodeSignedDownstreamCredential(signedCredential({ value: "15001" }), expected), null);
  const nested = Buffer.from(JSON.stringify({ wrapper: JSON.parse(Buffer.from(signedCredential(), "base64").toString()) })).toString("base64");
  assert.equal(decodeSignedDownstreamCredential(nested, expected), null);
});

test("ambiguous authorized responses block fallback until exact chain reconciliation", () => {
  assert.equal(classifyDownstreamAuthorization(200, null, "pending"), "authorized_ambiguous");
  assert.equal(classifyDownstreamAuthorization(200, { settled: false }, "failed"), "authorized_ambiguous");
  assert.equal(classifyDownstreamAuthorization(500, { settled: true, txHash: `0x${"a".repeat(64)}` }, "pending"), "authorized_ambiguous");
  assert.equal(classifyDownstreamAuthorization(200, { settled: true, txHash: `0x${"a".repeat(64)}` }, "confirmed"), "settlement_confirmed");
  assert.equal(mayAttemptFallback("authorized_ambiguous"), false);
  assert.equal(mayAttemptFallback("settlement_confirmed"), true);
  assert.equal(mayAttemptFallback("not_authorized"), true);
});

test("ambiguous authorization exposure is withheld from immediate refunds", () => {
  const exposure = unresolvedAuthorizationExposureUsdt([{
    step: 1,
    agentName: "Seller",
    status: "errored",
    attempts: [{
      agentName: "Seller",
      feeUsdt: 0.05,
      feeBaseUnits: "50000",
      paid: false,
      paymentState: "authorized_ambiguous",
      status: "errored",
    }],
  }]);
  assert.equal(exposure, 0.05);
  assert.equal(downstreamExposureBaseUnits([{
    step: 1,
    agentName: "Seller",
    status: "errored",
    attempts: [{ agentName: "Seller", feeBaseUnits: "50000", paid: false, paymentState: "authorized_ambiguous", status: "errored" }],
  }], "authorized_ambiguous"), 50_000n);
  assert.equal(100_000n - 50_000n, 50_000n);
});

test("confirmed seller spend counts even when the output failed verification", () => {
  const spent = downstreamExposureBaseUnits([{
    step: 1,
    agentName: "Seller",
    status: "failed",
    attempts: [{ agentName: "Seller", feeBaseUnits: "15001", paid: true, paymentState: "settlement_confirmed", status: "failed" }],
  }], "settlement_confirmed");
  assert.equal(spent, 15_001n);
});

test("remaining agent budget is aggregate across sequential steps and attempts", () => {
  const plan = {
    agentCost: 0.02,
    steps: [
      { agent: { feeAmount: 0.015 } },
      { agent: { feeAmount: 0.015 } },
    ],
  } as BindPlan;
  assert.equal(remainingAgentBudget(plan, 0), 0.02);
  assert.ok(Math.abs(remainingAgentBudget(plan, 0.015) - 0.005) < 1e-9);
  assert.equal(remainingAgentBudget(plan, 0.02), 0);
  assert.equal(remainingAgentBudget(plan, 0.03), 0);
});
