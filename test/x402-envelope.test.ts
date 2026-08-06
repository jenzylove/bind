import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingPaymentTerms } from "../src/bind/x402-settle.js";

process.env.PAY_TO_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.USDT_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const { validateIncomingCredential } = await import("../src/bind/x402-settle.js");
const { paymentIntentNonce } = await import("../src/bind/payment-intent.js");

const resource = "https://bind.example/bind/plan?mode=deep";
const intentNonce = paymentIntentNonce("/bind/plan?mode=deep", { goal: "BTC brief", inputs: { depth: 2 } });
const base = {
  x402Version: 2,
  resource: { url: resource },
  accepted: {
    scheme: "exact",
    network: "eip155:196",
    amount: "50000",
    asset: process.env.USDT_ASSET,
    payTo: process.env.PAY_TO_ADDRESS,
  },
  payload: {
    authorization: {
      from: "0x1111111111111111111111111111111111111111",
      to: process.env.PAY_TO_ADDRESS,
      value: "50000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: intentNonce,
    },
    signature: `0x${"b".repeat(130)}`,
  },
};
const exact: IncomingPaymentTerms = { amountBaseUnits: "50000", amountPolicy: "exact", resource, intentNonce };
const reason = (value: unknown, terms: IncomingPaymentTerms = exact) => {
  const result = validateIncomingCredential(value, terms);
  return "reason" in result ? result.reason : undefined;
};

test("standard x402 v2 envelope matches every issued term", () => {
  const result = validateIncomingCredential(structuredClone(base), exact);
  assert.equal("reason" in result, false);
  if (!("reason" in result)) assert.equal(result.value, 50_000n);
});

test("incoming settlement rejects every mismatched challenge dimension", () => {
  const changes: Array<[string, (value: any) => void]> = [
    ["version", (v) => { v.x402Version = 1; }],
    ["resource query", (v) => { v.resource.url = "https://bind.example/bind/plan?mode=fast"; }],
    ["scheme", (v) => { v.accepted.scheme = "upto"; }],
    ["network", (v) => { v.accepted.network = "eip155:1"; }],
    ["asset", (v) => { v.accepted.asset = "0x3333333333333333333333333333333333333333"; }],
    ["payee", (v) => { v.accepted.payTo = "0x3333333333333333333333333333333333333333"; }],
    ["authorization payee", (v) => { v.payload.authorization.to = "0x3333333333333333333333333333333333333333"; }],
    ["selected amount", (v) => { v.accepted.amount = "49999"; }],
    ["missing standard payload", (v) => { v.authorization = v.payload.authorization; delete v.payload; }],
    ["duplicate accepts representation", (v) => { v.accepts = [v.accepted]; }],
    ["duplicate payment requirements", (v) => { v.paymentRequirements = [v.accepted]; }],
    ["string resource shorthand", (v) => { v.resource = resource; }],
    ["array accepted terms", (v) => { v.accepted = [v.accepted]; }],
    ["max amount alias", (v) => { v.accepted.maxAmountRequired = v.accepted.amount; }],
    ["invalid payer address", (v) => { v.payload.authorization.from = "0x1"; }],
    ["invalid nonce", (v) => { v.payload.authorization.nonce = "0xaa"; }],
    ["invalid signature", (v) => { v.payload.signature = "0xbb"; }],
    ["expired authorization", (v) => { v.payload.authorization.validBefore = "1"; }],
    ["future authorization", (v) => { v.payload.authorization.validAfter = "9999999999"; }],
    ["noncanonical authorization amount", (v) => { v.payload.authorization.value = "5e4"; }],
  ];
  for (const [name, mutate] of changes) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.ok(reason(changed), name);
  }
});

test("payment intent nonce binds the exact normalized route and request body", () => {
  assert.equal(
    paymentIntentNonce("/bind/plan?mode=deep", { inputs: { depth: 2 }, goal: "BTC brief" }),
    intentNonce,
  );
  assert.notEqual(paymentIntentNonce("/bind/plan?mode=deep", { goal: "ETH brief", inputs: { depth: 2 } }), intentNonce);
  assert.notEqual(paymentIntentNonce("/bind/execute", { planId: "plan-b" }), paymentIntentNonce("/bind/execute", { planId: "plan-a" }));

  const replayedForAnotherBody = structuredClone(base);
  const otherIntent = paymentIntentNonce("/bind/plan?mode=deep", { goal: "ETH brief", inputs: { depth: 2 } });
  assert.match(reason(replayedForAnotherBody, { ...exact, intentNonce: otherIntent }) ?? "", /request intent/i);
});

test("fixed routes reject overpayment while execute may accept an accounted minimum", () => {
  const overpaid = structuredClone(base);
  overpaid.accepted.amount = "60000";
  overpaid.payload.authorization.value = "60000";
  assert.match(reason(overpaid) ?? "", /equal the fixed route price/i);
  assert.equal(reason(overpaid, { ...exact, amountPolicy: "minimum" }), undefined);

  const underpaid = structuredClone(base);
  underpaid.accepted.amount = "49999";
  underpaid.payload.authorization.value = "49999";
  assert.match(reason(underpaid, { ...exact, amountPolicy: "minimum" }) ?? "", /underpays/i);
});
