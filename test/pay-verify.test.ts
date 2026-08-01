import test from "node:test";
import assert from "node:assert/strict";

process.env.USDT_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
process.env.PAY_TO_ADDRESS = "0x2222222222222222222222222222222222222222";
const { summarizeBuyerPaymentReceipt } = await import("../src/bind/pay-verify.js");

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const token = process.env.USDT_ASSET!;
const recipient = process.env.PAY_TO_ADDRESS!;
const txHash = `0x${"a".repeat(64)}`;
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const transfer = (payer: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(payer), topic(recipient)],
  data: `0x${value.toString(16).padStart(64, "0")}`,
});

test("buyer payment evidence aggregates only one sender", () => {
  const payer = "0x1111111111111111111111111111111111111111";
  const result = summarizeBuyerPaymentReceipt({ transactionHash: txHash, logs: [transfer(payer, 40_000n), transfer(payer, 60_000n)] }, txHash, token, recipient);
  assert.deepEqual(result, { payer, amountBaseUnits: 100_000n });
});

test("buyer payment evidence rejects multiple transfer senders", () => {
  const receipt = {
    transactionHash: txHash,
    logs: [
      transfer("0x1111111111111111111111111111111111111111", 50_000n),
      transfer("0x3333333333333333333333333333333333333333", 50_000n),
    ],
  };
  const result = summarizeBuyerPaymentReceipt(receipt, txHash, token, recipient);
  assert.match("reason" in result ? result.reason : "", /multiple payers/i);
});

test("buyer payment evidence requires the requested transaction hash", () => {
  const result = summarizeBuyerPaymentReceipt({ transactionHash: `0x${"b".repeat(64)}`, logs: [] }, txHash, token, recipient);
  assert.match("reason" in result ? result.reason : "", /does not match/i);
});
