import test from "node:test";
import assert from "node:assert/strict";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const TX = `0x${"a".repeat(64)}`;

function topic(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function transferLog(to = TO, value = 50_000n, token = USDT) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topic(FROM), topic(to)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
  };
}

test("incoming settlement confirmation requires a successful expected USDT transfer log", async (t) => {
  process.env.PAY_TO_ADDRESS = TO;
  process.env.USDT_ASSET = USDT;
  const { confirmsExpectedTransfer } = await import("../src/bind/x402-settle.js");
  const auth = {
    from: FROM,
    to: TO,
    value: "50000",
    validAfter: 0,
    validBefore: 9_999_999_999,
    nonce: `0x${"b".repeat(64)}`,
  };

  const originalFetch = globalThis.fetch;
  let receipt: Record<string, unknown> = { status: "0x1", logs: [transferLog()] };
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await confirmsExpectedTransfer(TX, auth), true);

  receipt = { status: "0x0", logs: [transferLog()] };
  assert.equal(await confirmsExpectedTransfer(TX, auth), false);

  receipt = { status: "0x1", logs: [transferLog("0x3333333333333333333333333333333333333333")] };
  assert.equal(await confirmsExpectedTransfer(TX, auth), false);

  receipt = { status: "0x1", logs: [transferLog(TO, 49_999n)] };
  assert.equal(await confirmsExpectedTransfer(TX, auth), false);

  receipt = { status: "0x1", logs: [transferLog(TO, 50_000n, "0x4444444444444444444444444444444444444444")] };
  assert.equal(await confirmsExpectedTransfer(TX, auth), false);
});
